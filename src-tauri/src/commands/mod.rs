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
    AgendaEntryDto, AiSettingsDto, AppointmentDraftDto, BoardDto, BoardStatusDto, CategoriesDto,
    TriageSettingsDto, TriageSuggestionDto,
    ChecklistDto, ConflictDto, ConnectInfo, ItemDto, ListHit, NoteDto, NoteHit, NoteTranscribeDto,
    SearchResultsDto, SettingsDto, SyncReportDto, SyncStatusDto, TidyDto, VoiceRecordingDto,
    VoiceRetryStatsDto,
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

pub fn quick_capture_inner(conn: &mut Connection, text: &str) -> AppResult<NoteDto> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(AppError::Other("empty capture: nothing to store".into()));
    }
    let title = crate::db::notes::capture_title(conn);
    let tx = conn.transaction()?;
    let row = create_note_tx(&tx, &title, trimmed, "!INBOX")?;
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
    // originalCategory law (plan): stamp the PRE-patch row category ONLY when the
    // patch actually moves the note — captured BEFORE update_local merges the patch.
    // A pure autosave edit keeps the queued op byte-stable 3-key.
    let pre = notes::get(&tx, id)?;
    let original_category: Option<String> = match (&patch.category, pre) {
        (Some(next), Some(row)) if row.category != *next => Some(row.category),
        _ => None,
    };
    let row = notes::update_local(&tx, id, &patch)?;
    let mut payload = serde_json::json!({
        "title": &row.title, "content": &row.content, "category": &row.category
    });
    if let Some(original) = original_category {
        payload["originalCategory"] = serde_json::Value::String(original);
    }
    outbox::enqueue(&tx, "update", "note", id, &payload)?;
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
        // tier A task 3: counts on the wire — done = total - open (same two
        // maps already computed for the completion mirror).
        d.item_count = total;
        d.done_count = total - open;
    }
    Ok(dtos)
}

/// Appointments agenda (Task 4): the flat cross-list feed of DATED items
/// joined with their list, ascending by target_date then position. ONE SQL,
/// pure local read — NO network (ruling P precedent: "no network in a
/// getter"). Filters: checklist-level deleted_at stays (a tombstone has no
/// server dates to show); the dirty=0 filter is DROPPED in v0.21
/// (final-review T4-N1 promoted to v0.21 per user directive) —
/// target_date/reminder are client-authorable local columns, so a never-
/// synced local list's dated items carry local truth the agenda must show,
/// while pull-time enrichment keeps healing server-set values on clean
/// rows; the item-level `i.deleted_at` line from the plan is DROPPED — the
/// v1 schema gives checklist_items no tombstone column (verified via
/// migrations.rs + PRAGMA: deletes are physical row removes).
pub(crate) fn list_agenda_inner(conn: &Connection) -> AppResult<Vec<AgendaEntryDto>> {
    let sql = "SELECT i.local_id, i.text, i.completed, i.start_date, i.target_date,
       i.reminder_datetime, i.reminder_notified, i.status, i.position,
       c.id, c.title
FROM checklist_items i
JOIN checklists c ON c.id = i.checklist_id
WHERE c.deleted_at IS NULL
  AND i.target_date IS NOT NULL
ORDER BY i.target_date ASC, i.position ASC";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |r| {
        Ok(AgendaEntryDto {
            item_local_id: r.get(0)?,
            text: r.get(1)?,
            completed: r.get::<_, i64>(2)? != 0,
            start_date: r.get(3)?,
            target_date: r.get(4)?,
            reminder_datetime: r.get(5)?,
            // T1 row() precedent: INTEGER -> Option<i64> -> Option<bool>.
            reminder_notified: r.get::<_, Option<i64>>(6)?.map(|v| v != 0),
            status: r.get(7)?,
            position: r.get(8)?,
            checklist_id: r.get(9)?,
            checklist_title: r.get(10)?,
        })
    })?
    .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
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

// ---- promote (2026-10-07-triage-view-p2 Task 2): inbox note -> board card ----
// ONE tx per the one-mutation law: item insert + item-create op + note move to
// PROCESSED (provenance line) + note-update op, all-or-nothing. promote cannot
// reuse add_item_inner (it opens its OWN transaction; rusqlite has no nested
// transactions) — its EXACT enqueue shape is replicated inside this tx.
// Every guard below fails BEFORE any write/op: nothing is ever half-enqueued.
pub(crate) fn promote_note_to_board_inner(
    conn: &mut Connection,
    note_id: &str,
    board_id: &str,
    card_text: &str,
    new_title: &str,
) -> AppResult<NoteDto> {
    let tx = conn.transaction()?;
    // (1) stale-guard law (plan): revalidate INSIDE the tx — a note deleted
    // from another surface must fail safe with ZERO outbox enqueues.
    let pre = notes::get(&tx, note_id)?
        .ok_or_else(|| AppError::Other("stale: note no longer exists".into()))?;
    if pre.deleted_at.is_some() {
        return Err(AppError::Other("stale: note no longer exists".into()));
    }
    // fix F1 (T2 review): a note the triage pipeline already consumed is out of
    // the capture zone — re-promoting it would duplicate the card and the
    // provenance trail. Same user-facing error as the deleted-guard arm.
    let in_zone = pre.category == "!INBOX" || pre.category.starts_with("!INBOX/");
    if !in_zone {
        return Err(AppError::Other("stale: note no longer exists".into()));
    }
    // (2) board row must exist — its title feeds the provenance line. The
    // checklist_items FK (foreign_keys=ON) would also reject the insert, but
    // the explicit check fails before ANY write.
    let board = checklists::get_checklist(&tx, board_id)?
        .ok_or_else(|| AppError::Other("board not found".into()))?;
    // fix L1 (T2 review): tombstoned boards still return from get_checklist —
    // promoting into one would enqueue against a dead board id.
    if board.deleted_at.is_some() {
        return Err(AppError::Other("board not found".into()));
    }
    // (3) trimmed card text is both the item text and the payload text
    let trimmed = card_text.trim();
    if trimmed.is_empty() {
        return Err(AppError::Other("empty card text".into()));
    }
    // (4) plain-list insert (parent null, no status/date): the promote lands a
    // TODO-zone card like the voice-existing-board flow does.
    let item = items::insert_local(&tx, &items::NewItem {
        checklist_id: board_id.into(),
        parent_local_id: None,
        text: trimmed.into(),
        status: None,
        priority: None,
        target_date: None,
    })?;
    // (5) item-create op — add_item_inner's EXACT payload (Ruling D): 4 keys,
    // parent null, NO status key when None, NO set_date op when target None
    // (plain-list payload byte-stability law, pinned by tests).
    let payload = serde_json::json!({
        "checklist_id": board_id, "item_local_id": &item.local_id, "text": &item.text,
        "parent_local_id": serde_json::Value::Null
    });
    outbox::enqueue(&tx, "create", "checklist_item", &item.local_id, &payload)?;
    // (6) provenance line (spec §6, greppable) appended after a blank line
    let line = format!(
        "↳ {} → Board \"{}\" / item \"{}\"",
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        board.title,
        trimmed
    );
    let new_content = format!("{}\n\n{}", pre.content.trim_end(), line);
    // (7) move to PROCESSED; blank new_title keeps the entropy capture title
    let title: String = if new_title.trim().is_empty() {
        pre.title.clone()
    } else {
        new_title.trim().to_string()
    };
    let row = notes::update_local(&tx, note_id, &notes::NotePatch {
        title: Some(title),
        content: Some(new_content),
        category: Some("PROCESSED".into()),
    })?;
    // (8) note-update op: post-patch MERGED full copy (Ruling H). Promotion
    // ALWAYS moves the category (!INBOX -> PROCESSED), so originalCategory
    // rides unconditionally (plan semantics step 8).
    let mut op = serde_json::json!({
        "title": &row.title, "content": &row.content, "category": &row.category
    });
    op["originalCategory"] = serde_json::Value::String(pre.category);
    outbox::enqueue(&tx, "update", "note", note_id, &op)?;
    tx.commit()?;
    Ok(NoteDto::from(row))
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
/// (string = set, null = clear). T3: `start_date` rides the SAME op — the
/// "startDate" key appears ONLY when Some (legacy payloads stay byte-identical:
/// no startDate key); the push arm then issues a second startDate PATCH after
/// the targetDate PATCH. The row's start_date column itself is backfilled by
/// reconcile at group close (the server is the source of truth for it).
/// A SOME of the empty string is the P8 review-F1 explicit-clear sentinel: the
/// key authors PRESENT with a null value (upstream clear). A real start date
/// is never ''.
pub(crate) fn set_item_target_date_inner(
    conn: &mut Connection,
    checklist_id: &str,
    item_local_id: &str,
    target_date: Option<String>,
    start_date: Option<String>,
) -> AppResult<()> {
    let tx = conn.transaction()?;
    items::set_target_date(&tx, item_local_id, target_date.clone())?;
    let mut payload = serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": item_local_id, "targetDate": target_date
    });
    if let Some(s) = &start_date {
        // P8 review F1: '' is the explicit-clear SENTINEL — a literal null is
        // inexpressible at the tauri boundary (present-null and absent both
        // deserialize to Option::None; nested Options flatten on Null). ''
        // authors a PRESENT-NULL "startDate" key (the set_date push arm's
        // Some(_) branch then PATCHes {"startDate": null} = upstream clear).
        payload["startDate"] = if s.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::json!(s)
        };
    }
    outbox::enqueue(&tx, "set_date", "checklist_item", item_local_id, &payload)?;
    tx.commit()?;
    Ok(())
}

// ---- P8 card detail commands (task 2): description / estimatedTime / priority ----
// ONE tx each: row write (dirty=1 — the LOCAL edit owns the server write until
// the queued op replays) + outbox enqueue (invariant 1). Op kinds + payload
// keys mirror EXACTLY what sync/push.rs replays (T1 arms): set_note_desc reads
// payload["description"], set_est_time reads payload["estimatedTime"].as_i64()
// (INTEGER hours — the command layer never sees fractions; the UI truncates),
// set_prio reads payload["priority"]. A null value keeps the key PRESENT (the
// push arm maps null -> client None -> PATCH {"<field>": null} = upstream clear).
// Gate (mirrors set_item_text_inner's shape): item-generic — upstream PATCH
// accepts these fields on ANY checklist item, so there is NO list-type gate
// (boards-only is a UI concern); the ONLY error path is the unknown item.
pub(crate) fn set_item_description_inner(
    conn: &mut Connection,
    checklist_id: &str,
    item_local_id: &str,
    description: Option<String>,
) -> AppResult<()> {
    let tx = conn.transaction()?;
    items::get(&tx, item_local_id)?
        .ok_or_else(|| AppError::Other(format!("item {item_local_id} not found")))?;
    tx.execute(
        "UPDATE checklist_items SET description=?2, dirty=1 WHERE local_id=?1",
        rusqlite::params![item_local_id, description],
    )?;
    outbox::enqueue(&tx, "set_note_desc", "checklist_item", item_local_id, &serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": item_local_id, "description": description
    }))?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn set_item_est_time_inner(
    conn: &mut Connection,
    checklist_id: &str,
    item_local_id: &str,
    estimated_time: Option<i64>,
) -> AppResult<()> {
    let tx = conn.transaction()?;
    items::get(&tx, item_local_id)?
        .ok_or_else(|| AppError::Other(format!("item {item_local_id} not found")))?;
    tx.execute(
        "UPDATE checklist_items SET estimated_time=?2, dirty=1 WHERE local_id=?1",
        rusqlite::params![item_local_id, estimated_time],
    )?;
    outbox::enqueue(&tx, "set_est_time", "checklist_item", item_local_id, &serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": item_local_id, "estimatedTime": estimated_time
    }))?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn set_item_priority_inner(
    conn: &mut Connection,
    checklist_id: &str,
    item_local_id: &str,
    priority: Option<String>,
) -> AppResult<()> {
    let tx = conn.transaction()?;
    items::get(&tx, item_local_id)?
        .ok_or_else(|| AppError::Other(format!("item {item_local_id} not found")))?;
    tx.execute(
        "UPDATE checklist_items SET priority=?2, dirty=1 WHERE local_id=?1",
        rusqlite::params![item_local_id, priority],
    )?;
    outbox::enqueue(&tx, "set_prio", "checklist_item", item_local_id, &serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": item_local_id, "priority": priority
    }))?;
    tx.commit()?;
    Ok(())
}

/// Kanban card reminder (appointments T3): set/clear reminder_datetime + enqueue
/// the "set_reminder" op. One tx (invariant 1). Payload shape
/// {checklist_id, item_local_id, datetime} — datetime null = clear (the replay
/// arm maps null -> client None -> DELETE on the /reminder sub-route, the
/// documented route; API-key-viable again upstream since 1.28.0, #617).
/// Defense gate BEFORE any write: only
/// kanban-family boards take reminders (the UI gates too; upstream would
/// 404/400 the write anyway). Missing/NULL list_type -> treated as non-kanban.
pub(crate) fn set_item_reminder_inner(
    conn: &mut Connection,
    checklist_id: &str,
    item_local_id: &str,
    datetime: Option<String>,
) -> AppResult<()> {
    let list_type = checklists::get_checklist(conn, checklist_id)?
        .map(|c| c.list_type)
        .unwrap_or_default();
    if list_type != "kanban" && list_type != "task" {
        return Err(AppError::Other("reminders only work on kanban boards".into()));
    }
    let tx = conn.transaction()?;
    items::set_reminder_local(&tx, item_local_id, datetime.clone())?;
    outbox::enqueue(&tx, "set_reminder", "checklist_item", item_local_id, &serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": item_local_id, "datetime": datetime
    }))?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn delete_item_inner(conn: &mut Connection, checklist_id: &str, item_local_id: &str) -> AppResult<()> {
    // Snapshot BEFORE the row goes (2026-09-29, user report: every card delete
    // replayed into "unresolved item op <uid>"): the delete arm's resolve read
    // this very row, which delete_local removes first — a guaranteed conflict,
    // and list_conflicts had no row left to label either. The op now carries
    // its own resolve reference (stored path + text) for replay.
    let row = items::get(conn, item_local_id).ok().flatten();
    if row.is_none() {
        // nothing tracked under this id (double click / already gone): an
        // idempotent no-op — enqueuing would only manufacture a conflict.
        return Ok(());
    }
    let row = row.unwrap();
    let snapshot = serde_json::json!({
        "server_path": row.server_path,
        "text": row.text,
        "server_item_id": row.server_item_id,
    });
    let tx = conn.transaction()?;
    items::delete_local(&tx, item_local_id)?;
    // Ruling D: delete → {checklist_id, item_local_id}.
    outbox::enqueue(&tx, "delete", "checklist_item", item_local_id, &serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": item_local_id, "snapshot": snapshot
    }))?;
    tx.commit()?;
    Ok(())
}

/// Row-gone delete conflicts are terminal: the row can never re-resolve (removed
/// at enqueue time), so keep-mine means "dismiss" → mark DONE, not requeue into
/// the same conflict loop. Called from inner_resolve_conflict after loading the op.
pub(crate) fn keep_mine_rowless_delete(conn: &Connection, seq: i64) -> AppResult<bool> {
    let (op_type, entity): (String, String) = conn.query_row(
        "SELECT op_type, entity FROM outbox WHERE seq=?1 AND state='conflict'",
        [seq],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if op_type == "delete" && entity == "checklist_item" {
        // the local row is long gone and the replay proved the server target
        // can't be resolved — the deletion's end state already exists.
        outbox::mark_done(conn, seq)?;
        return Ok(true);
    }
    Ok(false)
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
    let result: AppResult<BoardDto> = match client.get_task(checklist_id).await {
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
    };
    // T3 (R-rec-5): recurrence sweep at board open — at the very END, after the
    // existing silent-error cache handling above, so an OFFLINE board open
    // (fetch failed) still rolls due cards. Non-fatal + silent (the `let _`
    // shape mirrors the cache-keep pattern above): a sweep failure never
    // fails the board open.
    {
        let conn = state.db.lock().await;
        let _ = sweep_recurrence_inner(&conn);
    }
    result
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

// ---- P9 board columns: add/rename/color/order/delete (ONLINE-ONLY thin wrappers) ----

fn slugify(label: &str) -> String {
    let lower = label.to_lowercase();
    let mut out = String::new();
    let mut in_run = false;
    for c in lower.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            in_run = true;
        } else if in_run {
            out.push('-');
            in_run = false;
        }
    }
    if out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        out = "col".into();
    }
    out
}

fn unique_column_id(base: &str, cached: &[crate::db::board::BoardStatusRow]) -> String {
    let ids: std::collections::HashSet<String> = cached.iter().map(|r| r.status_id.clone()).collect();
    if !ids.contains(base) {
        return base.to_string();
    }
    let mut n = 1;
    loop {
        let candidate = format!("{base}-{n}");
        if !ids.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

pub(crate) async fn add_board_column_inner(
    state: &AppState,
    checklist_id: &str,
    label: &str,
    color: Option<&str>,
) -> AppResult<()> {
    {
        let conn = state.db.lock().await;
        if let Some(cl) = checklists::get_checklist(&conn, checklist_id)? {
            if cl.list_type != "kanban" && cl.list_type != "task" {
                return Err(AppError::Other("columns only work on kanban boards".into()));
            }
        }
    }
    let client = state.client.read().await.clone()
        .ok_or_else(|| AppError::Other("not connected".into()))?;
    let (id, order) = {
        let conn = state.db.lock().await;
        let cached = board::list(&conn, checklist_id)?;
        let base = slugify(label);
        let id = unique_column_id(&base, &cached);
        let order = cached.iter().map(|r| r.sort_order).max().unwrap_or(-1) + 1;
        (id, order)
    };
    client.add_board_status(checklist_id, &id, label, color, order, None).await
}

pub(crate) async fn update_board_column_inner(
    state: &AppState,
    checklist_id: &str,
    status_id: &str,
    label: Option<String>,
    color: Option<String>,
    auto_complete: Option<bool>,
) -> AppResult<()> {
    {
        let conn = state.db.lock().await;
        if let Some(cl) = checklists::get_checklist(&conn, checklist_id)? {
            if cl.list_type != "kanban" && cl.list_type != "task" {
                return Err(AppError::Other("columns only work on kanban boards".into()));
            }
        }
    }
    let client = state.client.read().await.clone()
        .ok_or_else(|| AppError::Other("not connected".into()))?;
    let patch = crate::jotty::client::BoardStatusPatch {
        label,
        color,
        order: None,
        auto_complete,
    };
    client.update_board_status(checklist_id, status_id, &patch).await
}

pub(crate) async fn delete_board_column_inner(
    state: &AppState,
    checklist_id: &str,
    status_id: &str,
) -> AppResult<()> {
    {
        let conn = state.db.lock().await;
        if let Some(cl) = checklists::get_checklist(&conn, checklist_id)? {
            if cl.list_type != "kanban" && cl.list_type != "task" {
                return Err(AppError::Other("columns only work on kanban boards".into()));
            }
        }
        let cached = board::list(&conn, checklist_id)?;
        if cached.len() < 3 {
            return Err(AppError::Other("a board keeps at least two columns".into()));
        }
    }
    let client = state.client.read().await.clone()
        .ok_or_else(|| AppError::Other("not connected".into()))?;
    client.delete_board_status(checklist_id, status_id).await
}

pub(crate) async fn move_board_column_inner(
    state: &AppState,
    checklist_id: &str,
    status_id: &str,
    direction: &str,
) -> AppResult<()> {
    if direction != "up" && direction != "down" {
        return Err(AppError::Other("direction must be up or down".into()));
    }
    let client = state.client.read().await.clone()
        .ok_or_else(|| AppError::Other("not connected".into()))?;
    let (target_id, target_order, current_order) = {
        let conn = state.db.lock().await;
        if let Some(cl) = checklists::get_checklist(&conn, checklist_id)? {
            if cl.list_type != "kanban" && cl.list_type != "task" {
                return Err(AppError::Other("columns only work on kanban boards".into()));
            }
        }
        let cached = board::list(&conn, checklist_id)?;
        let idx = cached
            .iter()
            .position(|r| r.status_id == status_id)
            .ok_or_else(|| AppError::Other(format!("status {status_id} not found")))?;
        let neighbor_idx = if direction == "up" {
            idx.checked_sub(1)
        } else {
            Some(idx + 1)
        };
        if neighbor_idx.map(|i| i >= cached.len()).unwrap_or(true) {
            return Ok(());
        }
        let nidx = neighbor_idx.unwrap();
        let current = &cached[idx];
        let neighbor = &cached[nidx];
        (
            neighbor.status_id.clone(),
            neighbor.sort_order,
            current.sort_order,
        )
    };
    let patch_current = crate::jotty::client::BoardStatusPatch {
        label: None,
        color: None,
        order: Some(target_order),
        auto_complete: None,
    };
    client.update_board_status(checklist_id, status_id, &patch_current).await?;
    let patch_neighbor = crate::jotty::client::BoardStatusPatch {
        label: None,
        color: None,
        order: Some(current_order),
        auto_complete: None,
    };
    client.update_board_status(checklist_id, &target_id, &patch_neighbor).await
}

#[tauri::command]
pub async fn add_board_column(state: tauri::State<'_, AppState>, checklist_id: String, label: String, color: Option<String>) -> Result<(), String> {
    add_board_column_inner(&state, &checklist_id, &label, color.as_deref()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_board_column(state: tauri::State<'_, AppState>, checklist_id: String, status_id: String, label: Option<String>, color: Option<String>, auto_complete: Option<bool>) -> Result<(), String> {
    update_board_column_inner(&state, &checklist_id, &status_id, label, color, auto_complete).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_board_column(state: tauri::State<'_, AppState>, checklist_id: String, status_id: String) -> Result<(), String> {
    delete_board_column_inner(&state, &checklist_id, &status_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn move_board_column(state: tauri::State<'_, AppState>, checklist_id: String, status_id: String, direction: String) -> Result<(), String> {
    move_board_column_inner(&state, &checklist_id, &status_id, &direction).await.map_err(|e| e.to_string())
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
        "SELECT seq, entity, entity_id, op_type, last_error, payload FROM outbox WHERE state='conflict' ORDER BY seq",
    )?;
    let rows = stmt
        .query_map([], |r| {
            let entity: String = r.get(1)?;
            let entity_id: String = r.get(2)?;
            let mut label = label_for(conn, &entity, &entity_id);
            // rowless deletes: the row is gone, so the op's snapshot text is the
            // only human label left (v0.21.3)
            if label.is_none() {
                let payload: Option<String> = r.get(5).ok();
                if let Some(p) = payload {
                    if entity == "checklist_item" {
                        let v: serde_json::Value = serde_json::from_str(&p).unwrap_or_default();
                        label = v["snapshot"]["text"].as_str().map(|s| s.to_string());
                    }
                }
            }
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

fn stage_err(keep: &str, stage: &str, e: AppError) -> AppError {
    AppError::Other(format!("resolve_conflict failed — keep={keep} stage={stage} — {e}"))
}

// Ruling C: keep=="server" → outbox::mark_done + do_sync via app handle (pull
// re-imports server state); keep=="mine" → raw UPDATE outbox SET state='pending',
// attempts=0 WHERE seq=?1 (outbox.rs is NOT in this task's Files list).
pub(crate) async fn inner_resolve_conflict<R>(
    state: &AppState,
    app: &tauri::AppHandle<R>,
    seq: i64,
    keep: &str,
) -> AppResult<()>
where
    R: tauri::Runtime + crate::sync::retry_dispatch::DispatchRetry,
{
    match keep {
        "server" => {
            let conn = state.db.lock().await;
            outbox::mark_done(&conn, seq).map_err(|e| stage_err(keep, "outbox", e))?;
            drop(conn);
            crate::sync::do_sync::<R>(app).await.map_err(|e| stage_err(keep, "sync", e))?;
            // audit 4.2: do_sync preserves its Ok(()) contract and records pull
            // failures under sync_state.last_pull_error. A server-side conflict
            // resolution that fails to re-import server state is reported here.
            let conn = state.db.lock().await;
            let last_pull_error: Option<String> = conn
                .query_row("SELECT value FROM sync_state WHERE key='last_pull_error'", [], |r| r.get(0))
                .optional()?;
            if let Some(msg) = last_pull_error {
                return Err(stage_err(keep, "sync", AppError::Other(msg)));
            }
            Ok(())
        }
        "mine" => {
            let conn = state.db.lock().await;
            // rowless delete conflicts are terminal (the row was removed at enqueue
            // time and can never re-resolve) — keep-mine dismisses as DONE instead
            // of requeueing into the same conflict loop (v0.21.3).
            if keep_mine_rowless_delete(&conn, seq).map_err(|e| stage_err(keep, "inspect", e))? {
                Ok(())
            } else {
                conn.execute("UPDATE outbox SET state='pending', attempts=0 WHERE seq=?1", [seq])
                    .map_err(|e| stage_err(keep, "requeue", AppError::from(e)))?;
                Ok(())
            }
        }
        _ => Err(stage_err(keep, "unknown", AppError::Other(format!("unknown keep '{keep}'")))),
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
    Ok(SyncReportDto { pending, conflicts, last_sync_at, enrichment_errors: 0 })
}

pub(crate) fn sync_status_inner(conn: &Connection, syncing: bool) -> AppResult<SyncStatusDto> {
    let pending = outbox::pending_count(conn)?;
    let last_sync_at: Option<String> = conn
        .query_row("SELECT value FROM sync_state WHERE key='last_sync_at'", [], |r| r.get(0))
        .optional()?;
    let last_pull_error: Option<String> = conn
        .query_row("SELECT value FROM sync_state WHERE key='last_pull_error'", [], |r| r.get(0))
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
    Ok(SyncStatusDto { pending, last_sync_at, syncing, last_error, last_pull_error })
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
pub async fn quick_capture(state: tauri::State<'_, AppState>, text: String) -> Result<NoteDto, String> {
    let mut conn = state.db.lock().await;
    quick_capture_inner(&mut conn, &text).map_err(|e| e.to_string())
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

/// Appointments agenda (Task 4): flat dated-item feed across synced lists,
/// grouped client-side into Overdue/Today/Tomorrow/Next 7d/Later. Pure local
/// read (no network in a getter).
#[tauri::command]
pub async fn list_agenda(state: tauri::State<'_, AppState>) -> Result<Vec<AgendaEntryDto>, String> {
    let conn = state.db.lock().await;
    list_agenda_inner(&conn).map_err(|e| e.to_string())
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

/// Promote a captured note to a board card (Task 2): ONE tx inserts the card
/// item and moves the note to PROCESSED with a provenance line; both outbox
/// ops enqueue together (atomic — any failure leaves the outbox untouched).
#[tauri::command]
pub async fn promote_note_to_board(
    state: tauri::State<'_, AppState>,
    note_id: String,
    board_id: String,
    card_text: String,
    new_title: String,
) -> Result<NoteDto, String> {
    let mut conn = state.db.lock().await;
    promote_note_to_board_inner(&mut conn, &note_id, &board_id, &card_text, &new_title).map_err(|e| e.to_string())
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
    start_date: Option<String>,
) -> Result<(), String> {
    let mut conn = state.db.lock().await;
    set_item_target_date_inner(&mut conn, &checklist_id, &item_local_id, target_date, start_date).map_err(|e| e.to_string())
}

// P8 card details (task 2): description/estimatedTime/priority setters — null
// clears server-side (the op payload keeps the key, null value; the push arm
// PATCHes {"<field>": null}). Item-generic gates inside (no list-type check);
// invoke keys mirror the Rust params exactly (camelCase).
#[tauri::command]
pub async fn set_item_description(
    state: tauri::State<'_, AppState>,
    checklist_id: String,
    item_local_id: String,
    description: Option<String>,
) -> Result<(), String> {
    let mut conn = state.db.lock().await;
    set_item_description_inner(&mut conn, &checklist_id, &item_local_id, description).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_item_est_time(
    state: tauri::State<'_, AppState>,
    checklist_id: String,
    item_local_id: String,
    estimated_time: Option<i64>,
) -> Result<(), String> {
    let mut conn = state.db.lock().await;
    set_item_est_time_inner(&mut conn, &checklist_id, &item_local_id, estimated_time).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_item_priority(
    state: tauri::State<'_, AppState>,
    checklist_id: String,
    item_local_id: String,
    priority: Option<String>,
) -> Result<(), String> {
    let mut conn = state.db.lock().await;
    set_item_priority_inner(&mut conn, &checklist_id, &item_local_id, priority).map_err(|e| e.to_string())
}

/// Set/clear a kanban card's reminder (appointments T3): the local row's
/// reminder_datetime + dirty=1, then the set_reminder op replays via
/// client.set_item_reminder (Some -> PUT {"datetime":…}, None/null -> DELETE;
/// both on the /reminder sub-route — API-key-viable again upstream since
/// 1.28.0, #617). Kanban-family gate inside (inner).
#[tauri::command]
pub async fn set_item_reminder(
    state: tauri::State<'_, AppState>,
    checklist_id: String,
    item_local_id: String,
    datetime: Option<String>,
) -> Result<(), String> {
    let mut conn = state.db.lock().await;
    set_item_reminder_inner(&mut conn, &checklist_id, &item_local_id, datetime).map_err(|e| e.to_string())
}

/// Set/clear a kanban card's repeat (recurrence T2): authors/clears the card's
/// LOCAL-ONLY recurrence JSON via db::recurrence::set_item_recurrence_inner —
/// kanban-family gate inside; dtstart anchors to the card date (UTC midnight)
/// or now, nextDue = first slot strictly after now, and one set_date op is
/// enqueued ONLY when the card had NO target date yet (R-rec-7). The frontend
/// sends camelCase invoke keys: { checklistId, itemLocalId, preset }.
#[tauri::command]
pub async fn set_item_recurrence(
    state: tauri::State<'_, AppState>,
    checklist_id: String,
    item_local_id: String,
    preset: Option<String>,
) -> Result<(), String> {
    let mut conn = state.db.lock().await;
    crate::db::recurrence::set_item_recurrence_inner(&mut conn, &checklist_id, &item_local_id, preset).map_err(|e| e.to_string())
}

/// Roll every due recurring card (recurrence T3): the device-local sweep over
/// completed rows whose next slot has passed — reset-in-place, ops ride the
/// existing outbox kinds (check/status/set_date/set_reminder). The four
/// wire seats (R-rec-5: pull post-enrichment, push group-close, board open,
/// startup) treat this call as NON-FATAL; this command surfaces the
/// rolled-count/error to the caller instead (the frontend timer in T4
/// invokes it on mount + every 60s).
pub(crate) fn sweep_recurrence_inner(conn: &Connection) -> AppResult<usize> {
    crate::db::recurrence::sweep(conn, chrono::Utc::now())
}

/// Frontend sweep trigger (recurrence T3/T4): returns the rolled top-level
/// count. Mirrors the set_item_reminder wrapper shape (:956): one db lock,
/// inner call, map_err to String.
#[tauri::command]
pub async fn sweep_recurrence(state: tauri::State<'_, AppState>) -> Result<usize, String> {
    let conn = state.db.lock().await;
    sweep_recurrence_inner(&conn).map_err(|e| e.to_string())
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
/// .desktop launcher icon is baked into the bundle and cannot follow),
/// and mirrors the window title (v0.15.3: see apply_branding_title).
#[tauri::command]
pub async fn get_branding(state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<crate::commands::dto::BrandingDto, String> {
    let Some(client) = state.client.read().await.clone() else {
        return Err(AppError::NotConnected.to_string());
    };
    let data = client.get_branding().await.map_err(|e| e.to_string())?;
    if let Some(bytes) = &data.icon_bytes {
        best_effort_set_icon(&app, bytes);
    }
    if let Some(name) = &data.name {
        best_effort_set_title(&app, name);
    }
    Ok(crate::commands::dto::BrandingDto { name: data.name, icon_data_url: data.icon_data_url, theme_color: data.theme_color })
}

/// Mirror the window title to the branding name (v0.15.3 fix: on Wayland the
/// JS setTitle path is visually inert — tao's Wayland window embeds the title
/// in a GtkHeaderBar built ONCE at window creation (tao wayland/header.rs
/// WlHeader::setup), and gtk_window_set_title does not repaint a custom
/// titlebar — GTK only shows the title property in its default titlebar).
/// So besides the tauri set_title (which keeps the GTK/X11 title correct),
/// find the HeaderBar tao installed and update its title label directly.
/// Best-effort by design: missing window / no titlebar (X11 has none) / no
/// HeaderBar must never fail the branding command.
fn best_effort_set_title(app: &tauri::AppHandle, name: &str) {
    #[cfg(target_os = "android")]
    let _ = (app, name);
    #[cfg(not(target_os = "android"))]
    {
        use tauri::Manager as _;
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.set_title(name);
            // Android is also target_os=linux — the gtk block must exclude it
            // (the dep itself is target-gated out of android builds).
            #[cfg(all(target_os = "linux", not(target_os = "android")))]
            {
                // v0.28.1 field crash (Fedora SIGABRT, coredumpctl 2026-10-06,
                // PID 8035/thread 15761): this fn runs in async commands, i.e.
                // on tokio WORKER threads, and used to walk the titlebar right
                // here — gtk_window().titlebar() → gtk_header_bar_set_title —
                // while tao's GTK main loop was measuring the same header-bar
                // label. GTK3 is main-thread-only: the race corrupted glib's
                // heap (malloc_printerr → abort inside
                // gdk_threads_add_timeout_full). The tauri set_title above is
                // safe off-thread (tauri-runtime-wry dispatches SetTitle as a
                // WindowMessage applied on the main thread), but direct GTK
                // calls are not: marshal the whole walk onto the main thread.
                let title = name.to_string();
                let app2 = app.clone();
                let app3 = app2.clone();
                let _ = app2.run_on_main_thread(move || {
                    // Test-only thread tap for the crash fences in tests below.
                    #[cfg(test)]
                    tests::note_gtk_title_touch();
                    if let Some(win) = app3.get_webview_window("main") {
                        if let Ok(gtk_win) = win.gtk_window() {
                            use gtk::prelude::*;
                            if let Some(titlebar) = gtk_win.titlebar() {
                                if let Some(header) = find_headerbar(&titlebar) {
                                    header.set_title(Some(&title));
                                }
                            }
                        }
                    }
                });
            }
        }
    }
}

#[cfg(all(target_os = "linux", not(target_os = "android")))]
fn find_headerbar(widget: &gtk::Widget) -> Option<gtk::HeaderBar> {
    use gtk::prelude::*;
    if let Ok(header) = widget.clone().downcast::<gtk::HeaderBar>() {
        return Some(header);
    }
    if let Some(container) = widget.dynamic_cast_ref::<gtk::Container>() {
        for child in container.children() {
            if let Some(found) = find_headerbar(&child) {
                return Some(found);
            }
        }
    }
    None
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

pub(crate) async fn build_ai_client(state: &AppState) -> AppResult<crate::voice_ai::VoiceAiClient> {
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
    // Field contract (v0.22.3): Some(trimmed) = write the field's new state,
    // including Some("") = CLEAR (the frontend sends '' when the user empties
    // a field); None = don't touch (the masked API-key field relies on it —
    // its empty UI state must never delete a stored key).
    if let Some(u) = base_url.as_deref().map(str::trim) {
        if u.is_empty() {
            // clearing the base url never runs URL validation (VoiceAiClient::new("")
            // would reject an empty string with InvalidConfig)
            kv_set(conn, "ai_base_url", "")?;
        } else {
            // validate with the same rule the client enforces (https, or http on localhost)
            let _ = crate::voice_ai::VoiceAiClient::new(u, "unused", crate::voice_ai::Suffix::V1)?;
            kv_set(conn, "ai_base_url", u)?;
        }
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

// ---- AI-augmented triage (P3 Task 1) -------------------------------------
// Suggestions are ADVISORY session state: this command writes NOTHING except
// the ai_api_suffix kv on success (Send law: the db lock is never held across
// the network await — ai_models_core shape).
pub(crate) async fn triage_suggest_inner(
    state: &AppState,
    note_ids: Vec<String>,
) -> AppResult<Vec<TriageSuggestionDto>> {
    // (a) cap check FIRST — a hard error, not a silent clamp (silent clamping
    // would hide TS orchestration bugs; the two caps must drift together).
    if note_ids.len() > crate::triage_ai::TRIAGE_CHUNK_CAP {
        return Err(crate::error::AppError::Other(format!(
            "chunk exceeds cap of {} — slice client-side",
            crate::triage_ai::TRIAGE_CHUNK_CAP
        )));
    }
    // dedupe ids, order-stable
    let mut seen = std::collections::HashSet::new();
    let ids: Vec<String> = note_ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
    // (b) scoped db lock: rows + boards + vocab + model + start suffix
    let (payloads, board_names, vocab, model, start_suffix) = {
        let conn = state.db.lock().await;
        let mut payloads = Vec::new();
        for id in &ids {
            // missing -> skipped silently (stale client snapshots are legal)
            let Some(row) = crate::db::notes::get(&conn, id)? else { continue };
            // deleted -> skipped; out-of-zone -> skipped (the sweep only asks
            // about zone rows, but a stale id may have been triaged already)
            if row.deleted_at.is_some() {
                continue;
            }
            if !(row.category == "!INBOX" || row.category.starts_with("!INBOX/")) {
                continue;
            }
            payloads.push(crate::triage_ai::TriageNotePayload {
                id: row.id.clone(),
                title: row.title.clone(),
                // char-boundary-safe truncation to the prompt cap
                content: row.content.chars().take(crate::triage_ai::NOTE_CONTENT_CAP).collect(),
            });
        }
        let all = crate::db::checklists::list_checklists(&conn, false)?;
        let board_names: Vec<String> = all
            .iter()
            .filter(|c| c.deleted_at.is_none() && (c.list_type == "kanban" || c.list_type == "task"))
            .map(|c| c.title.clone())
            .collect();
        let vocab = triage_tag_vocab_inner(&conn)?;
        let model = ai_model(&conn)?;
        let start_suffix = ai_suffix(&conn)?;
        (payloads, board_names, vocab, model, start_suffix)
    };
    if payloads.is_empty() {
        return Err(crate::error::AppError::Other("no notes to triage".into()));
    }
    if model.trim().is_empty() {
        return Err(crate::error::AppError::Other(
            "AI model not configured — pick one in Settings".into(),
        ));
    }
    // (c) drop the lock -> network (Send law: no guard crosses this await)
    let ai = build_ai_client(state).await?;
    let (suggestions, effective) = crate::triage_ai::triage_suggest(
        &ai, &model, &payloads, &board_names, &vocab, start_suffix,
    )
    .await?;
    // (d) re-lock -> persist the effective suffix on success only
    let conn = state.db.lock().await;
    persist_ai_suffix(&conn, effective)?;
    Ok(suggestions.into_iter().map(TriageSuggestionDto::from).collect())
}

pub(crate) const TRIAGE_THRESHOLD_DEFAULT: f64 = 0.70;

pub(crate) fn get_triage_settings_inner(conn: &Connection) -> AppResult<TriageSettingsDto> {
    let raw = kv_get_or(conn, "triage_confidence_threshold", "")?;
    let threshold: f64 = raw.trim().parse::<f64>().ok()
        .filter(|v| (0.0..=1.0).contains(v))
        .unwrap_or(TRIAGE_THRESHOLD_DEFAULT); // absent/blank/garbage/out-of-range -> 0.70, never an error
    Ok(TriageSettingsDto { confidence_threshold: threshold })
}

pub(crate) fn set_triage_settings_inner(conn: &Connection, confidence_threshold: f64) -> AppResult<TriageSettingsDto> {
    if !(0.0..=1.0).contains(&confidence_threshold) {
        return Err(crate::error::AppError::Other(
            "confidence threshold must be between 0 and 1".into(),
        ));
    }
    // TEXT storage per the kv law (facts §18: no f64 precedent — TEXT round-trip)
    kv_set(conn, "triage_confidence_threshold", &confidence_threshold.to_string())?;
    Ok(TriageSettingsDto { confidence_threshold })
}

pub(crate) fn triage_tag_vocab_inner(conn: &Connection) -> AppResult<Vec<String>> {
    const DEFAULT_VOCAB: [&str; 4] = ["todo", "cmd", "incident", "research"]; // spec §5.4 seeds, without '#'
    let raw = kv_get_or(conn, "triage_tag_vocab", "")?;
    let parsed: Option<Vec<String>> = if raw.trim().is_empty() {
        None
    } else {
        serde_json::from_str::<Vec<String>>(&raw).ok()
    };
    Ok(parsed.unwrap_or_else(|| DEFAULT_VOCAB.iter().map(|s| s.to_string()).collect()))
}

pub(crate) fn triage_tag_vocab_add_inner(conn: &Connection, tag: &str) -> AppResult<Vec<String>> {
    // normalize: trim, strip ALL leading '#'s, lowercase; empty -> Err
    let norm = tag.trim().trim_start_matches('#').to_lowercase();
    if norm.is_empty() {
        return Err(crate::error::AppError::Other("empty tag".into()));
    }
    let mut vocab = triage_tag_vocab_inner(conn)?;
    if !vocab.iter().any(|t| t == &norm) {
        vocab.push(norm.clone());
        kv_set(conn, "triage_tag_vocab", &serde_json::to_string(&vocab).map_err(|e| crate::error::AppError::Other(format!("vocab serialize: {e}")))?)?;
    }
    Ok(vocab)
}

#[tauri::command]
pub async fn triage_suggest(
    state: tauri::State<'_, AppState>,
    note_ids: Vec<String>,
) -> Result<Vec<TriageSuggestionDto>, String> {
    triage_suggest_inner(&state, note_ids).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_triage_settings(state: tauri::State<'_, AppState>) -> Result<TriageSettingsDto, String> {
    let conn = state.db.lock().await;
    get_triage_settings_inner(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_triage_settings(
    state: tauri::State<'_, AppState>,
    confidence_threshold: f64,
) -> Result<TriageSettingsDto, String> {
    let conn = state.db.lock().await;
    set_triage_settings_inner(&conn, confidence_threshold).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn triage_tag_vocab(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let conn = state.db.lock().await;
    triage_tag_vocab_inner(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn triage_tag_vocab_add(
    state: tauri::State<'_, AppState>,
    tag: String,
) -> Result<Vec<String>, String> {
    let conn = state.db.lock().await;
    triage_tag_vocab_add_inner(&conn, &tag).map_err(|e| e.to_string())
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

/// Voice → appointment extraction (appointments Task 8): one LLM pass over
/// the transcript; None when the model reports there is no appointment.
/// Writes no table — the lock is dropped before the await and the effective
/// suffix from the returned pair is persisted under a fresh scoped lock
/// afterwards (voice_extract_tasks shape).
pub(crate) async fn voice_extract_appointment_inner(
    ai: &crate::voice_ai::VoiceAiClient,
    model: &str,
    text: &str,
) -> AppResult<(Option<crate::voice_ai::AppointmentDraft>, crate::voice_ai::Suffix)> {
    if model.trim().is_empty() {
        return Err(crate::error::AppError::Other(
            "AI model not configured — pick one in Settings".into(),
        ));
    }
    ai.extract_appointment(model, text).await
}

#[tauri::command]
pub async fn voice_extract_appointment(
    state: tauri::State<'_, AppState>,
    text: String,
) -> Result<Option<AppointmentDraftDto>, String> {
    let ai = build_ai_client(&state).await.map_err(|e| e.to_string())?;
    let model = { let conn = state.db.lock().await; ai_model(&conn).map_err(|e| e.to_string())? };
    let (draft, sfx) = voice_extract_appointment_inner(&ai, &model, &text).await.map_err(|e| e.to_string())?;
    {
        let conn = state.db.lock().await;
        persist_ai_suffix(&conn, sfx).map_err(|e| e.to_string())?;
    }
    Ok(draft.map(AppointmentDraftDto::from))
}

fn voice_list_unsaved_inner(conn: &Connection) -> AppResult<Vec<VoiceRecordingDto>> {
    Ok(crate::db::voice::list_unsaved(conn)?.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn voice_list_unsaved(state: tauri::State<'_, AppState>) -> Result<Vec<VoiceRecordingDto>, String> {
    let conn = state.db.lock().await;
    voice_list_unsaved_inner(&conn).map_err(|e| e.to_string())
}

// ---- on-demand retry + pending badge (2026-09-30 offline-voice run) ----
//
// voice_ai::maybe_retry runs the retry pass after sync completions; these
// commands expose the SAME pass on demand: the reconnect tap (App listens for
// the webview 'online' event) and the waiting-to-transcribe count chip.

#[tauri::command]
pub async fn voice_get_pending_transcriptions(state: tauri::State<'_, AppState>) -> Result<i64, String> {
    let conn = state.db.lock().await;
    crate::db::voice::count_pending_transcriptions(&conn)
        .map(|n| n as i64)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voice_retry_pending(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<VoiceRetryStatsDto, String> {
    let ai = build_ai_client(&state).await.map_err(|e| e.to_string())?;
    let hint = { let conn = state.db.lock().await; ai_language_hint(&conn).map_err(|e| e.to_string())? };
    let language = if hint.trim().is_empty() { None } else { Some(hint.trim().to_string()) };
    let stats = {
        let mut conn = state.db.lock().await;
        crate::voice_ai::retry_pending(&mut conn, &ai, language.as_deref())
            .await
            .map_err(|e| e.to_string())?
    };
    // Same contract as the sync hook: the pass finished, the UI may refresh.
    use tauri::Emitter;
    let _ = app.emit("voice-updated", ());
    Ok(stats.into())
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

    // ---- AI triage (P3 Task 1) ----

    fn seed_inbox_note(conn: &Connection, id_hint: &str, category: &str, content: &str) -> crate::db::notes::NoteRow {
        let n = crate::db::notes::insert_local(conn, &crate::db::notes::NewNote {
            title: format!("cap_{id_hint}"),
            content: content.into(),
            category: category.into(),
        }).unwrap();
        n
    }

    // v0.15.3 title-mirror regression: on Wayland, tao embeds the window title
    // in a GtkHeaderBar (built once via WlHeader::setup) and later
    // gtk_window_set_title calls do not repaint a custom titlebar, so the JS
    // setTitle path is visually inert on the user's GNOME session. The fix
    // walks the titlebar and updates the HeaderBar directly. This test builds
    // the same widget tree tao installs (EventBox containing a HeaderBar set
    // as the window's titlebar), runs find_headerbar + set_title, and asserts
    // the label changed. GTK needs a display: skip (not fail) when none is
    // available, e.g. plain CI; run under Xvfb for real coverage.
    #[test]
    fn find_headerbar_updates_tao_wayland_header_title() {
        #[cfg(target_os = "linux")]
        {
            // Serialize with the wry probe (see GTK_TEST_SEQUENCE).
            let _seq = GTK_TEST_SEQUENCE.lock().expect("gtk test sequence lock");
            if gtk::init().is_err() {
                eprintln!("skipped: no display for gtk::init");
                return;
            }
            use gtk::prelude::*;
            let win = gtk::Window::new(gtk::WindowType::Toplevel);
            let header = gtk::HeaderBar::new();
            header.set_title(Some("BEFORE-CONF-TITLE"));
            let event_box = gtk::EventBox::new();
            event_box.add(&header);
            win.set_titlebar(Some(&event_box));
            // The tree tao produces: titlebar = EventBox { HeaderBar }
            let titlebar = win.titlebar().expect("titlebar just set");
            let found = find_headerbar(&titlebar).expect("HeaderBar must be found");
            found.set_title(Some("BRAND-NEW-NAME"));
            assert_eq!(
                found.title().as_deref(),
                Some("BRAND-NEW-NAME"),
                "HeaderBar title must follow the branding name"
            );
            // Idempotent re-walk: a second branding load finds and sets again.
            let titlebar2 = win.titlebar().expect("titlebar persists");
            let found2 = find_headerbar(&titlebar2).expect("re-walk still finds it");
            found2.set_title(Some("BRAND-AGAIN"));
            assert_eq!(found2.title().as_deref(), Some("BRAND-AGAIN"));
        }
        #[cfg(not(target_os = "linux"))]
        {
            // The walk is Linux-only; nothing to pin on other hosts.
        }
    }

    // Instrument for the v0.28.1 crash fences below.
    // v0.28.0 field crash (Fedora SIGABRT, coredumpctl 2026-10-06, PID 8035 /
    // thread 15761): get_branding is an async tauri command, so it runs on a
    // tokio WORKER thread, and it mutated GTK directly from there
    // (gtk_window().titlebar() → gtk_header_bar_set_title) while tao's GTK main
    // loop was measuring the same header-bar label. GTK3 is main-thread-only;
    // the race corrupted glib's heap (malloc_printerr → abort inside
    // gdk_threads_add_timeout_full) and took the whole app down ~25s into a
    // session. Fix: marshal the titlebar mutation through
    // WebviewWindow::run_on_main_thread. These fences pin that mechanism —
    // a source-shape fence for a deterministic RED + a real-wry probe that
    // asserts the GTK mutation runs on the runtime main thread.
    static GTK_TITLE_TOUCH_THREAD: std::sync::Mutex<Option<std::thread::ThreadId>> =
        std::sync::Mutex::new(None);

    // Serializes the two GTK-owning tests (the Xvfb headerbar fence and the
    // wry probe below): GTK has ONE process-wide main-context owner, so two
    // tests racing gtk::init across harness threads is the exact bug class
    // this file fences against. Whichever holds it owns GTK for its duration.
    static GTK_TEST_SEQUENCE: std::sync::Mutex<()> = std::sync::Mutex::new(());

    // pub(super): the cfg(test) tap inside best_effort_set_title (parent
    // module) calls this; the static stays private to the tests module.
    pub(super) fn note_gtk_title_touch() {
        if let Ok(mut slot) = GTK_TITLE_TOUCH_THREAD.lock() {
            *slot = Some(std::thread::current().id());
        }
    }

    // The HeaderBar mechanics are covered headlessly by
    // find_headerbar_updates_tao_wayland_header_title, but a mock tauri
    // runtime has no gtk_window() and a real-runtime behavioral test cannot
    // fail on old code on X11 (tao ships no CSD titlebar there, so the GTK arm
    // never fires — the field race needs a Wayland session). So this fence
    // pins the MECHANISM shape directly: within best_effort_set_title, every
    // GTK access must be lexically inside the run_on_main_thread closure, and
    // nothing GTK-ish may run on the caller's (worker) thread.
    #[test]
    fn best_effort_set_title_marshals_gtk_onto_main_thread_shape_fence() {
        let src = include_str!("mod.rs");
        let start = src.find("fn best_effort_set_title").expect("fn exists");
        let end = src[start..]
            .find("fn find_headerbar")
            .map(|off| start + off)
            .unwrap_or(src.len());
        // Strip // comments BEFORE positional matching — the body carries a
        // root-cause comment that literally contains "gtk_window()" and
        // "titlebar()" mentions (same trap as the CSS rule() comment fence):
        // only CODE occurrences must govern the asserts.
        let body: String = src[start..end]
            .lines()
            .map(|l| {
                let cut = l.find("//").unwrap_or(l.len());
                l[..cut].to_string()
            })
            .collect::<Vec<_>>()
            .join("\n");
        let body = body.as_str();

        let rmt = body
            .find("run_on_main_thread")
            .expect("titlebar mutation must be marshaled via run_on_main_thread");
        assert!(
            !body[..rmt].contains("gtk_window"),
            "no gtk_window() access may precede the marshal (worker-thread GTK)"
        );
        assert!(
            !body[..rmt].contains("titlebar"),
            "no titlebar() access may precede the marshal (worker-thread GTK)"
        );
        let gtkw = body
            .find(".gtk_window()")
            .expect("the titlebar walk must still exist");
        assert!(
            gtkw > rmt,
            "gtk_window() must run inside the run_on_main_thread closure"
        );
        let hdr = body
            .find("header.set_title(")
            .expect("the HeaderBar title set must remain");
        assert!(
            hdr > rmt,
            "header.set_title must run inside the run_on_main_thread closure"
        );
        let tap = body
            .find("note_gtk_title_touch()")
            .expect("main-thread tap must be present under cfg(test)");
        assert!(
            tap > rmt,
            "the tap must fire inside the run_on_main_thread closure"
        );
    }

    // REAL-routine guard (not a gate-RED: on X11 old code passes because the
    // CSD arm no-ops — see the shape fence above for the deterministic RED).
    // Drives the PRODUCTION best_effort_set_title from a plain std thread (the
    // exact context of an async command body) against a REAL wry runtime, then
    // asserts the GTK mutation executed on the runtime MAIN thread and the
    // title lands on the GtkWindow. Skips (never fails) without a display.
    #[test]
    fn best_effort_set_title_runs_gtk_on_main_thread_when_called_off_thread() {
        #[cfg(all(target_os = "linux", not(target_os = "android")))]
        {
            // OPT-IN probe (JOTTY_GTK_WRY_PROBE=1): the real wry runtime owns
            // the process-wide GTK main context, and this test must BE the
            // GTK initiator — running the event loop on a thread that doesn't
            // own the context would recreate the exact cross-thread GTK class
            // this file fences against. Opt-in keeps normal gate runs
            // (cargo test --lib / DISPLAY=:99) free of that coupling: the
            // headerbar fence stays the sole GTK user there. Verify with:
            //   DISPLAY=:99 JOTTY_GTK_WRY_PROBE=1 \
            //   cargo test --lib -- --exact commands::tests::best_effort_set_title_runs_gtk_on_main_thread_when_called_off_thread --test-threads=1
            if std::env::var("DISPLAY").is_err() {
                eprintln!("skipped: no display for a real wry window");
                return;
            }
            if std::env::var("JOTTY_GTK_WRY_PROBE").is_err() {
                eprintln!("skipped: set JOTTY_GTK_WRY_PROBE=1 to run the wry GTK probe");
                return;
            }
            // Serialize with the headerbar fence (see GTK_TEST_SEQUENCE) —
            // belt and braces for a filtered-run corner where both were
            // selected at once. The env gate keeps normal suite runs clean.
            let _seq = GTK_TEST_SEQUENCE.lock().expect("gtk test sequence lock");

            use tauri::test::{mock_context, noop_assets};
            use tauri::{WebviewUrl, WebviewWindowBuilder, Wry};

            if let Ok(mut slot) = GTK_TITLE_TOUCH_THREAD.lock() {
                *slot = None;
            }

            use gtk::prelude::GtkWindowExt as _;
            let app = tauri::Builder::<Wry>::default()
                // Tests run on harness pool threads, not the process main
                // thread — tao panics on event-loop init there unless the
                // any-thread path is used (probes only; production keeps the
                // default main-thread loop).
                .any_thread()
                .build(mock_context(noop_assets()))
                .expect("real wry runtime builds under a display");
            let win = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
                .build()
                .expect("main window builds");

            let main_thread = std::thread::current().id();
            let handle = app.handle().clone();
            let worker = std::thread::spawn(move || {
                // Exact production call in the exact worker-thread context an
                // async tauri command body has.
                best_effort_set_title(&handle, "OFF-THREAD-BRAND");
            });
            // Watchdog: exit the loop if the marshaled job never lands so the
            // suite can't hang; the exit code then proves the timeout path.
            let watchdog = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(20));
                watchdog.exit(9);
            });

            let tap_out: std::sync::Arc<std::sync::Mutex<bool>> = Default::default();
            let title_out: std::sync::Arc<std::sync::Mutex<Option<String>>> = Default::default();
            let tap_out2 = tap_out.clone();
            let title_out2 = title_out.clone();
            let win_for_loop = win.clone();
            let main_thread_for_loop = main_thread;
            let code = app.run_return(move |app, _event| {
                // This callback runs ON the runtime main thread.
                let tapped = GTK_TITLE_TOUCH_THREAD
                    .lock()
                    .ok()
                    .and_then(|s| *s)
                    .map(|t| t == main_thread_for_loop)
                    .unwrap_or(false);
                if !tapped || *tap_out2.lock().unwrap() {
                    return;
                }
                let title = win_for_loop
                    .gtk_window()
                    .ok()
                    .and_then(|g| g.title().map(|t| t.to_string()));
                if title.as_deref() == Some("OFF-THREAD-BRAND") {
                    *tap_out2.lock().unwrap() = true;
                    *title_out2.lock().unwrap() = title;
                    app.exit(0);
                }
            });
            worker
                .join()
                .expect("worker must survive: no direct GTK access off the main thread");

            assert_eq!(
                code, 0,
                "loop must exit cleanly; code 9 = the marshaled job never landed (watchdog)"
            );
            assert!(
                *tap_out.lock().unwrap(),
                "the marshaled GTK job must have executed on the runtime main thread (tap)"
            );
            assert_eq!(
                title_out.lock().unwrap().as_deref(),
                Some("OFF-THREAD-BRAND"),
                "marshaled title must land on the GtkWindow"
            );
        }
        #[cfg(not(all(target_os = "linux", not(target_os = "android"))))]
        {
            // wry/GTK probe is desktop-Linux only; the android runtime has no
            // gtk arm and other desktops are not exercised on this box.
        }
    }

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let c = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&c).unwrap();
        c
    }

    // v0.22.3 — the user's exact report: "trying to remove the en hint, hit save,
    // reopen, it's back". The frontend coerces an empty field to null, and the
    // backend treats None as DON'T-TOUCH — so the stored hint survived forever.
    // Contract (all four fields): Some(trimmed) = write the field's new state
    // ('' clears it); None = don't touch (the masked API-key field relies on it).
    #[test]
    fn clearing_the_language_hint_writes_empty_and_reads_back_empty() {
        let conn = db();
        let ks = crate::keys::MockKeyStore::default();
        set_ai_settings_inner(&conn, &ks, Some("https://ai.example.com".into()), None, Some("en".into()), None).unwrap();
        assert_eq!(get_ai_settings_inner(&conn, &ks).unwrap().language_hint, "en");
        // the user's clear: the field sent as Some("") (fixed frontend shape)
        set_ai_settings_inner(&conn, &ks, None, None, Some("".into()), None).unwrap();
        assert_eq!(get_ai_settings_inner(&conn, &ks).unwrap().language_hint, "", "an intentional clear must persist as empty");
        // None stays don't-touch (masked fields never clobber stored state)
        set_ai_settings_inner(&conn, &ks, None, None, None, None).unwrap();
        assert_eq!(get_ai_settings_inner(&conn, &ks).unwrap().language_hint, "");
    }

    #[test]
    fn clearing_the_tidy_model_writes_empty_and_reads_back_empty() {
        let conn = db();
        let ks = crate::keys::MockKeyStore::default();
        set_ai_settings_inner(&conn, &ks, Some("https://ai.example.com".into()), Some("gemma3".into()), None, None).unwrap();
        assert_eq!(get_ai_settings_inner(&conn, &ks).unwrap().model, "gemma3");
        set_ai_settings_inner(&conn, &ks, None, Some("".into()), None, None).unwrap();
        assert_eq!(get_ai_settings_inner(&conn, &ks).unwrap().model, "", "an intentional clear must persist as empty");
    }

    #[test]
    fn clearing_the_base_url_writes_empty_without_running_url_validation() {
        let conn = db();
        let ks = crate::keys::MockKeyStore::default();
        set_ai_settings_inner(&conn, &ks, Some("https://ai.example.com".into()), None, None, None).unwrap();
        assert_eq!(get_ai_settings_inner(&conn, &ks).unwrap().base_url, "https://ai.example.com");
        // '' = clear — must NOT fall into VoiceAiClient::new("") validation
        set_ai_settings_inner(&conn, &ks, Some("".into()), None, None, None).unwrap();
        assert_eq!(get_ai_settings_inner(&conn, &ks).unwrap().base_url, "");
        // re-set works afterwards
        set_ai_settings_inner(&conn, &ks, Some("https://ai2.example.com".into()), None, None, None).unwrap();
        assert_eq!(get_ai_settings_inner(&conn, &ks).unwrap().base_url, "https://ai2.example.com");
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
    async fn update_note_inner_stamps_original_category_when_category_changes() {
        // originalCategory law (plan Global Constraints): stamp = PRE-patch row category,
        // only when patch.category is Some and ≠ pre-patch. Payload otherwise stays the
        // post-patch MERGED full copy (Ruling H) — push keys on op.entity_id.
        let mut conn = db();
        let note = create_note_inner(&mut conn, "T", "HOME").unwrap();
        let moved = update_note_inner(&mut conn, &note.id, Some("T moved".into()), Some("body".into()), Some("WORK".into())).unwrap();
        assert_eq!(moved.category, "WORK");
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[1].op_type, "update");
        let p2: serde_json::Value = serde_json::from_str(&ops[1].payload).unwrap();
        assert_eq!(p2["category"], "WORK", "payload: {p2}");
        assert_eq!(p2["originalCategory"], "HOME", "payload: {p2}");
        assert_eq!(p2["title"], "T moved", "payload: {p2}");
        assert_eq!(p2["content"], "body", "payload: {p2}");
    }

    #[tokio::test]
    async fn update_note_inner_omits_original_category_when_category_unchanged() {
        // byte-stable 3-key payload while the category stays put — covers BOTH the
        // Some(same-category) arm and the None (title/content-only) autosave arm.
        let mut conn = db();
        let note = create_note_inner(&mut conn, "T", "HOME").unwrap();
        update_note_inner(&mut conn, &note.id, None, Some("content v2".into()), Some("HOME".into())).unwrap();
        update_note_inner(&mut conn, &note.id, Some("T2".into()), None, None).unwrap();
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 3, "create + 2 updates");
        // Some("HOME") == pre-patch category → NO stamp
        let p1: serde_json::Value = serde_json::from_str(&ops[1].payload).unwrap();
        assert_eq!(ops[1].op_type, "update");
        assert_eq!(p1, serde_json::json!({"title":"T","content":"content v2","category":"HOME"}), "payload: {p1}");
        assert_eq!(p1.as_object().unwrap().len(), 3);
        // None category patch (title/content-only edit) → NO stamp
        let p2: serde_json::Value = serde_json::from_str(&ops[2].payload).unwrap();
        assert_eq!(ops[2].op_type, "update");
        assert_eq!(p2, serde_json::json!({"title":"T2","content":"content v2","category":"HOME"}), "payload: {p2}");
        assert_eq!(p2.as_object().unwrap().len(), 3);
    }

    // ---- Task 2 (2026-10-07-triage-view-p2): promote_note_to_board ----
    // Promotion composes item insert + item-create op + note move to PROCESSED
    // (provenance line) + note-update op inside ONE tx. Seeding is RAW
    // (notes::insert_local + seed_checklist_row — both op-free) so the outbox
    // starts EMPTY and exact row-count asserts pin the promote's OWN enqueues.

    #[tokio::test]
    async fn promote_happy_path_atomic() {
        let mut conn = db();
        let note = notes::insert_local(&conn, &notes::NewNote {
            title: "cap_1759812345678_abcd".into(),
            content: "grab bulbs\ncheck the fuse box".into(),
            category: "!INBOX".into(),
        })
        .unwrap();
        seed_checklist_row(&conn, "board-1", "Maintenance");
        let dto = promote_note_to_board_inner(
            &mut conn,
            &note.id,
            "board-1",
            "  Fix Nginx SSL  ",
            "Fresh Card Title",
        )
        .unwrap();

        // note row: PROCESSED + new title + content ends with the provenance line
        let row = notes::get(&conn, &note.id).unwrap().unwrap();
        assert_eq!(row.category, "PROCESSED");
        assert_eq!(row.title, "Fresh Card Title");
        assert!(row.dirty);
        assert!(row.content.starts_with("grab bulbs\ncheck the fuse box"));
        assert!(row.content.contains("\n\n↳ "), "content: {}", row.content);
        assert!(
            row.content.ends_with(" / item \"Fix Nginx SSL\""),
            "content: {}",
            row.content
        );
        // returned DTO mirrors the stored row
        assert_eq!(dto.id, note.id);
        assert_eq!(dto.title, "Fresh Card Title");
        assert_eq!(dto.category, "PROCESSED");
        assert_eq!(dto.content, row.content);

        // ONE item row on the board, trimmed text, plain-list shape
        let flat = items::list_for_checklist(&conn, "board-1").unwrap();
        assert_eq!(flat.len(), 1);
        assert_eq!(flat[0].text, "Fix Nginx SSL");
        assert_eq!(flat[0].checklist_id, "board-1");
        assert_eq!(flat[0].parent_id, None);
        assert_eq!(flat[0].status, None);

        // outbox EXACTLY 2 rows, FIFO: seq1 item create (4-key payload),
        // seq2 note update (3 merged keys + originalCategory)
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 2, "ops: {ops:?}");
        assert_eq!(ops[0].op_type, "create");
        assert_eq!(ops[0].entity, "checklist_item");
        assert_eq!(ops[0].entity_id, flat[0].local_id);
        let p1: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(
            p1,
            serde_json::json!({
                "checklist_id": "board-1",
                "item_local_id": &flat[0].local_id,
                "text": "Fix Nginx SSL",
                "parent_local_id": null
            }),
            "payload: {p1}"
        );
        assert_eq!(
            p1.as_object().unwrap().len(),
            4,
            "item create payload is exactly 4 keys (no status/date)"
        );
        assert_eq!(ops[1].op_type, "update");
        assert_eq!(ops[1].entity, "note");
        assert_eq!(ops[1].entity_id, note.id);
        let p2: serde_json::Value = serde_json::from_str(&ops[1].payload).unwrap();
        assert_eq!(p2["title"], "Fresh Card Title", "payload: {p2}");
        assert_eq!(p2["content"], row.content, "payload: {p2}");
        assert_eq!(p2["category"], "PROCESSED", "payload: {p2}");
        assert_eq!(p2["originalCategory"], "!INBOX", "payload: {p2}");
        assert_eq!(
            p2.as_object().unwrap().len(),
            4,
            "note update payload = merged 3 keys + originalCategory"
        );
    }

    #[tokio::test]
    async fn promote_stale_note_fails_without_enqueues() {
        let mut conn = db();
        let note = notes::insert_local(&conn, &notes::NewNote {
            title: "cap_1759812345678_abcd".into(),
            content: "stale body".into(),
            category: "!INBOX".into(),
        })
        .unwrap();
        seed_checklist_row(&conn, "board-1", "Maintenance");
        notes::soft_delete_local(&conn, &note.id).unwrap();

        let err = promote_note_to_board_inner(&mut conn, &note.id, "board-1", "card", "t").unwrap_err();
        assert_eq!(err.to_string(), "stale: note no longer exists");
        // ZERO side effects: nothing enqueued, no item row, row not resurrected
        assert!(
            outbox::next_batch(&conn, 10).unwrap().is_empty(),
            "stale promote must not enqueue"
        );
        assert!(items::list_for_checklist(&conn, "board-1").unwrap().is_empty());
        let row = notes::get(&conn, &note.id).unwrap().unwrap();
        assert!(row.deleted_at.is_some(), "row must stay soft-deleted");
        assert_eq!(row.category, "!INBOX");
    }

    #[tokio::test]
    async fn promote_missing_board_fails_without_enqueues() {
        let mut conn = db();
        let note = notes::insert_local(&conn, &notes::NewNote {
            title: "cap_1759812345678_abcd".into(),
            content: "lonesome".into(),
            category: "!INBOX".into(),
        })
        .unwrap();

        let err = promote_note_to_board_inner(&mut conn, &note.id, "no-such-board", "card", "t").unwrap_err();
        assert_eq!(err.to_string(), "board not found");
        assert!(
            outbox::next_batch(&conn, 10).unwrap().is_empty(),
            "missing board must not enqueue"
        );
        assert!(items::list_for_checklist(&conn, "no-such-board").unwrap().is_empty());
        // note untouched in !INBOX (Review Focus 3)
        let row = notes::get(&conn, &note.id).unwrap().unwrap();
        assert_eq!(row.category, "!INBOX");
        assert_eq!(row.content, "lonesome");
        assert!(row.deleted_at.is_none());
    }

    #[tokio::test]
    async fn promote_blank_title_keeps_entropy_title() {
        let mut conn = db();
        let entropy = "cap_1759812345678_abcd";
        let note = notes::insert_local(&conn, &notes::NewNote {
            title: entropy.into(),
            content: "body".into(),
            category: "!INBOX".into(),
        })
        .unwrap();
        seed_checklist_row(&conn, "board-1", "Maintenance");

        let dto = promote_note_to_board_inner(&mut conn, &note.id, "board-1", "card text", "   ").unwrap();
        assert_eq!(dto.title, entropy, "blank new_title must keep the existing title");
        let row = notes::get(&conn, &note.id).unwrap().unwrap();
        assert_eq!(row.title, entropy);
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 2);
        let p2: serde_json::Value = serde_json::from_str(&ops[1].payload).unwrap();
        assert_eq!(p2["title"], entropy, "queued update op must carry the kept title");
        assert_eq!(p2["category"], "PROCESSED");
    }

    #[tokio::test]
    async fn promote_trims_card_text_and_rejects_empty() {
        // trims
        let mut conn = db();
        let note = notes::insert_local(&conn, &notes::NewNote {
            title: "cap_1759812345678_abcd".into(),
            content: "body".into(),
            category: "!INBOX".into(),
        })
        .unwrap();
        seed_checklist_row(&conn, "board-t", "Trim");
        promote_note_to_board_inner(&mut conn, &note.id, "board-t", "  padded card  ", "").unwrap();
        let flat = items::list_for_checklist(&conn, "board-t").unwrap();
        assert_eq!(flat.len(), 1);
        assert_eq!(flat[0].text, "padded card");
        let p1: serde_json::Value =
            serde_json::from_str(&outbox::next_batch(&conn, 10).unwrap()[0].payload).unwrap();
        assert_eq!(p1["text"], "padded card", "payload carries the TRIMMED text");

        // rejects empty — fresh instance so the outbox-empty assert is clean
        let mut conn2 = db();
        let note2 = notes::insert_local(&conn2, &notes::NewNote {
            title: "cap_1759812345678_abcd".into(),
            content: "raw content".into(),
            category: "!INBOX".into(),
        })
        .unwrap();
        seed_checklist_row(&conn2, "board-e", "Empty");
        let err = promote_note_to_board_inner(&mut conn2, &note2.id, "board-e", "   ", "").unwrap_err();
        assert_eq!(err.to_string(), "empty card text");
        assert!(
            outbox::next_batch(&conn2, 10).unwrap().is_empty(),
            "empty card text must not enqueue"
        );
        assert!(items::list_for_checklist(&conn2, "board-e").unwrap().is_empty());
        let row2 = notes::get(&conn2, &note2.id).unwrap().unwrap();
        assert_eq!(row2.category, "!INBOX");
        assert_eq!(row2.content, "raw content");
    }

    #[tokio::test]
    async fn provenance_line_format_is_greppable() {
        let mut conn = db();
        let note = notes::insert_local(&conn, &notes::NewNote {
            title: "cap_1759812345678_abcd".into(),
            content: "seed body".into(),
            category: "!INBOX".into(),
        })
        .unwrap();
        seed_checklist_row(&conn, "board-g", "Maintenance");
        promote_note_to_board_inner(&mut conn, &note.id, "board-g", "Fix Nginx SSL", "").unwrap();

        let row = notes::get(&conn, &note.id).unwrap().unwrap();
        // new_content = old trimmed + blank line + ONE provenance line
        let line = row
            .content
            .strip_prefix("seed body\n\n")
            .expect("content = pre content + \\n\\n + provenance line");
        assert!(!line.contains('\n'), "provenance stays ONE line: {line}");
        assert!(line.starts_with("↳ "), "line: {line}");
        // exact structure: ↳ <RFC3339-Z seconds> → Board "<title>" / item "<text>"
        let body = line.strip_prefix("↳ ").unwrap();
        let mut segs = body.splitn(2, " → Board \"");
        let ts = segs.next().unwrap();
        let rest = segs.next().expect(" → Board \" segment");
        assert_eq!(
            ts.len(),
            20,
            "RFC3339 with Z suffix at SECOND precision (no fractional part): {ts}"
        );
        assert!(ts.ends_with('Z'), "Z-suffixed timestamp: {ts}");
        assert!(
            chrono::DateTime::parse_from_rfc3339(ts).is_ok(),
            "timestamp must parse as RFC3339: {ts}"
        );
        let mut board_segs = rest.splitn(2, "\" / item \"");
        let board_title = board_segs.next().unwrap();
        let item_part = board_segs.next().expect("\" / item \" segment");
        assert_eq!(board_title, "Maintenance");
        assert!(item_part.ends_with('"'), "item segment closes with a quote: {item_part}");
        assert_eq!(&item_part[..item_part.len() - 1], "Fix Nginx SSL");
    }

    // FIX ROUND 1 (2026-10-07 triage-view-p2, T2 review F1/L1): regression
    // fences, added RED-first — both must FAIL against pre-fix HEAD (the
    // re-promote currently succeeds and duplicates the card; the tombstoned
    // board currently passes the board lookup and enqueues).

    #[tokio::test]
    async fn promote_already_processed_note_is_stale_zero_enqueues() {
        let mut conn = db();
        let note = notes::insert_local(&conn, &notes::NewNote {
            title: "cap_1759000000000_ab12".into(),
            content: "audit triaged body".into(),
            category: "!INBOX".into(),
        })
        .unwrap();
        seed_checklist_row(&conn, "board-1", "Maintenance");
        // promote once (happy path), then promote AGAIN — the second call must
        // refuse: a PROCESSED note is out of the capture zone (review F1).
        promote_note_to_board_inner(&mut conn, &note.id, "board-1", "card text", "").unwrap();
        let outbox_after_first = outbox::pending_count(&conn).unwrap();
        let err = promote_note_to_board_inner(&mut conn, &note.id, "board-1", "card text", "").unwrap_err();
        assert!(format!("{}", err).contains("stale"), "got: {}", err);
        assert_eq!(outbox::pending_count(&conn).unwrap(), outbox_after_first, "re-promote enqueued ops");
        assert_eq!(items::list_for_checklist(&conn, "board-1").unwrap().len(), 1, "re-promote duplicated the card");
    }

    #[tokio::test]
    async fn promote_to_deleted_board_fails_without_enqueues() {
        let mut conn = db();
        let note = notes::insert_local(&conn, &notes::NewNote {
            title: "cap_1759000000000_cd34".into(),
            content: "body".into(),
            category: "!INBOX".into(),
        })
        .unwrap();
        // seed FIRST, then tombstone: a missing row would no-op the UPDATE and
        // the fence would pass through the missing-board arm, never RED. The
        // ruled L1 scenario is a TOMBSTONED (still-present) board row.
        seed_checklist_row(&conn, "board-1", "Maintenance");
        checklists::soft_delete_list_local(&conn, "board-1").unwrap();
        let err = promote_note_to_board_inner(&mut conn, &note.id, "board-1", "card", "").unwrap_err();
        assert!(format!("{}", err).contains("board not found"));
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
        assert!(items::list_for_checklist(&conn, "board-1").unwrap().is_empty(), "deleted-board promote must not insert the card");
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
    async fn list_checklists_inner_reports_item_and_done_counts() {
        // tier A task 3: SAME helpers as list_checklists_inner_reports_completion
        // (create_checklist_inner + add_item_inner + set_item_checked_inner) —
        // NO new seed helpers.
        let mut conn = db();
        let list = create_checklist_inner(&mut conn, "Counts", "Home").unwrap();
        add_item_inner(&mut conn, &list.id, "a", None, None, None).unwrap();
        let done_item = add_item_inner(&mut conn, &list.id, "b", None, None, None).unwrap();
        set_item_checked_inner(&mut conn, &list.id, &done_item.local_id, true).unwrap();
        let lists = list_checklists_inner(&conn).unwrap();
        let l = lists.iter().find(|l| l.id == list.id).unwrap();
        assert_eq!(l.item_count, 2);
        assert_eq!(l.done_count, 1);
    }

    #[tokio::test]
    async fn list_checklists_inner_counts_default_zero_for_empty_list() {
        let mut conn = db();
        let list = create_checklist_inner(&mut conn, "Empty", "Home").unwrap();
        let lists = list_checklists_inner(&conn).unwrap();
        let l = lists.iter().find(|l| l.id == list.id).unwrap();
        assert_eq!((l.item_count, l.done_count), (0, 0));
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
        assert!(s.last_pull_error.is_none());
        // two failed ops: the FIFO head (lowest seq) is the reported blocker
        outbox::enqueue(&conn, "update", "note", "n1", &serde_json::json!({})).unwrap();
        outbox::enqueue(&conn, "update", "note", "n2", &serde_json::json!({})).unwrap();
        outbox::record_attempt(&conn, 1, "connection refused").unwrap();
        outbox::record_attempt(&conn, 2, "500 server error").unwrap();
        let s = sync_status_inner(&conn, false).unwrap();
        assert_eq!(s.pending, 2);
        assert_eq!(s.last_error.as_deref(), Some("connection refused"));
    }

    #[test]
    fn stage_err_formats_exact_prefix() {
        let err = stage_err("server", "sync", AppError::Other("pull endpoint boom".into()));
        assert_eq!(
            err.to_string(),
            "resolve_conflict failed — keep=server stage=sync — pull endpoint boom"
        );
    }

    // audit 3.2 integration: resolving a conflict with keep="server" must surface the
    // underlying sync failure with a stable stage-prefixed error string.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolve_conflict_server_stages_sync_error() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let s = MockServer::start().await;
        // pull endpoint 500s -> do_sync's report collects the pull failure
        Mock::given(method("GET")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(500).set_body_string("pull endpoint boom"))
            .mount(&s).await;
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"checklists":[]})))
            .mount(&s).await;

        let conn = db();
        outbox::enqueue(&conn, "update", "note", "n1", &serde_json::json!({})).unwrap();
        outbox::mark_conflict(&conn, 1, "pre-existing conflict error").unwrap();

        let app = tauri::test::mock_app();
        let state = test_state_with_client(&s.uri()).await;
        app.manage(state);

        let err = inner_resolve_conflict(&*app.state::<AppState>(), app.handle(), 1, "server").await.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.starts_with("resolve_conflict failed — keep=server stage=sync —"),
            "error must carry stage prefix, got: {msg}"
        );
        assert!(
            msg.contains("pull endpoint boom") || msg.contains("pull failed") || msg.contains("500"),
            "error must include underlying pull failure, got: {msg}"
        );
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

    #[tokio::test]
    async fn extract_appointment_requires_a_model() {
        let ai = ai_mock_ok_text();
        let err = voice_extract_appointment_inner(&ai, "", "memo").await.unwrap_err();
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
        set_item_target_date_inner(&mut conn, &list.id, &it.local_id, Some("2026-10-05".into()), None).unwrap();
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
        set_item_target_date_inner(&mut conn, &list.id, &it.local_id, None, None).unwrap();
        let r = items::get(&conn, &it.local_id).unwrap().unwrap();
        assert!(r.target_date.is_none());
        assert_eq!(outbox::next_batch(&conn, 10).unwrap().len(), 2);
        let ops = outbox::next_batch(&conn, 10).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&ops[1].payload).unwrap();
        assert!(payload["targetDate"].is_null());
    }

    // ---- P8 task 2: card detail commands (description / estimatedTime / priority) ----
    // ONE tx each (row write dirty=1 + outbox enqueue, invariant 1). The op
    // kinds + payload keys mirror EXACTLY what sync/push.rs replays (T1):
    // set_note_desc reads payload["description"], set_est_time reads
    // payload["estimatedTime"].as_i64() (INTEGER hours — the command layer
    // never sees fractions), set_prio reads payload["priority"]. Gates mirror
    // set_item_text_inner's shape: item-generic (upstream PATCH accepts these
    // fields on ANY checklist item; boards-only is a UI concern), the ONLY
    // error path is the unknown item.

    #[tokio::test]
    async fn set_item_description_inner_updates_row_and_enqueues() {
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let it = items::insert_local(&conn, &items::NewItem {
            checklist_id: list.id.clone(), parent_local_id: None, text: "card".into(),
            status: None, priority: None, target_date: None,
        }).unwrap();

        // set: row description updated + dirty, ONE set_note_desc op (entity_id = local_id)
        set_item_description_inner(&mut conn, &list.id, &it.local_id, Some("prep the car".into())).unwrap();
        let r = items::get(&conn, &it.local_id).unwrap().unwrap();
        assert_eq!(r.description.as_deref(), Some("prep the car"));
        assert!(r.dirty);
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "set_note_desc");
        assert_eq!(ops[0].entity, "checklist_item");
        assert_eq!(ops[0].entity_id, it.local_id);
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(payload["checklist_id"], list.id.as_str());
        assert_eq!(payload["item_local_id"], it.local_id.as_str());
        assert_eq!(payload["description"], "prep the car");

        // clear (None): row NULLs the column, second op payload carries null
        // (push arm maps null -> None -> PATCH {"description": null} upstream)
        set_item_description_inner(&mut conn, &list.id, &it.local_id, None).unwrap();
        let r = items::get(&conn, &it.local_id).unwrap().unwrap();
        assert!(r.description.is_none());
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 2);
        let payload: serde_json::Value = serde_json::from_str(&ops[1].payload).unwrap();
        assert!(payload["description"].is_null());
    }

    #[tokio::test]
    async fn set_item_est_time_inner_updates_row_and_enqueues() {
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let it = items::insert_local(&conn, &items::NewItem {
            checklist_id: list.id.clone(), parent_local_id: None, text: "card".into(),
            status: None, priority: None, target_date: None,
        }).unwrap();

        // set: row estimated_time updated + dirty, ONE set_est_time op; the
        // payload pins the INTEGER wire shape (as_i64 — the shape the arm reads)
        set_item_est_time_inner(&mut conn, &list.id, &it.local_id, Some(3)).unwrap();
        let r = items::get(&conn, &it.local_id).unwrap().unwrap();
        assert_eq!(r.estimated_time, Some(3));
        assert!(r.dirty);
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "set_est_time");
        assert_eq!(ops[0].entity, "checklist_item");
        assert_eq!(ops[0].entity_id, it.local_id);
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(payload["checklist_id"], list.id.as_str());
        assert_eq!(payload["item_local_id"], it.local_id.as_str());
        assert_eq!(payload["estimatedTime"], serde_json::json!(3), "hours cross the wire as JSON INTEGER (never a float)");
        assert_eq!(payload["estimatedTime"].as_i64(), Some(3));

        // clear (None): row NULLs the column, second op payload carries null
        set_item_est_time_inner(&mut conn, &list.id, &it.local_id, None).unwrap();
        let r = items::get(&conn, &it.local_id).unwrap().unwrap();
        assert!(r.estimated_time.is_none());
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 2);
        let payload: serde_json::Value = serde_json::from_str(&ops[1].payload).unwrap();
        assert!(payload["estimatedTime"].is_null());
    }

    #[tokio::test]
    async fn set_item_priority_inner_updates_row_and_enqueues() {
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let it = items::insert_local(&conn, &items::NewItem {
            checklist_id: list.id.clone(), parent_local_id: None, text: "card".into(),
            status: None, priority: None, target_date: None,
        }).unwrap();

        // set: row priority updated + dirty, ONE set_prio op (upstream enum
        // literal rides verbatim: critical|high|medium|low|none)
        set_item_priority_inner(&mut conn, &list.id, &it.local_id, Some("high".into())).unwrap();
        let r = items::get(&conn, &it.local_id).unwrap().unwrap();
        assert_eq!(r.priority.as_deref(), Some("high"));
        assert!(r.dirty);
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "set_prio");
        assert_eq!(ops[0].entity, "checklist_item");
        assert_eq!(ops[0].entity_id, it.local_id);
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(payload["checklist_id"], list.id.as_str());
        assert_eq!(payload["item_local_id"], it.local_id.as_str());
        assert_eq!(payload["priority"], "high");

        // clear (None): row NULLs the column, second op payload carries null
        // (push arm maps null -> None -> PATCH {"priority": null} upstream)
        set_item_priority_inner(&mut conn, &list.id, &it.local_id, None).unwrap();
        let r = items::get(&conn, &it.local_id).unwrap().unwrap();
        assert!(r.priority.is_none());
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 2);
        let payload: serde_json::Value = serde_json::from_str(&ops[1].payload).unwrap();
        assert!(payload["priority"].is_null());
    }

    #[tokio::test]
    async fn set_item_detail_inners_reject_unknown_item_without_enqueue() {
        // the gate mirrors set_item_text_inner's shape: the ONLY error path is
        // the unknown item — refused BEFORE any row write or op enqueue
        // (an Update on an absent local_id would silently write 0 rows).
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let e = set_item_description_inner(&mut conn, &list.id, "ghost", Some("d".into())).unwrap_err();
        assert!(e.to_string().contains("not found"), "description rejects unknown item, got: {e}");
        let e = set_item_est_time_inner(&mut conn, &list.id, "ghost", Some(2)).unwrap_err();
        assert!(e.to_string().contains("not found"), "est time rejects unknown item, got: {e}");
        let e = set_item_priority_inner(&mut conn, &list.id, "ghost", Some("low".into())).unwrap_err();
        assert!(e.to_string().contains("not found"), "priority rejects unknown item, got: {e}");
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 0, "no op may enqueue for an unknown item");
    }

    #[tokio::test]
    async fn set_item_target_date_inner_empty_start_date_sentinel_is_present_null_clear() {
        // P8 review F1: the UI's touched-CLEAR save forwards "" (a literal null
        // is inexpressible at the tauri boundary — present-null and absent both
        // flatten to Option::None). "" must author a startDate key that is
        // PRESENT with a NULL value — the set_date arm's Some(_) branch then
        // PATCHes {"startDate": null} (clear). An ABSENT key would be the
        // legacy no-op shape this fence exists to prevent.
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let it = items::insert_local(&conn, &items::NewItem {
            checklist_id: list.id.clone(), parent_local_id: None, text: "card".into(),
            status: None, priority: None, target_date: None,
        }).unwrap();

        set_item_target_date_inner(&mut conn, &list.id, &it.local_id, Some("2026-10-01".into()), Some("".into())).unwrap();
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert!(payload.get("startDate").is_some(), "sentinel '': startDate key must be PRESENT in the set_date payload");
        assert!(payload["startDate"].is_null(), "sentinel '': startDate value must be null (upstream clear shape)");
        assert_eq!(payload["targetDate"], "2026-10-01");
        assert_eq!(payload["item_local_id"], it.local_id.as_str());
    }

    #[tokio::test]
    async fn set_item_target_date_inner_present_string_start_date_keeps_string() {
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let it = items::insert_local(&conn, &items::NewItem {
            checklist_id: list.id.clone(), parent_local_id: None, text: "card".into(),
            status: None, priority: None, target_date: None,
        }).unwrap();

        set_item_target_date_inner(&mut conn, &list.id, &it.local_id, Some("2026-10-01".into()), Some("2026-10-04".into())).unwrap();
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(payload["startDate"], "2026-10-04", "a real start date crosses the payload as a string");
    }

    #[tokio::test]
    async fn set_item_reminder_inner_gates_non_kanban_and_enqueues() {
        // T3: kanban-family boards take reminders (row reminder + dirty + ONE
        // set_reminder op, payload datetime null on clear); non-kanban is
        // refused BEFORE any write.
        let mut conn = db();
        conn.execute(
            "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('b1','B','Home','kanban','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0)", []).unwrap();
        let it = items::insert_local(&conn, &items::NewItem {
            checklist_id: "b1".into(), parent_local_id: None, text: "card".into(),
            status: Some("todo".into()), priority: None, target_date: None,
        }).unwrap();
        set_item_reminder_inner(&mut conn, "b1", &it.local_id, Some("2026-10-01T09:00:00Z".into())).unwrap();
        let r = items::get(&conn, &it.local_id).unwrap().unwrap();
        assert_eq!(r.reminder_datetime.as_deref(), Some("2026-10-01T09:00:00Z"));
        assert!(r.dirty, "the local edit owns the server write");
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "set_reminder");
        assert_eq!(ops[0].entity, "checklist_item");
        assert_eq!(ops[0].entity_id, it.local_id);
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(payload["checklist_id"], "b1");
        assert_eq!(payload["item_local_id"], it.local_id.as_str());
        assert_eq!(payload["datetime"], "2026-10-01T09:00:00Z");

        // clear: second op, payload datetime null (replay maps null -> DELETE)
        set_item_reminder_inner(&mut conn, "b1", &it.local_id, None).unwrap();
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 2);
        let payload: serde_json::Value = serde_json::from_str(&ops[1].payload).unwrap();
        assert!(payload["datetime"].is_null());

        // non-kanban gate: Err BEFORE any write (row + outbox untouched)
        conn.execute(
            "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('r1','R','Home','regular','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0)", []).unwrap();
        let it2 = items::insert_local(&conn, &items::NewItem {
            checklist_id: "r1".into(), parent_local_id: None, text: "plain".into(),
            status: None, priority: None, target_date: None,
        }).unwrap();
        let before = outbox::next_batch(&conn, 10).unwrap().len();
        let err = set_item_reminder_inner(&mut conn, "r1", &it2.local_id, Some("2026-10-01T09:00:00Z".into())).unwrap_err();
        assert_eq!(err.to_string(), "reminders only work on kanban boards");
        assert_eq!(outbox::next_batch(&conn, 10).unwrap().len(), before, "the gated op must not enqueue");
        let r2 = items::get(&conn, &it2.local_id).unwrap().unwrap();
        assert!(r2.reminder_datetime.is_none(), "the gated write must not touch the row");
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

    // ---- Appointments Task 4: list_agenda (flat dated-item feed) ----

    // Two lists, three items: dated 2026-10-02 (A), dated 2026-10-01 (B),
    // undated (B) -> only the dated pair survives, ascending by target_date
    // ACROSS lists (the agenda is one cross-list feed, not a per-list view).
    #[tokio::test]
    async fn list_agenda_spans_lists_sorted_by_target_date() {
        let mut conn = db();
        let a = create_checklist_inner(&mut conn, "A", "Home").unwrap();
        let b = create_checklist_inner(&mut conn, "B", "Home").unwrap();
        let later = add_item_inner(&mut conn, &a.id, "later", None, None, Some("2026-10-02".into())).unwrap();
        let earlier = add_item_inner(&mut conn, &b.id, "earlier", None, None, Some("2026-10-01".into())).unwrap();
        add_item_inner(&mut conn, &b.id, "undated", None, None, None).unwrap();
        // create_checklist_inner leaves rows dirty (local edits pending); the
        // agenda shows SYNCED lists only.
        checklists::mark_list_synced(&conn, &a.id, "2026-01-01T00:00:00.000Z").unwrap();
        checklists::mark_list_synced(&conn, &b.id, "2026-01-01T00:00:00.000Z").unwrap();
        let entries = list_agenda_inner(&conn).unwrap();
        assert_eq!(entries.len(), 2, "undated item excluded, both lists spanned");
        assert_eq!(entries[0].item_local_id, earlier.local_id, "2026-10-01 sorts first");
        assert_eq!(entries[0].checklist_title, "B");
        assert_eq!(entries[0].target_date.as_deref(), Some("2026-10-01"));
        assert_eq!(entries[1].item_local_id, later.local_id);
        assert_eq!(entries[1].checklist_title, "A");
        assert_eq!(entries[1].target_date.as_deref(), Some("2026-10-02"));
    }

    #[tokio::test]
    async fn list_agenda_excludes_deleted_lists() {
        // Deleted-exclusion pinned INDEPENDENTLY: `gone` is tombstoned with
        // dirty=0 (excluded ONLY by deleted_at — sync-pull tombstone
        // semantics). Since v0.21 (T4-N1) the dirty=0 filter is GONE from the
        // agenda SQL, so `pending` (deleted_at NULL, dirty=1 — created
        // locally, never synced) now asserts INCLUSION here; the
        // order-sensitive dirty-list pin is
        // list_agenda_includes_dirty_and_never_synced_lists below.
        let mut conn = db();
        let clean = create_checklist_inner(&mut conn, "Clean", "Home").unwrap();
        let gone = create_checklist_inner(&mut conn, "Gone", "Home").unwrap();
        let pending = create_checklist_inner(&mut conn, "Pending", "Home").unwrap();
        for l in [&clean.id, &gone.id, &pending.id] {
            add_item_inner(&mut conn, l, "appt", None, None, Some("2026-10-05".into())).unwrap();
        }
        checklists::mark_list_synced(&conn, &clean.id, "2026-01-01T00:00:00.000Z").unwrap();
        checklists::mark_list_synced(&conn, &gone.id, "2026-01-01T00:00:00.000Z").unwrap();
        checklists::tombstone(&conn, &gone.id).unwrap(); // deleted_at set, dirty untouched
        let entries = list_agenda_inner(&conn).unwrap();
        let mut ids: Vec<&str> = entries.iter().map(|e| e.checklist_id.as_str()).collect();
        ids.sort_unstable(); // same-dated items: the tie order is unspecified
        let mut expected = vec![clean.id.as_str(), pending.id.as_str()];
        expected.sort_unstable();
        assert_eq!(
            ids,
            expected,
            "tombstoned `gone` out; clean + never-synced `pending` in",
        );
    }

    #[tokio::test]
    async fn list_agenda_includes_dirty_and_never_synced_lists() {
        // v0.21 (T4-N1): the dirty=0 filter is gone — a never-synced local
        // list's dated item is agenda-visible NEXT TO clean lists' items, in
        // target_date order (target_date/reminder are client-authorable local
        // columns; dirty rows carry local truth; pull-time enrichment keeps
        // healing server-set values on clean rows).
        let mut conn = db();
        let clean = create_checklist_inner(&mut conn, "Clean", "Home").unwrap();
        let dirty_list = create_checklist_inner(&mut conn, "Dirty", "Home").unwrap();
        let clean_item = add_item_inner(&mut conn, &clean.id, "clean appt", None, None, Some("2026-10-03".into())).unwrap();
        let dirty_item = add_item_inner(&mut conn, &dirty_list.id, "dirty appt", None, None, Some("2026-10-01".into())).unwrap();
        checklists::mark_list_synced(&conn, &clean.id, "2026-01-01T00:00:00.000Z").unwrap();
        // fixture pin: `dirty_list` really is the never-synced class (dirty=1,
        // deleted_at NULL — adding an item never un-dirties the list).
        let dirty_flag: i64 = conn.query_row(
            "SELECT dirty FROM checklists WHERE id = ?1",
            [&dirty_list.id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(dirty_flag, 1, "fixture must be a dirty (never-synced) list");
        let entries = list_agenda_inner(&conn).unwrap();
        assert_eq!(entries.len(), 2, "dirty list's dated item in, clean list's too");
        assert_eq!(entries[0].item_local_id, dirty_item.local_id, "2026-10-01 sorts first");
        assert_eq!(entries[0].checklist_id, dirty_list.id);
        assert_eq!(entries[0].target_date.as_deref(), Some("2026-10-01"));
        assert_eq!(entries[1].item_local_id, clean_item.local_id);
        assert_eq!(entries[1].checklist_id, clean.id);
        assert_eq!(entries[1].target_date.as_deref(), Some("2026-10-03"));
    }

    #[tokio::test]
    async fn list_agenda_passes_reminder_fields_through() {
        let conn = db();
        conn.execute(
            "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('b1','B','Home','kanban','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0)", []).unwrap();
        let it = items::insert_local(&conn, &items::NewItem {
            checklist_id: "b1".into(), parent_local_id: None, text: "card".into(),
            status: Some("todo".into()), priority: None, target_date: Some("2026-10-01".into()),
        }).unwrap();
        // T3 enrichment mirror: datetime + notified=1 land on the row without
        // dirtying it (exactly the post-pull state the agenda must surface).
        items::set_reminder_from_server(&conn, &it.local_id, Some("2026-10-01T09:00:00.000Z".into()), Some(true)).unwrap();
        let entries = list_agenda_inner(&conn).unwrap();
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.item_local_id, it.local_id);
        assert_eq!(e.checklist_id, "b1");
        assert_eq!(e.checklist_title, "B");
        assert_eq!(e.status.as_deref(), Some("todo"));
        assert_eq!(e.reminder_datetime.as_deref(), Some("2026-10-01T09:00:00.000Z"));
        assert_eq!(e.reminder_notified, Some(true));
    }

    #[tokio::test]
    async fn list_agenda_includes_children_with_dates() {
        // The agenda reads the FLAT items table: a child row (parent_id set)
        // with a target_date is an agenda entry in its own right, while its
        // undated parent stays out.
        let mut conn = db();
        let list = create_checklist_inner(&mut conn, "Trip", "Home").unwrap();
        let parent = add_item_inner(&mut conn, &list.id, "pack", None, None, None).unwrap();
        let child = add_item_inner(&mut conn, &list.id, "visa appointment", Some(parent.local_id.clone()), None, Some("2026-10-03".into())).unwrap();
        checklists::mark_list_synced(&conn, &list.id, "2026-01-01T00:00:00.000Z").unwrap();
        let entries = list_agenda_inner(&conn).unwrap();
        assert_eq!(entries.len(), 1, "dated child in, undated parent out");
        assert_eq!(entries[0].item_local_id, child.local_id);
        assert_eq!(entries[0].text, "visa appointment");
        assert_eq!(entries[0].checklist_title, "Trip");
        assert_eq!(entries[0].target_date.as_deref(), Some("2026-10-03"));
    }

    #[tokio::test]
    async fn list_agenda_wire_shape_is_camel_case() {
        let conn = db();
        conn.execute(
            "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('b1','B','Home','kanban','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0)", []).unwrap();
        let it = items::insert_local(&conn, &items::NewItem {
            checklist_id: "b1".into(), parent_local_id: None, text: "dentist".into(),
            status: Some("todo".into()), priority: None, target_date: Some("2026-10-01".into()),
        }).unwrap();
        // start_date is server-authored (reconcile backfills it; the local
        // set_date op only carries it in the payload) — mirror the reconcile
        // write directly.
        conn.execute("UPDATE checklist_items SET start_date='2026-10-01' WHERE local_id=?1", rusqlite::params![it.local_id]).unwrap();
        items::set_reminder_from_server(&conn, &it.local_id, Some("2026-10-01T09:00:00.000Z".into()), Some(true)).unwrap();
        let entries = list_agenda_inner(&conn).unwrap();
        assert_eq!(entries.len(), 1);
        let v = serde_json::to_value(&entries[0]).unwrap();
        assert_eq!(v["checklistId"], "b1");
        assert_eq!(v["checklistTitle"], "B");
        assert_eq!(v["itemLocalId"], it.local_id.as_str());
        assert_eq!(v["startDate"], "2026-10-01");
        assert_eq!(v["targetDate"], "2026-10-01");
        assert_eq!(v["reminderDatetime"], "2026-10-01T09:00:00.000Z");
        assert_eq!(v["reminderNotified"], true);
    }

    // ---- T3: recurrence sweep command + board-open seat (R-rec-5) ----

    fn seed_due_recurring(conn: &Connection) -> String {
        conn.execute(
            "INSERT INTO checklists (id, title, list_type, created_at, updated_at) VALUES ('l1', 'L', 'kanban', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        let id = "i-1".to_string();
        conn.execute(
            "INSERT INTO checklist_items (local_id, checklist_id, text, completed, position, dirty, recurrence) VALUES ('i-1','l1','X',1,0,0,?1)",
            [r#"{"rrule":"FREQ=DAILY;INTERVAL=1","dtstart":"2026-10-01T00:00:00+00:00","nextDue":"2026-10-01T00:00:00+00:00"}"#],
        ).unwrap();
        id
    }

    #[test]
    fn sweep_recurrence_inner_rolls_due_rows() {
        let conn = crate::db::test_conn();
        let id = seed_due_recurring(&conn);
        let n = sweep_recurrence_inner(&conn).unwrap();
        assert_eq!(n, 1);
        assert!(!crate::db::items::get(&conn, &id).unwrap().unwrap().completed);
    }

    #[tokio::test]
    async fn fetch_task_board_inner_sweeps_even_when_fetch_fails() {
        let conn = crate::db::test_conn();
        let id = seed_due_recurring(&conn);
        // unreachable board URL: mirror the file-convention client usage rule
        // (http://127.0.0.1:1). The brief sketched a (conn, client, list_id)
        // signature; the LIVE fn takes (&AppState, checklist_id) — call shape
        // adapted per the brief's NOTE, assertions verbatim.
        let state = AppState::new(conn, Box::new(crate::keys::MockKeyStore::default()), Box::new(crate::keys::MockKeyStore::default())).unwrap();
        *state.client.write().await = Some(crate::jotty::client::JottyClient::new("http://127.0.0.1:1", "ck_test").unwrap());
        fetch_task_board_inner(&state, "l1").await.unwrap();
        let conn = state.db.lock().await;
        assert!(!crate::db::items::get(&conn, &id).unwrap().unwrap().completed);
    }

    #[test]
    fn quick_capture_creates_inbox_note_and_outbox_op() {
        let mut conn = db();
        let dto = super::quick_capture_inner(&mut conn, "check disk on web-01")
            .expect("capture");
        assert_eq!(dto.category, "!INBOX");
        assert_eq!(dto.content, "check disk on web-01");
        assert!(dto.title.starts_with("cap_"), "entropy title, got {}", dto.title);
        assert!(dto.dirty, "local capture is dirty until pushed");
        // outbox op = ('create','note', temp_id, payload with !INBOX)
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        let op = &ops[0];
        assert_eq!(op.op_type, "create");
        assert_eq!(op.entity, "note");
        let payload: serde_json::Value = serde_json::from_str(&op.payload).expect("payload json");
        assert_eq!(payload["category"], "!INBOX");
        assert_eq!(payload["content"], "check disk on web-01");
    }

    #[test]
    fn quick_capture_rejects_empty_text() {
        let mut conn = db();
        let err = super::quick_capture_inner(&mut conn, "   ")
            .expect_err("empty input rejected");
        assert!(err.to_string().contains("empty"), "message mentions empty: {err}");
    }

    // ---- AI triage (P3 Task 1): command + kv fences ----

    #[tokio::test]
    async fn triage_chunk_cap_enforced() {
        let conn = db();
        let ai_ks = crate::keys::MockKeyStore::default();
        ai_ks.set("sk-test").unwrap();
        let state = AppState::new(conn, Box::new(crate::keys::MockKeyStore::default()), Box::new(ai_ks)).unwrap();
        let ids: Vec<String> = (0..26).map(|i| format!("no-such-{i}")).collect();
        let err = triage_suggest_inner(&state, ids.clone()).await.expect_err("26 ids must fail the cap");
        assert!(err.to_string().contains("chunk exceeds cap of 20"), "{err}");
        // exactly at the cap passes the cap gate and reaches the next gate
        // (no such rows -> all filtered -> "no notes to triage")
        let ids20: Vec<String> = (0..20).map(|i| format!("no-such-{i}")).collect();
        let err2 = triage_suggest_inner(&state, ids20).await.expect_err("no rows to triage");
        assert!(err2.to_string().contains("no notes to triage"), "{err2}");
    }

    #[tokio::test]
    async fn triage_suggest_skips_missing_deleted_and_out_of_zone_ids() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        // seed FIRST: the mock's reply must carry the REAL id (the parser
        // drops unknown ids — the validation law this test proves)
        let conn = db();
        kv_set(&conn, "ai_model", "test-model").unwrap();
        let good = seed_inbox_note(&conn, "good", "!INBOX", "renew the vpn cert");
        let gone = seed_inbox_note(&conn, "gone", "!INBOX", "removed elsewhere");
        crate::db::notes::soft_delete_local(&conn, &gone.id).unwrap();
        let outside = seed_inbox_note(&conn, "outside", "HOME", "plain note");

        let s = MockServer::start().await;
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reqs: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>> = std::sync::Arc::default();
        let (h, rq) = (hits.clone(), reqs.clone());
        let reply_id = good.id.clone();
        kv_set(&conn, "ai_base_url", &s.uri()).unwrap();
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .respond_with(move |req: &wiremock::Request| {
                h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                rq.lock().unwrap().push(body);
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "choices": [{"message": {"content": serde_json::to_string(&serde_json::json!([
                        {"note_id": reply_id, "route": "TODO", "suggested_board": serde_json::Value::Null,
                         "suggested_title": serde_json::Value::Null, "suggested_tags": [], "confidence": 0.8}
                    ])).unwrap()}}]}
                ))
            })
            .mount(&s).await;
        let ai_ks = crate::keys::MockKeyStore::default();
        ai_ks.set("sk-test").unwrap();
        let state = AppState::new(conn, Box::new(crate::keys::MockKeyStore::default()), Box::new(ai_ks)).unwrap();
        let dto = triage_suggest_inner(&state, vec![good.id.clone(), gone.id.clone(), outside.id.clone(), "missing-id".into()])
            .await
            .expect("the good row survives every filter");
        // exactly ONE note reached the chat body
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        let sent = reqs.lock().unwrap();
        let notes = sent[0]["messages"][1]["content"]
            .as_str()
            .map(|c| serde_json::from_str::<serde_json::Value>(c).unwrap())
            .unwrap()["notes"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(notes.len(), 1, "missing/deleted/out-of-zone ids are filtered BEFORE the chat");
        assert_eq!(notes[0]["id"], good.id.as_str());
        // and the reply rides back as exactly one DTO
        assert_eq!(dto.len(), 1);
        assert_eq!(dto[0].note_id, good.id);
        assert_eq!(dto[0].route, "TODO");
        assert_eq!(dto[0].confidence, 0.8);
    }

    #[tokio::test]
    async fn triage_suggest_all_filtered_out_errors() {
        let conn = db();
        let gone = seed_inbox_note(&conn, "gone", "!INBOX", "removed elsewhere");
        crate::db::notes::soft_delete_local(&conn, &gone.id).unwrap();
        let _outside = seed_inbox_note(&conn, "outside", "HOME", "plain note");
        let state = AppState::new(conn, Box::new(crate::keys::MockKeyStore::default()), Box::new(crate::keys::MockKeyStore::default())).unwrap();
        let err = triage_suggest_inner(&state, vec![gone.id.clone(), "missing-id".into()])
            .await
            .expect_err("nothing left after the zone/existence filters");
        assert!(err.to_string().contains("no notes to triage"), "{err}");
    }

    #[tokio::test]
    async fn triage_suggest_model_not_configured_message() {
        let conn = db();
        let good = seed_inbox_note(&conn, "good", "!INBOX", "body");
        let state = AppState::new(conn, Box::new(crate::keys::MockKeyStore::default()), Box::new(crate::keys::MockKeyStore::default())).unwrap();
        let err = triage_suggest_inner(&state, vec![good.id])
            .await
            .expect_err("empty ai_model kv is the configure-prompt error");
        assert_eq!(
            err.to_string(),
            "AI model not configured — pick one in Settings",
            "the voice-chain string, verbatim"
        );
        // errors gate BEFORE any network/suffix write
        let raw: Option<String> = state
            .db
            .lock()
            .await
            .query_row("SELECT value FROM sync_state WHERE key='ai_api_suffix'", [], |r| r.get(0))
            .optional()
            .unwrap();
        assert!(raw.is_none(), "no chat -> no suffix persistence");
    }

    #[tokio::test]
    async fn triage_suggest_persists_effective_suffix_on_success() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        // seed first: the reply must carry the REAL id
        let conn = db();
        kv_set(&conn, "ai_model", "test-model").unwrap();
        let good = seed_inbox_note(&conn, "good", "!INBOX", "body");
        let s = MockServer::start().await;
        // v1 path 404s -> chain retries plain -> success carries the Plain suffix back
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({"detail": "no"})))
            .mount(&s).await;
        let reply_id = good.id.clone();
        kv_set(&conn, "ai_base_url", &s.uri()).unwrap();
        Mock::given(method("POST")).and(path("/api/chat/completions"))
            .respond_with(move |_req: &wiremock::Request| {
                let reply = serde_json::json!({"choices": [{"message": {"content": serde_json::to_string(&serde_json::json!([
                    {"note_id": reply_id, "route": "DOCS", "suggested_board": serde_json::Value::Null,
                     "suggested_title": serde_json::Value::Null, "suggested_tags": ["#Doc"], "confidence": 0.9}
                ])).unwrap()}}]});
                ResponseTemplate::new(200).set_body_json(reply)
            })
            .mount(&s).await;
        let ai_ks = crate::keys::MockKeyStore::default();
        ai_ks.set("sk-test").unwrap();
        let state = AppState::new(conn, Box::new(crate::keys::MockKeyStore::default()), Box::new(ai_ks)).unwrap();
        let dto = triage_suggest_inner(&state, vec![good.id]).await.unwrap();
        assert_eq!(dto.len(), 1);
        // the EFFECTIVE suffix persisted (raw "v1"/"plain" TEXT per the voice law)
        let raw: String = state.db.lock().await
            .query_row("SELECT value FROM sync_state WHERE key='ai_api_suffix'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(raw, "plain");
        // tags come back normalized (leading '#' stripped, lowercase)
        assert_eq!(dto[0].suggested_tags, vec!["doc"]);
    }

    #[tokio::test]
    async fn triage_note_content_truncated_to_cap_in_prompt() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        let reqs: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>> = std::sync::Arc::default();
        let rq = reqs.clone();
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .respond_with(move |req: &wiremock::Request| {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                rq.lock().unwrap().push(body);
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"choices": [{"message": {"content": "[]"}}]}))
            })
            .mount(&s).await;
        let conn = db();
        kv_set(&conn, "ai_base_url", &s.uri()).unwrap();
        kv_set(&conn, "ai_model", "test-model").unwrap();
        let long = "x".repeat(3000);
        let good = seed_inbox_note(&conn, "long", "!INBOX", &long);
        let ai_ks = crate::keys::MockKeyStore::default();
        ai_ks.set("sk-test").unwrap();
        let state = AppState::new(conn, Box::new(crate::keys::MockKeyStore::default()), Box::new(ai_ks)).unwrap();
        triage_suggest_inner(&state, vec![good.id]).await.unwrap();
        let sent = reqs.lock().unwrap();
        let note0 = &sent[0]["messages"][1]["content"]
            .as_str()
            .map(|c| serde_json::from_str::<serde_json::Value>(c).unwrap())
            .unwrap()["notes"][0];
        let c = note0["content"].as_str().unwrap();
        assert_eq!(c.chars().count(), 2000, "the prompt body truncates the note to the cap");
        assert!(c.chars().all(|ch| ch == 'x'));
    }

    #[test]
    fn triage_tag_vocab_defaults_without_persisting() {
        let conn = db();
        let v = triage_tag_vocab_inner(&conn).unwrap();
        assert_eq!(v, vec!["todo", "cmd", "incident", "research"]);
        // the read NEVER persists the default (facts §18 law)
        let raw: Option<String> = conn
            .query_row("SELECT value FROM sync_state WHERE key='triage_tag_vocab'", [], |r| r.get(0))
            .optional()
            .unwrap();
        assert!(raw.is_none(), "defaults stay unpersisted");
    }

    #[test]
    fn triage_tag_vocab_add_normalizes_dedups_and_persists() {
        let conn = db();
        let v1 = triage_tag_vocab_add_inner(&conn, "  #FreshTag ").unwrap();
        assert_eq!(v1.last().unwrap(), "freshtag", "trim + strip # + lowercase");
        // re-adding the same tag in any casing/shape dedupes: list unchanged
        let v2 = triage_tag_vocab_add_inner(&conn, "#FRESHTAG").unwrap();
        assert_eq!(v2, v1);
        let v3 = triage_tag_vocab_add_inner(&conn, "freshtag").unwrap();
        assert_eq!(v3, v1);
        // and the existing default tags dedupe the same way
        let v4 = triage_tag_vocab_add_inner(&conn, "#TODO").unwrap();
        assert_eq!(v4, v1, "default tags also dedupe, list unchanged");
        // the MERGED array persisted as kv TEXT (a future read gets the merge
        // back even from a fresh process — the defaults are NOT re-seeded)
        let raw: String = conn
            .query_row("SELECT value FROM sync_state WHERE key='triage_tag_vocab'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(raw, serde_json::json!(["todo", "cmd", "incident", "research", "freshtag"]).to_string());
        assert_eq!(triage_tag_vocab_inner(&conn).unwrap(), v1, "read-back equals the merged list");
    }

    #[test]
    fn triage_tag_vocab_add_rejects_empty() {
        let conn = db();
        for bad in ["", "   ", "###"] {
            assert!(triage_tag_vocab_add_inner(&conn, bad).is_err(), "{bad:?} rejected");
        }
        // nothing persisted by rejected adds
        let raw: Option<String> = conn
            .query_row("SELECT value FROM sync_state WHERE key='triage_tag_vocab'", [], |r| r.get(0))
            .optional()
            .unwrap();
        assert!(raw.is_none());
    }

    #[test]
    fn triage_confidence_threshold_default_when_absent_or_garbage() {
        let conn = db();
        assert_eq!(get_triage_settings_inner(&conn).unwrap().confidence_threshold, 0.70);
        kv_set(&conn, "triage_confidence_threshold", "abc").unwrap();
        assert_eq!(get_triage_settings_inner(&conn).unwrap().confidence_threshold, 0.70);
        kv_set(&conn, "triage_confidence_threshold", "1.5").unwrap(); // out of clamp -> default
        assert_eq!(get_triage_settings_inner(&conn).unwrap().confidence_threshold, 0.70);
        kv_set(&conn, "triage_confidence_threshold", "").unwrap();
        assert_eq!(get_triage_settings_inner(&conn).unwrap().confidence_threshold, 0.70);
        assert_eq!(get_triage_settings_inner(&conn).unwrap().confidence_threshold, 0.70);
    }

    #[test]
    fn triage_confidence_threshold_set_rejects_out_of_range() {
        let conn = db();
        let err = set_triage_settings_inner(&conn, 1.5).expect_err("out of range");
        assert!(err.to_string().contains("between 0 and 1"), "{err}");
        let err2 = set_triage_settings_inner(&conn, -0.1).expect_err("negative rejected");
        assert!(err2.to_string().contains("between 0 and 1"), "{err2}");
        // the kv stays untouched by the rejected writes
        let raw: Option<String> = conn
            .query_row("SELECT value FROM sync_state WHERE key='triage_confidence_threshold'", [], |r| r.get(0))
            .optional()
            .unwrap();
        assert!(raw.is_none());
        // boundaries are LEGAL (review focus 5: 0 and 1 inclusive)
        set_triage_settings_inner(&conn, 0.0).unwrap();
        set_triage_settings_inner(&conn, 1.0).unwrap();
    }

    #[test]
    fn triage_confidence_threshold_set_round_trips() {
        let conn = db();
        set_triage_settings_inner(&conn, 0.9).unwrap();
        let raw: String = conn
            .query_row("SELECT value FROM sync_state WHERE key='triage_confidence_threshold'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(raw, "0.9", "TEXT storage law");
        assert_eq!(get_triage_settings_inner(&conn).unwrap().confidence_threshold, 0.9);
    }

    // ---- P9 board column editor: command-layer fences (ONLINE-ONLY) ----

    #[tokio::test]
    async fn board_column_inners_reject_non_kanban_and_make_no_http() {
        let s = wiremock::MockServer::start().await;
        let state = test_state_with_client(&s.uri()).await;
        {
            let conn = state.db.lock().await;
            conn.execute(
                "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('b1','B','Home','regular','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',0)",
                [],
            ).unwrap();
        }
        assert_eq!(
            add_board_column_inner(&state, "b1", "New", None).await.unwrap_err().to_string(),
            "columns only work on kanban boards"
        );
        assert_eq!(
            update_board_column_inner(&state, "b1", "todo", Some("X".into()), None, None).await.unwrap_err().to_string(),
            "columns only work on kanban boards"
        );
        assert_eq!(
            delete_board_column_inner(&state, "b1", "todo").await.unwrap_err().to_string(),
            "columns only work on kanban boards"
        );
        assert_eq!(
            move_board_column_inner(&state, "b1", "todo", "up").await.unwrap_err().to_string(),
            "columns only work on kanban boards"
        );
        assert_eq!(s.received_requests().await.unwrap().len(), 0, "gated inners must issue zero http requests");
    }

    #[tokio::test]
    async fn add_board_column_generates_slug_and_order_from_cache() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/tasks/b1/statuses"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true})))
            .mount(&s).await;
        let state = test_state_with_client(&s.uri()).await;
        {
            let conn = state.db.lock().await;
            seed_checklist_row(&conn, "b1", "B");
            board::replace_cache(&conn, "b1", &[
                ("todo", "To Do", None, 0, false),
                ("in_progress", "In Progress", None, 1, false),
                ("completed", "Completed", None, 2, true),
            ]).unwrap();
        }
        add_board_column_inner(&state, "b1", "In Review", None).await.unwrap();
        let reqs = s.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 1);
        let body: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
        assert_eq!(body, serde_json::json!({"id":"in-review","label":"In Review","order":3}));
    }

    #[tokio::test]
    async fn add_board_column_dedupes_slug_collision_with_suffix() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/tasks/b1/statuses"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true})))
            .mount(&s).await;
        let state = test_state_with_client(&s.uri()).await;
        {
            let conn = state.db.lock().await;
            seed_checklist_row(&conn, "b1", "B");
            board::replace_cache(&conn, "b1", &[
                ("in-review", "In Review", None, 0, false),
                ("completed", "Completed", None, 1, true),
            ]).unwrap();
        }
        add_board_column_inner(&state, "b1", "In Review", None).await.unwrap();
        let reqs = s.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 1);
        let body: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
        assert_eq!(body, serde_json::json!({"id":"in-review-1","label":"In Review","order":2}));
    }

    #[tokio::test]
    async fn add_board_column_falls_back_to_col_for_non_sluggable_label() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/tasks/b1/statuses"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true})))
            .mount(&s).await;
        let state = test_state_with_client(&s.uri()).await;
        {
            let conn = state.db.lock().await;
            seed_checklist_row(&conn, "b1", "B");
            board::replace_cache(&conn, "b1", &[]).unwrap();
        }
        add_board_column_inner(&state, "b1", "ααα", None).await.unwrap();
        let reqs = s.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 1);
        let body: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
        assert_eq!(body, serde_json::json!({"id":"col","label":"ααα","order":0}));
    }

    #[tokio::test]
    async fn update_board_column_sends_only_some_keys() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        Mock::given(method("PUT")).and(path("/api/tasks/b1/statuses/todo"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true})))
            .mount(&s).await;
        let state = test_state_with_client(&s.uri()).await;
        {
            let conn = state.db.lock().await;
            seed_checklist_row(&conn, "b1", "B");
            board::replace_cache(
                &conn,
                "b1",
                &[("todo", "To Do", None, 0, false), ("completed", "Completed", None, 1, true)],
            ).unwrap();
        }
        update_board_column_inner(&state, "b1", "todo", Some("Backlog-ish".into()), None, None).await.unwrap();
        let reqs = s.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 1);
        let body: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
        assert_eq!(body, serde_json::json!({"label":"Backlog-ish"}));
    }

    #[tokio::test]
    async fn delete_board_column_rejects_when_two_or_fewer_columns() {
        let state = test_state_with_client("http://127.0.0.1:1").await;
        {
            let conn = state.db.lock().await;
            seed_checklist_row(&conn, "b1", "B");
            board::replace_cache(
                &conn,
                "b1",
                &[("todo", "To Do", None, 0, false), ("completed", "Completed", None, 1, true)],
            ).unwrap();
        }
        let err = delete_board_column_inner(&state, "b1", "todo").await.unwrap_err();
        assert!(err.to_string().contains("a board keeps at least two columns"), "{err}");
    }

    #[tokio::test]
    async fn delete_board_column_hits_when_three_or_more_columns() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        Mock::given(method("DELETE")).and(path("/api/tasks/b1/statuses/st2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true})))
            .mount(&s).await;
        let state = test_state_with_client(&s.uri()).await;
        {
            let conn = state.db.lock().await;
            seed_checklist_row(&conn, "b1", "B");
            board::replace_cache(
                &conn,
                "b1",
                &[
                    ("st1", "One", None, 0, false),
                    ("st2", "Two", None, 1, false),
                    ("st3", "Three", None, 2, true),
                ],
            ).unwrap();
        }
        delete_board_column_inner(&state, "b1", "st2").await.unwrap();
        let reqs = s.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].method.as_ref(), "DELETE");
        let body: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
        assert_eq!(body, serde_json::json!({}));
    }

    #[tokio::test]
    async fn move_board_column_swaps_order_with_neighbor() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        Mock::given(method("PUT")).and(path("/api/tasks/b1/statuses/st1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true})))
            .mount(&s).await;
        Mock::given(method("PUT")).and(path("/api/tasks/b1/statuses/st2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true})))
            .mount(&s).await;
        let state = test_state_with_client(&s.uri()).await;
        {
            let conn = state.db.lock().await;
            seed_checklist_row(&conn, "b1", "B");
            board::replace_cache(
                &conn,
                "b1",
                &[
                    ("st1", "One", None, 0, false),
                    ("st2", "Two", None, 1, false),
                    ("st3", "Three", None, 2, true),
                ],
            ).unwrap();
        }
        move_board_column_inner(&state, "b1", "st1", "down").await.unwrap();
        let reqs = s.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 2);
        assert_eq!(String::from_utf8_lossy(&reqs[0].body), r#"{"order":1}"#);
        assert_eq!(String::from_utf8_lossy(&reqs[1].body), r#"{"order":0}"#);
    }

    #[tokio::test]
    async fn move_board_column_at_edge_makes_zero_calls() {
        let s = wiremock::MockServer::start().await;
        let state = test_state_with_client(&s.uri()).await;
        {
            let conn = state.db.lock().await;
            seed_checklist_row(&conn, "b1", "B");
            board::replace_cache(
                &conn,
                "b1",
                &[
                    ("st1", "One", None, 0, false),
                    ("st2", "Two", None, 1, false),
                    ("st3", "Three", None, 2, true),
                ],
            ).unwrap();
        }
        move_board_column_inner(&state, "b1", "st1", "up").await.unwrap();
        move_board_column_inner(&state, "b1", "st3", "down").await.unwrap();
        assert_eq!(s.received_requests().await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn move_board_column_rejects_unknown_status() {
        let s = wiremock::MockServer::start().await;
        let state = test_state_with_client(&s.uri()).await;
        {
            let conn = state.db.lock().await;
            seed_checklist_row(&conn, "b1", "B");
            board::replace_cache(
                &conn,
                "b1",
                &[("st1", "One", None, 0, false), ("st2", "Two", None, 1, false)],
            ).unwrap();
        }
        let err = move_board_column_inner(&state, "b1", "ghost", "up").await.unwrap_err();
        assert!(err.to_string().contains("status ghost not found"), "{err}");
    }

    #[tokio::test]
    async fn board_column_inners_err_when_offline() {
        let state = test_state_with_client("http://127.0.0.1:1").await;
        {
            let conn = state.db.lock().await;
            seed_checklist_row(&conn, "b1", "B");
            board::replace_cache(
                &conn,
                "b1",
                &[
                    ("todo", "To Do", None, 0, false),
                    ("in_progress", "In Progress", None, 1, false),
                    ("completed", "Completed", None, 2, true),
                ],
            ).unwrap();
        }
        assert!(add_board_column_inner(&state, "b1", "X", None).await.is_err());
        assert!(update_board_column_inner(&state, "b1", "todo", Some("X".into()), None, None).await.is_err());
        assert!(delete_board_column_inner(&state, "b1", "todo").await.is_err());
        assert!(move_board_column_inner(&state, "b1", "todo", "down").await.is_err());
    }
}
