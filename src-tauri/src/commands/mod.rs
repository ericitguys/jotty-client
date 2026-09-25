//! Tauri command layer (Task 14): thin async command shells + pure `*_inner`
//! fns testable without Tauri. Every mutation writes the entity and enqueues
//! the outbox op inside ONE `conn.transaction()`.
pub mod dto;

use tauri::Manager;
use crate::db::{board, checklists, items, notes, outbox};
use crate::error::{AppError, AppResult};
use crate::jotty::client::JottyClient;
use crate::state::AppState;
use dto::{
    AiSettingsDto, BoardDto, BoardStatusDto, CategoriesDto, ChecklistDto, ConflictDto, ConnectInfo,
    ItemDto, ListHit, NoteDto, NoteHit, NoteTranscribeDto, SearchResultsDto, SettingsDto,
    SyncReportDto, SyncStatusDto, TidyDto, VoiceRecordingDto,
};
use rusqlite::Connection;
use rusqlite::OptionalExtension;

// ---- notes ----

pub(crate) fn create_note_inner(conn: &mut Connection, title: &str, category: &str) -> AppResult<NoteDto> {
    let tx = conn.transaction()?;
    let row = create_note_tx(&tx, title, "", category)?;
    tx.commit()?;
    Ok(NoteDto::from(row))
}

/// Single source of truth for note creation (entity + outbox create op with
/// temp_id). Used by create_note_inner and voice_save_note so the sync
/// invariants stay untouched (spec §5). BEHAVIOR-IDENTICAL refactor.
pub(crate) fn create_note_tx(
    tx: &rusqlite::Transaction,
    title: &str,
    content: &str,
    category: &str,
) -> AppResult<crate::db::notes::NoteRow> {
    let row = notes::insert_local(tx, &notes::NewNote {
        title: title.into(),
        content: content.into(),
        category: category.into(),
    })?;
    // Ruling E: note create payload = {temp_id (REQUIRED — push remaps via it), title, content, category}.
    outbox::enqueue(tx, "create", "note", &row.id, &serde_json::json!({
        "temp_id": &row.id, "title": &row.title, "content": &row.content, "category": &row.category
    }))?;
    Ok(row)
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
    status: Option<String>,
    target_date: Option<String>,
) -> AppResult<ItemDto> {
    let tx = conn.transaction()?;
    let row = items::insert_local(&tx, &items::NewItem {
        checklist_id: checklist_id.into(),
        parent_local_id: parent_local_id.clone(),
        text: text.into(),
        status: status.clone(),
        priority: None,
        target_date: target_date.clone(),
    })?;
    // Ruling D: create → {checklist_id, item_local_id, text, parent_local_id: opt}
    // (NO temp_local_id key — push.rs never reads it). Kanban cards add "status"
    // ONLY when Some: the plain-list payload stays byte-identical (pinned by tests).
    // targetDate is NOT in the create payload — upstream POST takes no date; the
    // adjacent set_date op (below) PATCHes it after the create replays.
    let mut payload = serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": &row.local_id, "text": &row.text,
        "parent_local_id": parent_local_id.as_deref()
    });
    if let Some(st) = &status { payload["status"] = serde_json::json!(st); }
    outbox::enqueue(&tx, "create", "checklist_item", &row.local_id, &payload)?;
    if let Some(d) = &target_date {
        // FIFO-adjacent: the create replays first, then the date lands on the
        // prepended card (upstream createItem inserts at index 0 — the fresh
        // snapshot's first text match IS the new card).
        outbox::enqueue(&tx, "set_date", "checklist_item", &row.local_id, &serde_json::json!({
            "checklist_id": checklist_id, "item_local_id": &row.local_id, "targetDate": d
        }))?;
    }
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

/// Kanban card move (Task 3): mirrors the server's applyStatus with the board's
/// cached columns. autoComplete comes from the CACHE; an empty cache (board never
/// opened) mirrors the server's statuses=null semantics -> target is non-auto.
/// One tx: row status/completed + the "status" outbox op (its payload shape is
/// what Task 4's push arm replays against PUT /api/tasks/{id}/items/{path}/status).
pub(crate) fn set_item_status_inner(
    conn: &mut Connection,
    checklist_id: &str,
    item_local_id: &str,
    new_status: &str,
) -> AppResult<()> {
    let tx = conn.transaction()?;
    let cache = board::list(&tx, checklist_id)?;
    let target_auto = cache.iter().find(|s| s.status_id == new_status).map(|s| s.auto_complete).unwrap_or(false);
    let prev = items::get(&tx, item_local_id)?
        .ok_or_else(|| AppError::Other(format!("item {item_local_id} not found")))?;
    let changed = prev.status.as_deref() != Some(new_status);
    items::set_status(&tx, item_local_id, Some(new_status.to_string()), target_auto, changed)?;
    if target_auto {
        items::set_completed_recursive(&tx, item_local_id, true)?;
    }
    // Ruling D shape: op_type = "status", entity = "checklist_item", entity_id = item local_id
    outbox::enqueue(&tx, "status", "checklist_item", item_local_id, &serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": item_local_id, "status": new_status
    }))?;
    tx.commit()?;
    Ok(())
}

/// Kanban card date (appointments): set/clear target_date + enqueue the
/// "set_date" op. One tx (invariant 1). Payload carries camelCase targetDate —
/// the shape push.rs replays against PATCH /api/checklists/{id}/items/{path}
/// (string = set, null = clear).
pub(crate) fn set_item_target_date_inner(
    conn: &mut Connection,
    checklist_id: &str,
    item_local_id: &str,
    target_date: Option<String>,
) -> AppResult<()> {
    let tx = conn.transaction()?;
    items::set_target_date(&tx, item_local_id, target_date.clone())?;
    outbox::enqueue(&tx, "set_date", "checklist_item", item_local_id, &serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": item_local_id, "targetDate": target_date
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

// ---- kanban boards (Task 3): column cache mirror + board fetch/create ----

/// Board columns for the frontend: the board_statuses cache when present, else
/// the site's 4-column default set (spec §6 offline fallback — the site renders
/// defaults for statuses=null, so an uncached board must show defaults too).
pub(crate) fn board_dto_from_cache(conn: &Connection, checklist_id: &str) -> BoardDto {
    let cached = board::list(conn, checklist_id).unwrap_or_default();
    let statuses: Vec<BoardStatusDto> = if cached.is_empty() {
        crate::jotty::models::render_default_statuses().into_iter().map(BoardStatusDto::from).collect()
    } else {
        cached.into_iter().map(BoardStatusDto::from).collect()
    };
    BoardDto { checklist_id: checklist_id.into(), statuses }
}

pub(crate) async fn fetch_task_board_inner(state: &AppState, checklist_id: &str) -> AppResult<BoardDto> {
    let client = state.client.read().await.clone()
        .ok_or_else(|| AppError::Other("not connected".into()))?;
    match client.get_task(checklist_id).await {
        Ok(task) => {
            let conn = state.db.lock().await;
            let server_statuses = task.statuses.unwrap_or_default();
            if server_statuses.is_empty() {
                // statuses null server-side -> the site renders the default set;
                // CLEAR the cache so the default fallback applies (spec §6).
                board::replace_cache(&conn, checklist_id, &[])?;
                Ok(BoardDto { checklist_id: checklist_id.into(),
                    statuses: crate::jotty::models::render_default_statuses().into_iter().map(BoardStatusDto::from).collect() })
            } else {
                let tuples: Vec<board::StatusTuple> = server_statuses.iter()
                    .map(|s| (s.id.as_str(), s.label.as_str(), s.color.as_deref(), s.order, s.auto_complete))
                    .collect();
                board::replace_cache(&conn, checklist_id, &tuples)?;
                Ok(BoardDto { checklist_id: checklist_id.into(),
                    statuses: server_statuses.into_iter().map(BoardStatusDto::from).collect() })
            }
        }
        // 404 (old instance / non-kanban list) and ANY network error: silent cache
        // keep — the board view must still show the last-known columns offline.
        Err(_) => {
            let conn = state.db.lock().await;
            Ok(board_dto_from_cache(&conn, checklist_id))
        }
    }
}

pub(crate) async fn get_board_columns_inner(state: &AppState, checklist_id: &str) -> AppResult<BoardDto> {
    let conn = state.db.lock().await;
    Ok(board_dto_from_cache(&conn, checklist_id))
}

pub(crate) async fn create_task_board_inner(state: &AppState, title: &str, category: &str) -> AppResult<ChecklistDto> {
    let client = state.client.read().await.clone()
        .ok_or_else(|| AppError::Other("not connected".into()))?;
    // Live creation (ruling 3): the plain checklist create endpoint cannot carry statuses.
    let mut created = client.create_task(title, category, &crate::jotty::models::creation_board_statuses()).await?;
    // We created it via the kanban creation endpoint, so the type is known —
    // upstream POST /api/tasks responses carry no "type" field to parse it
    // from, and the idempotent upsert would pin "regular" forever.
    created.list_type = Some("kanban".into());
    {
        let mut conn = state.db.lock().await;
        // Bring it local before returning (T14 precedent: the command holds the
        // guard across awaits). Pull errors surface — the board exists server-side
        // and the next sync will fetch it; refreshAll covers the UI either way.
        crate::sync::pull::pull_all(&mut conn, &client).await?;
        // The catalog pull_all just consumed may not yet carry the just-created
        // board (a lagging catalog — and the test's empty mocks) — upsert it from
        // the POST response directly. Idempotent when the pull already brought it
        // (upsert skips clean rows whose updated_at already matches the server's).
        checklists::upsert_list_from_server(&conn, &created)?;
    }
    let conn = state.db.lock().await;
    let row = checklists::get_checklist(&conn, &created.id)?
        .ok_or_else(|| AppError::Other("created board absent after pull".into()))?;
    Ok(ChecklistDto::from(row))
}

#[tauri::command]
pub async fn fetch_task_board(state: tauri::State<'_, AppState>, checklist_id: String) -> Result<BoardDto, String> {
    fetch_task_board_inner(&state, &checklist_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_board_columns(state: tauri::State<'_, AppState>, checklist_id: String) -> Result<BoardDto, String> {
    get_board_columns_inner(&state, &checklist_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_task_board(state: tauri::State<'_, AppState>, title: String, category: String) -> Result<ChecklistDto, String> {
    create_task_board_inner(&state, &title, &category).await.map_err(|e| e.to_string())
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
    status: Option<String>,
    target_date: Option<String>,
) -> Result<ItemDto, String> {
    let mut conn = state.db.lock().await;
    add_item_inner(&mut conn, &checklist_id, &text, parent_local_id, status, target_date).map_err(|e| e.to_string())
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
pub async fn set_item_status(
    state: tauri::State<'_, AppState>,
    checklist_id: String,
    item_local_id: String,
    status: String,
) -> Result<(), String> {
    let mut conn = state.db.lock().await;
    set_item_status_inner(&mut conn, &checklist_id, &item_local_id, &status).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_item_target_date(
    state: tauri::State<'_, AppState>,
    checklist_id: String,
    item_local_id: String,
    target_date: Option<String>,
) -> Result<(), String> {
    let mut conn = state.db.lock().await;
    set_item_target_date_inner(&mut conn, &checklist_id, &item_local_id, target_date).map_err(|e| e.to_string())
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
    Ok(crate::commands::dto::BrandingDto { name: data.name, icon_data_url: data.icon_data_url, theme_color: data.theme_color })
}

fn best_effort_set_icon(app: &tauri::AppHandle, bytes: &[u8]) {
    // Android: WebviewWindow::set_icon doesn't exist in the mobile runtime —
    // skip entirely (the OS draws the app icon from the launcher resources).
    #[cfg(target_os = "android")]
    let _ = (app, bytes);
    #[cfg(not(target_os = "android"))]
    {
        use tauri::Manager as _;
        // Best-effort by design: undecodable bytes (e.g. svg) or a missing window
        // must never fail the branding command — the sidebar icon still mirrors.
        if let Ok(img) = tauri::image::Image::from_bytes(bytes) {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_icon(img);
            }
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
    // Android previews ship as prereleases, which /releases/latest excludes —
    // the android path walks the releases list and offers the newest APK.
    #[cfg(target_os = "android")]
    return crate::updater::check_apk("https://api.github.com", current).await;
    #[cfg(not(target_os = "android"))]
    crate::updater::check("https://api.github.com", current).await
}

/// Android guided update: hand the APK download URL to the system browser /
/// Download Manager; the user installs from the downloaded APK via the system
/// installer prompt. (No silent self-install exists on Android by design.)
#[tauri::command]
pub async fn open_update_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt as _;
    if !url.starts_with("https://") {
        return Err(format!("refusing to open non-https url: {url}"));
    }
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("cannot open download page: {e}"))
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

/// Re-attach to an already-live recording session (field report 2026-09-25):
/// returns the active staging row so the overlay can resume Stop/Cancel
/// control of it. A session whose row is gone or no longer 'recording' is an
/// inconsistent state — refuse rather than silently double-start.
fn attach_to_active(conn: &Connection, active_id: &str) -> AppResult<VoiceRecordingDto> {
    match crate::db::voice::get(conn, active_id) {
        Ok(Some(row)) if row.state == crate::db::voice::ST_RECORDING => Ok(row.into()),
        _ => Err(crate::error::AppError::Other(
            "a recording is already active".into(),
        )),
    }
}

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
    // Re-attach (field report 2026-09-25): dismissing the overlay mid-recording
    // leaves the live session running with its staging row in 'recording'. A
    // second start must return the ACTIVE recording so the user can get back
    // into it (Stop → review) or cancel it — never a dead-end error.
    if let Some(active) = recorder.active_id() {
        return attach_to_active(conn, &active);
    }
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

/// Unlike voice_tidy (which holds the db lock across the network await because
/// it writes the recording row), extraction writes no table: the lock is
/// dropped before the await and the effective suffix from the returned pair is
/// persisted under a fresh scoped lock afterwards (ai_models_core shape).
pub(crate) async fn voice_extract_tasks_inner(
    ai: &crate::voice_ai::VoiceAiClient,
    model: &str,
    text: &str,
) -> AppResult<(Vec<String>, crate::voice_ai::Suffix)> {
    if model.trim().is_empty() {
        return Err(crate::error::AppError::Other(
            "AI model not configured — pick one in Settings".into(),
        ));
    }
    ai.extract_tasks(model, text).await
}

#[tauri::command]
pub async fn voice_extract_tasks(
    state: tauri::State<'_, AppState>,
    text: String,
) -> Result<Vec<String>, String> {
    let ai = build_ai_client(&state).await.map_err(|e| e.to_string())?;
    let model = { let conn = state.db.lock().await; ai_model(&conn).map_err(|e| e.to_string())? };
    let (tasks, sfx) = voice_extract_tasks_inner(&ai, &model, &text).await.map_err(|e| e.to_string())?;
    {
        let conn = state.db.lock().await;
        persist_ai_suffix(&conn, sfx).map_err(|e| e.to_string())?;
    }
    Ok(tasks)
}

fn voice_list_unsaved_inner(conn: &Connection) -> AppResult<Vec<VoiceRecordingDto>> {
    Ok(crate::db::voice::list_unsaved(conn)?.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn voice_list_unsaved(state: tauri::State<'_, AppState>) -> Result<Vec<VoiceRecordingDto>, String> {
    let conn = state.db.lock().await;
    voice_list_unsaved_inner(&conn).map_err(|e| e.to_string())
}

pub(crate) fn voice_save_note_inner(
    conn: &mut Connection,
    recording_id: &str,
    title: &str,
    category: &str,
    use_tidied: bool,
    content_override: Option<String>,
) -> AppResult<NoteDto> {
    let tx = conn.transaction()?;
    let rec = crate::db::voice::get(&tx, recording_id)?
        .ok_or_else(|| crate::error::AppError::Other(format!("recording {recording_id} not found")))?;
    if rec.state == crate::db::voice::ST_RECORDING {
        return Err(crate::error::AppError::Other("recording still in progress".into()));
    }
    // Content = tidied if useTidied && exists, else raw (spec §6); an explicit
    // override (review/edit -> save, spec §2) wins over both (plan ruling 3).
    let content = content_override.unwrap_or_else(|| {
        if use_tidied {
            rec.tidied_transcript.clone().unwrap_or_else(|| rec.raw_transcript.clone().unwrap_or_default())
        } else {
            rec.raw_transcript.clone().unwrap_or_default()
        }
    });
    let row = create_note_tx(&tx, title, &content, category)?;
    tx.execute(
        "UPDATE notes SET audio_path=?2, audio_duration_secs=?3 WHERE id=?1",
        rusqlite::params![row.id, rec.path, rec.duration_secs],
    )?;
    crate::db::voice::delete_staging(&tx, recording_id)?;
    tx.commit()?;
    // re-read so the DTO carries the audio columns
    let saved = crate::db::notes::get(conn, &row.id)?
        .ok_or_else(|| crate::error::AppError::Other("saved note vanished".into()))?;
    Ok(NoteDto::from(saved))
}

#[tauri::command]
pub async fn voice_save_note(
    state: tauri::State<'_, AppState>,
    recording_id: String,
    title: String,
    category: String,
    use_tidied: bool,
    content_override: Option<String>,
) -> Result<NoteDto, String> {
    let mut conn = state.db.lock().await;
    voice_save_note_inner(&mut conn, &recording_id, &title, &category, use_tidied, content_override)
        .map_err(|e| e.to_string())
}

pub(crate) async fn voice_transcribe_note_inner(
    conn: &mut Connection,
    ai: &crate::voice_ai::VoiceAiClient,
    language: Option<&str>,
    note_id: &str,
) -> AppResult<NoteTranscribeDto> {
    let note = crate::db::notes::get(conn, note_id)?
        .ok_or_else(|| crate::error::AppError::Other(format!("note {note_id} not found")))?;
    let path = note
        .audio_path
        .ok_or_else(|| crate::error::AppError::Other("note has no audio recording".into()))?;
    let (text, sfx) = ai.transcribe(std::path::Path::new(&path), language).await?;
    persist_ai_suffix(conn, sfx)?;
    Ok(NoteTranscribeDto { text })
}

#[tauri::command]
pub async fn voice_transcribe_note(
    state: tauri::State<'_, AppState>,
    note_id: String,
) -> Result<NoteTranscribeDto, String> {
    let ai = build_ai_client(&state).await.map_err(|e| e.to_string())?;
    let hint = { let conn = state.db.lock().await; ai_language_hint(&conn).map_err(|e| e.to_string())? };
    let language = if hint.trim().is_empty() { None } else { Some(hint.trim().to_string()) };
    let mut conn = state.db.lock().await;
    voice_transcribe_note_inner(&mut conn, &ai, language.as_deref(), &note_id)
        .await
        .map_err(|e| e.to_string())
}

pub(crate) fn voice_delete_note_audio_inner(conn: &mut Connection, note_id: &str) -> AppResult<NoteDto> {
    let note = crate::db::notes::get(conn, note_id)?
        .ok_or_else(|| crate::error::AppError::Other(format!("note {note_id} not found")))?;
    if let Some(p) = &note.audio_path {
        let _ = std::fs::remove_file(p); // best-effort
    }
    // LOCAL-ONLY metadata: no dirty flag, NO outbox op — sync must never see it
    conn.execute(
        "UPDATE notes SET audio_path=NULL, audio_duration_secs=NULL WHERE id=?1",
        [note_id],
    )?;
    let updated = crate::db::notes::get(conn, note_id)?
        .ok_or_else(|| crate::error::AppError::Other("note vanished".into()))?;
    Ok(NoteDto::from(updated))
}

#[tauri::command]
pub async fn voice_delete_note_audio(
    state: tauri::State<'_, AppState>,
    note_id: String,
) -> Result<NoteDto, String> {
    let mut conn = state.db.lock().await;
    voice_delete_note_audio_inner(&mut conn, &note_id).map_err(|e| e.to_string())
}

/// Desktop launcher branding (Linux): the packaged menu entry
/// (/usr/share/applications/jotty-desktop.desktop) can be shadowed by a
/// user-level file with the same desktop-file id (XDG precedence) carrying the
/// server's name + icon. Android has no equivalent — launcher icon/label are
/// compiled APK resources; those commands report supported=false there.
#[tauri::command]
pub fn branding_desktop_status() -> Result<crate::desktop_branding::BrandingDesktopStatus, String> {
    if cfg!(target_os = "android") {
        return Ok(crate::desktop_branding::BrandingDesktopStatus { supported: false, active: false });
    }
    let Some(data_dir) = crate::desktop_branding::xdg_data_home() else {
        return Ok(crate::desktop_branding::BrandingDesktopStatus { supported: false, active: false });
    };
    Ok(crate::desktop_branding::status_inner(&data_dir))
}

#[tauri::command]
pub fn branding_desktop_apply(
    name: Option<String>,
    icon_data_url: Option<String>,
) -> Result<String, String> {
    if cfg!(target_os = "android") {
        return Err("launcher branding is desktop-only (Android locks the launcher icon)".into());
    }
    let data_dir = crate::desktop_branding::xdg_data_home().ok_or("no home directory")?;
    let packaged_paths = vec![
        std::path::PathBuf::from("/usr/share/applications/jotty-desktop.desktop"),
        std::path::PathBuf::from("/usr/local/share/applications/jotty-desktop.desktop"),
    ];
    let path = crate::desktop_branding::apply_inner(&data_dir, &packaged_paths, name.as_deref(), icon_data_url.as_deref())?;
    // Best effort menu refresh; menus also watch the dirs themselves.
    let _ = std::process::Command::new("update-desktop-database")
        .arg(data_dir.join("applications"))
        .spawn();
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn branding_desktop_remove() -> Result<(), String> {
    if cfg!(target_os = "android") {
        return Err("launcher branding is desktop-only".into());
    }
    let data_dir = crate::desktop_branding::xdg_data_home().ok_or("no home directory")?;
    crate::desktop_branding::remove_inner(&data_dir)?;
    let _ = std::process::Command::new("update-desktop-database")
        .arg(data_dir.join("applications"))
        .spawn();
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{board, migrations, open, outbox};
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
        let di = add_item_inner(&mut conn, &done.id, "d", None, None, None).unwrap();
        set_item_checked_inner(&mut conn, &done.id, &di.local_id, true).unwrap();
        add_item_inner(&mut conn, &open.id, "o", None, None, None).unwrap();
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
        let item = add_item_inner(&mut conn, &list.id, "a", None, None, None).unwrap();
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
    fn voice_start_while_active_returns_active_row() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        let voice_dir = std::path::Path::new(dir.path()).join("voice");
        std::mem::forget(dir);
        // seed the live session + its staging row, as a dismissed overlay leaves them
        let recorder = crate::audio::VoiceRecorder::default();
        let path = voice_dir.join("rA.wav");
        std::fs::create_dir_all(&voice_dir).unwrap();
        std::fs::File::create(&path).unwrap();
        conn.execute(
            "INSERT INTO voice_recordings(id, path, duration_secs, state, created_at) VALUES ('rA', ?1, 0, 'recording', '2026-09-25T00:00:00Z')",
            [path.to_string_lossy().as_ref()],
        ).unwrap();
        recorder.prime_session("rA");
        let row = voice_start_recording_inner(
            &conn,
            &voice_dir,
            &recorder,
            || panic!("device probe must not run on re-attach"),
        ).unwrap();
        assert_eq!(row.id, "rA");
        assert_eq!(row.state, "recording");
        // exactly one staging row: no second recording was created
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM voice_recordings", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // the live session is untouched
        assert_eq!(recorder.active_id().as_deref(), Some("rA"));
    }

    #[test]
    fn attach_to_active_missing_row_errors() {
        let conn = db();
        let err = attach_to_active(&conn, "ghost").unwrap_err();
        assert!(err.to_string().contains("already active"));
    }

    #[test]
    fn attach_to_active_non_recording_row_errors() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rB.wav");
        std::fs::File::create(&path).unwrap();
        conn.execute(
            "INSERT INTO voice_recordings(id, path, duration_secs, state, created_at) VALUES ('rB', ?1, 3.0, 'recorded', '2026-09-25T00:00:00Z')",
            [path.to_string_lossy().as_ref()],
        ).unwrap();
        let err = attach_to_active(&conn, "rB").unwrap_err();
        assert!(err.to_string().contains("already active"));
    }

    #[test]
    fn attach_to_active_returns_the_recording_row() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rC.wav");
        std::fs::File::create(&path).unwrap();
        conn.execute(
            "INSERT INTO voice_recordings(id, path, duration_secs, state, created_at) VALUES ('rC', ?1, 0, 'recording', '2026-09-25T00:00:00Z')",
            [path.to_string_lossy().as_ref()],
        ).unwrap();
        let row = attach_to_active(&conn, "rC").unwrap();
        assert_eq!(row.id, "rC");
        assert_eq!(row.state, "recording");
        // the wav file was NOT deleted by the attach
        assert!(path.exists());
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

    #[tokio::test]
    async fn extract_requires_a_model() {
        let ai = ai_mock_ok_text();
        let err = voice_extract_tasks_inner(&ai, "", "memo").await.unwrap_err();
        assert!(
            err.to_string().contains("AI model not configured"),
            "expected the Settings-configured error, got {err}"
        );
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

    #[test]
    fn create_note_inner_behavior_unchanged_after_tx_refactor() {
        // byte-equivalence fence: refactor must not alter create-note invariants
        let mut conn = db();
        let dto = create_note_inner(&mut conn, "T", "Home").unwrap();
        let ops = crate::db::outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "create");
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(payload["temp_id"], dto.id);
        assert_eq!(payload["content"], "");
        let note = crate::db::notes::get(&conn, &dto.id).unwrap().unwrap();
        assert!(note.dirty);
        assert_eq!(note.content, "");
    }

    fn stage_transcribed_with_file(dir: &tempfile::TempDir, conn: &Connection, id: &str, raw: Option<&str>, tidied: Option<&str>, duration: f64) -> String {
        let wav = dir.path().join(format!("{id}.wav"));
        std::fs::write(&wav, b"RIFF").unwrap();
        crate::db::voice::create_staging(conn, id, wav.to_string_lossy().as_ref()).unwrap();
        crate::db::voice::mark_recorded(conn, id, duration).unwrap();
        if let Some(r) = raw { crate::db::voice::set_transcript(conn, id, r).unwrap(); }
        if let Some(t) = tidied { crate::db::voice::set_tidied(conn, id, t).unwrap(); }
        wav.to_string_lossy().into_owned()
    }

    #[test]
    fn voice_save_note_one_tx_note_audio_outbox_staging_delete() {
        let mut conn = db();
        let dir = tempfile::tempdir().unwrap();
        let path = stage_transcribed_with_file(&dir, &conn, "r1", Some("hello memo"), None, 12.5);
        let note = voice_save_note_inner(&mut conn, "r1", "My Memo", "Home", false, None).unwrap();
        // note created with raw content + audio columns
        assert_eq!(note.content, "hello memo");
        assert_eq!(note.audio_path.as_deref(), Some(path.as_str()));
        assert_eq!(note.audio_duration_secs, Some(12.5));
        // exactly ONE outbox op: create with temp_id + content
        let ops = crate::db::outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "create");
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(payload["temp_id"], note.id);
        assert_eq!(payload["content"], "hello memo");
        // staging row deleted; file kept on disk
        assert!(crate::db::voice::get(&conn, "r1").unwrap().is_none());
        assert!(std::path::Path::new(&path).exists());
        // FTS: transcript is searchable (spec §5)
        let hits: Vec<String> = conn
            .prepare("SELECT id FROM notes_fts WHERE notes_fts MATCH 'memo'").unwrap()
            .query_map([], |r| r.get(0)).unwrap()
            .map(Result::unwrap).collect();
        assert_eq!(hits, vec![note.id]);
    }

    #[test]
    fn voice_save_note_tidied_and_override_rules() {
        let mut conn = db();
        let dir = tempfile::tempdir().unwrap();
        let _ = stage_transcribed_with_file(&dir, &conn, "r2", Some("raw text"), Some("Raw, tidied."), 3.0);
        let a = voice_save_note_inner(&mut conn, "r2", "t", "Home", true, None).unwrap();
        assert_eq!(a.content, "Raw, tidied.");
        let mut conn2 = db();
        let _ = stage_transcribed_with_file(&dir, &conn2, "r3", Some("raw text"), None, 3.0);
        // useTidied but no tidied stored -> raw fallback (spec §6)
        let b = voice_save_note_inner(&mut conn2, "r3", "t", "Home", true, None).unwrap();
        assert_eq!(b.content, "raw text");
        // override wins over both (spec §2 review/edit -> save; plan ruling 3)
        // (setup amendment: b's single-tx save already consumed staging row r3,
        // so re-stage it with raw + tidied to prove override beats BOTH)
        let _ = stage_transcribed_with_file(&dir, &conn2, "r3", Some("raw text"), Some("Tidied!"), 3.0);
        let c = voice_save_note_inner(&mut conn2, "r3", "t", "Home", false, Some("user edited text".into())).unwrap();
        assert_eq!(c.content, "user edited text");
        // The frontend ALWAYS sends useTidied=true + override (the editor text) in
        // tidied view — pin that the override still wins over BOTH (field report
        // 2026-09-21: raw text was saved after a tidy; root cause was upstream,
        // this pins the precedence so the save layer can never reintroduce it).
        // (fresh staging row: each save consumes its row via the staging delete)
        let _ = stage_transcribed_with_file(&dir, &conn2, "r4", Some("raw text"), Some("Stale tidied."), 3.0);
        let d = voice_save_note_inner(&mut conn2, "r4", "t", "Home", true, Some("user edited text".into())).unwrap();
        assert_eq!(d.content, "user edited text");
    }

    #[test]
    fn voice_save_note_empty_transcript_saves_with_pending_state() {
        let mut conn = db();
        let dir = tempfile::tempdir().unwrap();
        let _ = stage_transcribed_with_file(&dir, &conn, "r4", None, None, 5.0);
        let note = voice_save_note_inner(&mut conn, "r4", "t", "Home", false, None).unwrap();
        assert_eq!(note.content, "");
        assert!(note.audio_path.is_some()); // retry hook will fill content later
    }

    #[test]
    fn voice_save_note_unknown_or_recording_row_errors_rolls_back() {
        let mut conn = db();
        assert!(voice_save_note_inner(&mut conn, "nope", "t", "Home", false, None).is_err());
        let dir = tempfile::tempdir().unwrap();
        crate::db::voice::create_staging(&conn, "live", dir.path().join("l.wav").to_string_lossy().as_ref()).unwrap();
        assert!(voice_save_note_inner(&mut conn, "live", "t", "Home", false, None).is_err());
        // nothing half-saved
        assert_eq!(crate::db::outbox::next_batch(&conn, 10).unwrap().len(), 0);
        assert_eq!(crate::db::notes::list(&conn, true).unwrap().len(), 0);
    }

    #[tokio::test]
    async fn voice_transcribe_note_requires_audio_and_transcribes() {
        let s = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/v1/audio/transcriptions"))
            .respond_with(wiremock::ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"text": "note transcript", "filename": "x.wav"})))
            .mount(&s).await;
        let mut conn = db();
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("n.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        conn.execute(
            "INSERT INTO notes (id,title,content,category,created_at,updated_at,dirty,audio_path) VALUES ('n1','t','','Home','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',1,?1)",
            rusqlite::params![wav.to_string_lossy().as_ref()],
        ).unwrap();
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk", crate::voice_ai::Suffix::V1).unwrap();
        let res = voice_transcribe_note_inner(&mut conn, &ai, None, "n1").await.unwrap();
        assert_eq!(res.text, "note transcript");
        // note without audio errors; unknown note errors
        conn.execute("UPDATE notes SET audio_path=NULL WHERE id='n1'", []).unwrap();
        assert!(voice_transcribe_note_inner(&mut conn, &ai, None, "n1").await.is_err());
        assert!(voice_transcribe_note_inner(&mut conn, &ai, None, "ghost").await.is_err());
    }

    #[test]
    fn voice_delete_note_audio_is_local_only() {
        let mut conn = db();
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("n.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        conn.execute(
            "INSERT INTO notes (id,title,content,category,created_at,updated_at,dirty,audio_path,audio_duration_secs) VALUES ('n1','t','keep text','Home','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',0,?1,9.0)",
            rusqlite::params![wav.to_string_lossy().as_ref()],
        ).unwrap();
        let note = voice_delete_note_audio_inner(&mut conn, "n1").unwrap();
        assert!(note.audio_path.is_none());
        assert_eq!(note.content, "keep text");
        assert!(!wav.exists(), "file removed");
        // LOCAL-ONLY: no outbox op, no dirty flag (sync must never see this)
        assert_eq!(crate::db::outbox::next_batch(&conn, 10).unwrap().len(), 0);
        let row = crate::db::notes::get(&conn, "n1").unwrap().unwrap();
        assert!(!row.dirty);
        assert_eq!(row.audio_duration_secs, None);
    }

    // ---- Task 3: kanban boards — command layer (fetch/cache/columns/create + set_item_status) ----

    async fn test_state_with_client(uri: &str) -> AppState {
        use crate::jotty::client::JottyClient;
        use crate::keys::MockKeyStore;
        let state = AppState::new(db(), Box::new(MockKeyStore::default()), Box::new(MockKeyStore::default())).unwrap();
        *state.client.write().await = Some(JottyClient::new(uri, "ck").unwrap());
        state
    }

    #[tokio::test]
    async fn set_item_status_inner_mirrors_apply_status_and_enqueues() {
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        board::replace_cache(&conn, &list.id, &[
            ("todo", "To Do", None, 0, false),
            ("completed", "Completed", None, 2, true),
        ]).unwrap();
        let parent = items::insert_local(&conn, &items::NewItem {
            checklist_id: list.id.clone(), parent_local_id: None, text: "p".into(),
            status: None, priority: None, target_date: None,
        }).unwrap();
        let child = items::insert_local(&conn, &items::NewItem {
            checklist_id: list.id.clone(), parent_local_id: Some(parent.local_id.clone()), text: "c".into(),
            status: None, priority: None, target_date: None,
        }).unwrap();

        // move INTO the autoComplete column -> completed cascade + op enqueued
        set_item_status_inner(&mut conn, &list.id, &parent.local_id, "completed").unwrap();
        let p = items::get(&conn, &parent.local_id).unwrap().unwrap();
        let c = items::get(&conn, &child.local_id).unwrap().unwrap();
        assert!(p.completed && c.completed);
        assert_eq!(p.status.as_deref(), Some("completed"));
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "status");
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(payload["checklist_id"], list.id.as_str());
        assert_eq!(payload["item_local_id"], parent.local_id.as_str());
        assert_eq!(payload["status"], "completed");

        // move OUT -> completed flips back (children untouched), second op
        set_item_status_inner(&mut conn, &list.id, &parent.local_id, "todo").unwrap();
        let p = items::get(&conn, &parent.local_id).unwrap().unwrap();
        assert!(!p.completed);
        assert_eq!(p.status.as_deref(), Some("todo"));
        let c = items::get(&conn, &child.local_id).unwrap().unwrap();
        assert!(c.completed); // server applyStatus does NOT un-complete children
        assert_eq!(outbox::next_batch(&conn, 10).unwrap().len(), 2);
    }

    #[tokio::test]
    async fn set_item_status_on_empty_cache_treats_target_as_non_auto() {
        // cache empty (board never opened): mirror server semantics with statuses=null
        // -> autoComplete false -> completed untouched
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let it = items::insert_local(&conn, &items::NewItem {
            checklist_id: list.id.clone(), parent_local_id: None, text: "x".into(),
            status: None, priority: None, target_date: None,
        }).unwrap();
        set_item_status_inner(&mut conn, &list.id, &it.local_id, "completed").unwrap();
        let r = items::get(&conn, &it.local_id).unwrap().unwrap();
        assert!(!r.completed);
        assert_eq!(r.status.as_deref(), Some("completed"));
    }

    #[tokio::test]
    async fn set_item_target_date_inner_updates_row_and_enqueues() {
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let it = items::insert_local(&conn, &items::NewItem {
            checklist_id: list.id.clone(), parent_local_id: None, text: "card".into(),
            status: None, priority: None, target_date: None,
        }).unwrap();

        // set: row target_date updated + dirty, ONE set_date op (R1: entity_id = local_id)
        set_item_target_date_inner(&mut conn, &list.id, &it.local_id, Some("2026-10-05".into())).unwrap();
        let r = items::get(&conn, &it.local_id).unwrap().unwrap();
        assert_eq!(r.target_date.as_deref(), Some("2026-10-05"));
        assert!(r.dirty);
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "set_date");
        assert_eq!(ops[0].entity, "checklist_item");
        assert_eq!(ops[0].entity_id, it.local_id);
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(payload["checklist_id"], list.id.as_str());
        assert_eq!(payload["item_local_id"], it.local_id.as_str());
        assert_eq!(payload["targetDate"], "2026-10-05");

        // clear (None): row NULLs the date, second op payload carries null
        // (upstream PATCH semantics: targetDate null -> cleared server-side)
        set_item_target_date_inner(&mut conn, &list.id, &it.local_id, None).unwrap();
        let r = items::get(&conn, &it.local_id).unwrap().unwrap();
        assert!(r.target_date.is_none());
        assert_eq!(outbox::next_batch(&conn, 10).unwrap().len(), 2);
        let ops = outbox::next_batch(&conn, 10).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&ops[1].payload).unwrap();
        assert!(payload["targetDate"].is_null());
    }

    #[tokio::test]
    async fn add_item_inner_carries_status_for_kanban() {
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let dto = add_item_inner(&mut conn, &list.id, "card".into(), None, Some("in_progress".into()), None).unwrap();
        assert_eq!(dto.status.as_deref(), Some("in_progress"));
        let ops = outbox::next_batch(&conn, 10).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(payload["status"], "in_progress");
        // plain lists: status None -> payload carries NO status key
        let dto2 = add_item_inner(&mut conn, &list.id, "plain".into(), None, None, None).unwrap();
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 2);
        let payload2: serde_json::Value = serde_json::from_str(&ops[1].payload).unwrap();
        assert!(payload2.get("status").is_none());
        assert_eq!(dto2.status, None);
    }

    #[tokio::test]
    async fn add_item_inner_with_target_date_enqueues_create_then_set_date() {
        // appoints: creating a card WITH a date = one tx writing the row (date
        // included) + the create op + the set_date op (None date = unchanged
        // single-create shape, Ruling D byte-identical).
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();

        let dto = add_item_inner(&mut conn, &list.id, "dentist".into(), None, Some("todo".into()), Some("2026-10-05".into())).unwrap();
        assert_eq!(dto.target_date.as_deref(), Some("2026-10-05"));
        let row = items::get(&conn, &dto.local_id).unwrap().unwrap();
        assert!(row.dirty);
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 2, "create op then set_date op, FIFO");
        assert_eq!(ops[0].op_type, "create");
        let create_payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(create_payload["status"], "todo");
        assert!(create_payload.get("targetDate").is_none(), "create payload stays byte-identical (upstream POST takes no date)");
        assert_eq!(ops[1].op_type, "set_date");
        assert_eq!(ops[1].entity_id, dto.local_id);
        let date_payload: serde_json::Value = serde_json::from_str(&ops[1].payload).unwrap();
        assert_eq!(date_payload["checklist_id"], list.id.as_str());
        assert_eq!(date_payload["item_local_id"], dto.local_id.as_str());
        assert_eq!(date_payload["targetDate"], "2026-10-05");

        // no date: single create op, no targetDate key, row target_date None
        let dto2 = add_item_inner(&mut conn, &list.id, "plain".into(), None, None, None).unwrap();
        assert_eq!(dto2.target_date, None);
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 3, "2 prior + 1 create, no set_date");
        assert_eq!(ops[2].op_type, "create");
        let payload: serde_json::Value = serde_json::from_str(&ops[2].payload).unwrap();
        assert!(payload.get("targetDate").is_none());
    }

    // board_statuses.checklist_id REFERENCES checklists(id) (schema v3) and the
    // connection runs with foreign_keys=ON: tests that exercise the cache must
    // seed the owning checklist row first (production always has it — a board
    // is only opened from a synced list).
    fn seed_checklist_row(conn: &Connection, id: &str, title: &str) {
        conn.execute(
            "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES (?1,?2,'Home','task','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',0)",
            rusqlite::params![id, title],
        ).unwrap();
    }

    #[tokio::test]
    async fn fetch_task_board_rewrites_cache_and_returns_columns() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/tasks/b-uuid"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "task": { "id": "b-uuid", "title": "B", "category": "Home",
                    "statuses": [ { "id": "todo", "label": "To Do", "order": 0, "autoComplete": false },
                                  { "id": "done", "label": "Done", "order": 1, "autoComplete": true } ],
                    "items": [], "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
            })))
            .mount(&s).await;
        let state = test_state_with_client(&s.uri()).await;
        { let conn = state.db.lock().await; seed_checklist_row(&conn, "b-uuid", "B"); }
        let dto = fetch_task_board_inner(&state, "b-uuid").await.unwrap();
        assert_eq!(dto.statuses.len(), 2);
        assert_eq!(dto.statuses[1].id, "done");
        assert!(dto.statuses[1].auto_complete);
        let conn = state.db.lock().await;
        assert_eq!(board::list(&conn, "b-uuid").unwrap().len(), 2); // cached
    }

    #[tokio::test]
    async fn fetch_task_board_404_keeps_cache_silent() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/tasks/b-uuid"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({"error":"Task not found"})))
            .mount(&s).await;
        let state = test_state_with_client(&s.uri()).await;
        { let conn = state.db.lock().await; seed_checklist_row(&conn, "b-uuid", "B"); }
        {
            let conn = state.db.lock().await;
            board::replace_cache(&conn, "b-uuid", &[("todo", "To Do", None, 0, false)]).unwrap();
        }
        let dto = fetch_task_board_inner(&state, "b-uuid").await.unwrap();
        assert_eq!(dto.statuses.len(), 1); // cache preserved, no error surfaced
        let conn = state.db.lock().await;
        assert_eq!(board::list(&conn, "b-uuid").unwrap().len(), 1);
    }

    #[tokio::test]
    async fn fetch_task_board_null_statuses_clears_cache() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        // server statuses null -> site renders the default set; cache must CLEAR
        // so get_board_columns' default fallback applies (spec §6).
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/tasks/b-uuid"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "task": { "id": "b-uuid", "title": "B", "category": "Home", "statuses": null,
                          "items": [], "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
            })))
            .mount(&s).await;
        let state = test_state_with_client(&s.uri()).await;
        { let conn = state.db.lock().await; seed_checklist_row(&conn, "b-uuid", "B"); }
        {
            let conn = state.db.lock().await;
            board::replace_cache(&conn, "b-uuid", &[("stale", "Stale", None, 0, false)]).unwrap();
        }
        let dto = fetch_task_board_inner(&state, "b-uuid").await.unwrap();
        assert_eq!(dto.statuses.len(), 4); // render_default_statuses()
        assert!(dto.statuses.iter().any(|s| s.id == "paused"));
        let conn = state.db.lock().await;
        assert!(board::list(&conn, "b-uuid").unwrap().is_empty()); // cache cleared
    }

    #[tokio::test]
    async fn get_board_columns_falls_back_to_defaults_when_uncached() {
        // unreachable client (port 1, the file's convention) — the command must
        // serve pure cache/defaults and never touch the network
        let state = test_state_with_client("http://127.0.0.1:1").await;
        let dto = get_board_columns_inner(&state, "never-opened").await.unwrap();
        assert_eq!(dto.statuses.len(), 4);
        assert_eq!(dto.statuses[0].id, "todo");
        assert!(dto.statuses.iter().find(|s| s.id == "completed").unwrap().auto_complete);
    }

    #[tokio::test]
    async fn create_task_board_posts_pulls_and_returns_local_row() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        // POST /api/tasks
        Mock::given(method("POST")).and(path("/api/tasks"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": { "id": "created-uuid", "title": "New board", "category": "Work",
                          "statuses": [ { "id": "todo", "label": "To Do", "order": 0, "autoComplete": false },
                                        { "id": "in_progress", "label": "In Progress", "order": 1, "autoComplete": false },
                                        { "id": "completed", "label": "Completed", "order": 2, "autoComplete": true } ],
                          "items": [], "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
            })))
            .mount(&s).await;
        // pull_all fetches notes + checklists catalogs (BOTH must be mocked —
        // unmatched -> 404 -> pull error). Empty catalogs fine.
        Mock::given(method("GET")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"notes": []})))
            .mount(&s).await;
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"checklists": []})))
            .mount(&s).await;
        let state = test_state_with_client(&s.uri()).await;
        let dto = create_task_board_inner(&state, "New board", "Work").await.unwrap();
        assert_eq!(dto.id, "created-uuid"); // the upsert brought it local
        // The POST mock body deliberately carries no "type" field — upstream
        // POST /api/tasks responses never do. "kanban" must come from the
        // creation-endpoint override in create_task_board_inner, not from the
        // server response.
        assert_eq!(dto.list_type, "kanban");
        let conn = state.db.lock().await;
        assert!(checklists::get_checklist(&conn, "created-uuid").unwrap().is_some());
        // creation sent the 3-column explicit set
        let reqs = s.received_requests().await.unwrap();
        let body = String::from_utf8_lossy(&reqs[0].body).to_string();
        assert!(body.contains("\"autoComplete\":true"));
        assert!(!body.contains("paused"), "creation set must not include paused: {body}");
    }
}
