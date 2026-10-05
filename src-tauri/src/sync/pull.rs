use crate::db::{checklists, items, notes, outbox};
use crate::error::AppResult;
use crate::jotty::client::JottyClient;
use crate::jotty::models::{KanbanBoard, ServerKanbanItem, ServerChecklist, ServerNote};
use chrono::Utc;
use rusqlite::Connection;

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct PullStats {
    pub notes_applied: usize,
    pub lists_applied: usize,
    pub tombstones: usize,
    // T3: per-board enrichment failures (fetch/parse/merge) — the pull NEVER
    // aborts on them; counts ride the sync report (camelCase mirror rides T5).
    pub enrichment_errors: usize,
}

pub async fn pull_all(conn: &mut Connection, client: &JottyClient) -> AppResult<PullStats> {
    // NB: `?` propagation, NOT unwrap_or_default — a failed catalog fetch must ABORT the
    // pull before the tombstone pass. Tombstoning against an empty/failing snapshot would
    // mass-delete every clean local entity on a transient network error (proven in the
    // Task 10 pre-dispatch scan; ruling in ledger).
    let server_notes = client.get_notes().await?;
    let server_lists = client.get_checklists().await?;
    let mut stats = PullStats::default();

    {
        let tx = conn.transaction()?;
        for n in &server_notes {
            if notes::upsert_from_server(&tx, n)? {
                stats.notes_applied += 1;
            }
        }
        for c in &server_lists {
            if checklists::upsert_list_from_server(&tx, c)? {
                stats.lists_applied += 1;
            }
        }
        tx.commit()?;
    }

    // tombstones
    let mut tombstones = 0usize;
    {
        let tx = conn.transaction()?;
        let present_notes: std::collections::HashSet<&str> = server_notes.iter().map(|n| n.id.as_str()).collect();
        for n in notes::list(&tx, true)? {
            if n.dirty || n.deleted_at.is_some() { continue; }
            if !present_notes.contains(n.id.as_str()) && !outbox::has_pending_for(&tx, "note", &n.id)? {
                notes::tombstone(&tx, &n.id)?;
                tombstones += 1;
            }
        }
        let present_lists: std::collections::HashSet<&str> = server_lists.iter().map(|c| c.id.as_str()).collect();
        for c in checklists::list_checklists(&tx, true)? {
            if c.dirty || c.deleted_at.is_some() { continue; }
            if !present_lists.contains(c.id.as_str()) && !outbox::has_pending_for(&tx, "checklist", &c.id)? {
                checklists::tombstone(&tx, &c.id)?;
                tombstones += 1;
            }
        }
        tx.commit()?;
    }
    stats.tombstones = tombstones;

    // T3 kanban reminder enrichment: AFTER the tombstone tx, BEFORE the
    // last_sync_at write. Per-board failures (fetch/parse/merge) accumulate
    // into stats.enrichment_errors; the pull NEVER aborts on them and
    // last_sync_at is still written. Local reminder values stay last-known on
    // failure — never zeroed.
    enrich_kanban_reminders(conn, client, &mut stats).await?;

    // T3 (R-rec-5): recurrence sweep AFTER enrichment, BEFORE the last_sync
    // write — server-checked recurring cards complete via the catalog
    // reconcile up top and must roll before the pull reports done. Non-fatal:
    // a sweep failure rides the SAME error channel the enrichment errors use
    // (log::warn + stats.enrichment_errors); the pull NEVER aborts on it and
    // last_sync_at is still written.
    if let Err(e) = crate::db::recurrence::sweep(conn, Utc::now()) {
        log::warn!("recurrence sweep: {e}");
        stats.enrichment_errors += 1;
    }

    // record last sync
    conn.execute(
        "INSERT INTO sync_state(key, value) VALUES ('last_sync_at', ?1)
         ON CONFLICT(key) DO UPDATE SET value=?1",
        [Utc::now().to_rfc3339()],
    )?;

    Ok(stats)
}

/// DFS index paths for kanban board items ("0", "0.1" — the same dot-notation
/// DFS convention as reconcile's ServerItem flatten).
fn flatten_kanban<'a>(prefix: &str, items: &'a [ServerKanbanItem], out: &mut Vec<(String, &'a ServerKanbanItem)>) {
    for (i, it) in items.iter().enumerate() {
        let path = if prefix.is_empty() { i.to_string() } else { format!("{prefix}.{i}") };
        out.push((path.clone(), it));
        flatten_kanban(&path, &it.children, out);
    }
}

/// Per-board reminder merge (T3): resolve each ServerKanbanItem to its local
/// row — (a) stable server_item_id, (b) DFS index path, (c) clean same-text
/// adopt — then mirror srv.reminder onto reminder_datetime/reminder_notified
/// WITHOUT touching dirty. A pending item is SKIPPED (its in-flight op wins);
/// siblings on the same board still enrich. ONE tx per board.
fn merge_board_reminders(conn: &mut Connection, board_id: &str, board: &KanbanBoard) -> AppResult<()> {
    let tx = conn.transaction()?;
    let rows = items::list_for_checklist(&tx, board_id)?;
    let mut flat: Vec<(String, &ServerKanbanItem)> = Vec::new();
    flatten_kanban("", &board.items, &mut flat);
    let mut claimed: std::collections::HashSet<String> = Default::default();
    for (index_path, srv) in &flat {
        // (a) stable server id (srv.id may be None -> fall through)
        let mut target: Option<&items::ItemRow> = None;
        if let Some(sid) = &srv.id {
            target = rows.iter().find(|r| {
                r.server_item_id.as_deref() == Some(sid.as_str()) && !claimed.contains(&r.local_id)
            });
        }
        // (b) DFS index-path fallback (same convention as reconcile's flatten)
        if target.is_none() {
            target = rows.iter().find(|r| {
                r.server_path.as_deref() == Some(index_path.as_str()) && !claimed.contains(&r.local_id)
            });
        }
        // (c) adopt class: unclaimed, no stable id, clean, same text
        if target.is_none() {
            target = rows.iter().find(|r| {
                r.server_item_id.is_none()
                    && !claimed.contains(&r.local_id)
                    && !r.dirty
                    && r.text == srv.text
                    && !matches!(outbox::has_pending_for(&tx, "checklist_item", &r.local_id), Ok(true))
            });
        }
        let Some(row) = target else { continue };
        claimed.insert(row.local_id.clone());
        // (d) per-item pending shield (spec §5.3): the in-flight local
        // reminder write wins; siblings still enrich.
        if matches!(outbox::has_pending_for(&tx, "checklist_item", &row.local_id), Ok(true)) {
            continue;
        }
        // (e) server truth mirror — never touches dirty.
        let (datetime, notified) = match &srv.reminder {
            Some(r) => (Some(r.datetime.clone()), r.notified),
            None => (None, None),
        };
        items::set_reminder_from_server(&tx, &row.local_id, datetime, notified)?;
    }
    tx.commit()?;
    Ok(())
}

/// Enrichment pass over every clean kanban/task board. Board-level failures
/// (GET/parse/merge) count into stats.enrichment_errors and the pull moves on;
/// only a db-level failure (the board SELECT) aborts the pull.
async fn enrich_kanban_reminders(conn: &mut Connection, client: &JottyClient, stats: &mut PullStats) -> AppResult<()> {
    let board_ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM checklists WHERE deleted_at IS NULL AND dirty=0 AND list_type IN ('kanban','task')",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for board_id in &board_ids {
        match client.get_kanban_board(board_id).await {
            Ok(board) => {
                if let Err(e) = merge_board_reminders(conn, board_id, &board) {
                    log::warn!("reminder enrichment merge failed for board {board_id}: {e}");
                    stats.enrichment_errors += 1;
                }
            }
            Err(e) => {
                // non-fatal: local reminder values stay last-known, NEVER zeroed
                log::warn!("kanban board fetch failed during reminder enrichment: {e}");
                stats.enrichment_errors += 1;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations, open};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    use std::path::Path;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&conn).unwrap();
        conn
    }

    async fn server_with_notes_and_lists(notes_json: serde_json::Value, lists_json: serde_json::Value) -> MockServer {
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(notes_json)).mount(&s).await;
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(lists_json)).mount(&s).await;
        s
    }

    fn note_json(id: &str, title: &str, updated: &str) -> serde_json::Value {
        serde_json::json!({"id": id, "title": title, "category": "Home", "content": "c", "createdAt": "2024-01-01T00:00:00.000Z", "updatedAt": updated})
    }

    #[tokio::test]
    async fn fresh_pull_imports_everything() {
        let s = server_with_notes_and_lists(
            serde_json::json!({"notes": [note_json("n1", "A", "2026-01-01T00:00:00.000Z")]}),
            serde_json::json!({"checklists": [{"id": "l1", "title": "L", "category": "Home", "items": [], "createdAt": "2024-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}]}),
        ).await;
        let mut conn = db();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = pull_all(&mut conn, &client).await.unwrap();
        assert_eq!(stats.notes_applied, 1);
        assert_eq!(stats.lists_applied, 1);
        assert_eq!(notes::list(&conn, false).unwrap().len(), 1);
        assert_eq!(checklists::list_checklists(&conn, false).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn absent_entities_are_tombstoned() {
        let s = server_with_notes_and_lists(
            serde_json::json!({"notes": []}),
            serde_json::json!({"checklists": []}),
        ).await;
        let mut conn = db();
        let n = notes::insert_local(&conn, &notes::NewNote { title: "x".into(), content: "".into(), category: "Home".into() }).unwrap();
        notes::mark_synced(&conn, &n.id, "2026-01-01T00:00:00.000Z").unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = pull_all(&mut conn, &client).await.unwrap();
        assert_eq!(stats.tombstones, 1);
        assert!(notes::get(&conn, &n.id).unwrap().unwrap().deleted_at.is_some());
        // dirty entities survive
        let dirty = notes::insert_local(&conn, &notes::NewNote { title: "y".into(), content: "".into(), category: "Home".into() }).unwrap();
        pull_all(&mut conn, &client).await.unwrap();
        assert!(notes::get(&conn, &dirty.id).unwrap().unwrap().deleted_at.is_none(), "dirty note must survive pull");
    }

    // ------------------------------------------------------------------
    // T3: kanban reminder enrichment (fences). Every test mounts its OWN
    // mocks — unmatched requests get a default 404, which would silently
    // abort the pull (catalog rule), so notes + catalog + board GETs are
    // all mounted per test.

    /// Canonical board wire shape (T2 binding ruling): statuses are
    /// {"id","label","order","autoComplete"}, items transformItem-shaped
    /// (the only board GET carrying `reminder`).
    fn board_envelope(id: &str, items: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "board": {"id": id, "title": "B", "category": "Home",
                "statuses": [{"id": "todo", "label": "To Do", "order": 0, "autoComplete": false}],
                "items": items,
                "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}
        })
    }

    /// Catalog list payload — `type` drives the local list_type the
    /// enrichment query filters on (kanban family).
    fn kanban_catalog_list(id: &str, items: serde_json::Value) -> serde_json::Value {
        serde_json::json!({"id": id, "title": "B", "category": "Home", "type": "kanban", "items": items,
            "createdAt": "2024-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"})
    }

    fn seed_kanban_list(conn: &Connection, list_id: &str) {
        conn.execute(
            "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES (?1,'B','Home','kanban','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0)",
            [list_id],
        ).unwrap();
    }

    fn seed_item(
        conn: &Connection,
        list_id: &str,
        local_id: &str,
        text: &str,
        server_item_id: Option<&str>,
        server_path: Option<&str>,
        reminder: Option<(&str, i64)>,
    ) {
        conn.execute(
            "INSERT INTO checklist_items (local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date, start_date, server_item_id, reminder_datetime, reminder_notified)
             VALUES (?1, ?2, NULL, ?3, 0, 0, ?4, 0, 'todo', NULL, NULL, NULL, ?5, ?6, ?7)",
            rusqlite::params![local_id, list_id, text, server_path, server_item_id, reminder.map(|r| r.0), reminder.map(|r| r.1)],
        ).unwrap();
    }

    #[tokio::test]
    async fn enrichment_merges_reminders_by_server_item_id() {
        // Rule (a): the stable server id match must win over the index-path
        // fallback. The board's items are REORDERED vs the catalog — a
        // path-only merge would stamp the wrong card's reminder.
        let catalog_items = serde_json::json!([
            {"id": "srv-1", "index": 0, "text": "Dentist", "completed": false},
            {"id": "srv-2", "index": 1, "text": "Other", "completed": false}
        ]);
        let s = server_with_notes_and_lists(
            serde_json::json!({"notes": []}),
            serde_json::json!({"checklists": [kanban_catalog_list("l1", catalog_items)]}),
        ).await;
        Mock::given(method("GET")).and(path("/api/kanban/l1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(board_envelope("l1", serde_json::json!([
                {"id": "srv-2", "index": 0, "text": "Other", "status": "todo", "completed": false,
                    "reminder": {"datetime": "2026-11-01T08:00:00.000Z", "notified": false}},
                {"id": "srv-1", "index": 1, "text": "Dentist", "status": "todo", "completed": false,
                    "reminder": {"datetime": "2026-10-01T09:00:00.000Z", "notified": false}}
            ]))))
            .mount(&s).await;
        let mut conn = db();
        seed_kanban_list(&conn, "l1");
        seed_item(&conn, "l1", "it-1", "Dentist", Some("srv-1"), Some("0"), None);
        seed_item(&conn, "l1", "it-2", "Other", Some("srv-2"), Some("1"), None);
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        pull_all(&mut conn, &client).await.unwrap();
        let row = crate::db::items::get(&conn, "it-1").unwrap().unwrap();
        assert_eq!(row.reminder_datetime.as_deref(), Some("2026-10-01T09:00:00.000Z"),
            "the board reminder must merge onto the id-matched row (Dentist), not the path-matched one");
        assert_eq!(row.reminder_notified, Some(false), "notified false must map to 0");
        let row2 = crate::db::items::get(&conn, "it-2").unwrap().unwrap();
        assert_eq!(row2.reminder_datetime.as_deref(), Some("2026-11-01T08:00:00.000Z"));
        assert!(!row.dirty, "enrichment is a server mirror — dirty untouched");
    }

    #[tokio::test]
    async fn enrichment_falls_back_to_index_path() {
        // Rule (b): a row without a stable server id (catalog item id-less)
        // still enriches via the DFS index path ("0" — reconcile's convention).
        let s = server_with_notes_and_lists(
            serde_json::json!({"notes": []}),
            serde_json::json!({"checklists": [kanban_catalog_list("l1", serde_json::json!([
                {"index": 0, "text": "Dentist", "completed": false}
            ]))]}),
        ).await;
        Mock::given(method("GET")).and(path("/api/kanban/l1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(board_envelope("l1", serde_json::json!([
                {"index": 0, "text": "Dentist", "status": "todo", "completed": false,
                    "reminder": {"datetime": "2026-10-01T09:00:00.000Z", "notified": true}}
            ]))))
            .mount(&s).await;
        let mut conn = db();
        seed_kanban_list(&conn, "l1");
        seed_item(&conn, "l1", "it-1", "Dentist", None, Some("0"), None);
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        pull_all(&mut conn, &client).await.unwrap();
        let row = crate::db::items::get(&conn, "it-1").unwrap().unwrap();
        assert_eq!(row.reminder_datetime.as_deref(), Some("2026-10-01T09:00:00.000Z"),
            "the id-less row must enrich via its index path");
        assert_eq!(row.reminder_notified, Some(true));
    }

    #[tokio::test]
    async fn enrichment_clears_local_reminder_when_server_shows_none() {
        // Server truth: the card has NO reminder -> the stale local reminder is
        // cleared to NULL (server mirror), dirty untouched.
        let s = server_with_notes_and_lists(
            serde_json::json!({"notes": []}),
            serde_json::json!({"checklists": [kanban_catalog_list("l1", serde_json::json!([
                {"id": "srv-1", "index": 0, "text": "Dentist", "completed": false}
            ]))]}),
        ).await;
        Mock::given(method("GET")).and(path("/api/kanban/l1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(board_envelope("l1", serde_json::json!([
                {"id": "srv-1", "index": 0, "text": "Dentist", "status": "todo", "completed": false}
            ]))))
            .mount(&s).await;
        let mut conn = db();
        seed_kanban_list(&conn, "l1");
        seed_item(&conn, "l1", "it-1", "Dentist", Some("srv-1"), Some("0"),
            Some(("2026-10-01T09:00:00.000Z", 1)));
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        pull_all(&mut conn, &client).await.unwrap();
        let row = crate::db::items::get(&conn, "it-1").unwrap().unwrap();
        assert_eq!(row.reminder_datetime, None, "server-without-reminder must clear the local reminder");
        assert_eq!(row.reminder_notified, None);
    }

    #[tokio::test]
    async fn enrichment_pending_item_is_skipped_sibling_enriched() {
        // Per-item pending shield (spec §5.3): row A has an in-flight op — its
        // local reminder write wins; sibling B still enriches.
        let s = server_with_notes_and_lists(
            serde_json::json!({"notes": []}),
            serde_json::json!({"checklists": [kanban_catalog_list("l1", serde_json::json!([
                {"id": "srv-a", "index": 0, "text": "A", "completed": false},
                {"id": "srv-b", "index": 1, "text": "B", "completed": false}
            ]))]}),
        ).await;
        Mock::given(method("GET")).and(path("/api/kanban/l1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(board_envelope("l1", serde_json::json!([
                {"id": "srv-a", "index": 0, "text": "A", "status": "todo", "completed": false,
                    "reminder": {"datetime": "2026-11-01T08:00:00.000Z", "notified": false}},
                {"id": "srv-b", "index": 1, "text": "B", "status": "todo", "completed": false,
                    "reminder": {"datetime": "2026-11-02T08:00:00.000Z", "notified": false}}
            ]))))
            .mount(&s).await;
        let mut conn = db();
        seed_kanban_list(&conn, "l1");
        seed_item(&conn, "l1", "it-a", "A", Some("srv-a"), Some("0"), Some(("KEEP-A", 1)));
        seed_item(&conn, "l1", "it-b", "B", Some("srv-b"), Some("1"), None);
        crate::db::outbox::enqueue(&conn, "set_reminder", "checklist_item", "it-a",
            &serde_json::json!({"item_local_id": "it-a", "checklist_id": "l1", "datetime": "KEEP-A"})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        pull_all(&mut conn, &client).await.unwrap();
        let a = crate::db::items::get(&conn, "it-a").unwrap().unwrap();
        assert_eq!(a.reminder_datetime.as_deref(), Some("KEEP-A"),
            "a pending item's in-flight reminder write must win (shield)");
        let b = crate::db::items::get(&conn, "it-b").unwrap().unwrap();
        assert_eq!(b.reminder_datetime.as_deref(), Some("2026-11-02T08:00:00.000Z"),
            "the sibling must still enrich");
    }

    #[tokio::test]
    async fn enrichment_board_500_counts_error_and_pull_still_ok() {
        // Board 1 GET fails -> enrichment_errors += 1, pull still Ok,
        // last_sync_at still written, board 2 still enriched, board 1's local
        // reminder stays last-known (NEVER zeroed).
        use rusqlite::OptionalExtension;
        let s = server_with_notes_and_lists(
            serde_json::json!({"notes": []}),
            serde_json::json!({"checklists": [
                {"id": "l1", "title": "B1", "category": "Home", "type": "task", "items": [
                    {"id": "srv-1", "index": 0, "text": "Dentist", "completed": false}],
                    "createdAt": "2024-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"},
                {"id": "l2", "title": "B2", "category": "Home", "type": "kanban", "items": [
                    {"id": "srv-2", "index": 0, "text": "Card", "completed": false}],
                    "createdAt": "2024-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}
            ]}),
        ).await;
        Mock::given(method("GET")).and(path("/api/kanban/l1"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&s).await;
        Mock::given(method("GET")).and(path("/api/kanban/l2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(board_envelope("l2", serde_json::json!([
                {"id": "srv-2", "index": 0, "text": "Card", "status": "todo", "completed": false,
                    "reminder": {"datetime": "2026-12-01T10:00:00.000Z", "notified": false}}
            ]))))
            .mount(&s).await;
        let mut conn = db();
        conn.execute(
            "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('l1','B1','Home','task','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0)", []).unwrap();
        conn.execute(
            "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('l2','B2','Home','kanban','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0)", []).unwrap();
        seed_item(&conn, "l1", "it-1", "Dentist", Some("srv-1"), Some("0"),
            Some(("2026-10-01T09:00:00.000Z", 0)));
        seed_item(&conn, "l2", "it-2", "Card", Some("srv-2"), Some("0"), None);
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = pull_all(&mut conn, &client).await.unwrap();
        assert_eq!(stats.enrichment_errors, 1, "the failed board must count exactly one enrichment error");
        let last: Option<String> = conn.query_row(
            "SELECT value FROM sync_state WHERE key='last_sync_at'", [], |r| r.get(0)).optional().unwrap();
        assert!(last.is_some(), "last_sync_at must still be written after an enrichment error");
        let l2 = crate::db::items::get(&conn, "it-2").unwrap().unwrap();
        assert_eq!(l2.reminder_datetime.as_deref(), Some("2026-12-01T10:00:00.000Z"),
            "the OTHER kanban board must still enrich");
        let l1 = crate::db::items::get(&conn, "it-1").unwrap().unwrap();
        assert_eq!(l1.reminder_datetime.as_deref(), Some("2026-10-01T09:00:00.000Z"),
            "the failed board's local reminder must stay last-known, never zeroed");
    }

    #[tokio::test]
    async fn enrichment_envelope_mismatch_is_error_not_zeroing() {
        // A board payload without the "board" envelope parses Err -> counted,
        // and the local reminder SURVIVES (silently-emptied board lesson).
        use rusqlite::OptionalExtension;
        let s = server_with_notes_and_lists(
            serde_json::json!({"notes": []}),
            serde_json::json!({"checklists": [kanban_catalog_list("l1", serde_json::json!([
                {"id": "srv-1", "index": 0, "text": "Dentist", "completed": false}
            ]))]}),
        ).await;
        Mock::given(method("GET")).and(path("/api/kanban/l1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"nope": 1})))
            .mount(&s).await;
        let mut conn = db();
        seed_kanban_list(&conn, "l1");
        seed_item(&conn, "l1", "it-1", "Dentist", Some("srv-1"), Some("0"),
            Some(("2026-10-01T09:00:00.000Z", 0)));
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = pull_all(&mut conn, &client).await.unwrap();
        assert_eq!(stats.enrichment_errors, 1, "envelope mismatch must count as an enrichment error");
        let last: Option<String> = conn.query_row(
            "SELECT value FROM sync_state WHERE key='last_sync_at'", [], |r| r.get(0)).optional().unwrap();
        assert!(last.is_some(), "pull must still complete");
        let row = crate::db::items::get(&conn, "it-1").unwrap().unwrap();
        assert_eq!(row.reminder_datetime.as_deref(), Some("2026-10-01T09:00:00.000Z"),
            "an unparseable board must never zero the local reminder");
    }

    #[tokio::test]
    async fn enrichment_maps_notified_true() {
        // reminder {datetime, notified: true} -> reminder_notified = 1.
        let s = server_with_notes_and_lists(
            serde_json::json!({"notes": []}),
            serde_json::json!({"checklists": [kanban_catalog_list("l1", serde_json::json!([
                {"id": "srv-1", "index": 0, "text": "Dentist", "completed": false}
            ]))]}),
        ).await;
        Mock::given(method("GET")).and(path("/api/kanban/l1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(board_envelope("l1", serde_json::json!([
                {"id": "srv-1", "index": 0, "text": "Dentist", "status": "todo", "completed": false,
                    "reminder": {"datetime": "2026-10-01T09:00:00.000Z", "notified": true}}
            ]))))
            .mount(&s).await;
        let mut conn = db();
        seed_kanban_list(&conn, "l1");
        seed_item(&conn, "l1", "it-1", "Dentist", Some("srv-1"), Some("0"), None);
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        pull_all(&mut conn, &client).await.unwrap();
        let row = crate::db::items::get(&conn, "it-1").unwrap().unwrap();
        assert_eq!(row.reminder_notified, Some(true), "notified true must map to 1");
        assert_eq!(row.reminder_datetime.as_deref(), Some("2026-10-01T09:00:00.000Z"));
    }

    // ------------------------------------------------------------------
    // T3: recurrence sweep seat in pull_all (R-rec-5). The seat sits at the
    // END of pull_all — AFTER enrich_kanban_reminders, BEFORE the last_sync
    // write — and is non-fatal, riding the same error channel the
    // enrichment errors use (log::warn + stats.enrichment_errors).
    // NOTE: the brief's `(i64,)` tuple query_row shape does not compile
    // (rusqlite 0.32 has no FromSql for (i64,) — Task 2 D2 precedent); the
    // count assert below uses the repo-standard scalar i64 shape.

    #[tokio::test]
    async fn pull_sweep_runs_after_reconcile_server_checked_recurring_rolls() {
        // Discriminates seat ORDER: the server carries completed=true for a locally
        // recurring DUE row that is currently clean and completed=0. If sweep ran
        // BEFORE reconcile, the row would complete (server flag) and stay completed
        // with no ops. Only a post-reconcile sweep un-completes it and enqueues ops.
        let s = server_with_notes_and_lists(
            serde_json::json!({"notes": []}),
            // catalog updatedAt 2026-10-05 is NEWER than the seeded local row's
            // 2026-01-01, so the pull upserts and reconcile CLAIMS the row (arm
            // A via server_item_id + matching text at stamped path '0') — this
            // is why the seed carries server_path='0' AND server_item_id='sid-1';
            // a pathless row would be deleted-and-reinserted unclaimed
            // (recurrence lost, roll never fires). Real catalog envelope shape
            // and item fields byte-mirror the exemplar enrichment fence above.
            serde_json::json!({"checklists": [{
                "id": "l1", "title": "L", "category": "Home", "type": "kanban",
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-10-05T00:00:00Z",
                "items": [{ "id": "sid-1", "index": 0, "text": "Weekly report", "completed": true }]
            }]}),
        ).await;
        Mock::given(method("GET")).and(path("/api/kanban/l1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(board_envelope("l1", serde_json::json!([
                {"id": "sid-1", "index": 0, "text": "Weekly report", "status": "todo", "completed": true}
            ]))))
            .mount(&s).await;
        let mut conn = crate::db::test_conn();
        // seed checklist row + clean recurring item completed=0, due slot in the past
        conn.execute(
            "INSERT INTO checklists (id, title, list_type, created_at, updated_at) VALUES ('l1', 'L', 'kanban', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        let local_id = "i-1";
        conn.execute(
            "INSERT INTO checklist_items (local_id, checklist_id, text, completed, position, dirty, server_path, server_item_id, recurrence) VALUES ('i-1','l1','Weekly report',0,0,0,'0','sid-1',?1)",
            [r#"{"rrule":"FREQ=WEEKLY;INTERVAL=1","dtstart":"2026-09-24T00:00:00+00:00","nextDue":"2026-10-01T00:00:00+00:00"}"#],
        ).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        pull_all(&mut conn, &client).await.unwrap();
        let row = crate::db::items::get(&conn, local_id).unwrap().unwrap();
        assert!(!row.completed, "post-reconcile sweep must reset the just-completed recurring card");
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM outbox WHERE state='pending' AND op_type='check'", [], |r| r.get(0)).unwrap();
        assert!(n >= 1, "roll must enqueue a check(false) op");
    }
}