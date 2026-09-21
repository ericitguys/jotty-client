use crate::db::{checklists, items, notes, outbox};
use crate::error::{AppError, AppResult};
use crate::jotty::client::JottyClient;
use crate::jotty::models::ServerItem;
use crate::sync::resolve::resolve;
use rusqlite::Connection;

#[derive(Debug, Default, Clone)]
pub struct PushStats {
    pub pushed: usize,
    pub conflicts: usize,
}

pub async fn push_pending(conn: &mut Connection, client: &JottyClient) -> AppResult<PushStats> {
    let mut stats = PushStats::default();
    // checklist_item ops replay as per-checklist groups: each op re-resolves its target
    // against a freshly fetched index (v1 correctness rule), and the group closes with one
    // re-fetch + reconcile + mark_list_synced after the checklist's last queued op.
    let mut group: Option<String> = None;
    // Review ruling 2026-09-17: claims are (item_local_id, path, text@path-at-claim)
    // triples; the plain `claimed` vec that resolve() consumes is DERIVED per op from
    // OTHER items' claims (own-claim exclusion) — see resolve_with_claims.
    let mut claims: Vec<(String, String, String)> = Vec::new();
    loop {
        let ops = outbox::next_batch(conn, 1)?;
        if ops.is_empty() {
            if let Some(list_id) = group.take() {
                close_item_group(conn, client, &list_id).await?;
            }
            break;
        }
        for op in ops {
            let payload: serde_json::Value = serde_json::from_str(&op.payload)
                .unwrap_or_else(|_| serde_json::json!({}));
            let item_list_id: String = if op.entity == "checklist_item" {
                let list_id = payload["checklist_id"].as_str().unwrap_or(&op.entity_id).to_string();
                if group.as_deref() != Some(list_id.as_str()) {
                    if let Some(prev) = group.take() {
                        close_item_group(conn, client, &prev).await?;
                    }
                    claims.clear();
                    group = Some(list_id.clone());
                }
                list_id
            } else {
                String::new()
            };
            let result: AppResult<()> = match (op.entity.as_str(), op.op_type.as_str()) {
                ("note", "create") => match client.create_note(
                    payload["title"].as_str().unwrap_or(""),
                    payload["content"].as_str().unwrap_or(""),
                    payload["category"].as_str().unwrap_or("Uncategorized"),
                ).await {
                    Ok(created) => {
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
                    Err(e) => Err(e),
                }
                ("note", "update") => match client.update_note(
                    &op.entity_id,
                    payload["title"].as_str().unwrap_or(""),
                    payload["content"].as_str().unwrap_or(""),
                    payload["category"].as_str().unwrap_or("Uncategorized"),
                ).await {
                    Ok(updated) => {
                        let tx = conn.transaction()?;
                        notes::mark_synced(&tx, &op.entity_id, &updated.updated_at)?;
                        tx.commit()?;
                        Ok(())
                    }
                    Err(e) => Err(e),
                }
                ("note", "delete") => client.delete_note(&op.entity_id).await,
                ("checklist", "create") => match client.create_checklist(
                    payload["title"].as_str().unwrap_or(""),
                    payload["category"].as_str().unwrap_or("Uncategorized"),
                ).await {
                    Ok(created) => {
                        let new_id = created.id.clone();
                        {
                            let tx = conn.transaction()?;
                            tx.execute_batch("PRAGMA defer_foreign_keys=ON")?;
                            let old_id = payload["temp_id"].as_str().unwrap_or(&op.entity_id).to_string();
                            tx.execute("UPDATE checklists SET id=?2, dirty=0 WHERE id=?1", rusqlite::params![old_id, new_id])?;
                            tx.execute("UPDATE checklists SET updated_at=?2 WHERE id=?1", rusqlite::params![new_id, created.updated_at])?;
                            tx.execute("UPDATE checklist_items SET checklist_id=?2 WHERE checklist_id=?1", rusqlite::params![old_id, new_id])?;
                            tx.execute("UPDATE outbox SET payload=json_set(payload, '$.checklist_id', ?2) WHERE state='pending' AND json_extract(payload, '$.checklist_id')=?1", rusqlite::params![old_id, new_id])?;
                            tx.execute("DELETE FROM lists_fts WHERE id=?1", rusqlite::params![old_id])?;
                            outbox::remap_entity_id(&tx, "checklist", &old_id, &new_id)?;
                            tx.commit()?;
                        }
                        Ok(())
                    }
                    Err(e) => Err(e),
                }
                ("checklist", "update") => match client.update_checklist(
                    &op.entity_id,
                    payload["title"].as_str().unwrap_or(""),
                    payload["category"].as_str().unwrap_or("Uncategorized"),
                ).await {
                    Ok(()) => {
                        let tx = conn.transaction()?;
                        checklists::mark_list_synced(&tx, &op.entity_id, &chrono::Utc::now().to_rfc3339())?;
                        tx.commit()?;
                        Ok(())
                    }
                    Err(e) => Err(e),
                }
                ("checklist", "delete") => client.delete_checklist(&op.entity_id).await,
                ("checklist_item", "create") => match fetch_list_snapshot(client, &item_list_id).await {
                    Ok(snap) => match resolve_parent_path(conn, &snap.items, &payload, &mut claims) {
                        Ok(parent_path) => match client.create_item(
                            &item_list_id,
                            payload["text"].as_str().unwrap_or(""),
                            parent_path.as_deref(),
                            // kanban cards carry their create-time column (T2 ruling):
                            // plain-list payloads have no status key -> as_str() -> None
                            // -> body unchanged (Ruling D byte-identical).
                            payload["status"].as_str(),
                        ).await {
                            Ok(()) => Ok(()),
                            Err(e) => Err(e),
                        },
                        Err(e) => Err(e),
                    },
                    Err(e) => Err(e),
                }
                ("checklist_item", "update") => match fetch_list_snapshot(client, &item_list_id).await {
                    Ok(snap) => match resolve_item_target(conn, &snap.items, payload["item_local_id"].as_str().unwrap_or(&op.entity_id), &mut claims, true) {
                        Ok(path) => match client.patch_item(&item_list_id, &path, payload["text"].as_str().unwrap_or("")).await {
                            Ok(()) => Ok(()),
                            Err(e) => Err(e),
                        },
                        Err(e) => Err(e),
                    },
                    Err(e) => Err(e),
                }
                ("checklist_item", "check") => match fetch_list_snapshot(client, &item_list_id).await {
                    Ok(snap) => match resolve_item_target(conn, &snap.items, payload["item_local_id"].as_str().unwrap_or(&op.entity_id), &mut claims, false) {
                        Ok(path) => match client.check_item(&item_list_id, &path, payload["checked"].as_bool().unwrap_or(false)).await {
                            Ok(()) => Ok(()),
                            Err(e) => Err(e),
                        },
                        Err(e) => Err(e),
                    },
                    Err(e) => Err(e),
                }
                ("checklist_item", "status") => match fetch_list_snapshot(client, &item_list_id).await {
                    Ok(snap) => match resolve_item_target(conn, &snap.items, payload["item_local_id"].as_str().unwrap_or(&op.entity_id), &mut claims, false) {
                        // text-verified (check-op class): a mis-targeted status move
                        // edits the wrong card — same hazard family as mis-targeted checks.
                        Ok(path) => match client.update_item_status(&item_list_id, &path, payload["status"].as_str().unwrap_or("todo")).await {
                            Ok(()) => Ok(()),
                            Err(e) => Err(e),
                        },
                        Err(e) => Err(e),
                    },
                    Err(e) => Err(e),
                }
                ("checklist_item", "delete") => match fetch_list_snapshot(client, &item_list_id).await {
                    Ok(snap) => match resolve_item_target(conn, &snap.items, payload["item_local_id"].as_str().unwrap_or(&op.entity_id), &mut claims, false) {
                        Ok(path) => match client.delete_item(&item_list_id, &path).await {
                            Ok(()) => {
                                items::delete_local(conn, payload["item_local_id"].as_str().unwrap_or(&op.entity_id))?;
                                Ok(())
                            }
                            Err(e) => Err(e),
                        },
                        Err(e) => Err(e),
                    },
                    Err(e) => Err(e),
                }
                ("checklist_item", "reorder") => match rebuild_replay(conn, client, &item_list_id, &payload).await {
                    Ok(()) => Ok(()),
                    Err(e) => Err(e),
                }
                _ => Err(crate::error::AppError::Other(format!("unknown op {}/{}", op.entity, op.op_type))),
            };
            match result {
                Ok(()) => {
                    outbox::mark_done(conn, op.seq)?;
                    stats.pushed += 1;
                }
                Err(AppError::Api { status: 404, .. })
                | Err(AppError::Api { status: 409, .. })
                | Err(AppError::Api { status: 410, .. })
                // client-error refusals are permanent for this op as-written:
                // 400 "Permission denied" (shared item the api user can't edit,
                // vanished grant, ...) would otherwise stay pending forever AND
                // the FIFO stop below would block every op queued behind it.
                | Err(AppError::Api { status: 400, .. })
                | Err(AppError::Api { status: 403, .. }) => {
                    outbox::mark_conflict(conn, op.seq, &format!("{:?}", AppError::Api { status: 0, body: "gone".into() }))?;
                    stats.conflicts += 1;
                }
                Err(e) if e.to_string().starts_with("unknown op") => {
                    outbox::mark_conflict(conn, op.seq, &e.to_string())?;
                    stats.conflicts += 1;
                }
                // (ruled 2026-09-17): an item op whose target can't be resolved is a CONFLICT
                // (state='conflict', UI offers keep-mine/take-server) — string-sentinel
                // precedent per the unknown-op arm.
                Err(e) if e.to_string().starts_with("unresolved item op") => {
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

async fn fetch_list_snapshot(client: &JottyClient, list_id: &str) -> AppResult<crate::jotty::models::ServerChecklist> {
    // v1 correctness rule: re-fetch the catalog before EACH item op's resolve —
    // index paths drift under concurrent edits, stored paths go stale.
    let lists = client.get_checklists().await?;
    lists
        .into_iter()
        .find(|c| c.id == list_id)
        .ok_or_else(|| AppError::Api { status: 404, body: format!("checklist {list_id} absent from index during item replay") })
}

async fn close_item_group(conn: &Connection, client: &JottyClient, list_id: &str) -> AppResult<()> {
    // group end: one re-fetch, reconcile that list, then mark synced with the server
    // updatedAt (LWW binding note: push WRITES timestamps, never COMPARES them).
    // A failed group-end fetch does NOT abort the run (unlike the pull's catalog rule —
    // no tombstone pass depends on it; ops are already done/conflicted): skip the
    // reconcile + mark_list_synced, the next pull imports server state. (T11's
    // checklist_create test pins this: its mock has no GET /api/checklists route.)
    if let Ok(lists) = client.get_checklists().await {
        if let Some(c) = lists.iter().find(|c| c.id == list_id) {
            items::reconcile(conn, list_id, &items::flatten(&c.items))?;
            checklists::mark_list_synced(conn, list_id, &c.updated_at)?;
        }
    }
    Ok(())
}

// Review ruling 2026-09-17: per-op target resolution over (item_local_id, path,
// text@path-at-claim) claims, shared by resolve_item_target (update/check/delete arms)
// and resolve_parent_path (create arm).
// (a) PRUNE: a claim whose (path, text@path) no longer matches the FRESH snapshot is
//     released — the claimed server item moved/changed, and a stale claim must not
//     block a different item now at that path.
// (b) IDENTITY: a surviving own claim resolves WITHOUT text equality in EVERY arm —
//     the own-claim memo stays all-arm (check→uncheck of the SAME item must keep
//     replaying at its path). The row's stored server_path hit, by contrast, is
//     UPDATE-ARM-ONLY (fix round 2, re-review N1): check/delete/create-parent ops at a
//     present-but-drifted stored path must fall through to the text fallback (baseline
//     6f9702d semantics — resolve()'s fast path is text-validated), never resolve a
//     drifted path without text verification. The claim for this item is (re)recorded
//     with the snapshot text at the resolved path either way.
// (c) FALLBACK: resolve() sees only OTHER items' claim paths (resolve.rs untouched);
//     two DIFFERENT identical-text items still never share a server item within a run.
fn resolve_with_claims(
    item_local_id: &str,
    server_path: Option<&str>,
    text: &str,
    snap_items: &[ServerItem],
    claims: &mut Vec<(String, String, String)>,
    update_arm: bool,
) -> Option<String> {
    let flat = items::flatten(snap_items);
    let text_at = |p: &str| flat.iter().find(|f| f.path == p).map(|f| f.text.clone());
    // (a) snapshot pruning
    claims.retain(|(_, p, t)| flat.iter().any(|f| f.path == *p && f.text == *t));
    // (b) own-claim memo
    if let Some((p, t)) = claims
        .iter()
        .find(|(id, _, _)| id == item_local_id)
        .and_then(|(_, p, _)| text_at(p).map(|t| (p.clone(), t)))
    {
        claims.retain(|(id, _, _)| id != item_local_id);
        claims.push((item_local_id.to_string(), p.clone(), t));
        return Some(p);
    }
    // (b) stored-path identity hit — UPDATE-ARM-ONLY (fix round 2, re-review N1:
    // check/delete/create-parent ops at a present-but-drifted stored path fall through
    // to the text fallback below; only the update arm may patch without text equality)
    if update_arm {
        if let Some(p) = server_path {
            if let Some(t) = text_at(p) {
                claims.retain(|(id, _, _)| id != item_local_id);
                claims.push((item_local_id.to_string(), p.to_string(), t));
                return Some(p.to_string());
            }
        }
    }
    // (c) text fallback against OTHER items' claims only
    let mut claimed: Vec<String> = claims
        .iter()
        .filter(|(id, _, _)| id != item_local_id)
        .map(|(_, p, _)| p.clone())
        .collect();
    let found = resolve(snap_items, server_path, text, &mut claimed);
    if let Some(p) = &found {
        if let Some(t) = text_at(p) {
            claims.retain(|(id, _, _)| id != item_local_id);
            claims.push((item_local_id.to_string(), p.clone(), t));
        }
    }
    found
}

fn resolve_item_target(
    conn: &Connection,
    snap_items: &[ServerItem],
    item_local_id: &str,
    claims: &mut Vec<(String, String, String)>,
    update_arm: bool,
) -> AppResult<String> {
    let row = items::get(conn, item_local_id)?
        .ok_or_else(|| AppError::Other(format!("unresolved item op {item_local_id}")))?;
    // F1 (review ruling 2026-09-17, update arm ONLY): a stored path that has VANISHED
    // from the fresh snapshot must not text-fallback for a patch (the row text is the
    // NEW text — a rename's target cannot be safely re-resolved) → sentinel conflict
    // directly. server_path None (created offline; its create replayed earlier this
    // run) keeps the normal text fallback below — bounded edge, may conflict.
    if update_arm {
        if let Some(p) = row.server_path.as_deref() {
            if !items::flatten(snap_items).iter().any(|f| f.path == p) {
                return Err(AppError::Other(format!("unresolved item op {item_local_id}")));
            }
        }
    }
    resolve_with_claims(
        item_local_id,
        row.server_path.as_deref(),
        &row.text,
        snap_items,
        claims,
        update_arm,
    )
    .ok_or_else(|| AppError::Other(format!("unresolved item op {item_local_id}")))
}

fn resolve_parent_path(
    conn: &Connection,
    snap_items: &[ServerItem],
    payload: &serde_json::Value,
    claims: &mut Vec<(String, String, String)>,
) -> AppResult<Option<String>> {
    let Some(parent_local_id) = payload["parent_local_id"].as_str() else {
        return Ok(None); // top-level create
    };
    let row = items::get(conn, parent_local_id)?
        .ok_or_else(|| AppError::Other(format!("unresolved item op {parent_local_id}")))?;
    // parent synced -> TEXT fallback via the shared helper (the stored-path identity
    // hit is UPDATE-ARM-ONLY, fix round 2 re-review N1 — fix round 1's "parent synced
    // -> stored path identity hit" note is superseded; a drifted parent path must
    // text-verify); parent also new -> its create op replayed earlier in FIFO (Task 14
    // enqueue order) — the same text fallback resolves it from the snapshot.
    resolve_with_claims(
        parent_local_id,
        row.server_path.as_deref(),
        &row.text,
        snap_items,
        claims,
        false,
    )
    .map(Some)
    .ok_or_else(|| AppError::Other(format!("unresolved item op {parent_local_id}")))
}

async fn rebuild_replay(
    conn: &Connection,
    client: &JottyClient,
    list_id: &str,
    payload: &serde_json::Value,
) -> AppResult<()> {
    // rebuild = fetch group snapshot -> delete every server item in REVERSE flatten order
    // (children before parents) -> re-create in local desired DFS order (top-level order
    // from the payload, children nested under their parents via parentIndex — never flat
    // ORDER BY position, R4) -> re-check recreated completed items.
    // M1 pre-wipe guard (review ruling 2026-09-17): every top-level local row must appear
    // in the payload's ordered ids; a stale/partial payload must become a sentinel
    // conflict BEFORE any client call, so the server list is never wiped by a payload we
    // cannot fully honor.
    let ordered: Vec<String> = payload["ordered_top_level_ids"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let rows = items::list_for_checklist(conn, list_id)?;
    if rows
        .iter()
        .any(|r| r.parent_id.is_none() && !ordered.contains(&r.local_id))
    {
        return Err(AppError::Other(format!(
            "unresolved item op {list_id} (reorder payload missing a top-level row)"
        )));
    }
    let snap = fetch_list_snapshot(client, list_id).await?;
    let flat = items::flatten(&snap.items);
    for s in flat.iter().rev() {
        client.delete_item(list_id, &s.path).await?;
    }
    let dfs = desired_dfs_order(&ordered, &rows);
    for (text, _, parent_path, _) in &dfs {
        client.create_item(list_id, text, parent_path.as_deref(), None).await?;
    }
    for (_, completed, _, path) in &dfs {
        if *completed {
            client.check_item(list_id, path, true).await?;
        }
    }
    // NB ruling: clear dirty on this checklist's items BEFORE reconcile(empty) -> re-fetch
    // -> reconcile(new) at group end — reconcile step-2 adoption requires server_path IS
    // NULL and step-3 deletes only clean rows, so stale dirty rows would be skipped and
    // duplicated by fresh INSERTs (production reorder marks items dirty=1, T5).
    conn.execute("UPDATE checklist_items SET dirty=0 WHERE checklist_id=?1", [list_id])?;
    items::reconcile(conn, list_id, &[])?;
    Ok(())
}

fn desired_dfs_order(
    ordered_top: &[String],
    rows: &[items::ItemRow],
) -> Vec<(String, bool, Option<String>, String)> {
    // sibling order within a parent comes from stored positions (maintained by T5); the forbidden flat rebuild applies to TOP-LEVEL ordering only (R4: children follow parents via parent_id nesting)
    let mut children_of: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        if let Some(p) = &r.parent_id {
            children_of.entry(p.clone()).or_default().push(i);
        }
    }
    let index_of: std::collections::HashMap<&str, usize> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| (r.local_id.as_str(), i))
        .collect();
    let mut out: Vec<(String, bool, Option<String>, String)> = Vec::new();
    fn walk(
        level: &[usize],
        rows: &[items::ItemRow],
        children_of: &std::collections::HashMap<String, Vec<usize>>,
        parent_path: Option<&str>,
        out: &mut Vec<(String, bool, Option<String>, String)>,
    ) {
        for (i, &ri) in level.iter().enumerate() {
            let r = &rows[ri];
            let path = match parent_path {
                None => i.to_string(),
                Some(p) => format!("{p}.{i}"),
            };
            out.push((r.text.clone(), r.completed, parent_path.map(str::to_string), path.clone()));
            if let Some(kids) = children_of.get(&r.local_id) {
                walk(kids, rows, children_of, Some(&path), out);
            }
        }
    }
    let top: Vec<usize> = ordered_top.iter().filter_map(|id| index_of.get(id.as_str()).copied()).collect();
    walk(&top, rows, &children_of, None, &mut out);
    out
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
            checklist_id: local.id.clone(), parent_local_id: None, text: "i".into(), status: None, priority: None, target_date: None,
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
        // (review ruling 2026-09-17): the create remap deletes the stale temp-id lists_fts row
        // (written by insert_local -> items::fts_refresh under the TEMP id; permanent orphan otherwise)
        let stale_fts: i64 = conn.query_row("SELECT count(*) FROM lists_fts WHERE id=?1", [&local.id], |r| r.get(0)).unwrap();
        assert_eq!(stale_fts, 0);
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
    async fn note_update_404_becomes_conflict_and_queue_continues() {
        let s = MockServer::start().await;
        // vanished target: note deleted server-side while locally dirty — brief line 20's
        // first-class case; the update arm must route it to mark_conflict (not an Err escape)
        Mock::given(method("PUT")).and(path("/api/notes/gone-1"))
            .respond_with(ResponseTemplate::new(404).set_body_string("nope"))
            .mount(&s).await;
        // a delete op queued behind must still replay after the conflict (FIFO continues)
        Mock::given(method("DELETE")).and(path("/api/notes/gone-2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        let mut conn = db();
        outbox::enqueue(&conn, "update", "note", "gone-1", &serde_json::json!({"id":"gone-1","title":"T","content":"c","category":"Home"})).unwrap();
        outbox::enqueue(&conn, "delete", "note", "gone-2", &serde_json::json!({})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.conflicts, 1);
        assert_eq!(stats.pushed, 1);
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
    }

    #[tokio::test]
    async fn permission_denied_400_becomes_conflict_and_queue_continues() {
        // regression: 400 "Permission denied" (shared-item edit the api user can't
        // edit, revoked grant, ...) fell into the transient bucket — the op stayed
        // pending FOREVER and the FIFO stop blocked every op queued behind it.
        let s = MockServer::start().await;
        Mock::given(method("PUT")).and(path("/api/checklists/cl-1"))
            .respond_with(ResponseTemplate::new(400).set_body_string("{\"error\":\"Permission denied\"}"))
            .mount(&s).await;
        // the op queued behind the blocked head must still replay in the same run
        Mock::given(method("PUT")).and(path("/api/checklists/cl-2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        let mut conn = db();
        outbox::enqueue(&conn, "update", "checklist", "cl-1", &serde_json::json!({"title":"T","category":"Home"})).unwrap();
        outbox::enqueue(&conn, "update", "checklist", "cl-2", &serde_json::json!({"title":"T2","category":"Home"})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.conflicts, 1, "400 must be a conflict, not a transient retry");
        assert_eq!(stats.pushed, 1, "the op behind the refused head must still replay");
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
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

    #[tokio::test]
    async fn item_ops_replay_against_fresh_indices() {
        let s = MockServer::start().await;
        // server list state at replay time: ONE item "a" at path "0" (drift: local thought 2 items)
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "checklists": [{"id":"l1","title":"L","category":"Home","items":[
                    {"id":"srv-a","index":0,"text":"a","completed":false}
                ],"createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]
            })))
            .mount(&s).await;
        Mock::given(method("PUT")).and(path("/api/checklists/l1/items/0/check"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        // force list id to server id and mark synced
        conn.execute("UPDATE checklists SET id='l1', dirty=0 WHERE id=?1", [&list.id]).unwrap();
        // local item "a" with stale server_path "0.5"
        let it = crate::db::items::insert_local(&conn, &crate::db::items::NewItem {
            checklist_id: "l1".into(), parent_local_id: None, text: "a".into(), status: None, priority: None, target_date: None,
        }).unwrap();
        conn.execute("UPDATE checklist_items SET server_path='0.5', dirty=0 WHERE local_id=?1", [&it.local_id]).unwrap();
        // queued check op for an item the server moved to path "0"
        outbox::enqueue(&conn, "check", "checklist_item", "l1",
            &serde_json::json!({"item_local_id": it.local_id, "checklist_id": "l1", "checked": true})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 1, "check op must resolve via text fallback and succeed");
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
    }

    #[tokio::test]
    async fn unresolvable_item_op_becomes_conflict() {
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "checklists": [{"id":"l1","title":"L","category":"Home","items":[
                    {"id":"srv-x","index":0,"text":"unrelated","completed":false}
                ],"createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]
            })))
            .mount(&s).await;
        let mut conn = db();
        conn.execute("INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('l1','L','Home','simple','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0)", []).unwrap();
        outbox::enqueue(&conn, "check", "checklist_item", "l1",
            &serde_json::json!({"item_local_id": "missing-item", "checklist_id": "l1", "checked": true})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.conflicts, 1);
    }

    #[tokio::test]
    async fn reorder_replays_as_rebuild() {
        let s = MockServer::start().await;
        // GET /api/checklists is CALL-COUNTED (binding ruling): call 1 returns the
        // original order [a(false), b(true)]; calls 2+ return the rebuilt order
        // [b(true), a(false)] — the post-rebuild reconcile fetch must see the new
        // server state. The impl makes exactly 2 GET calls for one reorder op
        // (group snapshot + post-group re-fetch).
        let get_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(move |_req: &_| {
                let n = get_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let items = if n == 0 {
                    serde_json::json!([
                        {"id":"srv-a","index":0,"text":"a","completed":false},
                        {"id":"srv-b","index":1,"text":"b","completed":true}
                    ])
                } else {
                    serde_json::json!([
                        {"id":"srv-b","index":0,"text":"b","completed":true},
                        {"id":"srv-a","index":1,"text":"a","completed":false}
                    ])
                };
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "checklists": [{"id":"l1","title":"L","category":"Home","items": items,
                        "createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]
                }))
            })
            .mount(&s).await;
        // rebuild: delete 1 (b) then 0 (a); recreate b, a; then re-check the recreated completed item
        for p in ["1", "0"] {
            Mock::given(method("DELETE")).and(path(format!("/api/checklists/l1/items/{p}")))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
                .mount(&s).await;
        }
        Mock::given(method("POST")).and(path("/api/checklists/l1/items"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        // re-check the recreated completed item (b recreated first -> path "0")
        Mock::given(method("PUT")).and(path("/api/checklists/l1/items/0/check"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        let mut conn = db();
        conn.execute("INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('l1','L','Home','simple','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0)", []).unwrap();
        // two local items a,b already synced with server_paths
        let a = crate::db::items::insert_local(&conn, &crate::db::items::NewItem { checklist_id: "l1".into(), parent_local_id: None, text: "a".into(), status: None, priority: None, target_date: None }).unwrap();
        let b = crate::db::items::insert_local(&conn, &crate::db::items::NewItem { checklist_id: "l1".into(), parent_local_id: None, text: "b".into(), status: None, priority: None, target_date: None }).unwrap();
        conn.execute("UPDATE checklist_items SET server_path='0', dirty=0 WHERE local_id=?1", [&a.local_id]).unwrap();
        conn.execute("UPDATE checklist_items SET server_path='1', dirty=0, completed=1 WHERE local_id=?1", [&b.local_id]).unwrap();
        // reorder: b first
        outbox::enqueue(&conn, "reorder", "checklist_item", "l1",
            &serde_json::json!({"checklist_id": "l1", "ordered_top_level_ids": [b.local_id, a.local_id]})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 1);
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
        // post-rebuild reconcile re-imports server items in the new order
        let items = crate::db::items::list_for_checklist(&conn, "l1").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].text, "b");
        assert_eq!(items[1].text, "a");
    }

    #[tokio::test]
    async fn item_update_renames_via_stored_path_without_text_conflict() {
        let s = MockServer::start().await;
        // server still holds the OLD text at path 0 — the row text is the NEW text
        // (update_local mutated it command-time); the update arm must patch the
        // stored path WITHOUT text equality (review ruling: path-existence)
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "checklists": [{"id":"l1","title":"L","category":"Home","items":[
                    {"id":"srv-a","index":0,"text":"old","completed":false}
                ],"createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]
            })))
            .mount(&s).await;
        Mock::given(method("PATCH")).and(path("/api/checklists/l1/items/0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        let mut conn = db();
        conn.execute("INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('l1','L','Home','simple','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0)", []).unwrap();
        let it = crate::db::items::insert_local(&conn, &crate::db::items::NewItem {
            checklist_id: "l1".into(), parent_local_id: None, text: "old".into(), status: None, priority: None, target_date: None,
        }).unwrap();
        // synced earlier at path "0", then renamed OFFLINE: row text = new, server text = old
        conn.execute("UPDATE checklist_items SET server_path='0', dirty=1, text='new' WHERE local_id=?1", [&it.local_id]).unwrap();
        outbox::enqueue(&conn, "update", "checklist_item", &it.local_id,
            &serde_json::json!({"item_local_id": it.local_id, "checklist_id": "l1", "text": "new"})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 1, "rename must patch the stored path even though server text differs");
        assert_eq!(stats.conflicts, 0);
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
    }

    #[tokio::test]
    async fn item_multi_op_same_run() {
        let s = MockServer::start().await;
        // check then uncheck the SAME item in one run: the own-claim memo must
        // let the second op resolve to the same path (no spurious conflict)
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "checklists": [{"id":"l1","title":"L","category":"Home","items":[
                    {"id":"srv-a","index":0,"text":"a","completed":false}
                ],"createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]
            })))
            .mount(&s).await;
        Mock::given(method("PUT")).and(path("/api/checklists/l1/items/0/check"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        Mock::given(method("PUT")).and(path("/api/checklists/l1/items/0/uncheck"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        let mut conn = db();
        conn.execute("INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('l1','L','Home','simple','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0)", []).unwrap();
        let it = crate::db::items::insert_local(&conn, &crate::db::items::NewItem {
            checklist_id: "l1".into(), parent_local_id: None, text: "a".into(), status: None, priority: None, target_date: None,
        }).unwrap();
        conn.execute("UPDATE checklist_items SET server_path='0', dirty=0 WHERE local_id=?1", [&it.local_id]).unwrap();
        outbox::enqueue(&conn, "check", "checklist_item", &it.local_id,
            &serde_json::json!({"item_local_id": it.local_id, "checklist_id": "l1", "checked": true})).unwrap();
        outbox::enqueue(&conn, "check", "checklist_item", &it.local_id,
            &serde_json::json!({"item_local_id": it.local_id, "checklist_id": "l1", "checked": false})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 2, "check then uncheck on the SAME item must both replay");
        assert_eq!(stats.conflicts, 0);
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
    }

    #[tokio::test]
    async fn item_check_resolves_via_text_after_delete_shift() {
        let s = MockServer::start().await;
        // Delete-shift regression pin (re-review N1, fix round 2): a@0, c@1, y@2
        // all synced; ops: check a, delete a, check c. After a's delete the
        // server reindexes to [c@0, y@1] — c's stale stored path "1" now holds
        // y. The stored-path identity hit is UPDATE-ARM-ONLY, so the check op
        // must fall through to the TEXT fallback and check c at its NEW path
        // "0" — never the drifted stored path "1".
        let check_hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stale_hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let gets = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(move |_req: &_| {
                let n = gets.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let items = if n < 2 {
                    serde_json::json!([
                        {"id":"srv-a","index":0,"text":"a","completed":false},
                        {"id":"srv-c","index":1,"text":"c","completed":false},
                        {"id":"srv-y","index":2,"text":"y","completed":false}
                    ])
                } else {
                    serde_json::json!([
                        {"id":"srv-c","index":0,"text":"c","completed":false},
                        {"id":"srv-y","index":1,"text":"y","completed":false}
                    ])
                };
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "checklists": [{"id":"l1","title":"L","category":"Home","items": items,
                        "createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]
                }))
            })
            .mount(&s).await;
        Mock::given(method("DELETE")).and(path("/api/checklists/l1/items/0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        {
            let check_hits = check_hits.clone();
            Mock::given(method("PUT")).and(path("/api/checklists/l1/items/0/check"))
                .respond_with(move |_req: &_| {
                    check_hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true}))
                })
                .mount(&s).await;
        }
        {
            let stale_hits = stale_hits.clone();
            Mock::given(method("PUT")).and(path("/api/checklists/l1/items/1/check"))
                .respond_with(move |_req: &_| {
                    stale_hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true}))
                })
                .mount(&s).await;
        }
        let mut conn = db();
        conn.execute("INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('l1','L','Home','simple','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0)", []).unwrap();
        let a = crate::db::items::insert_local(&conn, &crate::db::items::NewItem { checklist_id: "l1".into(), parent_local_id: None, text: "a".into(), status: None, priority: None, target_date: None }).unwrap();
        let c = crate::db::items::insert_local(&conn, &crate::db::items::NewItem { checklist_id: "l1".into(), parent_local_id: None, text: "c".into(), status: None, priority: None, target_date: None }).unwrap();
        conn.execute("UPDATE checklist_items SET server_path='0', dirty=0 WHERE local_id=?1", [&a.local_id]).unwrap();
        conn.execute("UPDATE checklist_items SET server_path='1', dirty=0 WHERE local_id=?1", [&c.local_id]).unwrap();
        // FIFO: check a (resolves "0"), delete a (resolves "0"; server reindexes),
        // check c (stale stored path "1" — must TEXT-resolve to "0")
        outbox::enqueue(&conn, "check", "checklist_item", &a.local_id,
            &serde_json::json!({"item_local_id": a.local_id, "checklist_id": "l1", "checked": true})).unwrap();
        outbox::enqueue(&conn, "delete", "checklist_item", &a.local_id,
            &serde_json::json!({"item_local_id": a.local_id, "checklist_id": "l1"})).unwrap();
        outbox::enqueue(&conn, "check", "checklist_item", &c.local_id,
            &serde_json::json!({"item_local_id": c.local_id, "checklist_id": "l1", "checked": true})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 3, "all three ops must replay");
        assert_eq!(stats.conflicts, 0);
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
        // the post-delete check of c must land at its NEW path "0" (text-resolved),
        // never at the drifted stored path "1" (which holds y after the reindex)
        assert_eq!(check_hits.load(std::sync::atomic::Ordering::SeqCst), 2,
            "path 0 checked once for a (pre-delete) and once for c (post-delete)");
        assert_eq!(stale_hits.load(std::sync::atomic::Ordering::SeqCst), 0,
            "the drifted stored path \"1\" must never be checked (identity hit is update-arm-only)");
    }

    #[tokio::test]
    async fn status_move_replays_to_resolved_path() {
        // Board with a drifted layout: item stored at path "0" locally but now at
        // "1" server-side (new item inserted above). Text-verified resolution must
        // find it by TEXT and hit /items/1/status, never /items/0/status.
        // (N1 class: aggregate stats can mask mis-targets — per-endpoint counters.)
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let hit0 = Arc::new(AtomicUsize::new(0));
        let hit1 = Arc::new(AtomicUsize::new(0));
        let s = MockServer::start().await;
        // catalog snapshot: [other, card]  -> "card" lives at path "1"
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "checklists": [ { "id": "l1", "title": "B", "category": "Home", "type": "kanban",
                    "items": [ { "index": 0, "text": "other", "completed": false, "status": "todo" },
                               { "index": 1, "text": "card", "completed": false, "status": "todo" } ],
                    "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" } ]
            })))
            .mount(&s).await;
        let h0 = hit0.clone();
        Mock::given(method("PUT")).and(path("/api/tasks/l1/items/0/status"))
            .respond_with(move |_: &wiremock::Request| {
                h0.fetch_add(1, Ordering::SeqCst);
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true}))
            })
            .mount(&s).await;
        let h1 = hit1.clone();
        Mock::given(method("PUT")).and(path("/api/tasks/l1/items/1/status"))
            .respond_with(move |_: &wiremock::Request| {
                h1.fetch_add(1, Ordering::SeqCst);
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true}))
            })
            .mount(&s).await;
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        // setup amendment (task-4-report): remap the fresh local list to the mocked
        // server id + clear dirty — the brief's sketch omitted the remap, so
        // fetch_list_snapshot's catalog find(c.id == payload.checklist_id) would 404
        // -> conflict regardless of the new arm (item_ops_replay_against_fresh_indices shape).
        conn.execute("UPDATE checklists SET id='l1', dirty=0 WHERE id=?1", [&list.id]).unwrap();
        // simulate the drifted state: the row was synced when "card" sat at path "0"
        conn.execute(
            "INSERT INTO checklist_items (local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date)
             VALUES ('it-1', 'l1', NULL, 'card', 0, 0, '0', 0, 'todo', NULL, NULL)",
            [],
        ).unwrap();
        outbox::enqueue(&conn, "status", "checklist_item", "it-1",
            &serde_json::json!({"item_local_id": "it-1", "checklist_id": "l1", "status": "in_progress"})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 1);
        assert_eq!(stats.conflicts, 0);
        assert_eq!(hit1.load(Ordering::SeqCst), 1, "text-verified resolve must hit the drifted path 1");
        assert_eq!(hit0.load(Ordering::SeqCst), 0, "stale stored path must never be touched");
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
    }

    #[tokio::test]
    async fn status_move_text_mismatch_is_sentinel_conflict() {
        // item renamed server-side: text fallback fails -> unresolved -> conflict
        // (same classification as check ops), NOT a wrong-item write.
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let hit = Arc::new(AtomicUsize::new(0));
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "checklists": [ { "id": "l1", "title": "B", "category": "Home", "type": "kanban",
                    "items": [ { "index": 0, "text": "renamed-away", "completed": false, "status": "todo" } ],
                    "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" } ]
            })))
            .mount(&s).await;
        let h = hit.clone();
        Mock::given(method("PUT")).and(path("/api/tasks/l1/items/0/status"))
            .respond_with(move |_: &wiremock::Request| {
                h.fetch_add(1, Ordering::SeqCst);
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true}))
            })
            .mount(&s).await;
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        // setup amendment (task-4-report): same remap as status_move_replays_to_resolved_path
        conn.execute("UPDATE checklists SET id='l1', dirty=0 WHERE id=?1", [&list.id]).unwrap();
        conn.execute(
            "INSERT INTO checklist_items (local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date)
             VALUES ('it-1', 'l1', NULL, 'card', 0, 0, '0', 0, 'todo', NULL, NULL)",
            [],
        ).unwrap();
        outbox::enqueue(&conn, "status", "checklist_item", "it-1",
            &serde_json::json!({"item_local_id": "it-1", "checklist_id": "l1", "status": "in_progress"})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.conflicts, 1);
        assert_eq!(hit.load(Ordering::SeqCst), 0, "unresolved target must never write");
    }

    #[tokio::test]
    async fn status_move_400_marks_conflict_and_keeps_fifo() {
        // server returns 400 -> mark_conflict; an op queued BEHIND it still replays
        // (the FIFO must not stall on a permanent refusal) — mirrors the
        // permission-denied classification test class.
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "checklists": [ { "id": "l1", "title": "B", "category": "Home", "type": "kanban",
                    "items": [ { "index": 0, "text": "card", "completed": false, "status": "todo" } ],
                    "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" } ]
            })))
            .mount(&s).await;
        Mock::given(method("PUT")).and(path("/api/tasks/l1/items/0/status"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({"error": "Permission denied"})))
            .mount(&s).await;
        // the op behind it: a note create (unrelated entity, must still push)
        Mock::given(method("POST")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": {"id":"srv-n","title":"T","content":"c","category":"Home","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","owner":"u"}
            })))
            .mount(&s).await;
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        // setup amendment (task-4-report): same remap as status_move_replays_to_resolved_path
        conn.execute("UPDATE checklists SET id='l1', dirty=0 WHERE id=?1", [&list.id]).unwrap();
        conn.execute(
            "INSERT INTO checklist_items (local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date)
             VALUES ('it-1', 'l1', NULL, 'card', 0, 0, '0', 0, 'todo', NULL, NULL)",
            [],
        ).unwrap();
        outbox::enqueue(&conn, "status", "checklist_item", "it-1",
            &serde_json::json!({"item_local_id": "it-1", "checklist_id": "l1", "status": "in_progress"})).unwrap();
        outbox::enqueue(&conn, "create", "note", "n-1", &serde_json::json!({"temp_id": "n-1", "title":"T","content":"c","category":"Home"})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.conflicts, 1);   // the 400 status move
        assert_eq!(stats.pushed, 1);      // the note create behind it still replayed
    }

    #[tokio::test]
    async fn item_create_replay_carries_status_in_body() {
        // controller addition (T2 ruling): Task 3's add_item_inner enqueues "status" in
        // kanban-card create payloads — the replay must carry it or offline-created
        // cards land in the first column server-side. Plain-list creates (payload with
        // NO status key) must keep a status-free POST body (Ruling D byte-identical).
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "checklists": [ { "id": "l1", "title": "B", "category": "Home", "type": "kanban",
                    "items": [],
                    "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" } ]
            })))
            .mount(&s).await;
        Mock::given(method("POST")).and(path("/api/checklists/l1/items"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true})))
            .mount(&s).await;
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        // setup amendment (task-4-report): same remap as status_move_replays_to_resolved_path
        conn.execute("UPDATE checklists SET id='l1', dirty=0 WHERE id=?1", [&list.id]).unwrap();
        // kanban-card create payload (add_item_inner Ruling D shape incl. status)
        outbox::enqueue(&conn, "create", "checklist_item", "it-1",
            &serde_json::json!({"checklist_id": "l1", "item_local_id": "it-1", "text": "card", "parent_local_id": null, "status": "in_progress"})).unwrap();
        // plain-list create payload: NO status key — body must stay status-free
        outbox::enqueue(&conn, "create", "checklist_item", "it-2",
            &serde_json::json!({"checklist_id": "l1", "item_local_id": "it-2", "text": "plain", "parent_local_id": null})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 2);
        assert_eq!(stats.conflicts, 0);
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
        let reqs = s.received_requests().await.unwrap();
        let posts: Vec<&wiremock::Request> = reqs.iter()
            .filter(|r| r.method.as_str() == "POST" && r.url.path() == "/api/checklists/l1/items")
            .collect();
        assert_eq!(posts.len(), 2, "both creates must replay as POSTs to the items endpoint");
        let with_status = String::from_utf8_lossy(&posts[0].body).to_string();
        let plain = String::from_utf8_lossy(&posts[1].body).to_string();
        assert!(with_status.contains("\"status\":\"in_progress\""), "kanban create body must carry the create-time status: {with_status}");
        assert!(with_status.contains("\"text\":\"card\""), "body: {with_status}");
        assert!(!plain.contains("\"status\""), "plain-list create body must stay status-free (Ruling D): {plain}");
    }
}
