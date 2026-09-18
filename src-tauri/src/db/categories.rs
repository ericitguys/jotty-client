use crate::error::AppResult;
use crate::jotty::models::{Categories, CategoryNode};
use rusqlite::Connection;

const UNCATEGORIZED: &str = "Uncategorized";
const ARCHIVED: &str = ".archive";

/// Offline fallback for the sidebar category tree (v0.9.2).
///
/// jotty categories are NOT entities — they are strings on notes/checklists,
/// and upstream /api/categories merely DERIVES a tree from the on-disk
/// category directories (count = direct .md files per directory, parents
/// synthesized for subdirectories, `.archive` filtered, alphabetical
/// depth-first order). The client already holds every visible note/checklist
/// locally, so the same tree can be derived from local SQLite when the live
/// fetch is unavailable (offline start / mid-session outage / no client).
///
/// Parity notes vs upstream (source-verified 2026-09-18, fccview/jotty
/// app/api/categories/route.ts + app/_utils/category-utils.ts):
/// - count counts entries whose category path equals the node path exactly
///   (direct children only; subcategories carry their own nodes) — same as
///   buildCategoryTree's per-directory .md count.
/// - intermediate path segments become nodes with count 0.
/// - paths containing a `.archive` segment are excluded (API layer
///   filterArchived). The pull can't normally hold archived rows (GET
///   /api/notes|checklists exclude them) — this is defense in depth.
/// - empty/blank category strings map to "Uncategorized" (upstream wire
///   fallback `category || "Uncategorized"`); the client's own create flow
///   also defaults to the literal "Uncategorized".
/// - siblings sort alphabetically (case-insensitive), depth-first — the
///   server's custom order-file ordering cannot be mirrored offline, its
///   fallback is alphabetical.
pub fn derive_local(conn: &Connection) -> AppResult<Categories> {
    let notes = derive_side(conn, "notes")?;
    let checklists = derive_side(conn, "checklists")?;
    Ok(Categories { notes, checklists })
}

fn derive_side(conn: &Connection, table: &str) -> AppResult<Vec<CategoryNode>> {
    // direct counts per exact category path (deleted rows excluded — they are
    // invisible in the lists, so their categories must not show either)
    let sql = format!("SELECT category, COUNT(*) FROM {table} WHERE deleted_at IS NULL GROUP BY category");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut direct: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    for (category, count) in rows {
        // empty category maps to "Uncategorized" exactly like the server REST
        // layer (`category || "Uncategorized"`); everything else is verbatim
        // (the server does not trim — a string is a literal directory name)
        let path = if category.is_empty() { UNCATEGORIZED.to_string() } else { category };
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        if segments.is_empty() || segments.iter().any(|s| *s == ARCHIVED) {
            continue;
        }
        *direct.entry(segments.join("/")).or_insert(0) += count;
    }
    // synthesize parent nodes for every proper prefix (intermediates count 0
    // unless entries sit directly in them — the direct pass below overwrites)
    let mut all: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    for path in direct.keys() {
        let segments: Vec<&str> = path.split('/').collect();
        for depth in 1..=segments.len() {
            all.entry(segments[..depth].join("/")).or_insert(0);
        }
    }
    for (path, count) in direct {
        all.insert(path, count);
    }
    let mut nodes: Vec<CategoryNode> = all
        .into_iter()
        .map(|(path, count)| CategoryNode {
            name: path.rsplit('/').next().unwrap_or(&path).to_string(),
            level: path.split('/').count() as i64 - 1,
            path: path.clone(),
            count,
        })
        .collect();
    // depth-first pre-order with alphabetical siblings: a parent path is a
    // strict prefix of its children, so byte-lex on the lowercased path puts
    // parents first and sorts siblings alphabetically in one pass
    nodes.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(nodes)
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

    fn add_note(conn: &Connection, title: &str, category: &str, deleted: bool) {
        conn.execute(
            "INSERT INTO notes (id, title, content, category, deleted_at) VALUES (?1,?2,'',?3,?4)",
            rusqlite::params![
                format!("n-{title}"),
                title,
                category,
                deleted.then(|| "2026-01-01T00:00:00Z".to_string())
            ],
        )
        .unwrap();
    }

    fn add_list(conn: &Connection, title: &str, category: &str, deleted: bool) {
        conn.execute(
            "INSERT INTO checklists (id, title, category, deleted_at) VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                format!("l-{title}"),
                title,
                category,
                deleted.then(|| "2026-01-01T00:00:00Z".to_string())
            ],
        )
        .unwrap();
    }

    fn deleted_at(deleted: bool) -> Option<String> {
        deleted.then(|| "2026-01-01T00:00:00Z".to_string())
    }

    #[test]
    fn derives_nested_paths_with_synthesized_parents() {
        let conn = db();
        add_note(&conn, "A", "Work/Projects", false);
        add_note(&conn, "B", "Home", false);
        let cats = derive_local(&conn).unwrap();
        let paths: Vec<&str> = cats.notes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(paths, vec!["Home", "Work", "Work/Projects"]);
        let work = &cats.notes[1];
        assert_eq!(work.name, "Work");
        assert_eq!(work.level, 0);
        assert_eq!(work.count, 0); // no notes directly in Work
        let projects = &cats.notes[2];
        assert_eq!(projects.name, "Projects");
        assert_eq!(projects.level, 1);
        assert_eq!(projects.count, 1);
    }

    #[test]
    fn count_is_direct_entries_only() {
        let conn = db();
        add_note(&conn, "A", "Work", false);
        add_note(&conn, "B", "Work/Sub", false);
        add_note(&conn, "C", "Work/Sub", false);
        let cats = derive_local(&conn).unwrap();
        let work = cats.notes.iter().find(|n| n.path == "Work").unwrap();
        assert_eq!(work.count, 1);
        let sub = cats.notes.iter().find(|n| n.path == "Work/Sub").unwrap();
        assert_eq!(sub.count, 2);
    }

    #[test]
    fn tombstoned_rows_are_excluded() {
        let conn = db();
        add_note(&conn, "A", "Home", false);
        add_note(&conn, "B", "Gone", true);
        let cats = derive_local(&conn).unwrap();
        assert!(cats.notes.iter().all(|n| n.path != "Gone"));
        assert_eq!(cats.notes.iter().find(|n| n.path == "Home").unwrap().count, 1);
    }

    #[test]
    fn archive_paths_are_excluded() {
        let conn = db();
        add_note(&conn, "A", ".archive/Old", false);
        add_note(&conn, "B", "Work/.archive/Deep", false);
        add_note(&conn, "C", "Home", false);
        let cats = derive_local(&conn).unwrap();
        let paths: Vec<&str> = cats.notes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(paths, vec!["Home"]);
    }

    #[test]
    fn blank_category_becomes_uncategorized() {
        let conn = db();
        add_note(&conn, "A", "", false);
        let cats = derive_local(&conn).unwrap();
        assert_eq!(cats.notes.len(), 1);
        assert_eq!(cats.notes[0].path, "Uncategorized");
        assert_eq!(cats.notes[0].count, 1);
    }

    #[test]
    fn notes_and_checklists_derived_separately() {
        let conn = db();
        add_note(&conn, "A", "Home", false);
        add_list(&conn, "C", "Errands", false);
        let cats = derive_local(&conn).unwrap();
        assert_eq!(cats.notes.iter().map(|n| n.path.as_str()).collect::<Vec<_>>(), vec!["Home"]);
        assert_eq!(cats.checklists.iter().map(|n| n.path.as_str()).collect::<Vec<_>>(), vec!["Errands"]);
    }

    #[test]
    fn dirty_local_rows_are_included() {
        // rows created offline (dirty=1, not yet synced) exist in the UI lists,
        // so their categories must show in the tree too.
        let conn = db();
        conn.execute(
            "INSERT INTO notes (id, title, content, category, dirty) VALUES ('n1','A','','Uncategorized',1)",
            [],
        ).unwrap();
        let cats = derive_local(&conn).unwrap();
        assert_eq!(cats.notes.iter().map(|n| n.path.as_str()).collect::<Vec<_>>(), vec!["Uncategorized"]);
    }

    #[test]
    fn empty_db_yields_empty_not_error() {
        let conn = db();
        let cats = derive_local(&conn).unwrap();
        assert!(cats.notes.is_empty());
        assert!(cats.checklists.is_empty());
    }

    #[test]
    fn checklists_exclude_tombstones() {
        let conn = db();
        add_list(&conn, "C", "Errands", true);
        let cats = derive_local(&conn).unwrap();
        assert!(cats.checklists.is_empty());
    }
}