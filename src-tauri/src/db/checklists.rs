use crate::db::items;
use crate::error::AppResult;
use crate::jotty::models::ServerChecklist;
use chrono::Utc;
use rusqlite::Connection;

#[derive(Debug, Clone, PartialEq)]
pub struct ChecklistRow {
    pub id: String,
    pub title: String,
    pub category: String,
    pub list_type: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub deleted_at: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone)]
pub struct NewChecklist {
    pub title: String,
    pub category: String,
}

const COLS: &str = "id, title, category, list_type, created_at, updated_at, deleted_at, dirty";

fn row(r: &rusqlite::Row) -> rusqlite::Result<ChecklistRow> {
    Ok(ChecklistRow {
        id: r.get(0)?,
        title: r.get(1)?,
        category: r.get(2)?,
        list_type: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        deleted_at: r.get(6)?,
        dirty: r.get::<_, i64>(7)? != 0,
    })
}

pub fn get_checklist(conn: &Connection, id: &str) -> AppResult<Option<ChecklistRow>> {
    let sql = format!("SELECT {COLS} FROM checklists WHERE id=?1");
    use rusqlite::OptionalExtension;
    Ok(conn.query_row(&sql, [id], |r| row(r)).optional()?)
}

pub fn list_checklists(conn: &Connection, include_deleted: bool) -> AppResult<Vec<ChecklistRow>> {
    let wc = if include_deleted { "" } else { " WHERE deleted_at IS NULL" };
    let sql = format!("SELECT {COLS} FROM checklists{wc} ORDER BY title");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| row(r))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn upsert_list_from_server(conn: &Connection, c: &ServerChecklist) -> AppResult<bool> {
    use rusqlite::OptionalExtension;
    let existing = conn
        .query_row("SELECT dirty, updated_at FROM checklists WHERE id=?1", [&c.id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .optional()?;
    if let Some((dirty, local_updated)) = existing {
        if dirty == 1 {
            return Ok(false);
        }
        if let Some(lu) = local_updated {
            if lu >= c.updated_at {
                return Ok(false);
            }
        }
        conn.execute(
            "UPDATE checklists SET title=?2, category=?3, list_type=?4, created_at=?5, updated_at=?6, dirty=0 WHERE id=?1",
            rusqlite::params![c.id, c.title, c.category, c.list_type.clone().unwrap_or_else(|| "regular".into()), c.created_at, c.updated_at],
        )?;
    } else {
        conn.execute(
            "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES (?1,?2,?3,?4,?5,?6,0)",
            rusqlite::params![c.id, c.title, c.category, c.list_type.clone().unwrap_or_else(|| "regular".into()), c.created_at, c.updated_at],
        )?;
    }
    items::reconcile(conn, &c.id, &items::flatten(&c.items))?;
    Ok(true)
}

pub fn insert_local_list(conn: &Connection, n: &NewChecklist) -> AppResult<ChecklistRow> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES (?1,?2,?3,'simple',?4,?4,1)",
        rusqlite::params![id, n.title, n.category, ts],
    )?;
    Ok(get_checklist(conn, &id)?.unwrap())
}

pub fn update_local_list(conn: &Connection, id: &str, title: Option<&str>, category: Option<&str>) -> AppResult<ChecklistRow> {
    let existing = get_checklist(conn, id)?.ok_or_else(|| crate::error::AppError::Other("list not found".into()))?;
    conn.execute(
        "UPDATE checklists SET title=?2, category=?3, dirty=1 WHERE id=?1",
        rusqlite::params![id, title.unwrap_or(&existing.title), category.unwrap_or(&existing.category)],
    )?;
    Ok(get_checklist(conn, id)?.unwrap())
}

pub fn soft_delete_list_local(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE checklists SET deleted_at=?2, dirty=1 WHERE id=?1",
        rusqlite::params![id, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

pub fn tombstone(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("UPDATE checklists SET deleted_at=?2 WHERE id=?1", rusqlite::params![id, chrono::Utc::now().to_rfc3339()])?;
    Ok(())
}

pub fn mark_list_synced(conn: &Connection, id: &str, server_updated_at: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE checklists SET dirty=0, updated_at=?2 WHERE id=?1",
        rusqlite::params![id, server_updated_at],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations, open};
    use crate::jotty::models::ServerItem;
    use std::path::Path;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&conn).unwrap();
        conn
    }

    fn server_checklist(id: &str, title: &str, updated: &str, items: Vec<ServerItem>) -> ServerChecklist {
        ServerChecklist {
            id: id.into(),
            title: title.into(),
            category: "Work".into(),
            list_type: Some("regular".into()),
            items,
            statuses: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: updated.into(),
        }
    }

    #[test]
    fn upsert_imports_items_and_respects_dirty() {
        let conn = db();
        let local = insert_local_list(&conn, &NewChecklist { title: "mine".into(), category: "Home".into() }).unwrap();
        let c = server_checklist(&local.id, "theirs", "2099-01-01T00:00:00.000Z", vec![ServerItem::simple("a")]);
        assert!(!upsert_list_from_server(&conn, &c).unwrap(), "dirty list must not be clobbered");
        mark_list_synced(&conn, &local.id, "2026-01-01T00:00:00.000Z").unwrap();
        let c2 = server_checklist(&local.id, "theirs", "2027-01-01T00:00:00.000Z", vec![ServerItem::simple("a"), ServerItem::simple("b")]);
        assert!(upsert_list_from_server(&conn, &c2).unwrap());
        assert_eq!(items::list_for_checklist(&conn, &local.id).unwrap().len(), 2);
        // lists_fts searchable
        let hits: Vec<String> = conn.prepare("SELECT id FROM lists_fts WHERE lists_fts MATCH 'a b'").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(hits, vec![local.id]);
    }
}