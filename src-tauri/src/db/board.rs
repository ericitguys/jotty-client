use rusqlite::Connection;
use crate::error::AppResult;

#[derive(Debug, Clone)]
pub struct BoardStatusRow {
    pub status_id: String,
    pub label: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub auto_complete: bool,
}

/// Seam for Task 1 (ServerStatus arrives in Task 2): (id, label, color, order, autoComplete).
pub type StatusTuple<'a> = (&'a str, &'a str, Option<&'a str>, i64, bool);

/// Site-truth COLUMN CACHE (spec §5, ruling 2): multi-statement autocommit like
/// upsert_list_from_server; a crash mid-rewrite leaves a partial cache the next
/// open repairs. Never touched by sync pull.
pub fn replace_cache(conn: &Connection, checklist_id: &str, statuses: &[StatusTuple]) -> AppResult<()> {
    conn.execute("DELETE FROM board_statuses WHERE checklist_id=?1", [checklist_id])?;
    for (id, label, color, order, auto) in statuses {
        conn.execute(
            "INSERT INTO board_statuses (checklist_id, status_id, label, color, sort_order, auto_complete)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![checklist_id, id, label, color, order, *auto as i64],
        )?;
    }
    Ok(())
}

pub fn list(conn: &Connection, checklist_id: &str) -> AppResult<Vec<BoardStatusRow>> {
    let mut stmt = conn.prepare(
        "SELECT status_id, label, color, sort_order, auto_complete FROM board_statuses
         WHERE checklist_id=?1 ORDER BY sort_order",
    )?;
    let rows = stmt
        .query_map([checklist_id], |r| {
            Ok(BoardStatusRow {
                status_id: r.get(0)?,
                label: r.get(1)?,
                color: r.get(2)?,
                sort_order: r.get(3)?,
                auto_complete: r.get::<_, i64>(4)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// AppError deliberately NOT imported: nothing here uses it today (Task 3 adds
// none) and an unused import would be a NEW warning (no-new-warnings gate).

#[cfg(test)]
mod tests {
    use crate::db::board;
    use crate::db::{checklists, migrations, open};
    use rusqlite::Connection;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&conn).unwrap();
        conn
    }

    #[test]
    fn replace_cache_rewrites_and_list_roundtrips() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        assert!(board::list(&conn, &list.id).unwrap().is_empty()); // uncached -> empty (caller applies defaults)
        let cols = vec![
            ("todo", "To Do", None, 0, false),
            ("in_progress", "In Progress", Some("#3b82f6"), 1, false),
            ("completed", "Completed", None, 2, true),
        ];
        board::replace_cache(&conn, &list.id, &cols).unwrap();
        let rows = board::list(&conn, &list.id).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].status_id, "todo");
        assert_eq!(rows[0].sort_order, 0);
        assert!(!rows[0].auto_complete);
        assert_eq!(rows[2].status_id, "completed");
        assert!(rows[2].auto_complete);
        assert_eq!(rows[1].color.as_deref(), Some("#3b82f6"));
        // rewrite replaces wholesale
        board::replace_cache(&conn, &list.id, &[("a", "A", None, 0, false)]).unwrap();
        assert_eq!(board::list(&conn, &list.id).unwrap().len(), 1);
    }

    #[test]
    fn board_statuses_are_scoped_per_list() {
        let conn = db();
        let l1 = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B1".into(), category: "Home".into() }).unwrap();
        let l2 = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B2".into(), category: "Home".into() }).unwrap();
        board::replace_cache(&conn, &l1.id, &[("todo", "To Do", None, 0, false)]).unwrap();
        assert!(board::list(&conn, &l2.id).unwrap().is_empty());
    }
}