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

const COLS: &str = "local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date";

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
    // pending ops shield items from adoption/deletion until their op resolves (Task 7 push-then-pull)
    let pending: Vec<String> = local
        .iter()
        .filter(|l| matches!(outbox::has_pending_for(conn, "checklist_item", &l.local_id), Ok(true)))
        .map(|l| l.local_id.clone())
        .collect();
    for (order, s) in server_items.iter().enumerate() {
        // 1) match by server_path
        let mut target = local.iter().find(|l| l.server_path.as_deref() == Some(s.path.as_str()) && !claimed.contains(&l.local_id));
        // 2) fallback: unclaimed, no pending op, same text (never-synced dirty locals are adoptable)
        if target.is_none() {
            target = local.iter().find(|l| {
                l.server_path.is_none() && !claimed.contains(&l.local_id) && !pending.contains(&l.local_id) && l.text == s.text
            });
        }
        match target {
            Some(l) => {
                claimed.push(l.local_id.clone());
                conn.execute(
                    "UPDATE checklist_items SET position=?2, completed=?3, server_path=?4, status=?5, priority=?6, target_date=?7, dirty=0 WHERE local_id=?1",
                    rusqlite::params![l.local_id, order as i64, s.completed as i64, s.path, s.status.clone(), s.priority.clone(), s.target_date.clone()],
                )?;
            }
            None => {
                conn.execute(
                    "INSERT INTO checklist_items (local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date)
                     VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)",
                    rusqlite::params![uuid::Uuid::new_v4().to_string(), checklist_id, s.text, s.completed as i64, order as i64, s.path, s.status.clone(), s.priority.clone(), s.target_date.clone()],
                )?;
            }
        }
    }
    // 3) unclaimed, not dirty, no pending op -> server removed it
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
    use crate::db::{checklists, migrations, open};
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
}