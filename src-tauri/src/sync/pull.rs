use crate::db::{checklists, notes, outbox};
use crate::error::AppResult;
use crate::jotty::client::JottyClient;
use crate::jotty::models::{ServerChecklist, ServerNote};
use chrono::Utc;
use rusqlite::Connection;

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct PullStats {
    pub notes_applied: usize,
    pub lists_applied: usize,
    pub tombstones: usize,
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

    // record last sync
    conn.execute(
        "INSERT INTO sync_state(key, value) VALUES ('last_sync_at', ?1)
         ON CONFLICT(key) DO UPDATE SET value=?1",
        [Utc::now().to_rfc3339()],
    )?;

    Ok(stats)
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
}