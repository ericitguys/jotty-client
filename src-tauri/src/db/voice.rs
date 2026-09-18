//! voice_recordings staging table (local-only, spec 2026-09-18 §5).
use crate::error::AppResult;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use std::collections::HashSet;

pub const ST_RECORDING: &str = "recording";
pub const ST_RECORDED: &str = "recorded";
pub const ST_TRANSCRIBING: &str = "transcribing";
pub const ST_TRANSCRIBED: &str = "transcribed";
pub const ST_FAILED: &str = "transcription_failed";
pub const ST_FAILED_AUTH: &str = "transcription_failed_auth";

#[derive(Debug, Clone, PartialEq)]
pub struct VoiceRecordingRow {
    pub id: String,
    pub path: String,
    pub duration_secs: f64,
    pub raw_transcript: Option<String>,
    pub tidied_transcript: Option<String>,
    pub state: String,
    pub last_error: Option<String>,
    pub created_at: String,
}

const COLS: &str = "id, path, duration_secs, raw_transcript, tidied_transcript, state, last_error, created_at";

fn row(r: &rusqlite::Row) -> rusqlite::Result<VoiceRecordingRow> {
    Ok(VoiceRecordingRow {
        id: r.get(0)?,
        path: r.get(1)?,
        duration_secs: r.get(2)?,
        raw_transcript: r.get(3)?,
        tidied_transcript: r.get(4)?,
        state: r.get(5)?,
        last_error: r.get(6)?,
        created_at: r.get(7)?,
    })
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn create_staging(conn: &Connection, id: &str, path: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO voice_recordings(id, path, duration_secs, state, created_at) VALUES (?1, ?2, 0, 'recording', ?3)",
        rusqlite::params![id, path, now()],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<VoiceRecordingRow>> {
    let sql = format!("SELECT {COLS} FROM voice_recordings WHERE id=?1");
    Ok(conn.query_row(&sql, [id], |r| row(r)).optional()?)
}

pub fn list_unsaved(conn: &Connection) -> AppResult<Vec<VoiceRecordingRow>> {
    let sql = format!(
        "SELECT {COLS} FROM voice_recordings WHERE state != '{}' ORDER BY created_at DESC, id",
        ST_RECORDING
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| row(r))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn list_failed(conn: &Connection) -> AppResult<Vec<VoiceRecordingRow>> {
    let sql = format!("SELECT {COLS} FROM voice_recordings WHERE state = '{}' ORDER BY created_at", ST_FAILED);
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| row(r))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn mark_recorded(conn: &Connection, id: &str, duration_secs: f64) -> AppResult<()> {
    conn.execute(
        "UPDATE voice_recordings SET state='recorded', duration_secs=?2 WHERE id=?1",
        rusqlite::params![id, duration_secs],
    )?;
    Ok(())
}

pub fn mark_transcribing(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("UPDATE voice_recordings SET state='transcribing' WHERE id=?1", [id])?;
    Ok(())
}

/// Success also flips the state — one statement owns the transition.
pub fn set_transcript(conn: &Connection, id: &str, raw: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE voice_recordings SET state='transcribed', raw_transcript=?2 WHERE id=?1",
        rusqlite::params![id, raw],
    )?;
    Ok(())
}

pub fn set_tidied(conn: &Connection, id: &str, tidied: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE voice_recordings SET tidied_transcript=?2 WHERE id=?1",
        rusqlite::params![id, tidied],
    )?;
    Ok(())
}

pub fn mark_failed(conn: &Connection, id: &str, auth: bool, err: &str) -> AppResult<()> {
    let state = if auth { ST_FAILED_AUTH } else { ST_FAILED };
    conn.execute(
        "UPDATE voice_recordings SET state=?2, last_error=?3 WHERE id=?1",
        rusqlite::params![id, state, err],
    )?;
    Ok(())
}

pub fn delete_staging(conn: &Connection, id: &str) -> AppResult<bool> {
    let n = conn.execute("DELETE FROM voice_recordings WHERE id=?1", [id])?;
    Ok(n > 0)
}

pub fn referenced_audio_paths(conn: &Connection) -> AppResult<HashSet<String>> {
    let mut set = HashSet::new();
    let mut stmt = conn.prepare("SELECT path FROM voice_recordings")?;
    for p in stmt.query_map([], |r| r.get::<_, String>(0))? {
        set.insert(p?);
    }
    let mut stmt = conn.prepare("SELECT audio_path FROM notes WHERE audio_path IS NOT NULL")?;
    for p in stmt.query_map([], |r| r.get::<_, String>(0))? {
        set.insert(p?);
    }
    Ok(set)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations, open};
    use std::path::Path;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&conn).unwrap();
        conn
    }

    #[test]
    fn staging_lifecycle_round_trip() {
        let conn = db();
        create_staging(&conn, "r1", "/tmp/r1.wav").unwrap();
        let rec = get(&conn, "r1").unwrap().unwrap();
        assert_eq!(rec.state, ST_RECORDING);
        assert_eq!(rec.duration_secs, 0.0);
        assert!(rec.raw_transcript.is_none());
        mark_recorded(&conn, "r1", 12.5).unwrap();
        mark_transcribing(&conn, "r1").unwrap();
        set_transcript(&conn, "r1", "hello world").unwrap();
        set_tidied(&conn, "r1", "Hello, world.").unwrap();
        let rec = get(&conn, "r1").unwrap().unwrap();
        assert_eq!(rec.state, ST_TRANSCRIBED);
        assert_eq!(rec.raw_transcript.as_deref(), Some("hello world"));
        assert_eq!(rec.tidied_transcript.as_deref(), Some("Hello, world."));
        assert_eq!(rec.duration_secs, 12.5);
        assert!(delete_staging(&conn, "r1").unwrap());
        assert!(get(&conn, "r1").unwrap().is_none());
        assert!(!delete_staging(&conn, "r1").unwrap());
    }

    #[test]
    fn mark_failed_distinguishes_auth_from_network() {
        let conn = db();
        create_staging(&conn, "r2", "/tmp/r2.wav").unwrap();
        mark_failed(&conn, "r2", false, "500 oops").unwrap();
        assert_eq!(get(&conn, "r2").unwrap().unwrap().state, ST_FAILED);
        mark_failed(&conn, "r2", true, "api error 401").unwrap();
        let rec = get(&conn, "r2").unwrap().unwrap();
        assert_eq!(rec.state, ST_FAILED_AUTH);
        assert_eq!(rec.last_error.as_deref(), Some("api error 401"));
    }

    #[test]
    fn list_unsaved_excludes_recording_state_and_orders_desc() {
        let conn = db();
        create_staging(&conn, "old", "/tmp/old.wav").unwrap();
        mark_recorded(&conn, "old", 3.0).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        create_staging(&conn, "new", "/tmp/new.wav").unwrap();
        set_transcript(&conn, "new", "text").unwrap();
        let rows = list_unsaved(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "new", "newest first");
        // an in-flight recording row is never surfaced
        create_staging(&conn, "live", "/tmp/live.wav").unwrap();
        assert_eq!(list_unsaved(&conn).unwrap().len(), 2);
    }

    #[test]
    fn referenced_paths_cover_staging_and_saved_notes() {
        let conn = db();
        create_staging(&conn, "r", "/tmp/voice/r.wav").unwrap();
        conn.execute(
            "INSERT INTO notes (id,title,content,category,created_at,updated_at,dirty,audio_path) VALUES ('n1','t','','Home','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',1,'/tmp/voice/n.wav')",
            [],
        ).unwrap();
        let refs = referenced_audio_paths(&conn).unwrap();
        assert!(refs.contains("/tmp/voice/r.wav"));
        assert!(refs.contains("/tmp/voice/n.wav"));
    }
}