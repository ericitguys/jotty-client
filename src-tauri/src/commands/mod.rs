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
    CategoriesDto, ChecklistDto, ConflictDto, ConnectInfo, ItemDto, ListHit, NoteDto, NoteHit,
    SearchResultsDto, SettingsDto, SyncReportDto, SyncStatusDto,
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
pub(crate) async fn inner_get_connection(state: &AppState) -> AppResult<Option<ConnectInfo>> {
    let connected = state.client.read().await.is_some();
    if !connected {
        return Ok(None);
    }
    let conn = state.db.lock().await;
    let url: Option<String> = conn
        .query_row("SELECT value FROM sync_state WHERE key='instance_url'", [], |r| r.get(0))
        .optional()?;
    Ok(url.map(|u| ConnectInfo { instance_url: u, version: None }))
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
#[tauri::command]
pub async fn list_categories(state: tauri::State<'_, AppState>) -> Result<CategoriesDto, String> {
    let Some(client) = state.client.read().await.clone() else {
        return Err(AppError::NotConnected.to_string());
    };
    let cats = client.get_categories().await.map_err(|e| e.to_string())?;
    Ok(CategoriesDto::from(cats))
}

#[tauri::command]
pub async fn get_prefs(state: tauri::State<'_, AppState>) -> Result<crate::jotty::models::UserPrefs, String> {
    let Some(client) = state.client.read().await.clone() else {
        return Err(AppError::NotConnected.to_string());
    };
    client.get_user_prefs().await.map_err(|e| e.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations, open, outbox};
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
}
