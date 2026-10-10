# Task 2 report — audit 2.2, item #5: list_type default

## Change
File: `src-tauri/src/db/checklists.rs`
- `upsert_list_from_server` INSERT and UPDATE arms now default a missing `list_type` to `"simple"` (upstream plain-list vocabulary) instead of undocumented `"regular"`.
- Added one-line audit comment at both sites.

## Test
Added `db::checklists::tests::upserts_missing_list_type_as_simple`:
- Constructs a `ServerChecklist` with `list_type: None`.
- Asserts stored `list_type == "simple"` after INSERT.
- Asserts stored `list_type == "simple"` after UPDATE (newer server timestamp).

## RED → GREEN
RED: new test failed with `left: "regular", right: "simple"` before the fix.
GREEN: `cargo test --lib checklists` passes (8 passed; 0 failed).

## Diff
```diff
diff --git a/src-tauri/src/db/checklists.rs b/src-tauri/src/db/checklists.rs
index b3d589e..3dcd8bb 100644
--- a/src-tauri/src/db/checklists.rs
+++ b/src-tauri/src/db/checklists.rs
@@ -69,12 +69,14 @@ pub fn upsert_list_from_server(conn: &Connection, c: &ServerChecklist) -> AppRes
         }
         conn.execute(
             "UPDATE checklists SET title=?2, category=?3, list_type=?4, created_at=?5, updated_at=?6, dirty=0 WHERE id=?1",
-            rusqlite::params![c.id, c.title, c.category, c.list_type.clone().unwrap_or_else(|| "regular".into()), c.created_at, c.updated_at],
+            // audit 2.2: default to upstream's plain-list type, not undocumented "regular"
+            rusqlite::params![c.id, c.title, c.category, c.list_type.clone().unwrap_or_else(|| "simple".into()), c.created_at, c.updated_at],
         )?;
     } else {
         conn.execute(
             "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES (?1,?2,?3,?4,?5,?6,0)",
-            rusqlite::params![c.id, c.title, c.category, c.list_type.clone().unwrap_or_else(|| "regular".into()), c.created_at, c.updated_at],
+            // audit 2.2: default to upstream's plain-list type, not undocumented "regular"
+            rusqlite::params![c.id, c.title, c.category, c.list_type.clone().unwrap_or_else(|| "simple".into()), c.created_at, c.updated_at],
         )?;
     }
     items::reconcile(conn, &c.id, &items::flatten(&c.items))?;
@@ -176,6 +178,37 @@ mod tests {
         );
     }
 
+    #[test]
+    fn upserts_missing_list_type_as_simple() {
+        let conn = db();
+        let c = ServerChecklist {
+            id: "srv-simple".into(),
+            title: "Plain List".into(),
+            category: "Work".into(),
+            list_type: None,
+            items: vec![ServerItem::simple("alpha")],
+            statuses: None,
+            created_at: "2026-01-01T00:00:00.000Z".into(),
+            updated_at: "2026-01-01T00:00:00.000Z".into(),
+        };
+        assert!(upsert_list_from_server(&conn, &c).unwrap());
+        assert_eq!(get_checklist(&conn, "srv-simple").unwrap().unwrap().list_type, "simple");
+
+        // UPDATE arm: later server update still without list_type defaults to simple
+        let c2 = ServerChecklist {
+            id: "srv-simple".into(),
+            title: "Plain List Updated".into(),
+            category: "Work".into(),
+            list_type: None,
+            items: vec![ServerItem::simple("alpha"), ServerItem::simple("beta")],
+            statuses: None,
+            created_at: "2026-01-01T00:00:00.000Z".into(),
+            updated_at: "2026-02-01T00:00:00.000Z".into(),
+        };
+        assert!(upsert_list_from_server(&conn, &c2).unwrap());
+        assert_eq!(get_checklist(&conn, "srv-simple").unwrap().unwrap().list_type, "simple");
+    }
+
     #[test]
     fn upsert_imports_items_and_respects_dirty() {
         let conn = db();
```

## Other "regular" literals
Grep found these remaining `"regular"` references to a `list_type` value:
- `src-tauri/src/db/checklists.rs:150` — test helper `server_checklist()` explicitly sets `list_type: Some("regular".into())`. This is intentional test payload data, not a default fallback; left unchanged to avoid altering unrelated existing tests.
- `src-tauri/src/commands/mod.rs:4235`, `src-tauri/src/commands/mod.rs:4940`, `src-tauri/src/sync/push.rs:1976` — test fixtures seeding pre-existing checklist rows with `list_type='regular'`. These are outside the scope file and represent legacy stored rows; not upstream defaults.
- `src-tauri/src/commands/mod.rs:731` — a code comment referencing the old pinned `"regular"` value.

No additional `unwrap_or_else` / default fallback to `"regular"` was found.

## Test output tail
```
running 8 tests
test db::categories::tests::checklists_exclude_tombstones ... ok
test db::categories::tests::notes_and_checklists_derived_separately ... ok
test commands::tests::list_checklists_inner_counts_default_zero_for_empty_list ... ok
test db::checklists::tests::upserts_missing_list_type_as_simple ... ok
test commands::tests::list_checklists_inner_reports_item_and_done_counts ... ok
test db::checklists::tests::checklist_tombstone_purges_fts_row ... ok
test db::checklists::tests::upsert_imports_items_and_respects_dirty ... ok
test commands::tests::list_checklists_inner_reports_completion ... ok

test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 381 filtered out
```
