use crate::db::{checklists, notes, outbox};
use crate::error::{AppError, AppResult};
use crate::jotty::client::JottyClient;
use rusqlite::Connection;

#[derive(Debug, Default, Clone)]
pub struct PushStats {
    pub pushed: usize,
    pub conflicts: usize,
}

pub async fn push_pending(conn: &mut Connection, client: &JottyClient) -> AppResult<PushStats> {
    let mut stats = PushStats::default();
    loop {
        let ops = outbox::next_batch(conn, 1)?;
        if ops.is_empty() { break; }
        for op in ops {
            let payload: serde_json::Value = serde_json::from_str(&op.payload)
                .unwrap_or_else(|_| serde_json::json!({}));
            let result: AppResult<()> = match (op.entity.as_str(), op.op_type.as_str()) {
                ("note", "create") => {
                    let created = client.create_note(
                        payload["title"].as_str().unwrap_or(""),
                        payload["content"].as_str().unwrap_or(""),
                        payload["category"].as_str().unwrap_or("Uncategorized"),
                    ).await?;
                    let new_id = created.id.clone();
                    {
                        let tx = conn.transaction()?;
                        let old_id = payload["temp_id"].as_str().unwrap_or(&op.entity_id).to_string();
                        tx.execute("UPDATE notes SET id=?2, dirty=0 WHERE id=?1", rusqlite::params![old_id, new_id])?;
                        tx.execute("UPDATE notes SET updated_at=?2 WHERE id=?1", rusqlite::params![new_id, created.updated_at])?;
                        tx.execute("DELETE FROM notes_fts WHERE id=?1", rusqlite::params![old_id])?;
                        tx.execute(
                            "INSERT INTO notes_fts(id, title, content) SELECT id, title, content FROM notes WHERE id=?1",
                            rusqlite::params![new_id],
                        )?;
                        outbox::remap_entity_id(&tx, "note", &old_id, &new_id)?;
                        tx.commit()?;
                    }
                    Ok(())
                }
                ("note", "update") => {
                    let updated = client.update_note(
                        &op.entity_id,
                        payload["title"].as_str().unwrap_or(""),
                        payload["content"].as_str().unwrap_or(""),
                        payload["category"].as_str().unwrap_or("Uncategorized"),
                    ).await?;
                    let tx = conn.transaction()?;
                    notes::mark_synced(&tx, &op.entity_id, &updated.updated_at)?;
                    tx.commit()?;
                    Ok(())
                }
                ("note", "delete") => client.delete_note(&op.entity_id).await,
                ("checklist", "create") => {
                    let created = client.create_checklist(
                        payload["title"].as_str().unwrap_or(""),
                        payload["category"].as_str().unwrap_or("Uncategorized"),
                    ).await?;
                    let new_id = created.id.clone();
                    {
                        let tx = conn.transaction()?;
                        tx.execute_batch("PRAGMA defer_foreign_keys=ON")?;
                        let old_id = payload["temp_id"].as_str().unwrap_or(&op.entity_id).to_string();
                        tx.execute("UPDATE checklists SET id=?2, dirty=0 WHERE id=?1", rusqlite::params![old_id, new_id])?;
                        tx.execute("UPDATE checklists SET updated_at=?2 WHERE id=?1", rusqlite::params![new_id, created.updated_at])?;
                        tx.execute("UPDATE checklist_items SET checklist_id=?2 WHERE checklist_id=?1", rusqlite::params![old_id, new_id])?;
                        tx.execute("UPDATE outbox SET payload=json_set(payload, '$.checklist_id', ?2) WHERE state='pending' AND json_extract(payload, '$.checklist_id')=?1", rusqlite::params![old_id, new_id])?;
                        outbox::remap_entity_id(&tx, "checklist", &old_id, &new_id)?;
                        tx.commit()?;
                    }
                    Ok(())
                }
                ("checklist", "update") => {
                    client.update_checklist(
                        &op.entity_id,
                        payload["title"].as_str().unwrap_or(""),
                        payload["category"].as_str().unwrap_or("Uncategorized"),
                    ).await?;
                    let tx = conn.transaction()?;
                    checklists::mark_list_synced(&tx, &op.entity_id, &chrono::Utc::now().to_rfc3339())?;
                    tx.commit()?;
                    Ok(())
                }
                ("checklist", "delete") => client.delete_checklist(&op.entity_id).await,
                _ => Err(crate::error::AppError::Other(format!("unknown op {}/{}", op.entity, op.op_type))),
            };
            match result {
                Ok(()) => {
                    outbox::mark_done(conn, op.seq)?;
                    stats.pushed += 1;
                }
                Err(AppError::Api { status: 404, .. })
                | Err(AppError::Api { status: 409, .. })
                | Err(AppError::Api { status: 410, .. }) => {
                    outbox::mark_conflict(conn, op.seq, &format!("{:?}", AppError::Api { status: 0, body: "gone".into() }))?;
                    stats.conflicts += 1;
                }
                Err(e) if e.to_string().starts_with("unknown op") => {
                    outbox::mark_conflict(conn, op.seq, &e.to_string())?;
                    stats.conflicts += 1;
                }
                Err(e) => {
                    outbox::record_attempt(conn, op.seq, &e.to_string())?;
                    // transient error: stop FIFO replay this run
                    return Ok(stats);
                }
            }
        }
    }
    Ok(stats)
}

// checklist ops handled in same loop; shown as separate match arms — see tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{checklists, migrations, open};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&conn).unwrap();
        conn
    }

    #[tokio::test]
    async fn note_create_remaps_temp_id_and_pending_ops() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": {"id":"srv-1","title":"T","content":"c","category":"Home","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-02T00:00:00.000Z","owner":"u"}
            })))
            .mount(&s).await;
        // (binding ruling): one-op-per-fetch means the queued update op replays AFTER the
        // remap and targets srv-1 — it needs this PUT mock.
        Mock::given(method("PUT")).and(path("/api/notes/srv-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": {"id":"srv-1","title":"T","content":"c2","category":"Home","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-03T00:00:00.000Z","owner":"u"}
            })))
            .mount(&s).await;
        let mut conn = db();
        let local = notes::insert_local(&conn, &notes::NewNote { title: "T".into(), content: "c".into(), category: "Home".into() }).unwrap();
        outbox::enqueue(&conn, "create", "note", &local.id, &serde_json::json!({"temp_id": local.id, "title":"T","content":"c","category":"Home"})).unwrap();
        // an update op queued behind create, referencing the temp id
        outbox::enqueue(&conn, "update", "note", &local.id, &serde_json::json!({"id": local.id, "title":"T","content":"c2","category":"Home"})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 2); // create + remapped update both replay (one op per fetch)
        let updated = notes::get(&conn, "srv-1").unwrap().unwrap();
        assert_eq!(updated.id, "srv-1");
        assert!(!updated.dirty);
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
        // (pre-review ruling): remap refreshes notes_fts — old temp-id row gone, new-id row searchable
        let fts: (String, i64) = conn.query_row(
            "SELECT id, (SELECT count(*) FROM notes_fts) FROM notes_fts WHERE notes_fts MATCH 'c'",
            [], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(fts, ("srv-1".into(), 1));
    }

    #[tokio::test]
    async fn checklist_create_remaps_and_update_pushes() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": {"id":"srv-l","title":"L","category":"Home","type":"simple","items":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}
            })))
            .mount(&s).await;
        Mock::given(method("PUT")).and(path("/api/checklists/srv-l"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        let mut conn = db();
        let local = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        outbox::enqueue(&conn, "create", "checklist", &local.id, &serde_json::json!({"temp_id": local.id, "title":"L","category":"Home"})).unwrap();
        outbox::enqueue(&conn, "update", "checklist", &local.id, &serde_json::json!({"id": local.id, "title":"L2","category":"Home"})).unwrap();
        // (pre-review ruling 2026-09-17): an offline item on the temp list id + its op queued
        // behind — the create remap must move the item FK and rewrite pending item-op payloads.
        let it = crate::db::items::insert_local(&conn, &crate::db::items::NewItem {
            checklist_id: local.id.clone(), parent_local_id: None, text: "i".into(),
        }).unwrap();
        outbox::enqueue(&conn, "check", "checklist_item", &it.local_id,
            &serde_json::json!({"item_local_id": it.local_id, "checklist_id": local.id, "checked": true})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 2);
        assert!(checklists::get_checklist(&conn, "srv-l").unwrap().is_some());
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
        // item FK moved with the list id; the unknown item op conflicts AFTER the remap rewrote its payload
        assert_eq!(stats.conflicts, 1);
        let item = crate::db::items::get(&conn, &it.local_id).unwrap().unwrap();
        assert_eq!(item.checklist_id, "srv-l");
        let op_payload: String = conn.query_row(
            "SELECT payload FROM outbox WHERE entity='checklist_item' AND state='conflict'", [], |r| r.get(0)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&op_payload).unwrap();
        assert_eq!(v["checklist_id"], "srv-l");
    }

    #[tokio::test]
    async fn note_delete_404_becomes_conflict_and_queue_continues() {
        let s = MockServer::start().await;
        Mock::given(method("DELETE")).and(path("/api/notes/gone-1"))
            .respond_with(ResponseTemplate::new(404).set_body_string("nope"))
            .mount(&s).await;
        // (pre-dispatch scan ruling): wiremock answers UNMATCHED requests with 404, which
        // the impl maps to mark_conflict — gone-2 needs its own 500 mock so the run's stop
        // is the transient-error branch (record_attempt), not a second conflict.
        Mock::given(method("DELETE")).and(path("/api/notes/gone-2"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&s).await;
        let mut conn = db();
        outbox::enqueue(&conn, "delete", "note", "gone-1", &serde_json::json!({})).unwrap();
        outbox::enqueue(&conn, "delete", "note", "gone-2", &serde_json::json!({})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.conflicts, 1);
        let conflicts = crate::db::outbox::next_batch(&conn, 10).unwrap();
        // gone-1 is conflict (not pending); gone-2 → 500 → record_attempt, run stops (FIFO)
        assert!(conflicts.iter().any(|o| o.entity_id == "gone-2"));
    }

    #[tokio::test]
    async fn network_error_keeps_op_pending_with_error() {
        // port 1 is guaranteed unroutable
        let client = JottyClient::new("http://127.0.0.1:1", "ck").unwrap();
        let mut conn = db();
        outbox::enqueue(&conn, "delete", "note", "x", &serde_json::json!({})).unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 0);
        let op = &outbox::next_batch(&conn, 10).unwrap()[0];
        assert_eq!(op.attempts, 1);
        assert!(op.last_error.is_some());
    }
}
