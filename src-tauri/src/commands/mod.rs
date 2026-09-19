//! Tauri command layer (Task 14): thin async command shells + pure `*_inner`
//! fns testable without Tauri. Every mutation writes the entity and enqueues
//! the outbox op inside ONE `conn.transaction()`.
pub mod dto;

use tauri::Manager;
use crate::db::{checklists, items, notes, outbox};
use crate::error::{AppError, AppResult};
use crate::jotty::client::JottyClient;
use crate::state::AppState;
use dto::{
    AiSettingsDto, CategoriesDto, ChecklistDto, ConflictDto, ConnectInfo, ItemDto, ListHit, NoteDto,
    NoteHit, SearchResultsDto, SettingsDto, SyncReportDto, SyncStatusDto, TidyDto, VoiceRecordingDto,
};
use rusqlite::Connection;
use rusqlite::OptionalExtension;

// ---- notes ----

pub(crate) fn create_note_inner(conn: &mut Connection, title: &str, category: &str) -> AppResult<NoteDto> {
    let tx = conn.transaction()?;
    let row = notes::insert_local(&tx, &notes::NewNote {
        title: title.into(),
        content: String::new(),
        category: category.into(),
    })?;
    // Ruling E: note create payload = {temp_id (REQUIRED — push remaps via it), title, content, category}.
    outbox::enqueue(&tx, "create", "note", &row.id, &serde_json::json!({
        "temp_id": &row.id, "title": &row.title, "content": &row.content, "category": &row.category
    }))?;
    tx.commit()?;
    Ok(NoteDto::from(row))
}

// Ruling H: enqueue the post-patch MERGED row values (full copy — push's update
// arm keys on op.entity_id).
pub(crate) fn update_note_inner(
    conn: &mut Connection,
    id: &str,
    title: Option<String>,
    content: Option<String>,
    category: Option<String>,
) -> AppResult<NoteDto> {
    let tx = conn.transaction()?;
    let patch = notes::NotePatch { title, content, category };
    let row = notes::update_local(&tx, id, &patch)?;
    outbox::enqueue(&tx, "update", "note", id, &serde_json::json!({
        "title": &row.title, "content": &row.content, "category": &row.category
    }))?;
    tx.commit()?;
    Ok(NoteDto::from(row))
}

pub(crate) fn delete_note_inner(conn: &mut Connection, id: &str) -> AppResult<()> {
    let tx = conn.transaction()?;
    notes::soft_delete_local(&tx, id)?;
    // Ruling E: note delete payload = {} (entity_id carries the id).
    outbox::enqueue(&tx, "delete", "note", id, &serde_json::json!({}))?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn list_notes_inner(conn: &Connection) -> AppResult<Vec<NoteDto>> {
    Ok(notes::list(conn, false)?.into_iter().map(NoteDto::from).collect())
}

pub(crate) fn get_note_inner(conn: &Connection, id: &str) -> AppResult<NoteDto> {
    notes::get(conn, id)?
        .map(NoteDto::from)
        .ok_or_else(|| AppError::Other(format!("note {id} not found")))
}

// ---- checklists ----

pub(crate) fn create_checklist_inner(conn: &mut Connection, title: &str, category: &str) -> AppResult<ChecklistDto> {
    let tx = conn.transaction()?;
    let row = checklists::insert_local_list(&tx, &checklists::NewChecklist {
        title: title.into(),
        category: category.into(),
    })?;
    // Ruling E: checklist create payload = {temp_id, title, category}.
    outbox::enqueue(&tx, "create", "checklist", &row.id, &serde_json::json!({
        "temp_id": &row.id, "title": &row.title, "category": &row.category
    }))?;
    tx.commit()?;
    Ok(ChecklistDto::from(row))
}

pub(crate) fn update_checklist_inner(
    conn: &mut Connection,
    id: &str,
    title: Option<String>,
    category: Option<String>,
) -> AppResult<ChecklistDto> {
    let tx = conn.transaction()?;
    let row = checklists::update_local_list(&tx, id, title.as_deref(), category.as_deref())?;
    outbox::enqueue(&tx, "update", "checklist", id, &serde_json::json!({
        "title": &row.title, "category": &row.category
    }))?;
    tx.commit()?;
    Ok(ChecklistDto::from(row))
}

pub(crate) fn delete_checklist_inner(conn: &mut Connection, id: &str) -> AppResult<()> {
    let tx = conn.transaction()?;
    checklists::soft_delete_list_local(&tx, id)?;
    outbox::enqueue(&tx, "delete", "checklist", id, &serde_json::json!({}))?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn list_checklists_inner(conn: &Connection) -> AppResult<Vec<ChecklistDto>> {
    // Per-list completion (web-pref mirror: defaultChecklistFilter). One grouped
    // query: a list is completed when it HAS items and none are open. Empty
    // lists count as open (there is nothing "done" about an empty list).
    let mut open_counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT checklist_id, COUNT(*) FROM checklist_items
             WHERE completed = 0 GROUP BY checklist_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (id, open_count) = row?;
            open_counts.insert(id, open_count);
        }
    }
    let item_counts: std::collections::HashMap<String, i64> = {
        let mut stmt = conn.prepare(
            "SELECT checklist_id, COUNT(*) FROM checklist_items GROUP BY checklist_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut m: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for row in rows {
            let (id, n) = row?;
            m.insert(id, n);
        }
        m
    };
    let mut dtos: Vec<ChecklistDto> = checklists::list_checklists(conn, false)?
        .into_iter()
        .map(ChecklistDto::from)
        .collect();
    for d in &mut dtos {
        let total = *item_counts.get(&d.id).unwrap_or(&0);
        let open = *open_counts.get(&d.id).unwrap_or(&0);
        d.completed = total > 0 && open == 0;
    }
    Ok(dtos)
}

// Ruling I: get_checklist nests ItemDto from list_for_checklist's flat rows
// via parent_id (v1 choice).
pub(crate) fn get_checklist_inner(conn: &Connection, id: &str) -> AppResult<ChecklistDto> {
    let row = checklists::get_checklist(conn, id)?
        .ok_or_else(|| AppError::Other(format!("checklist {id} not found")))?;
    let flat = items::list_for_checklist(conn, id)?;
    Ok(ChecklistDto {
        items: attach_items(None, &flat),
        ..ChecklistDto::from(row)
    })
}

fn attach_items(parent: Option<&str>, flat: &[items::ItemRow]) -> Vec<ItemDto> {
    let mut out = Vec::new();
    for r in flat.iter().filter(|r| r.parent_id.as_deref() == parent) {
        let mut dto = ItemDto::from(r.clone());
        dto.children = attach_items(Some(&r.local_id), flat);
        out.push(dto);
    }
    out
}

// ---- checklist items (op_type = plain create/update/check/delete/reorder,
// entity = "checklist_item", entity_id = item local_id — binding note R1) ----

pub(crate) fn add_item_inner(
    conn: &mut Connection,
    checklist_id: &str,
    text: &str,
    parent_local_id: Option<String>,
) -> AppResult<ItemDto> {
    let tx = conn.transaction()?;
    let row = items::insert_local(&tx, &items::NewItem {
        checklist_id: checklist_id.into(),
        parent_local_id: parent_local_id.clone(),
        text: text.into(),
    })?;
    // Ruling D: create → {checklist_id, item_local_id, text, parent_local_id: opt}
    // (NO temp_local_id key — push.rs never reads it).
    outbox::enqueue(&tx, "create", "checklist_item", &row.local_id, &serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": &row.local_id, "text": &row.text,
        "parent_local_id": parent_local_id.as_deref()
    }))?;
    tx.commit()?;
    Ok(ItemDto::from(row))
}

pub(crate) fn set_item_text_inner(
    conn: &mut Connection,
    checklist_id: &str,
    item_local_id: &str,
    text: &str,
) -> AppResult<()> {
    let tx = conn.transaction()?;
    items::update_local(&tx, item_local_id, text)?;
    // Ruling D: update → {checklist_id, item_local_id, text}.
    outbox::enqueue(&tx, "update", "checklist_item", item_local_id, &serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": item_local_id, "text": text
    }))?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn set_item_checked_inner(
    conn: &mut Connection,
    checklist_id: &str,
    item_local_id: &str,
    checked: bool,
) -> AppResult<()> {
    let tx = conn.transaction()?;
    items::set_checked(&tx, item_local_id, checked)?;
    // Ruling D: check → {checklist_id, item_local_id, checked: bool}.
    outbox::enqueue(&tx, "check", "checklist_item", item_local_id, &serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": item_local_id, "checked": checked
    }))?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn delete_item_inner(conn: &mut Connection, checklist_id: &str, item_local_id: &str) -> AppResult<()> {
    let tx = conn.transaction()?;
    items::delete_local(&tx, item_local_id)?;
    // Ruling D: delete → {checklist_id, item_local_id}.
    outbox::enqueue(&tx, "delete", "checklist_item", item_local_id, &serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": item_local_id
    }))?;
    tx.commit()?;
    Ok(())
}

// Superseded ruling (brief NB): reorder enqueues entity="checklist_item",
// entity_id=<checklist id> — push.rs's reorder arm pattern-matches that pair;
// the payload still carries checklist_id + ordered_top_level_ids.
pub(crate) fn reorder_items_inner(
    conn: &mut Connection,
    checklist_id: &str,
    ordered_top_level_ids: Vec<String>,
) -> AppResult<()> {
    let tx = conn.transaction()?;
    items::reorder_local(&tx, checklist_id, &ordered_top_level_ids)?;
    outbox::enqueue(&tx, "reorder", "checklist_item", checklist_id, &serde_json::json!({
        "checklist_id": checklist_id, "ordered_top_level_ids": ordered_top_level_ids
    }))?;
    tx.commit()?;
    Ok(())
}

// ---- search (FTS5 MATCH, quote-escaped) ----

pub(crate) fn search_inner(conn: &Connection, query: &str) -> AppResult<SearchResultsDto> {
    let safe = format!("\"{}\"", query.replace('"', "\"\""));
    let mut notes_hits = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, snippet(notes_fts, 2, '[', ']', '…', 12) FROM notes_fts WHERE notes_fts MATCH ?1 LIMIT 20")?;
        let rows = stmt.query_map([&safe], |r| Ok(NoteHit { id: r.get(0)?, title: r.get(1)?, snippet: r.get(2)? }))?;
        for h in rows { notes_hits.push(h?); }
    }
    let mut list_hits = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, snippet(lists_fts, 2, '[', ']', '…', 12) FROM lists_fts WHERE lists_fts MATCH ?1 LIMIT 20")?;
        let rows = stmt.query_map([&safe], |r| Ok(ListHit { id: r.get(0)?, title: r.get(1)?, item_text: r.get(2)? }))?;
        for h in rows { list_hits.push(h?); }
    }
    Ok(SearchResultsDto { notes: notes_hits, checklists: list_hits })
}

// ---- conflicts ----

// label = entity title/text for display; item ops join via checklist_items.local_id.
fn label_for(conn: &Connection, entity: &str, entity_id: &str) -> Option<String> {
    match entity {
        "note" => conn
            .query_row("SELECT title FROM notes WHERE id=?1", [entity_id], |r| r.get::<_, Option<String>>(0))
            .ok()
            .flatten(),
        "checklist" => conn
            .query_row("SELECT title FROM checklists WHERE id=?1", [entity_id], |r| r.get::<_, Option<String>>(0))
            .ok()
            .flatten(),
        "checklist_item" => conn
            .query_row("SELECT text FROM checklist_items WHERE local_id=?1", [entity_id], |r| r.get::<_, Option<String>>(0))
            .ok()
            .flatten(),
        _ => None,
    }
}

pub(crate) fn list_conflicts_inner(conn: &Connection) -> AppResult<Vec<ConflictDto>> {
    let mut stmt = conn.prepare(
        "SELECT seq, entity, entity_id, op_type, last_error FROM outbox WHERE state='conflict' ORDER BY seq",
    )?;
    let rows = stmt
        .query_map([], |r| {
            let entity: String = r.get(1)?;
            let entity_id: String = r.get(2)?;
            let label = label_for(conn, &entity, &entity_id);
            Ok(ConflictDto {
                seq: r.get(0)?,
                entity,
                entity_id,
                op_type: r.get(3)?,
                last_error: r.get(4)?,
                label,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// Ruling C: keep=="server" → outbox::mark_done + do_sync via app handle (pull
// re-imports server state); keep=="mine" → raw UPDATE outbox SET state='pending',
// attempts=0 WHERE seq=?1 (outbox.rs is NOT in this task's Files list).
pub(crate) async fn inner_resolve_conflict(
    state: &AppState,
    app: &tauri::AppHandle,
    seq: i64,
    keep: &str,
) -> AppResult<()> {
    match keep {
        "server" => {
            let conn = state.db.lock().await;
            outbox::mark_done(&conn, seq)?;
            drop(conn);
            crate::sync::do_sync(app).await?;
            Ok(())
        }
        "mine" => {
            let conn = state.db.lock().await;
            conn.execute("UPDATE outbox SET state='pending', attempts=0 WHERE seq=?1", [seq])?;
            Ok(())
        }
        _ => Err(AppError::Other(format!("unknown keep '{keep}'"))),
    }
}

// ---- connection / sync / settings ----

pub(crate) async fn inner_connect(
    state: &AppState,
    app: &tauri::AppHandle,
    url: &str,
    api_key: &str,
) -> AppResult<ConnectInfo> {
    let client = JottyClient::new(url, api_key)?;
    let health = client.health().await.map_err(|_| AppError::Api {
        status: 0,
        body: "health check failed — is the instance url correct?".into(),
    })?;
    if health.status != "healthy" {
        return Err(AppError::InvalidConfig(format!("instance reports '{}'", health.status)));
    }
    client.get_categories().await?; // auth check
    state.keystore.set(api_key)?;
    let conn = state.db.lock().await;
    conn.execute(
        "INSERT INTO sync_state(key,value) VALUES ('instance_url',?1) ON CONFLICT(key) DO UPDATE SET value=?1",
        [url],
    )?;
    *state.client.write().await = Some(client);
    drop(conn);
    crate::sync::do_sync(app).await?;
    Ok(ConnectInfo { instance_url: url.into(), version: health.version })
}

// Ruling J: clear client, DELETE the instance_url sync_state row, keystore.delete().
pub(crate) async fn inner_disconnect(state: &AppState) -> AppResult<()> {
    *state.client.write().await = None;
    let conn = state.db.lock().await;
    conn.execute("DELETE FROM sync_state WHERE key='instance_url'", [])?;
    drop(conn);
    state.keystore.delete()?;
    Ok(())
}

// Ruling P: get_connection returns version None in v1 (no network in a getter).
// Offline-launch fix (v0.9.1): "configured" is a LOCAL fact — the instance_url
// row plus a key in the keystore. The restore task rebuilds the in-memory
// client asynchronously, so a mount-time getter racing that restore must still
// report the configured instance; offline there is no sync-updated event to
// re-fetch later, and stranding on the onboarding screen (asking again for the
// URL + API key) defeated the whole point of the offline client.
pub(crate) async fn inner_get_connection(state: &AppState) -> AppResult<Option<ConnectInfo>> {
    let url: Option<String> = {
        let conn = state.db.lock().await;
        conn.query_row(
            "SELECT value FROM sync_state WHERE key='instance_url'",
            [],
            |r| r.get(0),
        )
        .optional()?
    };
    let Some(url) = url else { return Ok(None) };
    // fast path: the client is already live (fresh connect or finished restore)
    if state.client.read().await.is_some() {
        return Ok(Some(ConnectInfo { instance_url: url, version: None }));
    }
    // restore still pending (launch window): decide from the keystore — local,
    // no network. Missing key = genuinely unusable -> None (onboarding stays).
    let key = state.keystore.get().unwrap_or(None);
    Ok(key.map(|_| ConnectInfo { instance_url: url, version: None }))
}

// The verbatim sync::do_sync (Task 13 transplant) returns () and reports via the
// "sync-updated" event; the UI ignores this command's payload (plan line 3629:
// invoke<unknown>('trigger_sync')), so the report mirrors the post-sync outbox
// snapshot instead of fabricating push/pull stats.
pub(crate) async fn inner_trigger_sync(
    state: &AppState,
    app: &tauri::AppHandle,
) -> AppResult<SyncReportDto> {
    crate::sync::do_sync(app).await?;
    let conn = state.db.lock().await;
    let pending = outbox::pending_count(&conn)?;
    let conflicts: i64 = conn.query_row("SELECT COUNT(*) FROM outbox WHERE state='conflict'", [], |r| r.get(0))?;
    let last_sync_at: Option<String> = conn
        .query_row("SELECT value FROM sync_state WHERE key='last_sync_at'", [], |r| r.get(0))
        .optional()?;
    Ok(SyncReportDto { pending, conflicts, last_sync_at })
}

pub(crate) fn sync_status_inner(conn: &Connection, syncing: bool) -> AppResult<SyncStatusDto> {
    let pending = outbox::pending_count(conn)?;
    let last_sync_at: Option<String> = conn
        .query_row("SELECT value FROM sync_state WHERE key='last_sync_at'", [], |r| r.get(0))
        .optional()?;
    // newest recorded failure across pending + conflict rows (FIFO head is what
    // blocks the queue, so order by seq — first failed op is the blocker)
    let last_error: Option<String> = conn
        .query_row(
            "SELECT last_error FROM outbox WHERE last_error IS NOT NULL AND state IN ('pending','conflict') ORDER BY seq LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(SyncStatusDto { pending, last_sync_at, syncing, last_error })
}

pub(crate) fn get_settings_inner(conn: &Connection) -> AppResult<SettingsDto> {
    let instance_url: Option<String> = conn
        .query_row("SELECT value FROM sync_state WHERE key='instance_url'", [], |r| r.get(0))
        .optional()?;
    let sync_interval_minutes: i64 = conn.query_row(
        "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM sync_state WHERE key='sync_interval_minutes'), 5)",
        [],
        |r| r.get(0),
    )?;
    Ok(SettingsDto { instance_url, sync_interval_minutes })
}

pub(crate) fn set_sync_interval_inner(conn: &Connection, minutes: i64) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sync_state(key,value) VALUES ('sync_interval_minutes',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [minutes],
    )?;
    Ok(())
}

// ---- command shells (thin: lock the db / call inner, map Err → String) ----

#[tauri::command]
pub async fn connect_instance(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    url: String,
    api_key: String,
) -> Result<ConnectInfo, String> {
    inner_connect(&state, &app, &url, &api_key).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disconnect_instance(state: tauri::State<'_, AppState>) -> Result<(), String> {
    inner_disconnect(&state).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_connection(state: tauri::State<'_, AppState>) -> Result<Option<ConnectInfo>, String> {
    inner_get_connection(&state).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_notes(state: tauri::State<'_, AppState>) -> Result<Vec<NoteDto>, String> {
    let conn = state.db.lock().await;
    list_notes_inner(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_note(state: tauri::State<'_, AppState>, id: String) -> Result<NoteDto, String> {
    let conn = state.db.lock().await;
    get_note_inner(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_note(state: tauri::State<'_, AppState>, title: String, category: String) -> Result<NoteDto, String> {
    let mut conn = state.db.lock().await;
    create_note_inner(&mut conn, &title, &category).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_note(
    state: tauri::State<'_, AppState>,
    id: String,
    title: Option<String>,
    content: Option<String>,
    category: Option<String>,
) -> Result<NoteDto, String> {
    let mut conn = state.db.lock().await;
    update_note_inner(&mut conn, &id, title, content, category).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_note(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let mut conn = state.db.lock().await;
    delete_note_inner(&mut conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_checklists(state: tauri::State<'_, AppState>) -> Result<Vec<ChecklistDto>, String> {
    let conn = state.db.lock().await;
    list_checklists_inner(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_checklist(state: tauri::State<'_, AppState>, id: String) -> Result<ChecklistDto, String> {
    let conn = state.db.lock().await;
    get_checklist_inner(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_checklist(
    state: tauri::State<'_, AppState>,
    title: String,
    category: String,
) -> Result<ChecklistDto, String> {
    let mut conn = state.db.lock().await;
    create_checklist_inner(&mut conn, &title, &category).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_checklist(
    state: tauri::State<'_, AppState>,
    id: String,
    title: Option<String>,
    category: Option<String>,
) -> Result<ChecklistDto, String> {
    let mut conn = state.db.lock().await;
    update_checklist_inner(&mut conn, &id, title, category).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_checklist(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let mut conn = state.db.lock().await;
    delete_checklist_inner(&mut conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_item(
    state: tauri::State<'_, AppState>,
    checklist_id: String,
    text: String,
    parent_local_id: Option<String>,
) -> Result<ItemDto, String> {
    let mut conn = state.db.lock().await;
    add_item_inner(&mut conn, &checklist_id, &text, parent_local_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_item_text(
    state: tauri::State<'_, AppState>,
    checklist_id: String,
    item_local_id: String,
    text: String,
) -> Result<(), String> {
    let mut conn = state.db.lock().await;
    set_item_text_inner(&mut conn, &checklist_id, &item_local_id, &text).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_item_checked(
    state: tauri::State<'_, AppState>,
    checklist_id: String,
    item_local_id: String,
    checked: bool,
) -> Result<(), String> {
    let mut conn = state.db.lock().await;
    set_item_checked_inner(&mut conn, &checklist_id, &item_local_id, checked).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_item(
    state: tauri::State<'_, AppState>,
    checklist_id: String,
    item_local_id: String,
) -> Result<(), String> {
    let mut conn = state.db.lock().await;
    delete_item_inner(&mut conn, &checklist_id, &item_local_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reorder_items(
    state: tauri::State<'_, AppState>,
    checklist_id: String,
    ordered_top_level_ids: Vec<String>,
) -> Result<(), String> {
    let mut conn = state.db.lock().await;
    reorder_items_inner(&mut conn, &checklist_id, ordered_top_level_ids).map_err(|e| e.to_string())
}

// Ruling K: via the state client's get_categories (DTO wrapper shape here).
// v0.9.2 offline fallback: the live fetch stays the online source of truth
// (server-side sharing/permission filtering + custom order file); on ANY
// failure — or when no client is configured/restored yet — the tree is
// derived locally from the synced note/checklist category strings
// (db::categories::derive_local). A fresh offline start previously rendered
// an empty sidebar tree. The connect-time auth probe (inner_connect) keeps
// calling get_categories directly and is unaffected.
pub(crate) async fn inner_list_categories(state: &AppState) -> AppResult<crate::jotty::models::Categories> {
    let client = state.client.read().await.clone();
    if let Some(client) = client {
        if let Ok(cats) = client.get_categories().await {
            return Ok(cats);
        }
    }
    let conn = state.db.lock().await;
    crate::db::categories::derive_local(&conn)
}

#[tauri::command]
pub async fn list_categories(state: tauri::State<'_, AppState>) -> Result<CategoriesDto, String> {
    let cats = inner_list_categories(&state).await.map_err(|e| e.to_string())?;
    Ok(CategoriesDto::from(cats))
}

#[tauri::command]
pub async fn get_prefs(state: tauri::State<'_, AppState>) -> Result<crate::jotty::models::UserPrefs, String> {
    let Some(client) = state.client.read().await.clone() else {
        return Err(AppError::NotConnected.to_string());
    };
    client.get_user_prefs().await.map_err(|e| e.to_string())
}

/// Instance branding mirror (v0.9.0): name + best icon from the public
/// /api/manifest. Also sets the window/taskbar icon best-effort (X11;
/// some Wayland compositors ignore runtime icon changes; the installed
/// .desktop launcher icon is baked into the bundle and cannot follow).
#[tauri::command]
pub async fn get_branding(state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<crate::commands::dto::BrandingDto, String> {
    let Some(client) = state.client.read().await.clone() else {
        return Err(AppError::NotConnected.to_string());
    };
    let data = client.get_branding().await.map_err(|e| e.to_string())?;
    if let Some(bytes) = &data.icon_bytes {
        best_effort_set_icon(&app, bytes);
    }
    Ok(crate::commands::dto::BrandingDto { name: data.name, icon_data_url: data.icon_data_url })
}

fn best_effort_set_icon(app: &tauri::AppHandle, bytes: &[u8]) {
    use tauri::Manager as _;
    // Best-effort by design: undecodable bytes (e.g. svg) or a missing window
    // must never fail the branding command — the sidebar icon still mirrors.
    if let Ok(img) = tauri::image::Image::from_bytes(bytes) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.set_icon(img);
        }
    }
}

#[tauri::command]
pub async fn search(state: tauri::State<'_, AppState>, query: String) -> Result<SearchResultsDto, String> {
    let conn = state.db.lock().await;
    search_inner(&conn, &query).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn trigger_sync(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SyncReportDto, String> {
    inner_trigger_sync(&state, &app).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_status(state: tauri::State<'_, AppState>) -> Result<SyncStatusDto, String> {
    let syncing = state.syncing.load(std::sync::atomic::Ordering::SeqCst);
    let conn = state.db.lock().await;
    sync_status_inner(&conn, syncing).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_conflicts(state: tauri::State<'_, AppState>) -> Result<Vec<ConflictDto>, String> {
    let conn = state.db.lock().await;
    list_conflicts_inner(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn resolve_conflict(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    seq: i64,
    keep: String,
) -> Result<(), String> {
    inner_resolve_conflict(&state, &app, seq, &keep).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_settings(state: tauri::State<'_, AppState>) -> Result<SettingsDto, String> {
    let conn = state.db.lock().await;
    get_settings_inner(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_sync_interval(state: tauri::State<'_, AppState>, minutes: i64) -> Result<(), String> {
    let conn = state.db.lock().await;
    set_sync_interval_inner(&conn, minutes).map_err(|e| e.to_string())
}

// ---- self-update ----

#[tauri::command]
pub async fn check_update() -> Result<crate::updater::UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION");
    crate::updater::check("https://api.github.com", current).await
}

#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    url: String,
) -> Result<String, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no cache dir: {e}"))?
        .join("updates");
    let path = crate::updater::download(&url, &dir).await?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn install_update(path: String) -> Result<(), String> {
    // blocking process spawn (pkexec waits for the polkit dialog) — keep it
    // off the async runtime's worker threads
    tokio::task::spawn_blocking(move || crate::updater::install(std::path::Path::new(&path)))
        .await
        .map_err(|e| format!("installer task failed: {e}"))?
}

#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

// ---- voice notes (spec 2026-09-18) -----------------------------------------

fn voice_dto(conn: &Connection, id: &str) -> AppResult<VoiceRecordingDto> {
    Ok(crate::db::voice::get(conn, id)?
        .ok_or_else(|| crate::error::AppError::Other("recording vanished".into()))?
        .into())
}

pub(crate) fn voice_start_recording_inner(
    conn: &Connection,
    voice_dir: &std::path::Path,
    recorder: &crate::audio::VoiceRecorder,
    prepare: impl FnOnce() -> Result<crate::audio::PreparedInput, String>,
) -> AppResult<VoiceRecordingDto> {
    // device probe FIRST: no partial state on failure (spec §7)
    let prepared = match prepare() {
        Ok(p) => p,
        Err(msg) => return Err(crate::error::AppError::Other(msg)),
    };
    std::fs::create_dir_all(voice_dir)
        .map_err(|e| crate::error::AppError::Other(format!("voice dir: {e}")))?;
    let id = uuid::Uuid::new_v4().to_string();
    let path = voice_dir.join(format!("{id}.wav"));
    crate::db::voice::create_staging(conn, &id, path.to_string_lossy().as_ref())?;
    // open the WAV now: the file exists from recording start, so a crash
    // leaves a valid partial file (spec §4)
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: crate::audio::TARGET_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let writer = match hound::WavWriter::create(&path, spec) {
        Ok(w) => w,
        Err(e) => {
            let _ = crate::db::voice::delete_staging(conn, &id);
            let _ = std::fs::remove_file(&path);
            return Err(crate::error::AppError::Other(format!("open wav: {e}")));
        }
    };
    if let Err(msg) = recorder.start(&id, prepared, writer) {
        let _ = crate::db::voice::delete_staging(conn, &id);
        let _ = std::fs::remove_file(&path);
        return Err(crate::error::AppError::Other(msg));
    }
    voice_dto(conn, &id)
}

pub(crate) fn voice_stop_recording_inner(
    conn: &Connection,
    recorder: &crate::audio::VoiceRecorder,
) -> AppResult<VoiceRecordingDto> {
    let (id, duration) = recorder.stop().map_err(crate::error::AppError::Other)?;
    crate::db::voice::mark_recorded(conn, &id, duration)?;
    voice_dto(conn, &id)
}

pub(crate) fn voice_delete_recording_inner(
    conn: &Connection,
    recorder: &crate::audio::VoiceRecorder,
    recording_id: &str,
) -> AppResult<()> {
    // cancel-anytime: if this row owns the live session, stop it first (spec §6)
    if recorder.active_id().as_deref() == Some(recording_id) {
        let _ = recorder.stop(); // duration discarded — the row is being deleted
    }
    if let Some(rec) = crate::db::voice::get(conn, recording_id)? {
        let _ = std::fs::remove_file(&rec.path);
        crate::db::voice::delete_staging(conn, recording_id)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn voice_start_recording(
    state: tauri::State<'_, AppState>,
    recorder: tauri::State<'_, crate::audio::VoiceRecorder>,
) -> Result<VoiceRecordingDto, String> {
    let conn = state.db.lock().await;
    let dir = crate::audio::voice_dir(&state.db_path);
    voice_start_recording_inner(&conn, &dir, &recorder, crate::audio::prepare_default_input)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voice_stop_recording(
    state: tauri::State<'_, AppState>,
    recorder: tauri::State<'_, crate::audio::VoiceRecorder>,
) -> Result<VoiceRecordingDto, String> {
    let conn = state.db.lock().await;
    voice_stop_recording_inner(&conn, &recorder).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voice_delete_recording(
    state: tauri::State<'_, AppState>,
    recorder: tauri::State<'_, crate::audio::VoiceRecorder>,
    recording_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().await;
    voice_delete_recording_inner(&conn, &recorder, &recording_id).map_err(|e| e.to_string())
}

// ---- AI server settings (voice notes, spec §2.5/§4) ------------------------
// Key ONLY in the keyring; everything else is a plain sync_state pref.

pub(crate) fn kv_set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sync_state(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

fn kv_get_or(conn: &Connection, key: &str, default: &str) -> AppResult<String> {
    let v: Option<String> = conn
        .query_row("SELECT value FROM sync_state WHERE key=?1", [key], |r| r.get(0))
        .optional()?;
    Ok(v.unwrap_or_else(|| default.to_string()))
}

pub(crate) fn ai_base_url(conn: &Connection) -> AppResult<String> { kv_get_or(conn, "ai_base_url", "") }
pub(crate) fn ai_model(conn: &Connection) -> AppResult<String> { kv_get_or(conn, "ai_model", "") }
pub(crate) fn ai_language_hint(conn: &Connection) -> AppResult<String> { kv_get_or(conn, "ai_language_hint", "") }
pub(crate) fn ai_suffix(conn: &Connection) -> AppResult<crate::voice_ai::Suffix> {
    Ok(crate::voice_ai::Suffix::from_storage(&kv_get_or(conn, "ai_api_suffix", "v1")?))
}
pub(crate) fn persist_ai_suffix(conn: &Connection, effective: crate::voice_ai::Suffix) -> AppResult<()> {
    if ai_suffix(conn)? != effective {
        kv_set(conn, "ai_api_suffix", effective.as_str())?;
    }
    Ok(())
}

pub(crate) async fn build_ai_client(state: &tauri::State<'_, AppState>) -> AppResult<crate::voice_ai::VoiceAiClient> {
    let (base, suffix) = {
        let conn = state.db.lock().await;
        (ai_base_url(&conn)?, ai_suffix(&conn)?)
    };
    if base.trim().is_empty() {
        return Err(crate::error::AppError::Other("AI server not configured".into()));
    }
    let key = state
        .ai_keystore
        .get()?
        .ok_or_else(|| crate::error::AppError::Other("AI server API key not set".into()))?;
    crate::voice_ai::VoiceAiClient::new(&base, &key, suffix)
}

pub(crate) fn get_ai_settings_inner(conn: &Connection, ai_keystore: &dyn crate::keys::KeyStore) -> AppResult<AiSettingsDto> {
    Ok(AiSettingsDto {
        base_url: ai_base_url(conn)?,
        model: ai_model(conn)?,
        language_hint: ai_language_hint(conn)?,
        api_path_suffix: ai_suffix(conn)?.as_str().into(),
        has_key: ai_keystore.get()?.is_some(),
    })
}

pub(crate) fn set_ai_settings_inner(
    conn: &Connection,
    ai_keystore: &dyn crate::keys::KeyStore,
    base_url: Option<String>,
    model: Option<String>,
    language_hint: Option<String>,
    api_key: Option<String>,
) -> AppResult<AiSettingsDto> {
    if let Some(u) = base_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // validate with the same rule the client enforces (https, or http on localhost)
        let _ = crate::voice_ai::VoiceAiClient::new(u, "unused", crate::voice_ai::Suffix::V1)?;
        kv_set(conn, "ai_base_url", u)?;
    }
    if let Some(m) = model.as_deref().map(str::trim) {
        kv_set(conn, "ai_model", m)?; // empty clears
    }
    if let Some(l) = language_hint.as_deref().map(str::trim) {
        kv_set(conn, "ai_language_hint", l)?; // empty clears
    }
    if let Some(k) = api_key.as_deref().map(str::trim) {
        if k.is_empty() {
            ai_keystore.delete()?;
        } else {
            ai_keystore.set(k)?;
        }
    }
    get_ai_settings_inner(conn, ai_keystore)
}

pub(crate) async fn ai_models_core(
    ai: &crate::voice_ai::VoiceAiClient,
    db: &tokio::sync::Mutex<Connection>,
) -> AppResult<Vec<String>> {
    // rusqlite::Connection is !Sync, so the db lock must NOT be held across the
    // network await — tauri commands require Send futures.
    let (models, sfx) = ai.models().await?;
    let conn = db.lock().await;
    persist_ai_suffix(&conn, sfx)?;
    Ok(models)
}

#[tauri::command]
pub async fn get_ai_settings(state: tauri::State<'_, AppState>) -> Result<AiSettingsDto, String> {
    let conn = state.db.lock().await;
    get_ai_settings_inner(&conn, state.ai_keystore.as_ref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_ai_settings(
    state: tauri::State<'_, AppState>,
    base_url: Option<String>,
    model: Option<String>,
    language_hint: Option<String>,
    api_key: Option<String>,
) -> Result<AiSettingsDto, String> {
    let conn = state.db.lock().await;
    set_ai_settings_inner(&conn, state.ai_keystore.as_ref(), base_url, model, language_hint, api_key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_get_models(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let ai = build_ai_client(&state).await.map_err(|e| e.to_string())?;
    ai_models_core(&ai, &state.db).await.map_err(|e| e.to_string())
}

pub(crate) async fn voice_transcribe_inner(
    conn: &mut Connection,
    ai: &crate::voice_ai::VoiceAiClient,
    language: Option<&str>,
    recording_id: &str,
) -> AppResult<VoiceRecordingDto> {
    let rec = crate::db::voice::get(conn, recording_id)?
        .ok_or_else(|| crate::error::AppError::Other(format!("recording {recording_id} not found")))?;
    if rec.state == crate::db::voice::ST_RECORDING {
        return Err(crate::error::AppError::Other("recording still in progress".into()));
    }
    if rec.state == crate::db::voice::ST_TRANSCRIBED {
        return Ok(rec.into()); // idempotent: no second request
    }
    // 'recorded' | 'transcribing' (stale after restart) | failed states are all retryable
    crate::db::voice::mark_transcribing(conn, recording_id)?;
    match ai.transcribe(std::path::Path::new(&rec.path), language).await {
        Ok((text, sfx)) => {
            persist_ai_suffix(conn, sfx)?;
            crate::db::voice::set_transcript(conn, recording_id, &text)?;
        }
        Err(e) => {
            crate::db::voice::mark_failed(conn, recording_id, crate::voice_ai::is_auth_error(&e), &e.to_string())?;
        }
    }
    voice_dto(conn, recording_id)
}

#[tauri::command]
pub async fn voice_transcribe(
    state: tauri::State<'_, AppState>,
    recording_id: String,
) -> Result<VoiceRecordingDto, String> {
    let ai = build_ai_client(&state).await.map_err(|e| e.to_string())?;
    let hint = { let conn = state.db.lock().await; ai_language_hint(&conn).map_err(|e| e.to_string())? };
    let language = if hint.trim().is_empty() { None } else { Some(hint.trim().to_string()) };
    let mut conn = state.db.lock().await;
    voice_transcribe_inner(&mut conn, &ai, language.as_deref(), &recording_id)
        .await
        .map_err(|e| e.to_string())
}

pub(crate) async fn voice_tidy_inner(
    conn: &mut Connection,
    ai: &crate::voice_ai::VoiceAiClient,
    model: &str,
    recording_id: Option<&str>,
    raw: &str,
) -> AppResult<TidyDto> {
    if model.trim().is_empty() {
        return Err(crate::error::AppError::Other("tidy model not configured — pick one in Settings".into()));
    }
    let (tidied, sfx) = ai.tidy(model, raw).await?;
    persist_ai_suffix(conn, sfx)?;
    if let Some(id) = recording_id {
        crate::db::voice::set_tidied(conn, id, &tidied)?;
    }
    Ok(TidyDto { tidied })
}

#[tauri::command]
pub async fn voice_tidy(
    state: tauri::State<'_, AppState>,
    recording_id: Option<String>,
    raw: String,
) -> Result<TidyDto, String> {
    let ai = build_ai_client(&state).await.map_err(|e| e.to_string())?;
    let model = { let conn = state.db.lock().await; ai_model(&conn).map_err(|e| e.to_string())? };
    let mut conn = state.db.lock().await;
    voice_tidy_inner(&mut conn, &ai, &model, recording_id.as_deref(), &raw)
        .await
        .map_err(|e| e.to_string())
}

fn voice_list_unsaved_inner(conn: &Connection) -> AppResult<Vec<VoiceRecordingDto>> {
    Ok(crate::db::voice::list_unsaved(conn)?.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn voice_list_unsaved(state: tauri::State<'_, AppState>) -> Result<Vec<VoiceRecordingDto>, String> {
    let conn = state.db.lock().await;
    voice_list_unsaved_inner(&conn).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations, open, outbox};
    use crate::keys::KeyStore as _;
    use rusqlite::Connection;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let c = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&c).unwrap();
        c
    }

    #[tokio::test]
    async fn create_note_enqueues_in_same_transaction() {
        let mut conn = db();
        let note = create_note_inner(&mut conn, "T", "Home").unwrap();
        let stored = notes::get(&conn, &note.id).unwrap().unwrap();
        assert!(stored.dirty);
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].entity_id, note.id);
        assert_eq!(ops[0].op_type, "create");
    }

    #[tokio::test]
    async fn update_note_replaces_content_and_queues_full_copy() {
        let mut conn = db();
        let note = create_note_inner(&mut conn, "T", "Home").unwrap();
        let updated = update_note_inner(&mut conn, &note.id, Some("T2".into()), Some("body".into()), None).unwrap();
        assert_eq!(updated.title, "T2");
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 2);
        let p2: serde_json::Value = serde_json::from_str(&ops[1].payload).unwrap();
        assert_eq!(ops[1].op_type, "update");
        assert_eq!(p2["content"], "body");
    }

    #[tokio::test]
    async fn list_checklists_inner_reports_completion() {
        // web-preference mirror: defaultChecklistFilter completed/incomplete
        // needs per-list completion state on the LIST payload.
        let mut conn = db();
        let done = create_checklist_inner(&mut conn, "Done", "Home").unwrap();
        let open = create_checklist_inner(&mut conn, "Open", "Home").unwrap();
        let di = add_item_inner(&mut conn, &done.id, "d", None).unwrap();
        set_item_checked_inner(&mut conn, &done.id, &di.local_id, true).unwrap();
        add_item_inner(&mut conn, &open.id, "o", None).unwrap();
        let lists = list_checklists_inner(&conn).unwrap();
        let done_dto = lists.iter().find(|l| l.id == done.id).unwrap();
        let open_dto = lists.iter().find(|l| l.id == open.id).unwrap();
        assert!(done_dto.completed, "all items checked -> completed");
        assert!(!open_dto.completed, "open item -> not completed");
    }

    #[tokio::test]
    async fn item_ops_enqueue_with_dependencies() {
        let mut conn = db();
        let list = create_checklist_inner(&mut conn, "L", "Home").unwrap();
        let item = add_item_inner(&mut conn, &list.id, "a", None).unwrap();
        set_item_checked_inner(&mut conn, &list.id, &item.local_id, true).unwrap();
        reorder_items_inner(&mut conn, &list.id, vec![item.local_id.clone()]).unwrap();
        let ops = outbox::next_batch(&conn, 10).unwrap();
        let kinds: Vec<&str> = ops.iter().map(|o| o.op_type.as_str()).collect();
        assert_eq!(kinds, vec!["create", "create", "check", "reorder"]);
    }

    #[tokio::test]
    async fn sync_status_surfaces_oldest_outbox_error() {
        let conn = db();
        // no failures -> clean
        let s = sync_status_inner(&conn, false).unwrap();
        assert!(s.last_error.is_none());
        // two failed ops: the FIFO head (lowest seq) is the reported blocker
        outbox::enqueue(&conn, "update", "note", "n1", &serde_json::json!({})).unwrap();
        outbox::enqueue(&conn, "update", "note", "n2", &serde_json::json!({})).unwrap();
        outbox::record_attempt(&conn, 1, "connection refused").unwrap();
        outbox::record_attempt(&conn, 2, "500 server error").unwrap();
        let s = sync_status_inner(&conn, false).unwrap();
        assert_eq!(s.pending, 2);
        assert_eq!(s.last_error.as_deref(), Some("connection refused"));
    }

    // ---- offline-launch fix: get_connection must report CONFIGURED
    // deterministically from local state, not from the async restore task ----

    #[tokio::test]
    async fn get_connection_reports_configured_before_client_restore() {
        use crate::keys::MockKeyStore;
        let conn = db();
        conn.execute(
            "INSERT INTO sync_state(key,value) VALUES ('instance_url','http://localhost:1122')",
            [],
        ).unwrap();
        let state = AppState::new(conn, Box::new(MockKeyStore::default()), Box::new(MockKeyStore::default())).unwrap();
        state.keystore.set("ck_key").unwrap();
        // client deliberately None: the restore task hasn't rebuilt it yet
        let info = inner_get_connection(&state).await.unwrap();
        let info = info.expect("configured (url row + keystore key) must be Some before the client is restored");
        assert_eq!(info.instance_url, "http://localhost:1122");
        assert!(info.version.is_none());
    }

    #[tokio::test]
    async fn get_connection_none_when_keystore_key_missing() {
        use crate::keys::MockKeyStore;
        let conn = db();
        conn.execute(
            "INSERT INTO sync_state(key,value) VALUES ('instance_url','http://localhost:1122')",
            [],
        ).unwrap();
        let state = AppState::new(conn, Box::new(MockKeyStore::default()), Box::new(MockKeyStore::default())).unwrap();
        // url row but no key: unusable connection -> onboarding stays correct
        assert!(inner_get_connection(&state).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn get_connection_none_when_never_configured() {
        use crate::keys::MockKeyStore;
        let state = AppState::new(db(), Box::new(MockKeyStore::default()), Box::new(MockKeyStore::default())).unwrap();
        state.keystore.set("ck_key").unwrap();
        // key present but no instance_url row: never connected -> None
        assert!(inner_get_connection(&state).await.unwrap().is_none());
    }

    // ---- v0.9.2 offline categories: live fetch first, local derivation fallback ----

    #[tokio::test]
    async fn list_categories_derives_locally_when_client_is_none() {
        use crate::keys::MockKeyStore;
        let mut conn = db();
        create_note_inner(&mut conn, "A", "Work/Projects").unwrap();
        create_note_inner(&mut conn, "B", "Home").unwrap();
        create_checklist_inner(&mut conn, "C", "Home").unwrap();
        let state = AppState::new(conn, Box::new(MockKeyStore::default()), Box::new(MockKeyStore::default())).unwrap();
        // client deliberately None (offline start): the command must still resolve
        let cats = inner_list_categories(&state).await.unwrap();
        let notes: Vec<&str> = cats.notes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(notes, vec!["Home", "Work", "Work/Projects"]);
        let work = cats.notes.iter().find(|n| n.path == "Work").unwrap();
        assert_eq!(work.count, 0);
        let projects = cats.notes.iter().find(|n| n.path == "Work/Projects").unwrap();
        assert_eq!(projects.count, 1);
        let checklists: Vec<&str> = cats.checklists.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(checklists, vec!["Home"]);
    }

    #[tokio::test]
    async fn list_categories_falls_back_to_local_when_live_fetch_fails() {
        use crate::jotty::client::JottyClient;
        use crate::keys::MockKeyStore;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let mut conn = db();
        create_note_inner(&mut conn, "A", "Home").unwrap();
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/categories"))
            .respond_with(wiremock::ResponseTemplate::new(500))
            .mount(&s).await;
        let state = AppState::new(conn, Box::new(MockKeyStore::default()), Box::new(MockKeyStore::default())).unwrap();
        *state.client.write().await = Some(JottyClient::new(&s.uri(), "ck").unwrap());
        // live fetch 500s -> the locally derived tree is served (offline UX)
        let cats = inner_list_categories(&state).await.unwrap();
        let notes: Vec<&str> = cats.notes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(notes, vec!["Home"]);
    }

    #[tokio::test]
    async fn list_categories_prefers_live_server_tree() {
        use crate::jotty::client::JottyClient;
        use crate::keys::MockKeyStore;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let mut conn = db();
        // local row in a category the server tree does NOT report:
        // the live server tree must win untouched
        create_note_inner(&mut conn, "A", "Home").unwrap();
        let state = AppState::new(conn, Box::new(MockKeyStore::default()), Box::new(MockKeyStore::default())).unwrap();
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/categories"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "categories": {
                    "notes": [{"name": "ServerCat", "path": "ServerCat", "count": 7, "level": 0}],
                    "checklists": []
                }
            })))
            .mount(&s).await;
        *state.client.write().await = Some(JottyClient::new(&s.uri(), "ck").unwrap());
        let cats = inner_list_categories(&state).await.unwrap();
        let notes: Vec<&str> = cats.notes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(notes, vec!["ServerCat"]);
        assert_eq!(cats.notes[0].count, 7);
    }

    #[test]
    fn voice_start_no_device_creates_no_partial_state() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        let voice_dir = std::path::Path::new(dir.path()).join("voice");
        std::mem::forget(dir);
        let recorder = crate::audio::VoiceRecorder::default();
        let err = voice_start_recording_inner(
            &conn,
            &voice_dir,
            &recorder,
            || Err("no microphone available".into()),
        ).unwrap_err();
        assert!(err.to_string().contains("no microphone"));
        // nothing created: no staging row, no file, no live session
        assert!(crate::db::voice::list_unsaved(&conn).unwrap().is_empty());
        assert!(recorder.active_id().is_none());
    }

    #[test]
    fn voice_start_stream_build_failure_cleans_up_row_and_file() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        let voice_dir = std::path::Path::new(dir.path()).join("voice");
        std::mem::forget(dir);
        let recorder = crate::audio::VoiceRecorder::default();
        let prepared = crate::audio::PreparedInput {
            config: cpal::StreamConfig {
                channels: 1,
                sample_rate: 48_000,
                buffer_size: cpal::BufferSize::Default,
            },
            sample_format: cpal::SampleFormat::F32,
            build: Box::new(|_tx| Err("open mic stream: boom".into())),
        };
        let err = voice_start_recording_inner(&conn, &voice_dir, &recorder, || Ok(prepared)).unwrap_err();
        assert!(err.to_string().contains("boom"));
        let rows = crate::db::voice::list_unsaved(&conn).unwrap();
        let _ = rows; // row deleted below; also assert no file survived
        let files: Vec<_> = std::fs::read_dir(&voice_dir)
            .map(|rd| rd.filter_map(Result::ok).collect())
            .unwrap_or_default();
        assert!(files.is_empty(), "wav must be cleaned up");
        assert!(recorder.active_id().is_none());
        // the staging row was deleted too (list_unsaved excludes 'recording', so query directly)
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM voice_recordings", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn voice_stop_without_session_errors() {
        let conn = db();
        let recorder = crate::audio::VoiceRecorder::default();
        let err = voice_stop_recording_inner(&conn, &recorder).unwrap_err();
        assert!(err.to_string().contains("not recording"));
    }

    #[test]
    fn voice_delete_removes_row_and_file_and_stops_active_session() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("r.wav");
        std::mem::forget(dir);
        std::fs::write(&path, b"fake").unwrap();
        crate::db::voice::create_staging(&conn, "r1", path.to_string_lossy().as_ref()).unwrap();
        let recorder = crate::audio::VoiceRecorder::default();
        voice_delete_recording_inner(&conn, &recorder, "r1").unwrap();
        assert!(crate::db::voice::get(&conn, "r1").unwrap().is_none());
        assert!(!path.exists());
        // unknown id: no-op, no error
        voice_delete_recording_inner(&conn, &recorder, "gone").unwrap();
    }

    #[test]
    fn voice_recording_dto_serializes_camel_case() {
        let dto = crate::commands::dto::VoiceRecordingDto {
            id: "r1".into(),
            path: "/tmp/r1.wav".into(),
            duration_secs: 12.5,
            raw_transcript: Some("hi".into()),
            tidied_transcript: None,
            state: "transcribed".into(),
            last_error: None,
            created_at: "2026-09-18T00:00:00+00:00".into(),
        };
        let v = serde_json::to_value(&dto).unwrap();
        assert!(v.get("durationSecs").is_some());
        assert!(v.get("rawTranscript").is_some());
        assert!(v.get("tidiedTranscript").is_some());
        assert!(v.get("lastError").is_some());
        assert!(v.get("createdAt").is_some());
        assert!(v.get("duration_secs").is_none());
    }

    #[test]
    fn get_ai_settings_defaults_are_empty_and_unkeyed() {
        let conn = db();
        let ks = crate::keys::MockKeyStore::default();
        let s = get_ai_settings_inner(&conn, &ks).unwrap();
        assert_eq!(s.base_url, "");
        assert_eq!(s.model, "");
        assert_eq!(s.language_hint, "");
        assert_eq!(s.api_path_suffix, "v1");
        assert!(!s.has_key);
    }

    #[test]
    fn set_ai_settings_stores_prefs_and_key_round_trip() {
        let conn = db();
        let ks = crate::keys::MockKeyStore::default();
        let s = set_ai_settings_inner(
            &conn, &ks,
            Some("https://ai.example.com".into()),
            Some("llama3".into()),
            Some("en".into()),
            Some("sk-abc".into()),
        ).unwrap();
        assert_eq!(s.base_url, "https://ai.example.com");
        assert_eq!(s.model, "llama3");
        assert_eq!(s.language_hint, "en");
        assert!(s.has_key);
        assert_eq!(ks.get().unwrap().as_deref(), Some("sk-abc"));
        // empty key clears the keyring entry
        let s2 = set_ai_settings_inner(&conn, &ks, None, None, None, Some("".into())).unwrap();
        assert!(!s2.has_key);
        assert_eq!(ks.get().unwrap(), None);
    }

    #[test]
    fn set_ai_settings_rejects_non_local_http() {
        let conn = db();
        let ks = crate::keys::MockKeyStore::default();
        let err = set_ai_settings_inner(&conn, &ks, Some("http://example.com".into()), None, None, None).unwrap_err();
        assert!(err.to_string().contains("https"));
        // nothing persisted
        assert_eq!(ai_base_url(&conn).unwrap(), "");
    }

    #[test]
    fn ai_suffix_defaults_to_v1_and_persists_effective() {
        let conn = db();
        assert_eq!(ai_suffix(&conn).unwrap(), crate::voice_ai::Suffix::V1);
        persist_ai_suffix(&conn, crate::voice_ai::Suffix::Plain).unwrap();
        assert_eq!(ai_suffix(&conn).unwrap(), crate::voice_ai::Suffix::Plain);
        persist_ai_suffix(&conn, crate::voice_ai::Suffix::Plain).unwrap(); // idempotent
        let v: String = conn.query_row("SELECT value FROM sync_state WHERE key='ai_api_suffix'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "plain");
    }

    #[tokio::test]
    async fn ai_models_core_returns_models_and_persists_fallback_suffix() {
        let s = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/api/v1/models"))
            .respond_with(wiremock::ResponseTemplate::new(404))
            .mount(&s).await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/api/models"))
            .respond_with(wiremock::ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"data": [{"id": "m1"}]})))
            .mount(&s).await;
        let conn = tokio::sync::Mutex::new(db());
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk", crate::voice_ai::Suffix::V1).unwrap();
        let models = ai_models_core(&ai, &conn).await.unwrap();
        assert_eq!(models, vec!["m1"]);
        let g = conn.lock().await;
        assert_eq!(ai_suffix(&g).unwrap(), crate::voice_ai::Suffix::Plain);
    }

    #[test]
    fn app_state_holds_two_keystores() {
        let conn = db();
        let state = AppState::new(conn, Box::new(crate::keys::MockKeyStore::default()), Box::new(crate::keys::MockKeyStore::default())).unwrap();
        state.ai_keystore.set("sk-1").unwrap();
        state.keystore.set("ck-1").unwrap();
        assert_eq!(state.ai_keystore.get().unwrap().as_deref(), Some("sk-1"));
        assert_eq!(state.keystore.get().unwrap().as_deref(), Some("ck-1"));
    }

    // ---- Task 6: transcribe + tidy commands (state machine) + list_unsaved ----

    fn staged(conn: &Connection, id: &str, _state: &str, raw: Option<&str>, tidied: Option<&str>) {
        crate::db::voice::create_staging(conn, id, "/tmp/t.wav").unwrap();
        if let Some(r) = raw { crate::db::voice::set_transcript(conn, id, r).unwrap(); }
        if let Some(t) = tidied { crate::db::voice::set_tidied(conn, id, t).unwrap(); }
    }

    fn ai_mock_ok_text() -> crate::voice_ai::VoiceAiClient {
        // unreachable endpoint (port 1): failure-path tests use this client;
        // success-path tests build their own against a live MockServer
        crate::voice_ai::VoiceAiClient::new("http://127.0.0.1:1", "sk", crate::voice_ai::Suffix::V1).unwrap()
    }

    #[tokio::test]
    async fn transcribe_success_sets_transcribed_with_raw() {
        let s = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/v1/audio/transcriptions"))
            .respond_with(wiremock::ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"text": "the transcript", "filename": "x.wav"})))
            .mount(&s).await;
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("t.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let mut conn = db();
        crate::db::voice::create_staging(&conn, "r1", wav.to_string_lossy().as_ref()).unwrap();
        crate::db::voice::mark_recorded(&conn, "r1", 2.0).unwrap();
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk", crate::voice_ai::Suffix::V1).unwrap();
        let dto = voice_transcribe_inner(&mut conn, &ai, None, "r1").await.unwrap();
        assert_eq!(dto.state, crate::db::voice::ST_TRANSCRIBED);
        assert_eq!(dto.raw_transcript.as_deref(), Some("the transcript"));
        assert!(dto.last_error.is_none());
    }

    #[tokio::test]
    async fn transcribe_500_marks_retryable_failed_with_error_text() {
        let s = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/v1/audio/transcriptions"))
            .respond_with(wiremock::ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&s).await;
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("t.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let mut conn = db();
        crate::db::voice::create_staging(&conn, "r1", wav.to_string_lossy().as_ref()).unwrap();
        crate::db::voice::mark_recorded(&conn, "r1", 2.0).unwrap();
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk", crate::voice_ai::Suffix::V1).unwrap();
        let dto = voice_transcribe_inner(&mut conn, &ai, None, "r1").await.unwrap(); // Ok(dto), failed state
        assert_eq!(dto.state, crate::db::voice::ST_FAILED);
        assert!(dto.last_error.as_deref().unwrap().contains("boom"));
    }

    #[tokio::test]
    async fn transcribe_401_marks_failed_auth_distinctly() {
        let s = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/v1/audio/transcriptions"))
            .respond_with(wiremock::ResponseTemplate::new(401).set_body_string("bad key"))
            .mount(&s).await;
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("t.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let mut conn = db();
        crate::db::voice::create_staging(&conn, "r1", wav.to_string_lossy().as_ref()).unwrap();
        crate::db::voice::mark_recorded(&conn, "r1", 2.0).unwrap();
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk", crate::voice_ai::Suffix::V1).unwrap();
        let dto = voice_transcribe_inner(&mut conn, &ai, None, "r1").await.unwrap();
        assert_eq!(dto.state, crate::db::voice::ST_FAILED_AUTH);
        // retry hook only picks up ST_FAILED — this row is excluded there
        assert!(crate::db::voice::list_failed(&conn).unwrap().is_empty());
    }

    #[tokio::test]
    async fn transcribe_fallback_persists_plain_suffix() {
        let s = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/v1/audio/transcriptions"))
            .respond_with(wiremock::ResponseTemplate::new(404)).mount(&s).await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/audio/transcriptions"))
            .respond_with(wiremock::ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"text": "via plain", "filename": "x.wav"})))
            .mount(&s).await;
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("t.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let mut conn = db();
        crate::db::voice::create_staging(&conn, "r1", wav.to_string_lossy().as_ref()).unwrap();
        crate::db::voice::mark_recorded(&conn, "r1", 2.0).unwrap();
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk", crate::voice_ai::Suffix::V1).unwrap();
        voice_transcribe_inner(&mut conn, &ai, None, "r1").await.unwrap();
        assert_eq!(ai_suffix(&conn).unwrap(), crate::voice_ai::Suffix::Plain);
    }

    #[tokio::test]
    async fn transcribe_while_recording_is_rejected_and_transcribed_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("t.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let mut conn = db();
        let ai = ai_mock_ok_text();
        crate::db::voice::create_staging(&conn, "r1", wav.to_string_lossy().as_ref()).unwrap();
        assert!(voice_transcribe_inner(&mut conn, &ai, None, "r1").await.is_err(), "still recording");
        crate::db::voice::mark_recorded(&conn, "r1", 1.0).unwrap();
        crate::db::voice::set_transcript(&conn, "r1", "done").unwrap();
        let dto = voice_transcribe_inner(&mut conn, &ai, None, "r1").await.unwrap();
        assert_eq!(dto.state, crate::db::voice::ST_TRANSCRIBED); // no second request (no server running)
    }

    #[tokio::test]
    async fn tidy_persists_to_row_only_when_id_given() {
        let s = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/v1/chat/completions"))
            .respond_with(wiremock::ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"choices": [{"message": {"content": "Tidied."}}]})))
            .mount(&s).await;
        let mut conn = db();
        staged(&conn, "r1", crate::db::voice::ST_TRANSCRIBED, Some("raw"), None);
        kv_set(&conn, "ai_model", "llama3").unwrap();
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk", crate::voice_ai::Suffix::V1).unwrap();
        let dto = voice_tidy_inner(&mut conn, &ai, "llama3", Some("r1"), "raw").await.unwrap();
        assert_eq!(dto.tidied, "Tidied.");
        assert_eq!(crate::db::voice::get(&conn, "r1").unwrap().unwrap().tidied_transcript.as_deref(), Some("Tidied."));
        // raw untouched
        assert_eq!(crate::db::voice::get(&conn, "r1").unwrap().unwrap().raw_transcript.as_deref(), Some("raw"));
        // no id: returned only, nothing persisted
        let dto2 = voice_tidy_inner(&mut conn, &ai, "llama3", None, "raw2").await.unwrap();
        assert_eq!(dto2.tidied, "Tidied.");
        assert!(crate::db::voice::list_unsaved(&conn).unwrap().iter().all(|r| r.tidied_transcript.is_none() || r.id != "r9"));
    }

    #[tokio::test]
    async fn tidy_failure_returns_err_and_leaves_row_untouched() {
        let mut conn = db();
        staged(&conn, "r1", crate::db::voice::ST_TRANSCRIBED, Some("raw"), None);
        let ai = ai_mock_ok_text(); // unreachable server
        assert!(voice_tidy_inner(&mut conn, &ai, "llama3", Some("r1"), "raw").await.is_err());
        assert!(crate::db::voice::get(&conn, "r1").unwrap().unwrap().tidied_transcript.is_none());
    }

    #[tokio::test]
    async fn tidy_requires_a_model() {
        let mut conn = db();
        let ai = ai_mock_ok_text();
        assert!(voice_tidy_inner(&mut conn, &ai, "", None, "raw").await.is_err());
    }

    #[test]
    fn list_unsaved_maps_rows_to_dtos() {
        let conn = db();
        staged(&conn, "r1", crate::db::voice::ST_TRANSCRIBED, Some("raw"), Some("tid"));
        let rows = voice_list_unsaved_inner(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "r1");
        assert_eq!(rows[0].state, crate::db::voice::ST_TRANSCRIBED);
    }
}
