use crate::error::AppResult;
use rusqlite::Connection;

pub const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'Uncategorized',
        created_at TEXT,
        updated_at TEXT,
        deleted_at TEXT,
        dirty INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE checklists (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Uncategorized',
        list_type TEXT NOT NULL DEFAULT 'simple',
        created_at TEXT,
        updated_at TEXT,
        deleted_at TEXT,
        dirty INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE checklist_items (
        local_id TEXT PRIMARY KEY,
        checklist_id TEXT NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
        parent_id TEXT,
        text TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL,
        server_path TEXT,
        dirty INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_items_list ON checklist_items(checklist_id, position);
    CREATE TABLE outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        op_type TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX idx_outbox_pending ON outbox(state, seq);
    CREATE TABLE sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title, content);
    CREATE VIRTUAL TABLE lists_fts USING fts5(id UNINDEXED, title, item_text);
    "#,
    // v2 — voice notes (2026-09-18): staging table + local-only audio columns.
    // audio_path/audio_duration_secs are LOCAL-ONLY: they must never reach the
    // sync engine (spec §5). Sync code uses explicit column lists everywhere.
    r#"
    ALTER TABLE notes ADD COLUMN audio_path TEXT;
    ALTER TABLE notes ADD COLUMN audio_duration_secs REAL;
    CREATE TABLE voice_recordings (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        duration_secs REAL NOT NULL DEFAULT 0,
        raw_transcript TEXT,
        tidied_transcript TEXT,
        state TEXT NOT NULL DEFAULT 'recording',
        last_error TEXT,
        created_at TEXT NOT NULL
    );
    "#,
    // v3 — kanban boards (2026-09-20): per-item status + display-only fields,
    // plus the board_statuses COLUMN CACHE (site-truth, refreshed by
    // fetch_task_board; never dirty-tracked, never touched by sync pull).
    r#"
    ALTER TABLE checklist_items ADD COLUMN status TEXT;
    ALTER TABLE checklist_items ADD COLUMN priority TEXT;
    ALTER TABLE checklist_items ADD COLUMN target_date TEXT;
    CREATE TABLE board_statuses (
        checklist_id TEXT NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
        status_id TEXT NOT NULL,
        label TEXT NOT NULL,
        color TEXT,
        sort_order INTEGER NOT NULL,
        auto_complete INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (checklist_id, status_id)
    );
    CREATE INDEX idx_board_statuses ON board_statuses(checklist_id, sort_order);
    "#,
    // v4 — appointments (2026-09-28): per-item start date, stable server item
    // id, reminder columns. Additive; server-mirrored (dates, id) or
    // kanban-enriched (reminder) — never client-invented (spec §5.1).
    r#"
    ALTER TABLE checklist_items ADD COLUMN start_date TEXT;
    ALTER TABLE checklist_items ADD COLUMN server_item_id TEXT;
    ALTER TABLE checklist_items ADD COLUMN reminder_datetime TEXT;
    ALTER TABLE checklist_items ADD COLUMN reminder_notified INTEGER;
    "#,
    r#"
-- v5: kanban recurrence (2026-10-05) - LOCAL-ONLY client-side recurrence data on
-- checklist items. Never synced, never in outbox ops, never dirty-tracked by this
-- column; authored/rolled by this device (db/recurrence.rs). Same contract class
-- as the voice audio columns.
ALTER TABLE checklist_items ADD COLUMN recurrence TEXT;
    "#,
    // v6 — kanban card details (2026-10-09): upstream-writable rich fields on
    // checklist items (PATCH /api/checklists/{listId}/items/{indexPath} accepts
    // text/description/priority/estimatedTime with null-clears — live-probed
    // 1.28.0). Additive; BOTH server-mirrored (reconcile carries them on clean
    // claims, dirty rows keep their local values — existing dirty-fence law).
    // estimated_time INTEGER: whole hours only cross the DB (upstream truncates
    // fractional hours server-side; the client flattens f64 -> i64).
    r#"
    ALTER TABLE checklist_items ADD COLUMN description TEXT;
    ALTER TABLE checklist_items ADD COLUMN estimated_time INTEGER;
    "#,
];

pub fn run(conn: &Connection) -> AppResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", (i + 1) as i64)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{MIGRATIONS, run};
    use crate::db::open;
    use rusqlite::Connection;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        conn
    }

    // P8 Task 1 (gate R6): after a FRESH FULL migrations::run() the
    // checklist_items table must carry BOTH new card-detail columns with the
    // exact declared types. Type pin matters: estimated_time must be INTEGER
    // (i64 crosses the DB — server-side fractional hours are truncated at
    // flatten, never stored as float), description TEXT.
    #[test]
    fn migration_v6_adds_item_description_and_estimated_time_columns() {
        let conn = db();
        run(&conn).unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert!(v >= 6, "a full run must reach v6, got {v}");
        let mut stmt = conn.prepare("PRAGMA table_info(checklist_items)").unwrap();
        let cols: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let decl = |name: &str| cols.iter().find(|(n, _)| n == name).map(|(_, t)| t.clone());
        assert_eq!(decl("description").as_deref(), Some("TEXT"), "columns: {cols:?}");
        assert_eq!(decl("estimated_time").as_deref(), Some("INTEGER"), "columns: {cols:?}");
    }

    // v5 -> v6 must be ADDITIVE (the run() contract: MIGRATIONS is a cumulative
    // vec, each entry is one version's batch). A row inserted at the v5 state
    // (v6 columns ABSENT) must survive the upgrade intact, with the new
    // columns NULL — never a table rebuild or a data loss.
    #[test]
    fn migration_v5_to_v6_is_additive_rows_survive_with_null_new_columns() {
        let conn = db();
        // apply v1..v5 EXACTLY the way run() applies them (batch per entry,
        // user_version bumped per entry) so the db sits at the real v5 state
        for (i, sql) in MIGRATIONS.iter().enumerate().take(5) {
            conn.execute_batch(sql).unwrap();
            conn.pragma_update(None, "user_version", (i + 1) as i64).unwrap();
        }
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 5, "seed state must be the real v5");
        // v5-era rows (no description/estimated_time columns exist yet)
        conn.execute(
            "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('l1','L','Home','kanban','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO checklist_items (local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date, start_date, server_item_id, reminder_datetime, reminder_notified, recurrence)
             VALUES ('it-1','l1',NULL,'card a',1,0,'0',0,'todo','high','2026-10-01','2026-09-30',NULL,NULL,NULL,NULL)",
            [],
        ).unwrap();
        // upgrade v5 -> v6 through the REAL run()
        run(&conn).unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 6, "run() must land exactly on v6 after the v5 seed");
        let (text, status, priority, target_date, recurrence, description, estimated_time): (
            String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<i64>,
        ) = conn.query_row(
            "SELECT text, status, priority, target_date, recurrence, description, estimated_time FROM checklist_items WHERE local_id='it-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        ).unwrap();
        assert_eq!(text, "card a", "pre-existing row must survive the additive migration");
        assert_eq!(status.as_deref(), Some("todo"));
        assert_eq!(priority.as_deref(), Some("high"));
        assert_eq!(target_date.as_deref(), Some("2026-10-01"));
        assert_eq!(recurrence, None);
        assert_eq!(description, None, "new v6 column starts NULL on migrated rows");
        assert_eq!(estimated_time, None, "new v6 column starts NULL on migrated rows");
    }
}