pub mod categories;
pub mod checklists;
pub mod items;
pub mod migrations;
pub mod notes;
pub mod outbox;

use std::path::Path;
use crate::error::AppResult;

pub fn open(path: &Path) -> AppResult<rusqlite::Connection> {
    let conn = rusqlite::Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn tmp_db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("test.db")).unwrap();
        migrations::run(&conn).unwrap();
        (dir, conn)
    }

    #[test]
    fn migrations_create_all_tables() {
        let (_d, conn) = tmp_db();
        let names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for expected in [
            "notes",
            "checklists",
            "checklist_items",
            "outbox",
            "sync_state",
            "notes_fts",
            "lists_fts",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }

    #[test]
    fn migrations_are_idempotent() {
        let (_d, conn) = tmp_db();
        migrations::run(&conn).unwrap();
        migrations::run(&conn).unwrap();
    }

    #[test]
    fn fts5_is_available() {
        let (_d, conn) = tmp_db();
        conn.execute("INSERT INTO notes_fts(id, title, content) VALUES ('n1', 'hello world', 'body text')", [])
            .unwrap();
        let hits: Vec<String> = conn
            .prepare("SELECT id FROM notes_fts WHERE notes_fts MATCH 'hello'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(hits, vec!["n1"]);
    }
}