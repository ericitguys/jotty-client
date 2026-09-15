use crate::error::AppResult;
use rusqlite::Connection;
use serde_json::json;

#[derive(Debug, Clone)]
pub struct OutboxOp {
    pub seq: i64,
    pub op_type: String,
    pub entity: String,
    pub entity_id: String,
    pub payload: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub state: String,
}

pub fn enqueue(conn: &Connection, op_type: &str, entity: &str, entity_id: &str, payload: &serde_json::Value) -> AppResult<()> {
    conn.execute(
        "INSERT INTO outbox(op_type, entity, entity_id, payload) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![op_type, entity, entity_id, payload.to_string()],
    )?;
    Ok(())
}

fn row_to_op(r: &rusqlite::Row) -> rusqlite::Result<OutboxOp> {
    Ok(OutboxOp {
        seq: r.get(0)?,
        op_type: r.get(1)?,
        entity: r.get(2)?,
        entity_id: r.get(3)?,
        payload: r.get(4)?,
        attempts: r.get(5)?,
        last_error: r.get(6)?,
        state: r.get(7)?,
    })
}

pub fn next_batch(conn: &Connection, limit: i64) -> AppResult<Vec<OutboxOp>> {
    let mut stmt = conn.prepare(
        "SELECT seq, op_type, entity, entity_id, payload, attempts, last_error, state
         FROM outbox WHERE state='pending' ORDER BY seq LIMIT ?1",
    )?;
    let ops = stmt.query_map([limit], |r| row_to_op(r))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ops)
}

pub fn mark_done(conn: &Connection, seq: i64) -> AppResult<()> {
    conn.execute("UPDATE outbox SET state='done' WHERE seq=?1", [seq])?;
    Ok(())
}

pub fn mark_conflict(conn: &Connection, seq: i64, err: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE outbox SET state='conflict', last_error=?2 WHERE seq=?1",
        rusqlite::params![seq, err],
    )?;
    Ok(())
}

pub fn record_attempt(conn: &Connection, seq: i64, err: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE outbox SET attempts=attempts+1, last_error=?2 WHERE seq=?1",
        rusqlite::params![seq, err],
    )?;
    Ok(())
}

pub fn pending_count(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM outbox WHERE state='pending'", [], |r| r.get(0))?)
}

pub fn has_pending_for(conn: &Connection, entity: &str, id: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM outbox WHERE state='pending' AND entity=?1 AND entity_id=?2",
        rusqlite::params![entity, id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub fn remap_entity_id(conn: &Connection, entity: &str, old_id: &str, new_id: &str) -> AppResult<usize> {
    let n = conn.execute(
        "UPDATE outbox SET entity_id=?3 WHERE entity=?1 AND entity_id=?2 AND state='pending'",
        rusqlite::params![entity, old_id, new_id],
    )?;
    Ok(n)
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

    #[test]
    fn fifo_order_and_state_filtering() {
        let conn = db();
        enqueue(&conn, "create", "note", "a", &json!({"title": "A"})).unwrap();
        enqueue(&conn, "update", "note", "b", &json!({})).unwrap();
        let batch = next_batch(&conn, 10).unwrap();
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[0].entity_id, "a");
        assert_eq!(batch[0].op_type, "create");
        mark_done(&conn, batch[0].seq).unwrap();
        mark_conflict(&conn, batch[1].seq, "gone").unwrap();
        assert_eq!(pending_count(&conn).unwrap(), 0);
    }

    #[test]
    fn has_pending_and_remap() {
        let conn = db();
        enqueue(&conn, "create", "note", "tmp1", &json!({})).unwrap();
        enqueue(&conn, "update", "note", "tmp1", &json!({})).unwrap();
        assert!(has_pending_for(&conn, "note", "tmp1").unwrap());
        assert!(!has_pending_for(&conn, "checklist", "tmp1").unwrap());
        let n = remap_entity_id(&conn, "note", "tmp1", "real-uuid").unwrap();
        assert_eq!(n, 2);
        assert!(has_pending_for(&conn, "note", "real-uuid").unwrap());
    }

    #[test]
    fn record_attempt_increments() {
        let conn = db();
        enqueue(&conn, "create", "note", "x", &json!({})).unwrap();
        let op = &next_batch(&conn, 1).unwrap()[0];
        record_attempt(&conn, op.seq, "timeout").unwrap();
        let after = next_batch(&conn, 1).unwrap();
        assert_eq!(after[0].attempts, 1);
        assert_eq!(after[0].last_error.as_deref(), Some("timeout"));
    }
}