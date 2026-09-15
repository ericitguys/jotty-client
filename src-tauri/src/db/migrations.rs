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
];

pub fn run(conn: &Connection) -> AppResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", (i + 1) as i64)?;
    }
    Ok(())
}