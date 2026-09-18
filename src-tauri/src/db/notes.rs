use crate::error::AppResult;
use crate::jotty::models::ServerNote;
use chrono::Utc;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use serde_json::json;

#[derive(Debug, Clone, PartialEq)]
pub struct NoteRow {
    pub id: String,
    pub title: String,
    pub content: String,
    pub category: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub deleted_at: Option<String>,
    pub dirty: bool,
    pub audio_path: Option<String>,
    pub audio_duration_secs: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct NewNote {
    pub title: String,
    pub content: String,
    pub category: String,
}

#[derive(Debug, Clone, Default)]
pub struct NotePatch {
    pub title: Option<String>,
    pub content: Option<String>,
    pub category: Option<String>,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn fts_refresh(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM notes_fts WHERE id=?1", [id])?;
    conn.execute(
        "INSERT INTO notes_fts(id, title, content)
         SELECT id, title, content FROM notes WHERE id=?1",
        [id],
    )?;
    Ok(())
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<NoteRow> {
    Ok(NoteRow {
        id: r.get(0)?,
        title: r.get(1)?,
        content: r.get(2)?,
        category: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        deleted_at: r.get(6)?,
        dirty: r.get::<_, i64>(7)? != 0,
        audio_path: r.get(8)?,
        audio_duration_secs: r.get(9)?,
    })
}

const COLS: &str = "id, title, content, category, created_at, updated_at, deleted_at, dirty, audio_path, audio_duration_secs";

pub fn upsert_from_server(conn: &Connection, n: &ServerNote) -> AppResult<bool> {
    let existing = conn
        .query_row(
            &format!("SELECT dirty, updated_at FROM notes WHERE id=?1"),
            [&n.id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    if let Some((dirty, local_updated)) = existing {
        if dirty == 1 {
            return Ok(false); // local pending ops win until pushed
        }
        if let Some(lu) = local_updated {
            if lu >= n.updated_at {
                return Ok(false); // LWW: local not older
            }
        }
        conn.execute(
            "UPDATE notes SET title=?2, content=?3, category=?4, created_at=?5, updated_at=?6, dirty=0 WHERE id=?1",
            rusqlite::params![n.id, n.title, n.content.clone().unwrap_or_default(), n.category, n.created_at, n.updated_at],
        )?;
    } else {
        conn.execute(
            "INSERT INTO notes (id, title, content, category, created_at, updated_at, dirty) VALUES (?1,?2,?3,?4,?5,?6,0)",
            rusqlite::params![n.id, n.title, n.content.clone().unwrap_or_default(), n.category, n.created_at, n.updated_at],
        )?;
    }
    fts_refresh(conn, &n.id)?;
    Ok(true)
}

pub fn insert_local(conn: &Connection, n: &NewNote) -> AppResult<NoteRow> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now();
    conn.execute(
        "INSERT INTO notes (id, title, content, category, created_at, updated_at, dirty) VALUES (?1,?2,?3,?4,?5,?5,1)",
        rusqlite::params![id, n.title, n.content, n.category, ts],
    )?;
    fts_refresh(conn, &id)?;
    Ok(get(conn, &id)?.unwrap())
}

pub fn update_local(conn: &Connection, id: &str, p: &NotePatch) -> AppResult<NoteRow> {
    let existing = get(conn, id)?.ok_or_else(|| crate::error::AppError::Other(format!("note {id} not found")))?;
    conn.execute(
        "UPDATE notes SET title=?2, content=?3, category=?4, dirty=1 WHERE id=?1",
        rusqlite::params![
            id,
            p.title.clone().unwrap_or(existing.title),
            p.content.clone().unwrap_or(existing.content),
            p.category.clone().unwrap_or(existing.category)
        ],
    )?;
    fts_refresh(conn, id)?;
    Ok(get(conn, id)?.unwrap())
}

pub fn soft_delete_local(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE notes SET deleted_at=?2, dirty=1 WHERE id=?1",
        rusqlite::params![id, now()],
    )?;
    Ok(())
}

pub fn tombstone(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("UPDATE notes SET deleted_at=?2 WHERE id=?1", rusqlite::params![id, chrono::Utc::now().to_rfc3339()])?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<NoteRow>> {
    let sql = format!("SELECT {COLS} FROM notes WHERE id=?1");
    Ok(conn.query_row(&sql, [id], |r| row(r)).optional()?)
}

pub fn list(conn: &Connection, include_deleted: bool) -> AppResult<Vec<NoteRow>> {
    let where_clause = if include_deleted { "" } else { " WHERE deleted_at IS NULL" };
    let sql = format!("SELECT {COLS} FROM notes{where_clause} ORDER BY updated_at DESC, id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| row(r))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn mark_synced(conn: &Connection, id: &str, server_updated_at: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE notes SET dirty=0, updated_at=?2 WHERE id=?1",
        rusqlite::params![id, server_updated_at],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations, open};
    use std::path::Path;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        // leak tempdir for test lifetime
        std::mem::forget(dir);
        migrations::run(&conn).unwrap();
        conn
    }

    fn server_note(id: &str, title: &str, updated: &str) -> ServerNote {
        ServerNote {
            id: id.into(),
            title: title.into(),
            category: "Work".into(),
            content: Some("hello".into()),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: updated.into(),
            owner: None,
        }
    }

    #[test]
    fn insert_local_is_dirty_and_searchable() {
        let conn = db();
        let n = insert_local(&conn, &NewNote { title: "Groceries".into(), content: "milk".into(), category: "Home".into() }).unwrap();
        assert!(n.dirty);
        let hits: Vec<String> = conn
            .prepare("SELECT id FROM notes_fts WHERE notes_fts MATCH 'milk'")
            .unwrap().query_map([], |r| r.get(0)).unwrap()
            .map(Result::unwrap).collect();
        assert_eq!(hits, vec![n.id]);
    }

    #[test]
    fn upsert_respects_lww_and_dirty() {
        let conn = db();
        let local = insert_local(&conn, &NewNote { title: "mine".into(), content: "".into(), category: "Home".into() }).unwrap();
        // dirty local: server copy must not clobber
        assert!(!upsert_from_server(&conn, &server_note(&local.id, "theirs", "2099-01-01T00:00:00.000Z")).unwrap());
        mark_synced(&conn, &local.id, "2026-01-01T00:00:00.000Z").unwrap();
        // older server update loses
        assert!(!upsert_from_server(&conn, &server_note(&local.id, "old", "2025-01-01T00:00:00.000Z")).unwrap());
        // newer server update wins
        assert!(upsert_from_server(&conn, &server_note(&local.id, "new-title", "2027-01-01T00:00:00.000Z")).unwrap());
        let after = get(&conn, &local.id).unwrap().unwrap();
        assert_eq!(after.title, "new-title");
        assert!(!after.dirty);
    }

    #[test]
    fn upsert_from_server_never_touches_local_audio_columns() {
        let conn = db();
        let n = insert_local(&conn, &NewNote { title: "t".into(), content: "".into(), category: "Home".into() }).unwrap();
        conn.execute("UPDATE notes SET audio_path='/tmp/x.wav', audio_duration_secs=12.5 WHERE id=?1", [&n.id]).unwrap();
        // clear the dirty flag (insert_local always sets it) so the newer server
        // copy can win on LWW — mirrors upsert_respects_lww_and_dirty
        mark_synced(&conn, &n.id, "2026-01-01T00:00:00.000Z").unwrap();
        // a NEWER server copy must win on LWW but must not clobber the local-only columns
        assert!(upsert_from_server(&conn, &server_note(&n.id, "theirs", "2099-01-01T00:00:00.000Z")).unwrap());
        let after = get(&conn, &n.id).unwrap().unwrap();
        assert_eq!(after.audio_path.as_deref(), Some("/tmp/x.wav"));
        assert_eq!(after.audio_duration_secs, Some(12.5));
        assert!(!after.dirty);
    }

    #[test]
    fn soft_delete_tombstones_and_list_filters() {
        let conn = db();
        let n = insert_local(&conn, &NewNote { title: "t".into(), content: "".into(), category: "Home".into() }).unwrap();
        soft_delete_local(&conn, &n.id).unwrap();
        assert_eq!(list(&conn, false).unwrap().len(), 0);
        assert_eq!(list(&conn, true).unwrap().len(), 1);
    }

    #[test]
    fn update_local_patch_merges_marks_dirty_and_refreshes_fts() {
        let conn = db();
        let n = insert_local(&conn, &NewNote { title: "Old Title".into(), content: "stale bread".into(), category: "Home".into() }).unwrap();
        // partial patch: only content provided — title/category must be left untouched
        let merged = update_local(
            &conn,
            &n.id,
            &NotePatch { title: None, content: Some("fresh mango".into()), category: None },
        ).unwrap();
        assert!(merged.dirty);
        assert_eq!(merged.title, "Old Title");
        assert_eq!(merged.content, "fresh mango");
        assert_eq!(merged.category, "Home");
        // full patch: all three fields replaced
        let full = update_local(
            &conn,
            &n.id,
            &NotePatch { title: Some("New Title".into()), content: Some("ripe mango".into()), category: Some("Work".into()) },
        ).unwrap();
        assert!(full.dirty);
        assert_eq!(full.title, "New Title");
        assert_eq!(full.content, "ripe mango");
        assert_eq!(full.category, "Work");
        // FTS refreshed: new content matches, replaced content is gone
        let hits: Vec<String> = conn
            .prepare("SELECT id FROM notes_fts WHERE notes_fts MATCH 'mango'")
            .unwrap().query_map([], |r| r.get(0)).unwrap()
            .map(Result::unwrap).collect();
        assert_eq!(hits, vec![n.id]);
        let stale_count: i64 = conn
            .query_row("SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'stale'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stale_count, 0, "FTS must not retain replaced content");
    }
}
