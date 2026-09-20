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

#[derive(Debug, Default, Clone, PartialEq)]
pub struct SweepStats {
    pub stale_transcribing_reset: usize,
    pub recording_rows_deleted: usize,
    pub orphan_files_deleted: usize,
}

/// Startup sweep (spec §6, plan ruling 4). Order matters:
/// (a) stale `transcribing` rows (restart left no live owner) reset to
///     `transcription_failed` so the retry path owns them — nothing deleted;
/// (b) `recording` rows: no live owner after a restart — delete row + file;
/// (c) orphan wavs in the voice dir referenced by NOTHING (staging row or
///     saved note) are deleted; non-wav files are never touched.
/// Unsaved non-recording staging rows SURVIVE (resume prompt, spec §6).
pub fn sweep_startup(conn: &Connection, voice_dir: &std::path::Path) -> AppResult<SweepStats> {
    let reset = conn.execute(
        "UPDATE voice_recordings SET state='transcription_failed', last_error='interrupted by restart' WHERE state='transcribing'",
        [],
    )? as usize;
    let mut stmt = conn.prepare("SELECT id, path FROM voice_recordings WHERE state='recording'")?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut deleted = 0usize;
    for (id, path) in rows {
        let _ = std::fs::remove_file(&path);
        delete_staging(conn, &id)?;
        deleted += 1;
    }
    let referenced = referenced_audio_paths(conn)?;
    let mut orphans = 0usize;
    if let Ok(entries) = std::fs::read_dir(voice_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            let is_wav = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("wav"))
                .unwrap_or(false);
            if !is_wav {
                continue;
            }
            let as_str = p.to_string_lossy().into_owned();
            if !referenced.contains(&as_str) && std::fs::remove_file(&p).is_ok() {
                orphans += 1;
            }
        }
    }
    Ok(SweepStats {
        stale_transcribing_reset: reset,
        recording_rows_deleted: deleted,
        orphan_files_deleted: orphans,
    })
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

    #[test]
    fn sweep_deletes_recording_rows_and_their_files() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("live.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        create_staging(&conn, "live", wav.to_string_lossy().as_ref()).unwrap();
        let stats = sweep_startup(&conn, dir.path()).unwrap();
        assert_eq!(stats.recording_rows_deleted, 1);
        assert!(!wav.exists());
        assert!(get(&conn, "live").unwrap().is_none());
    }

    #[test]
    fn sweep_resets_stale_transcribing_to_failed() {
        let conn = db();
        create_staging(&conn, "stuck", "/tmp/stuck.wav").unwrap();
        mark_transcribing(&conn, "stuck").unwrap();
        let stats = sweep_startup(&conn, std::path::Path::new("/tmp")).unwrap();
        assert_eq!(stats.stale_transcribing_reset, 1);
        let rec = get(&conn, "stuck").unwrap().unwrap();
        assert_eq!(rec.state, ST_FAILED);
        assert_eq!(rec.last_error.as_deref(), Some("interrupted by restart"));
    }

    #[test]
    fn sweep_deletes_orphan_wavs_but_keeps_referenced_ones() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        let staging_wav = dir.path().join("staging.wav");
        let note_wav = dir.path().join("note.wav");
        let orphan_wav = dir.path().join("orphan.wav");
        let stray_txt = dir.path().join("keep.txt");
        for f in [&staging_wav, &note_wav, &orphan_wav, &stray_txt] {
            std::fs::write(f, b"x").unwrap();
        }
        create_staging(&conn, "r", staging_wav.to_string_lossy().as_ref()).unwrap();
        set_transcript(&conn, "r", "t").unwrap(); // not recording state
        conn.execute(
            "INSERT INTO notes (id,title,content,category,created_at,updated_at,dirty,audio_path) VALUES ('n1','t','','Home','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',0,?1)",
            rusqlite::params![note_wav.to_string_lossy().as_ref()],
        ).unwrap();
        let stats = sweep_startup(&conn, dir.path()).unwrap();
        assert_eq!(stats.orphan_files_deleted, 1);
        assert!(staging_wav.exists());
        assert!(note_wav.exists());
        assert!(!orphan_wav.exists());
        assert!(stray_txt.exists(), "non-wav files untouched");
    }

    #[test]
    fn sweep_on_empty_dir_and_db_is_ok() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        let stats = sweep_startup(&conn, dir.path()).unwrap();
        assert_eq!(
            stats.stale_transcribing_reset + stats.recording_rows_deleted + stats.orphan_files_deleted,
            0
        );
    }
}