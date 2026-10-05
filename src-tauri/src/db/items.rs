use crate::db::outbox;
use crate::error::AppResult;
use crate::jotty::models::{flatten_items, ServerItem};
use rusqlite::Connection;
use serde_json::json;

#[derive(Debug, Clone, PartialEq)]
pub struct ItemRow {
    pub local_id: String,
    pub checklist_id: String,
    pub parent_id: Option<String>,
    pub text: String,
    pub completed: bool,
    pub position: i64,
    pub server_path: Option<String>,
    pub dirty: bool,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub target_date: Option<String>,
    pub start_date: Option<String>,
    pub server_item_id: Option<String>,
    pub reminder_datetime: Option<String>,
    pub reminder_notified: Option<bool>,
    pub recurrence: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewItem {
    pub checklist_id: String,
    pub parent_local_id: Option<String>,
    pub text: String,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub target_date: Option<String>,
}

pub struct ServerItemFlat {
    pub path: String,
    pub id: Option<String>,
    pub text: String,
    pub completed: bool,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub target_date: Option<String>,
    pub start_date: Option<String>,
}

pub fn flatten(server_items: &[ServerItem]) -> Vec<ServerItemFlat> {
    flatten_items(server_items)
        .into_iter()
        .map(|(path, it)| ServerItemFlat {
            path,
            id: it.id.clone(),
            text: it.text.clone(),
            completed: it.completed.unwrap_or(false),
            status: it.status.clone(),
            priority: it.priority.clone(),
            target_date: it.target_date.clone(),
            start_date: it.start_date.clone(),
        })
        .collect()
}

fn fts_refresh(conn: &Connection, list_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM lists_fts WHERE id=?1", [list_id])?;
    conn.execute(
        "INSERT INTO lists_fts(id, title, item_text)
         SELECT c.id, c.title, COALESCE((SELECT GROUP_CONCAT(text, ' ') FROM checklist_items WHERE checklist_id=c.id), '')
         FROM checklists c WHERE c.id=?1",
        [list_id],
    )?;
    Ok(())
}

const COLS: &str = "local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date, start_date, server_item_id, reminder_datetime, reminder_notified, recurrence";

fn row(r: &rusqlite::Row) -> rusqlite::Result<ItemRow> {
    Ok(ItemRow {
        local_id: r.get(0)?,
        checklist_id: r.get(1)?,
        parent_id: r.get(2)?,
        text: r.get(3)?,
        completed: r.get::<_, i64>(4)? != 0,
        position: r.get(5)?,
        server_path: r.get(6)?,
        dirty: r.get::<_, i64>(7)? != 0,
        status: r.get(8)?,
        priority: r.get(9)?,
        target_date: r.get(10)?,
        start_date: r.get(11)?,
        server_item_id: r.get(12)?,
        reminder_datetime: r.get(13)?,
        reminder_notified: r.get::<_, Option<i64>>(14)?.map(|v| v != 0),
        recurrence: r.get(15)?,
    })
}

pub fn get(conn: &Connection, local_id: &str) -> AppResult<Option<ItemRow>> {
    let sql = format!("SELECT {COLS} FROM checklist_items WHERE local_id=?1");
    use rusqlite::OptionalExtension;
    Ok(conn.query_row(&sql, [local_id], |r| row(r)).optional()?)
}

pub fn list_for_checklist(conn: &Connection, checklist_id: &str) -> AppResult<Vec<ItemRow>> {
    let sql = format!("SELECT {COLS} FROM checklist_items WHERE checklist_id=?1 ORDER BY position");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([checklist_id], |r| row(r))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn reconcile(conn: &Connection, checklist_id: &str, server_items: &[ServerItemFlat]) -> AppResult<()> {
    let local = list_for_checklist(conn, checklist_id)?;
    let mut claimed: Vec<String> = Vec::new(); // local_ids matched to server
    // pending ops shield items from adoption/deletion until their op resolves (Task 7 push-then-pull).
    // The shield applies to EVERY arm: at pull time pending = failed/conflicted ops, and a pull
    // must never clobber the fields those ops own (a conflicted check kept its completed=1 here).
    let pending: Vec<String> = local
        .iter()
        .filter(|l| matches!(outbox::has_pending_for(conn, "checklist_item", &l.local_id), Ok(true)))
        .map(|l| l.local_id.clone())
        .collect();
    // local_id of the row currently bound to each claimed server path, for dot-path
    // parent derivation: DFS order guarantees a parent claim/insert lands before
    // its children are processed ("0" before "0.0" before "0.0.1").
    let mut bound: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    // Drift signature (v0.21.3 set_reminder precedent): a row's server_item_id is
    // trustworthy only while the item at its stamped path still carries the row's
    // text. The old text-agnostic path claim is what let a +1-shifted layout
    // (upstream creates insert at index 0 — live-verified 1.27.0) stamp foreign
    // flags/ids onto every row while KEEPING their texts, plus insert a tail copy —
    // the "completed task shows in BOTH sections" field bug (2026-10-03).
    // Tenant gone from the snapshot counts as drifted too (layout shrank).
    fn signature_ok(row: &ItemRow, server_items: &[ServerItemFlat]) -> bool {
        match row.server_path.as_deref() {
            None => true,
            Some(p) => server_items.iter().find(|f| f.path == p)
                .map(|f| f.text == row.text)
                .unwrap_or(false),
        }
    }

    fn parent_prefix(path: &str) -> Option<String> {
        path.rsplit_once('.').map(|(p, _)| p.to_string())
    }

    for (order, s) in server_items.iter().enumerate() {
        // A) stable id WITH drift signature (server truth when the binding agrees).
        let mut target = s.id.as_deref().and_then(|id|
            local.iter().find(|l| {
                l.server_item_id.as_deref() == Some(id)
                    && !claimed.contains(&l.local_id)
                    && !pending.contains(&l.local_id)
                    && signature_ok(l, server_items)
            })
        );
        // B) stored path + text: the same item at an untouched index path.
        if target.is_none() {
            target = local.iter().find(|l| {
                l.server_path.as_deref() == Some(s.path.as_str())
                    && !claimed.contains(&l.local_id)
                    && !pending.contains(&l.local_id)
                    && l.text == s.text
            });
        }
        // C) dirty in-place fence (pinned by reconcile_keeps_dirty_local_edits): a
        // DIRTY row still at its path whose id agrees (or predates ids) is a local
        // edit mid-flight — the local edit owns the row AND its text; claim it
        // WITHOUT taking the server text. The id gate refuses this ride to a
        // DRIFTED dirty row (id disagrees = its item moved = text adopt below).
        if target.is_none() {
            target = local.iter().find(|l| {
                l.dirty
                    && l.server_path.as_deref() == Some(s.path.as_str())
                    && !claimed.contains(&l.local_id)
                    && !pending.contains(&l.local_id)
                    && l.text != s.text
                    && (l.server_item_id.is_none() || l.server_item_id.as_deref() == s.id.as_deref())
            });
        }
        // D) text adopt (drift heal + never-synced locals): any unclaimed,
        // non-pending row whose text matches, whatever its stored path — this is
        // the arm that REBINDS shifted layouts (and clears the stale duplicate).
        if target.is_none() {
            target = local.iter().find(|l| {
                !claimed.contains(&l.local_id) && !pending.contains(&l.local_id) && l.text == s.text
            });
        }
        match target {
            Some(l) => {
                claimed.push(l.local_id.clone());
                // Dirty rows keep their local text (the queued op owns it until it
                // replays); clean rows mirror server truth, which repairs text on
                // id-confirmed claims whose stored path had drifted away.
                let text = if l.dirty { l.text.clone() } else { s.text.clone() };
                let parent_local = parent_prefix(&s.path).and_then(|p| bound.get(&p).cloned());
                conn.execute(
                    "UPDATE checklist_items SET position=?2, text=?3, completed=?4, server_path=?5, status=?6, priority=?7, target_date=?8, start_date=?9, server_item_id=?10, parent_id=?11, dirty=0 WHERE local_id=?1",
                    rusqlite::params![l.local_id, order as i64, text, s.completed as i64, s.path, s.status.clone(), s.priority.clone(), s.target_date.clone(), s.start_date.clone(), s.id.clone(), parent_local],
                )?;
                bound.insert(s.path.clone(), l.local_id.clone());
            }
            None => {
                let local_id = uuid::Uuid::new_v4().to_string();
                let parent_local = parent_prefix(&s.path).and_then(|p| bound.get(&p).cloned());
                conn.execute(
                    "INSERT INTO checklist_items (local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date, start_date, server_item_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11, ?12)",
                    rusqlite::params![local_id, checklist_id, parent_local, s.text, s.completed as i64, order as i64, s.path, s.status.clone(), s.priority.clone(), s.target_date.clone(), s.start_date.clone(), s.id.clone()],
                )?;
                bound.insert(s.path.clone(), local_id);
            }
        }
    }
    // 5) unclaimed, not dirty, no pending op -> server removed it
    for l in local.iter() {
        if claimed.contains(&l.local_id) { continue; }
        if l.dirty { continue; }
        if outbox::has_pending_for(conn, "checklist_item", &l.local_id)? { continue; }
        delete_local(conn, &l.local_id)?;
    }
    fts_refresh(conn, checklist_id)?;
    Ok(())
}

pub fn insert_local(conn: &Connection, n: &NewItem) -> AppResult<ItemRow> {
    let parent_pos_base: i64 = match &n.parent_local_id {
        Some(pid) => {
            let p = get(conn, pid)?.ok_or_else(|| crate::error::AppError::Other("parent not found".into()))?;
            // children positions continue after parent's subtree; simple: max over all +1 (DFS order kept by reconcile)
            let max_pos: i64 = conn.query_row("SELECT COALESCE(MAX(position), -1) FROM checklist_items WHERE checklist_id=?1", [&n.checklist_id], |r| r.get(0))?;
            let _ = p;
            max_pos + 1
        }
        None => {
            let max_pos: i64 = conn.query_row(
                "SELECT COALESCE(MAX(position), -1) FROM checklist_items WHERE checklist_id=?1 AND parent_id IS NULL",
                [&n.checklist_id], |r| r.get(0))?;
            max_pos + 1
        }
    };
    let local_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO checklist_items (local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date)
         VALUES (?1,?2,?3,?4,0,?5,NULL,1,?6,?7,?8)",
        rusqlite::params![local_id, n.checklist_id, n.parent_local_id, n.text, parent_pos_base, n.status.clone(), n.priority.clone(), n.target_date.clone()],
    )?;
    fts_refresh(conn, &n.checklist_id)?;
    Ok(get(conn, &local_id)?.unwrap())
}

pub fn update_local(conn: &Connection, local_id: &str, text: &str) -> AppResult<ItemRow> {
    conn.execute("UPDATE checklist_items SET text=?2, dirty=1 WHERE local_id=?1", rusqlite::params![local_id, text])?;
    let item = get(conn, local_id)?.ok_or_else(|| crate::error::AppError::Other("item not found".into()))?;
    fts_refresh(conn, &item.checklist_id)?;
    Ok(item)
}

pub fn set_checked(conn: &Connection, local_id: &str, checked: bool) -> AppResult<ItemRow> {
    conn.execute("UPDATE checklist_items SET completed=?2, dirty=1 WHERE local_id=?1", rusqlite::params![local_id, checked as i64])?;
    let item = get(conn, local_id)?.ok_or_else(|| crate::error::AppError::Other("item not found".into()))?;
    Ok(item)
}

/// Set/clear a kanban card's target date. Row always marked dirty=1 (the
/// queued set_date op owns the server write; until it replays the local
/// value is the truth and must not be clobbered by a pull).
pub fn set_target_date(conn: &Connection, local_id: &str, target_date: Option<String>) -> AppResult<ItemRow> {
    conn.execute("UPDATE checklist_items SET target_date=?2, dirty=1 WHERE local_id=?1", rusqlite::params![local_id, target_date])?;
    let item = get(conn, local_id)?.ok_or_else(|| crate::error::AppError::Other("item not found".into()))?;
    Ok(item)
}

/// Local reminder edit (T3 set_reminder op): write the reminder datetime and
/// mark the row dirty=1 — the LOCAL edit owns the server write (the queued
/// set_reminder op replays it via client.set_item_reminder).
pub fn set_reminder_local(conn: &Connection, local_id: &str, datetime: Option<String>) -> AppResult<ItemRow> {
    conn.execute(
        "UPDATE checklist_items SET reminder_datetime=?2, dirty=1 WHERE local_id=?1",
        rusqlite::params![local_id, datetime],
    )?;
    Ok(get(conn, local_id)?.ok_or_else(|| crate::error::AppError::Other("item not found".into()))?)
}

/// Enrichment mirror (T3): write/clear the reminder columns from SERVER truth
/// WITHOUT touching `dirty` — the dirty flag is owned by local edits + ops,
/// never by a pull-side mirror.
pub fn set_reminder_from_server(conn: &Connection, local_id: &str, datetime: Option<String>, notified: Option<bool>) -> AppResult<()> {
    conn.execute(
        "UPDATE checklist_items SET reminder_datetime=?2, reminder_notified=?3 WHERE local_id=?1",
        rusqlite::params![local_id, datetime, notified],
    )?;
    Ok(())
}

pub fn set_recurrence_raw(conn: &Connection, local_id: &str, value: Option<&str>) -> AppResult<()> {
    // LOCAL-ONLY: recurrence never syncs; no dirty flag, NO outbox op (voice audio precedent).
    conn.execute(
        "UPDATE checklist_items SET recurrence=?1 WHERE local_id=?2",
        rusqlite::params![value, local_id],
    )?;
    Ok(())
}

/// Mirrors upstream applyStatus (item-status-utils.ts, source-verified 2026-09-20):
/// target autoComplete -> completed=1; status CHANGED on a completed row -> completed=0;
/// same-status no-op -> completed untouched. Row always marked dirty=1.
pub fn set_status(conn: &Connection, local_id: &str, status: Option<String>, target_auto: bool, changed: bool) -> AppResult<ItemRow> {
    conn.execute(
        "UPDATE checklist_items SET status=?2,
            completed = CASE WHEN ?3 THEN 1 WHEN ?4 AND completed = 1 THEN 0 ELSE completed END,
            dirty = 1
         WHERE local_id=?1",
        rusqlite::params![local_id, status, target_auto as i64, changed as i64],
    )?;
    Ok(get(conn, local_id)?.ok_or_else(|| crate::error::AppError::Other("item not found".into()))?)
}

/// applyStatus's child cascade: moving INTO an autoComplete column completes ALL descendants.
pub fn set_completed_recursive(conn: &Connection, local_id: &str, completed: bool) -> AppResult<()> {
    let mut to_update = vec![local_id.to_string()];
    let mut i = 0;
    while i < to_update.len() {
        let id = to_update[i].clone();
        let mut stmt = conn.prepare("SELECT local_id FROM checklist_items WHERE parent_id=?1")?;
        let kids = stmt.query_map([&id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        to_update.extend(kids);
        i += 1;
    }
    for id in &to_update {
        conn.execute("UPDATE checklist_items SET completed=?2, dirty=1 WHERE local_id=?1", rusqlite::params![id, completed as i64])?;
    }
    Ok(())
}

pub fn delete_local(conn: &Connection, local_id: &str) -> AppResult<()> {
    use rusqlite::OptionalExtension;
    let list_id: Option<String> = conn
        .query_row("SELECT checklist_id FROM checklist_items WHERE local_id=?1", [local_id], |r| r.get(0))
        .optional()?;
    // collect descendants (BFS) then delete children-first
    let mut to_delete = vec![local_id.to_string()];
    let mut i = 0;
    while i < to_delete.len() {
        let id = &to_delete[i];
        let mut stmt = conn.prepare("SELECT local_id FROM checklist_items WHERE parent_id=?1")?;
        let children: Vec<String> = stmt.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        to_delete.extend(children);
        i += 1;
    }
    for id in to_delete.iter().rev() {
        conn.execute("DELETE FROM checklist_items WHERE local_id=?1", [id])?;
    }
    if let Some(l) = list_id { fts_refresh(conn, &l)?; }
    Ok(())
}

pub fn reorder_local(conn: &Connection, checklist_id: &str, ordered_top_level_ids: &[String]) -> AppResult<()> {
    // rewrite top-level positions 0..n; children keep relative DFS position via same order pass
    for (i, id) in ordered_top_level_ids.iter().enumerate() {
        conn.execute(
            "UPDATE checklist_items SET position=?2, dirty=1 WHERE local_id=?1",
            rusqlite::params![id, i as i64],
        )?;
    }
    fts_refresh(conn, checklist_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{checklists, items, migrations, open};
    use serde_json::json;
    use std::path::Path;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&conn).unwrap();
        conn
    }

    fn server_item(text: &str, completed: bool, children: Vec<ServerItem>) -> ServerItem {
        ServerItem {
            id: Some(format!("srv-{}", text.replace(' ', "-"))),
            index: 0,
            text: text.into(),
            completed: Some(completed),
            status: None,
            description: None,
            children,
            priority: None,
            score: None,
            start_date: None,
            target_date: None,
            estimated_time: None,
            reminder: None,
        }
    }

    #[test]
    fn reconcile_adopts_new_local_items_by_text() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        // local new item (dirty, no server_path)
        let it = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "buy milk".into(), status: None, priority: None, target_date: None }).unwrap();
        assert!(it.dirty);
        // server has the same item (someone created it on the web)
        let server = vec![server_item("buy milk", false, vec![])];
        let flat = flatten(&server);
        reconcile(&conn, &list.id, &flat).unwrap();
        let items = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].local_id, it.local_id, "existing local row must be adopted, not duplicated");
        assert_eq!(items[0].server_path.as_deref(), Some("0"));
        assert!(!items[0].dirty);
    }

    #[test]
    fn reconcile_removes_server_deleted_items_unless_dirty() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        let server = vec![server_item("a", false, vec![]), server_item("b", false, vec![])];
        reconcile(&conn, &list.id, &flatten(&server)).unwrap();
        assert_eq!(list_for_checklist(&conn, &list.id).unwrap().len(), 2);
        // server now only has "a"
        reconcile(&conn, &list.id, &flatten(&vec![server_item("a", false, vec![])])).unwrap();
        let items = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "a");
    }

    #[test]
    fn reconcile_keeps_dirty_local_edits() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        reconcile(&conn, &list.id, &flatten(&vec![server_item("a", false, vec![])])).unwrap();
        let items = list_for_checklist(&conn, &list.id).unwrap();
        // local edit (dirty) — server still says "a" but local renamed to "a edited"
        update_local(&conn, &items[0].local_id, "a edited").unwrap();
        reconcile(&conn, &list.id, &flatten(&vec![server_item("a", false, vec![])])).unwrap();
        let after = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(after.len(), 1, "dirty local must not be deleted or duplicated");
        assert_eq!(after[0].text, "a edited");
    }

    // THE FIELD BUG (user report 2026-10-03, mobile): "completed a task, it went
    // in the completed section but it also stayed in the to do section".
    // Sequence: rows synced clean -> user checks T2 (row dirty, op replayed+done)
    // -> ANOTHER surface adds T5 (upstream creates insert at INDEX 0 — live-verified
    // 1.27.0) -> the next reconcile sees a +1-shifted layout. Reconcile must rebind
    // rows by identity (text for simple lists) so the checked item stays ONE row,
    // completed, and every row binds ITS OWN server item.
    #[test]
    fn reconcile_rebinds_shifted_layout_after_a_check_no_duplicates() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        reconcile(&conn, &list.id, &flatten(&vec![
            server_item("T0", false, vec![]),
            server_item("T1", false, vec![]),
            server_item("T2", false, vec![]),
        ])).unwrap();
        // user completes T2: local truth flips; the check op replays + completes (op done → NOT pending)
        let rows = list_for_checklist(&conn, &list.id).unwrap();
        let t2 = rows.iter().find(|r| r.text == "T2").unwrap().clone();
        set_checked(&conn, &t2.local_id, true).unwrap();
        // another surface (web/desktop) adds T5 — upstream inserts at index 0
        let added = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "T5".into(), status: None, priority: None, target_date: None }).unwrap();
        let _ = added;
        let shifted = vec![
            server_item("T5", false, vec![]),          // NEW item at index 0 (upstream insert-at-0)
            server_item("T0", false, vec![]),
            server_item("T1", false, vec![]),
            server_item("T2", true, vec![]),           // the check REPLAYED server-side: completed
        ];
        reconcile(&conn, &list.id, &flatten(&shifted)).unwrap();
        let after = list_for_checklist(&conn, &list.id).unwrap();
        let t2s: Vec<_> = after.iter().filter(|r| r.text == "T2").collect();
        assert_eq!(t2s.len(), 1, "the completed task must exist as ONE row (user saw it in both sections): {:?}", after.iter().map(|r| (r.text.as_str(), r.completed, r.server_path.clone())).collect::<Vec<_>>());
        assert!(t2s[0].completed, "the single T2 row keeps the completed flag");
        // every text binds to its OWN server item — no flag/text cross-assignment
        for r in &after {
            let own = shifted.iter().find(|s| s.text == r.text).map(|s| s.completed.unwrap_or(false)).unwrap();
            assert_eq!(r.completed, own, "row '{}' must carry its own item's completed flag", r.text);
            assert_eq!(r.server_path.as_deref(), Some(flat_pos(&shifted, &r.text).as_str()), "row '{}' rebinds to its own index path", r.text);
        }
    }

    /// flat DFS index path of the FIRST server item with `text` (top-level helper for the tests above).
    fn flat_pos(server: &[ServerItem], text: &str) -> String {
        flatten_items(server).into_iter().find(|(_, it)| it.text == text).map(|(p, _)| p).unwrap()
    }

    // Prior reconcile runs on a +1-shifted layout (pre-fix builds) can stamp each
    // row with the PREVIOUS path-tenant's flags/server_item_id while keeping its
    // text, plus an inserted tail row. The fixed reconcile must HEAL such a DB in
    // one pull: ids only trusted with the drift signature, text rebinds the rest,
    // orphaned contaminated rows die, and the completed tail ends bound to its own.
    #[test]
    fn reconcile_heals_contaminated_rows_from_older_builds() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        // simulate the contaminated state the old reconcile produced (texts kept,
        // flags/ids/path-boundaries shifted +1): L0 carries T5's id, L1 carries
        // T0's id, L2 carries T1's id (un-completed!), T2's real row is the tail copy.
        for (text, completed, path, sid) in [
            ("T0", false, "0", "srv-T5"),
            ("T1", false, "1", "srv-T0"),
            ("T2", false, "2", "srv-T1"),
            ("T2", true, "3", "srv-T2"),
        ] {
            conn.execute(
                "INSERT INTO checklist_items (local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date, start_date, server_item_id)
                 VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 0, NULL, NULL, NULL, NULL, ?7)",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), list.id, text, completed as i64, path.parse::<i64>().unwrap(), path, sid],
            ).unwrap();
        }
        // the phone's own never-synced T5 add rides along, adopted at index 0
        insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "T5".into(), status: None, priority: None, target_date: None }).unwrap();
        let server = vec![
            server_item("T5", false, vec![]),
            server_item("T0", false, vec![]),
            server_item("T1", false, vec![]),
            server_item("T2", true, vec![]),
        ];
        reconcile(&conn, &list.id, &flatten(&server)).unwrap();
        let after = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(after.len(), 4, "contaminated copies must die, one row per item: {:?}", after.iter().map(|r| (r.text.as_str(), r.completed, r.server_path.clone())).collect::<Vec<_>>());
        for r in &after {
            let own = server.iter().find(|s| s.text == r.text).map(|s| s.completed.unwrap_or(false)).unwrap();
            assert_eq!(r.completed, own, "row '{}' must carry its own item's completed flag", r.text);
            assert_eq!(r.server_path.as_deref(), Some(flat_pos(&server, &r.text).as_str()));
            assert_eq!(r.server_item_id.as_deref(), Some(format!("srv-{}", r.text).as_str()));
        }
        assert_eq!(after.iter().filter(|r| r.text == "T2").count(), 1);
    }

    /// Server-side children (added on the web) must import NESTED under their
    /// parent row — parent derived from the dot-path prefix, never as stray
    /// top-level rows. (reconcile's INSERT hardcoded parent_id NULL before.)
    #[test]
    fn reconcile_imports_server_children_nested_and_rebinds_them_after_shifts() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        let parent = server_item("P", false, vec![server_item("C", false, vec![])]);
        reconcile(&conn, &list.id, &flatten(&vec![parent.clone()])).unwrap();
        let rows = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(rows.len(), 2);
        let c = rows.iter().find(|r| r.text == "C").unwrap();
        let p = rows.iter().find(|r| r.text == "P").unwrap();
        assert_eq!(c.parent_id.as_deref(), Some(p.local_id.as_str()), "server child nests under its parent row");
        assert_eq!(c.server_path.as_deref(), Some("0.0"));
        // shift: another surface prepends a new parent; P/C move to paths "1"/"1.0"
        let shifted = vec![server_item("N", false, vec![]), server_item("P", false, vec![server_item("C", false, vec![])])];
        reconcile(&conn, &list.id, &flatten(&shifted)).unwrap();
        let after = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(after.len(), 3);
        let c2 = after.iter().find(|r| r.text == "C").unwrap();
        let p2 = after.iter().find(|r| r.text == "P").unwrap();
        assert_eq!(c2.parent_id.as_deref(), Some(p2.local_id.as_str()), "child re-parents to the rebound parent row");
        assert_eq!(c2.server_path.as_deref(), Some("1.0"));
    }

    #[test]
    fn insert_update_check_delete_flow() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        let a = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "a".into(), status: None, priority: None, target_date: None }).unwrap();
        let child = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: Some(a.local_id.clone()), text: "a.1".into(), status: None, priority: None, target_date: None }).unwrap();
        assert_eq!(child.parent_id.as_deref(), Some(a.local_id.as_str()));
        update_local(&conn, &a.local_id, "a2").unwrap();
        set_checked(&conn, &a.local_id, true).unwrap();
        assert!(get(&conn, &a.local_id).unwrap().unwrap().completed);
        // delete parent removes descendants
        delete_local(&conn, &a.local_id).unwrap();
        assert!(get(&conn, &child.local_id).unwrap().is_none());
    }

    #[test]
    fn reorder_repositions_top_level() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        let a = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "a".into(), status: None, priority: None, target_date: None }).unwrap();
        let b = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "b".into(), status: None, priority: None, target_date: None }).unwrap();
        reorder_local(&conn, &list.id, &[b.local_id.clone(), a.local_id.clone()]).unwrap();
        let items = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(items[0].local_id, b.local_id);
        assert_eq!(items[1].local_id, a.local_id);
        assert!(items.iter().all(|i| i.dirty));
    }

    #[test]
    fn reconcile_writes_item_status_and_display_fields() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let server = vec![
            ServerItem { text: "card a".into(), completed: Some(false), status: Some("in_progress".into()), priority: Some("high".into()), target_date: Some("2026-10-01".into()), ..Default::default() },
            ServerItem { text: "card b".into(), completed: Some(true), status: None, ..Default::default() },
        ];
        reconcile(&conn, &list.id, &flatten(&server)).unwrap();
        let rows = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(rows[0].status.as_deref(), Some("in_progress"));
        assert_eq!(rows[0].priority.as_deref(), Some("high"));
        assert_eq!(rows[0].target_date.as_deref(), Some("2026-10-01"));
        assert_eq!(rows[1].status, None); // absent stays NULL
    }

    #[test]
    fn set_status_mirrors_apply_status_completed_rules() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let it = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "card".into(), status: Some("in_progress".into()), priority: None, target_date: None }).unwrap();
        set_checked(&conn, &it.local_id, true).unwrap();
        // moving a completed item to a DIFFERENT non-auto status -> completed=0
        let r = set_status(&conn, &it.local_id, Some("todo".into()), false, true).unwrap();
        assert!(!r.completed);
        assert_eq!(r.status.as_deref(), Some("todo"));
        // moving to an autoComplete column -> completed=1 (changed irrelevant)
        let r = set_status(&conn, &it.local_id, Some("completed".into()), true, true).unwrap();
        assert!(r.completed);
        // same-status no-op -> completed untouched (stays 1), still dirty
        let r = set_status(&conn, &it.local_id, Some("completed".into()), true, false).unwrap();
        assert!(r.completed);
        assert!(r.dirty);
    }

    #[test]
    fn set_completed_recursive_cascades_descendants_only() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let parent = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "p".into(), status: None, priority: None, target_date: None }).unwrap();
        let child = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: Some(parent.local_id.clone()), text: "c".into(), status: None, priority: None, target_date: None }).unwrap();
        let _grand = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: Some(child.local_id.clone()), text: "g".into(), status: None, priority: None, target_date: None }).unwrap();
        set_completed_recursive(&conn, &parent.local_id, true).unwrap();
        let rows = list_for_checklist(&conn, &list.id).unwrap();
        assert!(rows.iter().all(|r| r.completed));
        set_completed_recursive(&conn, &child.local_id, false).unwrap();
        let rows = list_for_checklist(&conn, &list.id).unwrap();
        let g = rows.iter().find(|r| r.text == "g").unwrap();
        let c = rows.iter().find(|r| r.text == "c").unwrap();
        let p = rows.iter().find(|r| r.text == "p").unwrap();
        assert!(!g.completed && !c.completed && p.completed); // parent untouched
    }

    #[test]
    fn reconcile_captures_server_item_id_and_start_date() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        let server = vec![
            ServerItem { id: Some("srv-1".into()), text: "Dentist".into(), start_date: Some("2026-10-01".into()), target_date: Some("2026-10-01".into()), ..Default::default() },
            ServerItem { text: "no-id item".into(), ..Default::default() },
        ];
        reconcile(&conn, &list.id, &flatten(&server)).unwrap();
        let items = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(items.len(), 2);
        let row1 = items.iter().find(|r| r.text == "Dentist").unwrap();
        assert_eq!(row1.server_item_id.as_deref(), Some("srv-1"));
        assert_eq!(row1.start_date.as_deref(), Some("2026-10-01"));
        let row2 = items.iter().find(|r| r.text == "no-id item").unwrap();
        assert_eq!(row2.server_item_id, None, "server row without id stores NULL server_item_id");
        assert_eq!(row2.start_date, None, "server row without start_date stores NULL");
    }

    #[test]
    fn reconcile_update_arm_updates_dates_by_path() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        let first = ServerItem { id: Some("srv-1".into()), text: "A".into(), start_date: Some("2026-01-01".into()), target_date: Some("2026-01-02".into()), ..Default::default() };
        reconcile(&conn, &list.id, &flatten(&vec![first])).unwrap();
        // same path "0": the matched-UPDATE arm must write the new server dates
        let second = ServerItem { id: Some("srv-1".into()), text: "A".into(), start_date: Some("2026-02-01".into()), target_date: Some("2026-02-02".into()), ..Default::default() };
        reconcile(&conn, &list.id, &flatten(&vec![second])).unwrap();
        let items = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(items.len(), 1, "path match must update in place, not duplicate");
        assert_eq!(items[0].server_path.as_deref(), Some("0"));
        assert_eq!(items[0].start_date.as_deref(), Some("2026-02-01"));
        assert_eq!(items[0].target_date.as_deref(), Some("2026-02-02"));
        assert_eq!(items[0].server_item_id.as_deref(), Some("srv-1"));
    }

    #[test]
    fn reconcile_text_adopt_carries_new_columns() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        let it = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "Dentist".into(), status: None, priority: None, target_date: None }).unwrap();
        let server = vec![ServerItem { id: Some("srv-7".into()), text: "Dentist".into(), start_date: Some("2026-10-05".into()), target_date: Some("2026-10-05".into()), ..Default::default() }];
        reconcile(&conn, &list.id, &flatten(&server)).unwrap();
        let after = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(after.len(), 1, "text adopt must not duplicate");
        assert_eq!(after[0].local_id, it.local_id);
        assert_eq!(after[0].server_path.as_deref(), Some("0"));
        assert_eq!(after[0].server_item_id.as_deref(), Some("srv-7"));
        assert_eq!(after[0].start_date.as_deref(), Some("2026-10-05"));
    }

    #[test]
    fn set_reminder_local_writes_datetime_and_dirty() {
        // T3: the LOCAL reminder edit owns the server write -> dirty=1.
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let it = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "card".into(), status: None, priority: None, target_date: None }).unwrap();
        let r = set_reminder_local(&conn, &it.local_id, Some("2026-10-01T09:00:00Z".into())).unwrap();
        assert_eq!(r.reminder_datetime.as_deref(), Some("2026-10-01T09:00:00Z"));
        assert!(r.dirty, "the queued set_reminder op owns the server write");
        // clear: NULL, still dirty
        let r = set_reminder_local(&conn, &it.local_id, None).unwrap();
        assert_eq!(r.reminder_datetime, None);
        assert!(r.dirty);
    }

    #[test]
    fn set_reminder_from_server_writes_without_dirty() {
        // T3: the enrichment mirror writes reminder columns WITHOUT dirty.
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let it = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "card".into(), status: None, priority: None, target_date: None }).unwrap();
        conn.execute("UPDATE checklist_items SET dirty=0 WHERE local_id=?1", [&it.local_id]).unwrap();
        set_reminder_from_server(&conn, &it.local_id, Some("2026-10-01T09:00:00Z".into()), Some(true)).unwrap();
        let r = get(&conn, &it.local_id).unwrap().unwrap();
        assert_eq!(r.reminder_datetime.as_deref(), Some("2026-10-01T09:00:00Z"));
        assert_eq!(r.reminder_notified, Some(true));
        assert!(!r.dirty, "server mirror must never dirty the row");
        // server-without-reminder clears both columns, dirty still untouched
        set_reminder_from_server(&conn, &it.local_id, None, None).unwrap();
        let r = get(&conn, &it.local_id).unwrap().unwrap();
        assert_eq!(r.reminder_datetime, None);
        assert_eq!(r.reminder_notified, None);
        assert!(!r.dirty);
    }

    #[test]
    fn migration_v5_recurrence_column_roundtrips() {
        let conn = db();
        migrations::run(&conn).expect("migrations");
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 5);
        conn.execute(
            "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('l1', 'L', 'Home', 'kanban', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
            [],
        )
        .unwrap();
        let row = items::insert_local(
            &conn,
            &NewItem { checklist_id: "l1".into(), parent_local_id: None, text: "T".into(), status: None, priority: None, target_date: None },
        )
        .unwrap();
        items::set_recurrence_raw(&conn, &row.local_id, Some(r#"{"rrule":"FREQ=WEEKLY;INTERVAL=1","dtstart":"2026-10-01T00:00:00+00:00","nextDue":"2026-10-08T00:00:00+00:00"}"#)).unwrap();
        let got = items::get(&conn, &row.local_id).unwrap().unwrap();
        assert_eq!(
            got.recurrence.as_deref(),
            Some(r#"{"rrule":"FREQ=WEEKLY;INTERVAL=1","dtstart":"2026-10-01T00:00:00+00:00","nextDue":"2026-10-08T00:00:00+00:00"}"#)
        );
        items::set_recurrence_raw(&conn, &row.local_id, None).unwrap();
        assert!(items::get(&conn, &row.local_id).unwrap().unwrap().recurrence.is_none());
    }

    #[test]
    fn set_recurrence_raw_does_not_mark_dirty() {
        let conn = db();
        migrations::run(&conn).expect("migrations");
        conn.execute(
            "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('l1', 'L', 'Home', 'kanban', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
            [],
        )
        .unwrap();
        let row = items::insert_local(
            &conn,
            &NewItem { checklist_id: "l1".into(), parent_local_id: None, text: "T".into(), status: None, priority: None, target_date: None },
        )
        .unwrap();
        conn.execute("UPDATE checklist_items SET dirty=0 WHERE local_id=?1", [&row.local_id]).unwrap();
        items::set_recurrence_raw(&conn, &row.local_id, Some("{\"rrule\":\"FREQ=DAILY;INTERVAL=1\",\"dtstart\":\"2026-10-01T00:00:00+00:00\",\"nextDue\":\"2026-10-02T00:00:00+00:00\"}")).unwrap();
        assert!(!items::get(&conn, &row.local_id).unwrap().unwrap().dirty);
    }

    #[test]
    fn reconcile_claimed_update_preserves_local_recurrence() {
        let conn = db();
        migrations::run(&conn).expect("migrations");
        conn.execute(
            "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('l1', 'L', 'Home', 'kanban', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
            [],
        )
        .unwrap();
        let row = items::insert_local(
            &conn,
            &NewItem { checklist_id: "l1".into(), parent_local_id: None, text: "Groceries".into(), status: None, priority: None, target_date: None },
        )
        .unwrap();
        items::set_recurrence_raw(&conn, &row.local_id, Some("{\"rrule\":\"FREQ=DAILY;INTERVAL=1\"}")).unwrap();
        conn.execute("UPDATE checklist_items SET dirty=0, server_item_id='sid-1' WHERE local_id=?1", [&row.local_id]).unwrap();
        let flat = items::ServerItemFlat {
            path: "0".into(),
            id: Some("sid-1".into()),
            text: "Groceries".into(),
            completed: false,
            status: None,
            priority: None,
            target_date: None,
            start_date: None,
        };
        items::reconcile(&conn, "l1", &[flat]).unwrap();
        let after = items::get(&conn, &row.local_id).unwrap().unwrap();
        assert_eq!(after.recurrence.as_deref(), Some("{\"rrule\":\"FREQ=DAILY;INTERVAL=1\"}"));
        assert!(!after.dirty);
    }
}