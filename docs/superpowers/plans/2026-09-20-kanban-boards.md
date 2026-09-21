# Kanban Boards (v0.11.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render jotty kanban boards (checklists of type `kanban`/legacy `task`) as real board views in the desktop and Android client — columns from the board's statuses, cards grouped by item status, move/add/rename/delete synced through the outbox, offline-safe with a cached column set — and let the user create new boards in-client.

**Architecture:** SQLite migration v3 adds `checklist_items.status/priority/target_date` + a `board_statuses` cache table (columns are a site-truth cache refreshed by a live `GET /api/tasks/{uuid}` on board open; items stay pull-owned). A new outbox op `("checklist_item", "status")` replays `PUT /api/tasks/{uuid}/items/{path}/status` through the EXISTING text-verified claim/resolve machinery (check-op class). The local move mirrors the server's `applyStatus` semantics optimistically (autoComplete column → completed=1 + descendants; status change away from a completed status → completed=0). Frontend: one responsive `KanbanBoard` component rendered by ChecklistView in place of the flat list for kanban types; menu-driven moves (touch-safe) + HTML5 DnD (desktop).

**Tech Stack:** Tauri 2 + Rust (rusqlite, reqwest, wiremock 0.6 for HTTP tests) / React + TypeScript + zustand + vitest/RTL. No new crates.

**Spec:** `docs/superpowers/specs/2026-09-20-kanban-boards-design.md` (approved 2026-09-20) — the plan argues from the spec; executors read both. Upstream API facts were source-verified 2026-09-20 at `/tmp/jotty-upstream` @ b5458a2 (= origin/main) and are pinned in spec §3.

## Plan rulings (disclosed deviations from the spec)

1. **Spec §5 gains two columns.** The display-only badges (priority, target date) must render OFFLINE, so migration v3 also adds `checklist_items.priority TEXT` + `checklist_items.target_date TEXT` (data already parsed in `ServerItem`; carried by the same reconcile/DTO path as status; NO op ever writes them — display-only). `ItemDto`/`types.ts` gain `priority`/`targetDate` alongside `status`.
2. **`board_statuses` cache rewrites are multi-statement autocommit** (same precedent as `checklists::upsert_list_from_server`), not one transaction — a crash mid-rewrite leaves a partial cache that the next open repairs; bounded and accepted.
3. **`create_task_board` is live + inline-pull:** holds the db mutex across the awaited POST and `pull_all` (T14 precedent: commands may hold the guard across awaits) so the created board is locally present when the command returns. It does NOT use the outbox (unlike `create_checklist`) because board creation must carry explicit statuses (`POST /api/tasks`), which the plain checklist-create endpoint does not accept.
4. **Conflict presentation:** `ConflictDialog` renders `opType` raw (no label map exists for any op) — a conflicted status move shows as `status`. Accepted, consistent with every existing op.
5. **Reorder is forbidden for kanban lists** (ruled, load-bearing): `rebuild_replay` re-creates items text-only and would STRIP server-side statuses. The board offers no reorder UI and ChecklistView's DnD is unreachable for kanban types, so the client can never enqueue `reorder` for a board. Reviewers: any code path that enqueues reorder on a kanban list is a defect.
6. **Unknown/absent item status → FIRST column** (sorted by `order`), mirroring upstream `getColumnItems` — not an "Other" column.

## Global Constraints

(from the spec + repo standing rules, verbatim)

- TDD: failing test first, then minimal GREEN; disclose any fence reshapes.
- Full gates after EVERY task: `npm test` (= `NODE_OPTIONS=--no-webstorage vitest run`; node ≥25 on this box makes bare `npx vitest run` break on localStorage), `npx tsc -p tsconfig.json --noEmit`, `cargo test` (re-census by RUNNING immediately before citing; last known 165 passed + 4 ignored at 0.10.8, vitest 101/100 files as of 2026-09-20 post-dropdown). Zero NEW compiler warnings (delta vs a stash-verified baseline; ~15 pre-existing unused-import warnings are baseline noise).
- NEVER run `cargo fmt` in this repo (explodes the unformatted tree).
- Commits on main, repo-local identity zeus <zeus@local>, conventional messages. AGENTS.md is write-guarded — this plan makes NO AGENTS.md edits.
- Wiremock standing rules: every exercised op needs its OWN matching mock (unmatched → default 404 → silently misclassified as conflict); per-endpoint hit counters (`Arc<AtomicUsize>`) when aggregate stats could mask mis-targets; assert-order caveats pinned by surviving asserts. Envelope unwrap tests are MANDATORY for every new endpoint getter (ceaf6eb class).
- `OutboxOp.payload` is a String — parse with `serde_json::from_str` before indexing fields (push.rs:33 precedent).
- Sync invariants 1–7 (jotty-client skill) hold: push-before-pull, one tx per mutation+enqueue, never `unwrap_or_default()` a catalog fetch, item-op text-verified resolution (check/delete/create-parent arms; UPDATE-arm-only stored-path identity), 400/403/404/409/410 → conflict.
- NEVER fabricate a live run: env-gated tests return early when `JOTTY_TEST_URL`/`JOTTY_TEST_API_KEY` are unset.
- Android: gen/android fixups (minSdk 26, MainActivity insets, mic permissions, keystore.properties + signingConfig) are already in place at `src-tauri/gen/android` (verified 2026-09-20). NEVER run `cargo fmt`. Ship procedure = jotty-client skill §Ship.
- Visual checks: serve `dist/` over http (never file://), addInitScript the `__TAURI_INTERNALS__` shim (invoke + transformCallback) BEFORE goto; playwright package resolves only with cwd=/tmp.

---

### Task 1: Schema v3 — item status/priority/target_date + board_statuses cache (Rust)

**Files:**
- Modify: `src-tauri/src/db/migrations.rs` (append v3 entry)
- Modify: `src-tauri/src/db/items.rs` (ItemRow + COLS + row(); NewItem gains status/priority/target_date; insert_local; set_status; set_completed_recursive; reconcile carries the new fields; ServerItemFlat gains status/priority/target_date; flatten maps them)
- Create: `src-tauri/src/db/board.rs` (BoardStatusRow + replace_cache + list)
- Modify: `src-tauri/src/db/mod.rs` (`pub mod board;` + tests table list + migration test)
- Test: `src-tauri/src/db/mod.rs::tests`, `src-tauri/src/db/items.rs::tests`, `src-tauri/src/db/board.rs::tests`

**Interfaces:**
- Produces: table `board_statuses(checklist_id TEXT NOT NULL REFERENCES checklists(id) ON DELETE CASCADE, status_id TEXT NOT NULL, label TEXT NOT NULL, color TEXT, sort_order INTEGER NOT NULL, auto_complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(checklist_id, status_id))` + index `idx_board_statuses(checklist_id, sort_order)`; `checklist_items` columns `status TEXT`, `priority TEXT`, `target_date TEXT` (all NULL-able); `items::ItemRow { status: Option<String>, priority: Option<String>, target_date: Option<String> }` (new fields at struct end); `items::NewItem { status: Option<String>, priority: Option<String>, target_date: Option<String> }`; `items::ServerItemFlat { status: Option<String>, priority: Option<String>, target_date: Option<String> }`; `items::set_status(conn, local_id, status: Option<String>, target_auto: bool, changed: bool) -> AppResult<ItemRow>`; `items::set_completed_recursive(conn, local_id, completed: bool) -> AppResult<()>`; `board::BoardStatusRow { status_id, label, color: Option<String>, sort_order: i64, auto_complete: bool }`; `board::replace_cache(conn, checklist_id, &[ServerStatus]) -> AppResult<()>`; `board::list(conn, checklist_id) -> AppResult<Vec<BoardStatusRow>>` (empty vec when uncached). Later tasks consume ALL of these — exact names above.
- Consumes: `jotty::models::ServerStatus` does NOT exist yet (Task 2). Task 1's `board::replace_cache` therefore takes a SEAM: `&[(&str /*id*/, &str /*label*/, Option<&str> /*color*/, i64 /*order*/, bool /*auto_complete*/)]` — Task 3 bridges `ServerStatus` → that tuple shape at the call site (single map). Document this in Task 3's Interfaces.

- [ ] **Step 1: Write failing migration tests** — in `src-tauri/src/db/mod.rs` tests: add `"board_statuses"` to the `migrations_create_all_tables` expected list, and add:

```rust
    #[test]
    fn migration_v3_adds_item_kanban_columns_and_board_statuses() {
        let (_d, conn) = tmp_db();
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(checklist_items)").unwrap()
            .query_map([], |r| r.get::<_, String>(1)).unwrap()
            .map(Result::unwrap).collect();
        for c in ["status", "priority", "target_date"] {
            assert!(cols.iter().any(|x| x == c), "missing checklist_items.{c}");
        }
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 3);
        let bcols: Vec<String> = conn
            .prepare("PRAGMA table_info(board_statuses)").unwrap()
            .query_map([], |r| r.get::<_, String>(1)).unwrap()
            .map(Result::unwrap).collect();
        for c in ["checklist_id", "status_id", "label", "color", "sort_order", "auto_complete"] {
            assert!(bcols.iter().any(|x| x == c), "missing board_statuses.{c}");
        }
    }
```

- [ ] **Step 2: Run to verify RED** — `cargo test --manifest-path src-tauri/Cargo.toml migration_v3` → compile-ok, test FAILS (version 2 / missing columns).

- [ ] **Step 3: Implement migration v3** — append to `MIGRATIONS` in `src-tauri/src/db/migrations.rs` (v2 voice entry stays verbatim above it):

```rust
    // v3 — kanban boards (2026-09-20): per-item status + display-only fields,
    // plus the board_statuses COLUMN CACHE (site-truth, refreshed by
    // fetch_task_board; never dirty-tracked, never touched by sync pull).
    r#"
    ALTER TABLE checklist_items ADD COLUMN status TEXT;
    ALTER TABLE checklist_items ADD COLUMN priority TEXT;
    ALTER TABLE checklist_items ADD COLUMN target_date TEXT;
    CREATE TABLE board_statuses (
        checklist_id TEXT NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
        status_id TEXT NOT NULL,
        label TEXT NOT NULL,
        color TEXT,
        sort_order INTEGER NOT NULL,
        auto_complete INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (checklist_id, status_id)
    );
    CREATE INDEX idx_board_statuses ON board_statuses(checklist_id, sort_order);
    "#,
```

- [ ] **Step 4: GREEN the migration test** — `cargo test --manifest-path src-tauri/Cargo.toml migration_v3` → PASS.

- [ ] **Step 5: Write failing item/board unit tests** — in `src-tauri/src/db/items.rs` tests (reuse the file's `db()` helper pattern and `server_item` test constructor — extend it with `status: Option<String>` etc. via struct-update or a second constructor `server_item_status(text, completed, status)`), and a new tests mod in `src-tauri/src/db/board.rs`:

```rust
    // items.rs tests
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
```

```rust
    // board.rs tests
    #[test]
    fn replace_cache_rewrites_and_list_roundtrips() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        assert!(board::list(&conn, &list.id).unwrap().is_empty()); // uncached -> empty (caller applies defaults)
        let cols = vec![
            ("todo", "To Do", None, 0, false),
            ("in_progress", "In Progress", Some("#3b82f6"), 1, false),
            ("completed", "Completed", None, 2, true),
        ];
        board::replace_cache(&conn, &list.id, &cols).unwrap();
        let rows = board::list(&conn, &list.id).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].status_id, "todo");
        assert_eq!(rows[0].sort_order, 0);
        assert!(!rows[0].auto_complete);
        assert_eq!(rows[2].status_id, "completed");
        assert!(rows[2].auto_complete);
        assert_eq!(rows[1].color.as_deref(), Some("#3b82f6"));
        // rewrite replaces wholesale
        board::replace_cache(&conn, &list.id, &[("a", "A", None, 0, false)]).unwrap();
        assert_eq!(board::list(&conn, &list.id).unwrap().len(), 1);
    }

    #[test]
    fn board_statuses_are_scoped_per_list() {
        let conn = db();
        let l1 = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B1".into(), category: "Home".into() }).unwrap();
        let l2 = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B2".into(), category: "Home".into() }).unwrap();
        board::replace_cache(&conn, &l1.id, &[("todo", "To Do", None, 0, false)]).unwrap();
        assert!(board::list(&conn, &l2.id).unwrap().is_empty());
    }
```

NOTE: `tmp_db()`/`db()` helpers live in the existing per-file test mods — follow each file's current helper (items.rs has its own; board.rs creates one following the items.rs pattern: tempdir + `open` + `migrations::run`).

- [ ] **Step 6: Run to verify RED** — `cargo test --manifest-path src-tauri/Cargo.toml board:: reconcile_writes set_status_mirrors set_completed_recursive` → FAIL (missing module/functions/fields).

- [ ] **Step 7: Implement** —

`src-tauri/src/db/board.rs`:

```rust
use rusqlite::Connection;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct BoardStatusRow {
    pub status_id: String,
    pub label: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub auto_complete: bool,
}

/// Seam for Task 1 (ServerStatus arrives in Task 2): (id, label, color, order, autoComplete).
pub type StatusTuple<'a> = (&'a str, &'a str, Option<&'a str>, i64, bool);

/// Site-truth COLUMN CACHE (spec §5, ruling 2): multi-statement autocommit like
/// upsert_list_from_server; a crash mid-rewrite leaves a partial cache the next
/// open repairs. Never touched by sync pull.
pub fn replace_cache(conn: &Connection, checklist_id: &str, statuses: &[StatusTuple]) -> AppResult<()> {
    conn.execute("DELETE FROM board_statuses WHERE checklist_id=?1", [checklist_id])?;
    for (id, label, color, order, auto) in statuses {
        conn.execute(
            "INSERT INTO board_statuses (checklist_id, status_id, label, color, sort_order, auto_complete)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![checklist_id, id, label, color, order, *auto as i64],
        )?;
    }
    Ok(())
}

pub fn list(conn: &Connection, checklist_id: &str) -> AppResult<Vec<BoardStatusRow>> {
    let mut stmt = conn.prepare(
        "SELECT status_id, label, color, sort_order, auto_complete FROM board_statuses
         WHERE checklist_id=?1 ORDER BY sort_order",
    )?;
    let rows = stmt
        .query_map([checklist_id], |r| {
            Ok(BoardStatusRow {
                status_id: r.get(0)?,
                label: r.get(1)?,
                color: r.get(2)?,
                sort_order: r.get(3)?,
                auto_complete: r.get::<_, i64>(4)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// keep AppError imported for future arms; unused today would be a NEW warning —
// so do NOT import it until needed (Task 3 adds none here).
```

(CAUTION — no-new-warnings gate: import only what compiles used. Drop the `AppError` import if unused.)

`src-tauri/src/db/items.rs` changes:
- `ItemRow` gains `pub status: Option<String>, pub priority: Option<String>, pub target_date: Option<String>` (at struct end); `NewItem` gains the same three; `ServerItemFlat` gains `pub status: Option<String>, pub priority: Option<String>, pub target_date: Option<String>`.
- `COLS` becomes `"local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date"`; `row()` maps indexes 8/9/10.
- `flatten` maps `status: it.status.clone(), priority: it.priority.clone(), target_date: it.target_date.clone()` (ServerItem already parses them — verified 2026-09-20).
- `insert_local` INSERT gains the three columns (values from `NewItem`).
- `reconcile` UPDATE becomes `... SET position=?2, completed=?3, server_path=?4, status=?5, priority=?6, target_date=?7, dirty=0 WHERE local_id=?1` and INSERT gains the columns from `s`.
- New helpers:

```rust
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
```

(CAUTION: `set_status`'s CASE binds booleans as i64 params; `?3`/`?4` are the flags. Verify the param ORDER matches the SQL placeholders exactly: ?1 local_id, ?2 status, ?3 target_auto, ?4 changed.)

`src-tauri/src/db/mod.rs`: `pub mod board;`.

- [ ] **Step 8: Run the full Rust suite** — `cargo test --manifest-path src-tauri/Cargo.toml` → all green, ZERO new warnings vs the stash-verified baseline (git-stash the tree, `cargo check`, compare, pop — standing technique). Existing tests that construct `NewItem`/`ItemRow` literals need the new fields (test-side fixes, disclosed — fields set to `None`).

- [ ] **Step 9: Commit** — `git add -A src-tauri/src && git commit -m "feat(db): schema v3 — item status/priority/target_date + board_statuses column cache"`.

---

### Task 2: jotty client — ServerStatus + get_task / create_task / update_item_status (Rust + wiremock)

**Files:**
- Modify: `src-tauri/src/jotty/models.rs` (ServerStatus struct; ServerChecklist.statuses retyped; default-status fns)
- Modify: `src-tauri/src/jotty/client.rs` (get_task, create_task, update_item_status; create_item gains `status: Option<&str>`)
- Modify: `src-tauri/src/sync/push.rs` (rebuild_replay's create_item call site passes `None`)
- Test: `src-tauri/src/jotty/client.rs::tests`

**Interfaces:**
- Produces: `models::ServerStatus { id: String, label: String, color: Option<String>, order: i64, auto_complete: bool }` (serde camelCase; `label` field carries `#[serde(alias = "name")]` for the API's default-status fallback shape — spec §3 shape trap); `ServerChecklist.statuses: Option<Vec<ServerStatus>>` (retyped from `Option<Vec<serde_json::Value>>`); `models::render_default_statuses() -> Vec<ServerStatus>` (4-col site default: todo/To Do/0/false, in_progress/In Progress/1/false, completed/Completed/2/TRUE, paused/Paused/3/false); `models::creation_board_statuses() -> Vec<ServerStatus>` (3-col: todo, in_progress, completed+autoComplete true); `client.get_task(&id) -> AppResult<ServerChecklist>`; `client.create_task(&title, &category, &[ServerStatus]) -> AppResult<ServerChecklist>`; `client.update_item_status(&list_id, &path, &status) -> AppResult<()>`; `client.create_item(&list_id, &text, parent_path: Option<&str>, status: Option<&str>)`.
- Consumes: nothing new from Task 1.

- [ ] **Step 1: Write failing wiremock tests** (in `client.rs::tests`, following the existing `server()` helper + `JottyClient::new(&s.uri(), "ck")` pattern):

```rust
    #[tokio::test]
    async fn get_task_unwraps_envelope_and_aliases_name() {
        // REAL wire shape (upstream GET /api/tasks/{taskId} → { "task": {...} }).
        // The default-statuses fallback uses `name`, persisted ones use `label` —
        // parser must accept BOTH (spec §3 shape trap).
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/tasks/b-uuid"))
            .and(header("x-api-key", "ck"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "task": {
                    "id": "b-uuid", "title": "Board", "category": "Home",
                    "statuses": [
                        { "id": "todo", "name": "To Do", "order": 0 },
                        { "id": "done", "label": "Done", "color": "#22c55f", "order": 1, "autoComplete": true }
                    ],
                    "items": [
                        { "id": "srv-1", "index": 0, "text": "card a", "completed": false, "status": "done" }
                    ],
                    "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-02T00:00:00.000Z"
                }
            })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let t = c.get_task("b-uuid").await.unwrap();
        assert_eq!(t.id, "b-uuid");
        let sts = t.statuses.unwrap();
        assert_eq!(sts[0].label, "To Do");          // came from `name`
        assert!(!sts[0].auto_complete);
        assert_eq!(sts[1].label, "Done");           // native label
        assert!(sts[1].auto_complete);
        assert_eq!(sts[1].color.as_deref(), Some("#22c55f"));
        assert_eq!(t.items[0].status.as_deref(), Some("done"));
    }

    #[tokio::test]
    async fn get_task_404_maps_to_api_error() {
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/tasks/nope"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({"error":"Task not found"})))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let err = c.get_task("nope").await.unwrap_err();
        assert!(matches!(err, AppError::Api { status: 404, .. }));
    }

    #[tokio::test]
    async fn create_task_posts_statuses_and_unwraps_data() {
        let s = server().await;
        Mock::given(method("POST")).and(path("/api/tasks"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": { "id": "new-uuid", "title": "Board", "category": "Work",
                          "statuses": [ { "id": "todo", "label": "To Do", "order": 0 } ],
                          "items": [], "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
            })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let t = c.create_task("Board", "Work", &crate::jotty::models::creation_board_statuses()).await.unwrap();
        assert_eq!(t.id, "new-uuid");
        // request body assertions: statuses serialized camelCase with autoComplete
        let reqs = s.received_requests().await.unwrap();
        let body = reqs[0].body.clone();
        let text = String::from_utf8_lossy(&body).to_string();
        assert!(text.contains("\"autoComplete\":true"), "body: {text}");
        assert!(text.contains("\"label\":\"To Do\""));
    }

    #[tokio::test]
    async fn update_item_status_puts_tasks_status_endpoint() {
        let s = server().await;
        Mock::given(method("PUT")).and(path("/api/tasks/b-uuid/items/0/status"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true})))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        c.update_item_status("b-uuid", "0", "in_progress").await.unwrap();
        let reqs = s.received_requests().await.unwrap();
        assert!(String::from_utf8_lossy(&reqs[0].body).contains("\"status\":\"in_progress\""));
    }
```

NOTE: `s.received_requests()` needs `use wiremock::MatchToken`? — no; it's a MockServer method (wiremock 0.6). Existing tests in this file may already assert bodies; follow their pattern if they do.

- [ ] **Step 2: Run to verify RED** — compile errors (get_task/create_task/update_item_status undefined) count as RED.

- [ ] **Step 3: Implement models + client** —

`models.rs`:

```rust
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub id: String,
    #[serde(alias = "name")]
    pub label: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub order: i64,
    #[serde(default)]
    pub auto_complete: bool,
}

/// Site UI default when a board's `statuses` is null (spec §3, _consts/kanban.ts).
pub fn render_default_statuses() -> Vec<ServerStatus> {
    vec![
        ServerStatus { id: "todo".into(), label: "To Do".into(), color: None, order: 0, auto_complete: false },
        ServerStatus { id: "in_progress".into(), label: "In Progress".into(), color: None, order: 1, auto_complete: false },
        ServerStatus { id: "completed".into(), label: "Completed".into(), color: None, order: 2, auto_complete: true },
        ServerStatus { id: "paused".into(), label: "Paused".into(), color: None, order: 3, auto_complete: false },
    ]
}

/// Columns for NEW boards created in-client (spec §6).
pub fn creation_board_statuses() -> Vec<ServerStatus> {
    render_default_statuses().into_iter().filter(|s| s.id != "paused").collect()
}
```

Retype `ServerChecklist.statuses` to `Option<Vec<ServerStatus>>` (catalog omits statuses → `#[serde(default)]` keeps it `None` — verify the `#[serde(default)]` attribute survives the retype).

`client.rs` (inside `impl JottyClient`):

```rust
    pub async fn get_task(&self, id: &str) -> AppResult<ServerChecklist> {
        let v = self.api_get::<serde_json::Value>(&format!("/api/tasks/{id}")).await?;
        let task = v.get("task").ok_or_else(|| AppError::Other("get_task: missing task envelope".into()))?;
        serde_json::from_value(task.clone())
            .map_err(|e| AppError::Other(format!("parse /api/tasks/{{id}}: {e}")))
    }

    pub async fn create_task(&self, title: &str, category: &str, statuses: &[ServerStatus]) -> AppResult<ServerChecklist> {
        let created: Created<ServerChecklist> = self.api_send(
            reqwest::Method::POST, "/api/tasks",
            serde_json::json!({ "title": title, "category": category, "statuses": statuses }),
        ).await?;
        created.data.ok_or_else(|| AppError::Other("create_task: missing data".into()))
    }

    pub async fn update_item_status(&self, list_id: &str, path: &str, status: &str) -> AppResult<()> {
        self.api_send::<serde_json::Value>(
            reqwest::Method::PUT, &format!("/api/tasks/{list_id}/items/{path}/status"),
            serde_json::json!({ "status": status }),
        ).await?;
        Ok(())
    }
```

`create_item` gains the status param (body `status` only when Some):

```rust
    pub async fn create_item(&self, list_id: &str, text: &str, parent_path: Option<&str>, status: Option<&str>) -> AppResult<()> {
        let mut body = serde_json::json!({ "text": text });
        if let Some(p) = parent_path { body["parentIndex"] = serde_json::Value::String(p.to_string()); }
        if let Some(st) = status { body["status"] = serde_json::Value::String(st.to_string()); }
        self.api_send::<serde_json::Value>(reqwest::Method::POST, &format!("/api/checklists/{list_id}/items"), body).await?;
        Ok(())
    }
```

Update the ONE existing call site: `push.rs` rebuild_replay line ~402 → `client.create_item(list_id, text, parent_path.as_deref(), None)` (ruling 5: rebuild is for non-kanban reorder only).

- [ ] **Step 4: Full Rust gates** — `cargo test --manifest-path src-tauri/Cargo.toml` green, no new warnings (existing ServerChecklist constructions in tests may need `..Default::default()` adjustments — disclosed test-side fixes).

- [ ] **Step 5: Commit** — `git commit -m "feat(api): tasks endpoints client — get_task/create_task/update_item_status (+item status on create)"`.

---

### Task 3: Commands — board fetch/cache/columns/create + set_item_status + DTOs (Rust)

**Files:**
- Modify: `src-tauri/src/commands/dto.rs` (ItemDto gains status/priority/targetDate; BoardStatusDto + BoardDto)
- Modify: `src-tauri/src/commands/mod.rs` (set_item_status_inner, add_item_inner status param, fetch_task_board, get_board_columns, create_task_board + #[tauri::command] wrappers)
- Modify: `src-tauri/src/lib.rs` (register the 4 new commands)
- Test: `src-tauri/src/commands/mod.rs::tests` (wiremock + state tests, following the file's existing harness)

**Interfaces:**
- Consumes: Task 1 (`items::set_status`, `set_completed_recursive`, `board::{replace_cache, list, StatusTuple}`, ItemRow/ItemDto new fields) and Task 2 (`client.get_task/create_task/update_item_status`, `models::{ServerStatus, render_default_statuses, creation_board_statuses}`).
- Produces: `dto::BoardStatusDto { id, label, color: Option<String>, order: i64, autoComplete: bool }` (serde camelCase), `dto::BoardDto { checklist_id: String, statuses: Vec<BoardStatusDto> }` (→ `{checklistId, statuses:[...]}`); `ItemDto { ..., status: Option<String>, priority: Option<String>, target_date: Option<String> }` (→ `status/priority/targetDate`); `commands::fetch_task_board(state, checklist_id) -> BoardDto`, `commands::get_board_columns(state, checklist_id) -> BoardDto`, `commands::create_task_board(state, title, category) -> ChecklistDto`, `commands::set_item_status(state, checklist_id, item_local_id, status) -> ()`; `commands::add_item(state, checklist_id, text, parent_local_id, status: Option<String>) -> ItemDto` (status now Option — frontend passes null for plain lists); `commands::set_item_status_inner(conn: &mut Connection, checklist_id, item_local_id, new_status: &str) -> AppResult<()>` (Task 4's push arm does NOT consume the inner — the outbox op replays the server call — but the inner defines the op payload shape: `{checklist_id, item_local_id, status}`).
- BoardDto assembly helper: `commands::board_dto_from_cache(conn: &Connection, checklist_id: &str) -> BoardDto` — cache rows, or `models::render_default_statuses()` mapped to DTOs when the cache is EMPTY (spec §6 offline fallback; 4-col site parity).

- [ ] **Step 1: Write failing tests** (in `commands/mod.rs::tests`; the file already has wiremock-backed tests for other commands — reuse its harness patterns exactly):

State test (no HTTP):

```rust
    #[tokio::test]
    async fn set_item_status_inner_mirrors_apply_status_and_enqueues() {
        let mut conn = db(); // the file's existing helper
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        board::replace_cache(&conn, &list.id, &[
            ("todo", "To Do", None, 0, false),
            ("completed", "Completed", None, 2, true),
        ]).unwrap();
        let parent = items::insert_local(&conn, &items::NewItem {
            checklist_id: list.id.clone(), parent_local_id: None, text: "p".into(),
            status: None, priority: None, target_date: None,
        }).unwrap();
        let child = items::insert_local(&conn, &items::NewItem {
            checklist_id: list.id.clone(), parent_local_id: Some(parent.local_id.clone()), text: "c".into(),
            status: None, priority: None, target_date: None,
        }).unwrap();

        // move INTO the autoComplete column -> completed cascade + op enqueued
        set_item_status_inner(&mut conn, &list.id, &parent.local_id, "completed").unwrap();
        let p = items::get(&conn, &parent.local_id).unwrap().unwrap();
        let c = items::get(&conn, &child.local_id).unwrap().unwrap();
        assert!(p.completed && c.completed);
        assert_eq!(p.status.as_deref(), Some("completed"));
        let ops = outbox::next_batch(&conn, 10).unwrap(); // the file's existing pending accessor
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "status");
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(payload["checklist_id"], list.id.as_str());
        assert_eq!(payload["item_local_id"], parent.local_id.as_str());
        assert_eq!(payload["status"], "completed");

        // move OUT -> completed flips back (children untouched), second op
        set_item_status_inner(&mut conn, &list.id, &parent.local_id, "todo").unwrap();
        let p = items::get(&conn, &parent.local_id).unwrap().unwrap();
        assert!(!p.completed);
        assert_eq!(p.status.as_deref(), Some("todo"));
        let c = items::get(&conn, &child.local_id).unwrap().unwrap();
        assert!(c.completed); // server applyStatus does NOT un-complete children
        assert_eq!(outbox::next_batch(&conn, 10).unwrap().len(), 2);
    }

    #[tokio::test]
    async fn set_item_status_on_empty_cache_treats_target_as_non_auto() {
        // cache empty (board never opened): mirror server semantics with statuses=null
        // -> autoComplete false -> completed untouched
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let it = items::insert_local(&conn, &items::NewItem {
            checklist_id: list.id.clone(), parent_local_id: None, text: "x".into(),
            status: None, priority: None, target_date: None,
        }).unwrap();
        set_item_status_inner(&mut conn, &list.id, &it.local_id, "completed").unwrap();
        let r = items::get(&conn, &it.local_id).unwrap().unwrap();
        assert!(!r.completed);
        assert_eq!(r.status.as_deref(), Some("completed"));
    }

    #[tokio::test]
    async fn add_item_inner_carries_status_for_kanban() {
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "B".into(), category: "Home".into() }).unwrap();
        let dto = add_item_inner(&mut conn, &list.id, "card".into(), None, Some("in_progress".into())).unwrap();
        assert_eq!(dto.status.as_deref(), Some("in_progress"));
        let ops = outbox::next_batch(&conn, 10).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(payload["status"], "in_progress");
        // plain lists: status None -> payload carries NO status key
        let dto2 = add_item_inner(&mut conn, &list.id, "plain".into(), None, None).unwrap();
        let ops = outbox::next_batch(&conn, 10).unwrap();
        let payload2: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert!(payload2.get("status").is_none());
        assert_eq!(dto2.status, None);
    }
```

(CAUTION: the file's harness is VERIFIED 2026-09-20: tests are `#[tokio::test] async fn` with `let mut conn = db();` and pending ops are read via `outbox::next_batch(&conn, 10)`. For wiremock command tests build the state EXACTLY like the existing harness does: `let state = AppState::new(db(), Box::new(MockKeyStore::default()), Box::new(MockKeyStore::default())).unwrap();` then inject the client directly — `*state.client.write().await = Some(JottyClient::new(&s.uri(), "ck").unwrap());` (state.rs: client starts as `RwLock::new(None)`; direct write beats the restore-task dance). `MockKeyStore` comes from `crate::keys` (already used at commands/mod.rs:1314). Name the helper `async fn test_state_with_client(uri: &str) -> AppState` following the file's conventions. The TESTS above are the contract; the plumbing follows repo convention.)

Wiremock tests (fetch_task_board + get_board_columns + create_task_board):

```rust
    #[tokio::test]
    async fn fetch_task_board_rewrites_cache_and_returns_columns() {
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/tasks/b-uuid"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "task": { "id": "b-uuid", "title": "B", "category": "Home",
                    "statuses": [ { "id": "todo", "label": "To Do", "order": 0, "autoComplete": false },
                                  { "id": "done", "label": "Done", "order": 1, "autoComplete": true } ],
                    "items": [], "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
            })))
            .mount(&s).await;
        let state = test_state_with_client(&s.uri()).await; // the file's existing AppState harness (client Some)
        let dto = fetch_task_board_inner(&state, "b-uuid").await.unwrap();
        assert_eq!(dto.statuses.len(), 2);
        assert_eq!(dto.statuses[1].id, "done");
        assert!(dto.statuses[1].auto_complete);
        let conn = state.db.lock().await;
        assert_eq!(board::list(&conn, "b-uuid").unwrap().len(), 2); // cached
    }

    #[tokio::test]
    async fn fetch_task_board_404_keeps_cache_silent() {
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/tasks/b-uuid"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({"error":"Task not found"})))
            .mount(&s).await;
        let state = test_state_with_client(&s.uri()).await;
        {
            let conn = state.db.lock().await;
            board::replace_cache(&conn, "b-uuid", &[("todo", "To Do", None, 0, false)]).unwrap();
        }
        let dto = fetch_task_board_inner(&state, "b-uuid").await.unwrap();
        assert_eq!(dto.statuses.len(), 1); // cache preserved, no error surfaced
        let conn = state.db.lock().await;
        assert_eq!(board::list(&conn, "b-uuid").unwrap().len(), 1);
    }

    #[tokio::test]
    async fn fetch_task_board_null_statuses_clears_cache() {
        // server statuses null -> site renders the default set; cache must CLEAR
        // so get_board_columns' default fallback applies (spec §6).
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/tasks/b-uuid"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "task": { "id": "b-uuid", "title": "B", "category": "Home", "statuses": null,
                          "items": [], "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
            })))
            .mount(&s).await;
        let state = test_state_with_client(&s.uri()).await;
        {
            let conn = state.db.lock().await;
            board::replace_cache(&conn, "b-uuid", &[("stale", "Stale", None, 0, false)]).unwrap();
        }
        let dto = fetch_task_board_inner(&state, "b-uuid").await.unwrap();
        assert_eq!(dto.statuses.len(), 4); // render_default_statuses()
        assert!(dto.statuses.iter().any(|s| s.id == "paused"));
        let conn = state.db.lock().await;
        assert!(board::list(&conn, "b-uuid").unwrap().is_empty()); // cache cleared
    }

    #[tokio::test]
    async fn get_board_columns_falls_back_to_defaults_when_uncached() {
        let state = test_state_with_client(&"http://unused.invalid").await;
        let dto = get_board_columns_inner(&state, "never-opened").await.unwrap();
        assert_eq!(dto.statuses.len(), 4);
        assert_eq!(dto.statuses[0].id, "todo");
        assert!(dto.statuses.iter().find(|s| s.id == "completed").unwrap().auto_complete);
    }

    #[tokio::test]
    async fn create_task_board_posts_pulls_and_returns_local_row() {
        let s = MockServer::start().await;
        // POST /api/tasks
        Mock::given(method("POST")).and(path("/api/tasks"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": { "id": "created-uuid", "title": "New board", "category": "Work",
                          "statuses": [ { "id": "todo", "label": "To Do", "order": 0, "autoComplete": false },
                                        { "id": "in_progress", "label": "In Progress", "order": 1, "autoComplete": false },
                                        { "id": "completed", "label": "Completed", "order": 2, "autoComplete": true } ],
                          "items": [], "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
            })))
            .mount(&s).await;
        // pull_all fetches notes + checklists catalogs (BOTH must be mocked —
        // unmatched -> 404 -> pull error). Empty catalogs fine.
        Mock::given(method("GET")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"notes": []})))
            .mount(&s).await;
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"checklists": []})))
            .mount(&s).await;
        let state = test_state_with_client(&s.uri()).await;
        let dto = create_task_board_inner(&state, "New board", "Work").await.unwrap();
        assert_eq!(dto.id, "created-uuid"); // the pull brought it local
        let conn = state.db.lock().await;
        assert!(checklists::get_checklist(&conn, "created-uuid").unwrap().is_some());
        // creation sent the 3-column explicit set
        let reqs = s.received_requests().await.unwrap();
        let body = String::from_utf8_lossy(&reqs[0].body).to_string();
        assert!(body.contains("\"autoComplete\":true"));
        assert!(!body.contains("paused"), "creation set must not include paused: {body}");
    }
```

(CAUTION: the file's existing harness may name things differently — `test_state_with_client` is a STAND-IN for whatever exists (search for how existing wiremock command tests build AppState with a client; if none exists yet, build `AppState { db: Mutex::new(conn), client: RwLock::new(Some(JottyClient::new(...))), keystore: Box::new(MockKeyStore...), ... }` following the state.rs struct and the keys.rs test mocks). If inner-vs-command boundaries differ from the file's conventions, follow the file — the TESTS above are the contract, the plumbing follows repo convention.)

- [ ] **Step 2: Run to verify RED** — missing fns/DTOs = RED.

- [ ] **Step 3: Implement** —

`dto.rs`: ItemDto gains `pub status: Option<String>, pub priority: Option<String>, pub target_date: Option<String>` (Default derive already present; `From<ItemRow>` maps them). Add:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardStatusDto {
    pub id: String,
    pub label: String,
    pub color: Option<String>,
    pub order: i64,
    pub auto_complete: bool,
}

impl From<crate::db::board::BoardStatusRow> for BoardStatusDto {
    fn from(r: crate::db::board::BoardStatusRow) -> Self {
        BoardStatusDto { id: r.status_id, label: r.label, color: r.color, order: r.sort_order, auto_complete: r.auto_complete }
    }
}

impl From<crate::jotty::models::ServerStatus> for BoardStatusDto {
    fn from(s: crate::jotty::models::ServerStatus) -> Self {
        BoardStatusDto { id: s.id, label: s.label, color: s.color, order: s.order, auto_complete: s.auto_complete }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardDto {
    pub checklist_id: String,
    pub statuses: Vec<BoardStatusDto>,
}
```

`commands/mod.rs`:

```rust
pub(crate) fn set_item_status_inner(conn: &mut Connection, checklist_id: &str, item_local_id: &str, new_status: &str) -> AppResult<()> {
    let tx = conn.transaction()?;
    let cache = board::list(&tx, checklist_id)?;
    // spec §6: autoComplete comes from the CACHE; empty cache mirrors the server's
    // statuses-null semantics (autoComplete=false -> completed untouched).
    let target_auto = cache.iter().find(|s| s.status_id == new_status).map(|s| s.auto_complete).unwrap_or(false);
    let prev = items::get(&tx, item_local_id)?
        .ok_or_else(|| AppError::Other(format!("item {item_local_id} not found")))?;
    let changed = prev.status.as_deref() != Some(new_status);
    items::set_status(&tx, item_local_id, Some(new_status.to_string()), target_auto, changed)?;
    if target_auto {
        items::set_completed_recursive(&tx, item_local_id, true)?;
    }
    // Ruling D shape: op_type = "status", entity = "checklist_item", entity_id = item local_id
    outbox::enqueue(&tx, "status", "checklist_item", item_local_id, &serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": item_local_id, "status": new_status
    }))?;
    tx.commit()?;
    Ok(())
}
```

`add_item_inner` gains `status: Option<String>`: pass into `NewItem`, and the payload gains `"status"` ONLY when Some (plain-list payload stays byte-identical to today — existing tests pin it):

```rust
    let mut payload = serde_json::json!({
        "checklist_id": checklist_id, "item_local_id": &row.local_id, "text": &row.text,
        "parent_local_id": parent_local_id.as_deref()
    });
    if let Some(st) = &status { payload["status"] = serde_json::json!(st); }
    outbox::enqueue(&tx, "create", "checklist_item", &row.local_id, &payload)?;
```

(The `#[tauri::command] pub async fn add_item` wrapper gains `status: Option<String>` — Tauri passes None when the JS omits the arg; existing frontend callers get it appended in Task 5.)

Board commands:

```rust
pub(crate) fn board_dto_from_cache(conn: &Connection, checklist_id: &str) -> BoardDto {
    let cached = board::list(conn, checklist_id).unwrap_or_default();
    let statuses: Vec<BoardStatusDto> = if cached.is_empty() {
        crate::jotty::models::render_default_statuses().into_iter().map(BoardStatusDto::from).collect()
    } else {
        cached.into_iter().map(BoardStatusDto::from).collect()
    };
    BoardDto { checklist_id: checklist_id.into(), statuses }
}

async fn fetch_task_board_inner(state: &AppState, checklist_id: &str) -> AppResult<BoardDto> {
    let client = state.client.read().await.clone()
        .ok_or_else(|| AppError::Other("not connected".into()))?;
    match client.get_task(checklist_id).await {
        Ok(task) => {
            let conn = state.db.lock().await;
            let server_statuses = task.statuses.unwrap_or_default();
            if server_statuses.is_empty() {
                // statuses null server-side -> site renders defaults; CLEAR the cache
                // so the default fallback applies (spec §6, test above pins this).
                board::replace_cache(&conn, checklist_id, &[])?;
                Ok(BoardDto { checklist_id: checklist_id.into(),
                    statuses: crate::jotty::models::render_default_statuses().into_iter().map(BoardStatusDto::from).collect() })
            } else {
                let tuples: Vec<board::StatusTuple> = server_statuses.iter()
                    .map(|s| (s.id.as_str(), s.label.as_str(), s.color.as_deref(), s.order, s.auto_complete))
                    .collect();
                board::replace_cache(&conn, checklist_id, &tuples)?;
                Ok(BoardDto { checklist_id: checklist_id.into(),
                    statuses: server_statuses.into_iter().map(BoardStatusDto::from).collect() })
            }
        }
        // 404/400 (old instance / non-kanban) and ANY network error: silent cache keep.
        Err(_) => {
            let conn = state.db.lock().await;
            Ok(board_dto_from_cache(&conn, checklist_id))
        }
    }
}

#[tauri::command]
pub async fn fetch_task_board(state: tauri::State<'_, AppState>, checklist_id: String) -> Result<BoardDto, String> {
    fetch_task_board_inner(&state, &checklist_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_board_columns(state: tauri::State<'_, AppState>, checklist_id: String) -> Result<BoardDto, String> {
    let conn = state.db.lock().await;
    Ok(board_dto_from_cache(&conn, &checklist_id))
}

async fn create_task_board_inner(state: &AppState, title: &str, category: &str) -> AppResult<ChecklistDto> {
    let client = state.client.read().await.clone()
        .ok_or_else(|| AppError::Other("not connected".into()))?;
    // Live creation (ruling 3): the plain create endpoint cannot carry statuses.
    let board = client.create_task(title, category, &crate::jotty::models::creation_board_statuses()).await?;
    {
        let mut conn = state.db.lock().await;
        // Bring it local before returning (T14 precedent: the command holds the
        // guard across awaits). Pull errors surface — the board exists server-side
        // and the next sync will fetch it; refreshAll covers the UI either way.
        crate::sync::pull_all(&mut conn, &client).await?;
    }
    let conn = state.db.lock().await;
    let row = checklists::get_checklist(&conn, &board.id)?
        .ok_or_else(|| AppError::Other("created board absent after pull".into()))?;
    Ok(ChecklistDto::from(row))
}

#[tauri::command]
pub async fn create_task_board(state: tauri::State<'_, AppState>, title: String, category: String) -> Result<ChecklistDto, String> {
    create_task_board_inner(&state, &title, &category).await.map_err(|e| e.to_string())
}
```

(CAUTION — borrow/await shape: `pull_all(&mut conn, ...)` needs `&mut` — take the guard as `let mut conn = state.db.lock().await;` and pass `&mut *conn`. The guard across `.await` is Send-safe (Connection: Send — T5 correction). Do NOT pass a shared `&Connection` across an await (T5 class). If pull_all's signature differs, match it.)

`lib.rs`: register `commands::fetch_task_board, commands::get_board_columns, commands::create_task_board, commands::set_item_status` in `generate_handler!` (keep alphabetical-ish grouping with the other checklist commands).

- [ ] **Step 4: Full Rust gates** — green, zero new warnings. Existing add_item tests (payload shape without status) must stay green BYTE-IDENTICAL (plain-list payload unchanged).

- [ ] **Step 5: Commit** — `git commit -m "feat(commands): kanban board commands — fetch/cache columns, create board, set_item_status"`.

---

### Task 4: Push replay arm ("checklist_item", "status") + live round-trip test (Rust)

**Files:**
- Modify: `src-tauri/src/sync/push.rs` (new arm in the op match; + tests)
- Modify: `src-tauri/tests/integration_real.rs` (env-gated live kanban round-trip)
- Test: `src-tauri/src/sync/push.rs::tests`, `src-tauri/tests/integration_real.rs`

**Interfaces:**
- Consumes: Task 2 `client.update_item_status`; Task 3's op payload shape `{checklist_id, item_local_id, status}`; the EXISTING `fetch_list_snapshot` + `resolve_item_target(conn, &snap.items, local_id, &mut claims, update_arm=false)` (text-verified — check-op class, spec §6; ruling: NEVER update_arm=true for status moves).
- Produces: `("checklist_item", "status")` arm wired into the FIFO replay; conflicts via the existing 400/403/404/409/410 classification (no new code — it's the shared `result` match below the arms).

- [ ] **Step 1: Write failing wiremock tests** (push.rs tests — the file has wiremock sync-engine tests with per-endpoint hit counters; follow its harness EXACTLY):

```rust
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
        // simulate the drifted state: the row was synced when "card" sat at path "0"
        conn.execute(
            "INSERT INTO checklist_items (local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date)
             VALUES ('it-1', ?1, NULL, 'card', 0, 0, '0', 0, 'todo', NULL, NULL)",
            [&list.id],
        ).unwrap();
        outbox::enqueue(&conn, "status", "checklist_item", "it-1",
            &serde_json::json!({"item_local_id": "it-1", "checklist_id": list.id, "status": "in_progress"})).unwrap();
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
        conn.execute(
            "INSERT INTO checklist_items (local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date)
             VALUES ('it-1', ?1, NULL, 'card', 0, 0, '0', 0, 'todo', NULL, NULL)",
            [&list.id],
        ).unwrap();
        outbox::enqueue(&conn, "status", "checklist_item", "it-1",
            &serde_json::json!({"item_local_id": "it-1", "checklist_id": list.id, "status": "in_progress"})).unwrap();
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
        conn.execute(
            "INSERT INTO checklist_items (local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date)
             VALUES ('it-1', ?1, NULL, 'card', 0, 0, '0', 0, 'todo', NULL, NULL)",
            [&list.id],
        ).unwrap();
        outbox::enqueue(&conn, "status", "checklist_item", "it-1",
            &serde_json::json!({"item_local_id": "it-1", "checklist_id": list.id, "status": "in_progress"})).unwrap();
        outbox::enqueue(&conn, "create", "note", "n-1", &serde_json::json!({"temp_id": "n-1", "title":"T","content":"c","category":"Home"})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.conflicts, 1);   // the 400 status move
        assert_eq!(stats.pushed, 1);      // the note create behind it still replayed
    }
```

(The 2nd/3rd tests above are now FULLY specified; the seed shape mirrors the file's real harness verified 2026-09-20: `db()` helper at push.rs:470 (open + migrations), `checklists::insert_local_list` + raw INSERT for the drifted row (NewItem can't set server_path — it's a synced-row simulation), `outbox::enqueue`, `push_pending(&mut conn, &client)` at push.rs:14. Note the FIFO test's note-create mock: wiremock unmatched→404→conflict class requires EVERY replayed op to have its own mock.)

- [ ] **Step 2: Run to verify RED** — `unknown op checklist_item/status` error = RED (the arm doesn't exist).

- [ ] **Step 3: Implement the arm** (insert after the `("checklist_item", "check")` arm, before `"delete"`):

```rust
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
```

(The existing `result` match below ALREADY classifies 400/403/404/409/410 → mark_conflict and unresolved → conflict — no new classification code.)

- [ ] **Step 4: Full Rust gates** — green (pushed/conflict stats unchanged for every existing test), zero new warnings.

- [ ] **Step 5: Env-gated live round-trip** — append to `src-tauri/tests/integration_real.rs` (the file's harness: `env()`, `fresh_db()`, `jotty_client_lib::jotty::client::JottyClient`; follow the existing `#[test] #[ignore] fn + rt.block_on` shape):

```rust
#[test]
#[ignore]
fn live_kanban_board_roundtrip() {
    let Some((url, key)) = env() else { return; };
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let client = JottyClient::new(&url, &key).unwrap();
        // 1) create a throwaway board (disposable name, deleted at the end)
        let board = jotty_client_lib::jotty::models::creation_board_statuses();
        let created = client.create_task(
            &format!("KANBAN-CLIENT-TEST {}", uuid::Uuid::new_v4()),
            "Uncategorized", &board,
        ).await.unwrap();
        // 2) add a card in the first column
        client.create_item(&created.id, "roundtrip card", None, Some("todo")).await.unwrap();
        // 3) read the board back: card is at index 0 with status todo
        let task = client.get_task(&created.id).await.unwrap();
        assert_eq!(task.items[0].status.as_deref(), Some("todo"));
        // 4) move it to in_progress via the status endpoint; verify via GET
        client.update_item_status(&created.id, "0", "in_progress").await.unwrap();
        let task = client.get_task(&created.id).await.unwrap();
        assert_eq!(task.items[0].status.as_deref(), Some("in_progress"));
        assert!(!task.items[0].completed.unwrap_or(false));
        // 5) move to the autoComplete column; verify completed flipped server-side
        client.update_item_status(&created.id, "0", "completed").await.unwrap();
        let task = client.get_task(&created.id).await.unwrap();
        assert_eq!(task.items[0].status.as_deref(), Some("completed"));
        assert!(task.items[0].completed.unwrap_or(false));
        // cleanup: delete the throwaway board (best-effort, log on failure)
        if let Err(e) = client.delete_checklist(&created.id).await {
            eprintln!("cleanup: failed to delete test board {}: {e:?}", created.id);
        }
    });
}
```

(The client crate name in tests is `jotty_client_lib` — matches the file's existing imports. This test MUTATES the user's instance with a clearly-named throwaway board and DELETES it — the established T19 harness pattern. Run it for real if JOTTY_TEST_URL/JOTTY_TEST_API_KEY are configured on this box; otherwise it SKIPS — never fabricate output.)

- [ ] **Step 6: Commit** — `git commit -m "feat(sync): replay item status moves via /api/tasks/{uuid}/items/{path}/status"`.

---

### Task 5: Frontend API surface — types, client wrappers, store.createBoard (TS)

**Files:**
- Modify: `src/api/types.ts` (ItemDto.status/priority/targetDate; BoardStatusDto; BoardDto)
- Modify: `src/api/client.ts` (getBoardColumns, fetchTaskBoard, createBoard, setItemStatus; addItem gains status param)
- Modify: `src/stores/store.ts` (AppState.createBoard + implementation)
- Modify: `src/components/ChecklistView.tsx` (its `add` passes `status: null` — addItem signature change)
- Test: `src/stores/store.test.ts` (or the file's existing store-test home — check where store actions are tested)

**Interfaces:**
- Consumes: Task 3 command names/camelCase DTOs (fetch_task_board → BoardDto, get_board_columns, create_task_board → ChecklistDto, set_item_status, add_item + status).
- Produces (Task 6/7 consume): `api.getBoardColumns(checklistId): Promise<T.BoardDto>`; `api.fetchTaskBoard(checklistId): Promise<T.BoardDto>`; `api.createBoard(title, category): Promise<T.ChecklistDto>`; `api.setItemStatus(checklistId, itemLocalId, status): Promise<void>`; `api.addItem(checklistId, text, parentLocalId, status: string | null)`; `T.ItemDto.status: string | null; priority: string | null; targetDate: string | null`; `T.BoardStatusDto { id: string; label: string; color: string | null; order: number; autoComplete: boolean }`; `T.BoardDto { checklistId: string; statuses: BoardStatusDto[] }`; `store.createBoard(title, category)` (creates → refreshAll → selects the board, mirroring `createChecklist`).

- [ ] **Step 1: Write the failing store test** (in the store's existing test file):

```ts
it('createBoard calls create_task_board, refreshes, and selects the new board', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'create_task_board') return Promise.resolve({ id: 'b1', title: 'New board', category: 'Work', dirty: false, completed: false, listType: 'kanban', items: [] });
      if (cmd === 'list_checklists') return Promise.resolve([]); // keep existing list mocks shape
      return Promise.resolve(null);
    });
    await useStore.getState().createBoard('New board', 'Work');
    expect(invoke).toHaveBeenCalledWith('create_task_board', { title: 'New board', category: 'Work' });
    expect(useStore.getState().selectedChecklistId).toBe('b1');
    expect(useStore.getState().listMode).toBe('checklists');
});
```

(Adapt to the real store-test harness in the repo — `useStore.setState` resets in beforeEach etc. The ASSERTIONS are the contract.)

- [ ] **Step 2: RED** — run the store test → createBoard undefined.

- [ ] **Step 3: Implement** —

`types.ts`:

```ts
export interface ItemDto {
  localId: string; checklistId: string; parentLocalId: string | null;
  text: string; completed: boolean; position: number; dirty: boolean;
  status: string | null; priority: string | null; targetDate: string | null;
  children: ItemDto[];
}
export interface BoardStatusDto { id: string; label: string; color: string | null; order: number; autoComplete: boolean; }
export interface BoardDto { checklistId: string; statuses: BoardStatusDto[]; }
```

`client.ts`:

```ts
export const getBoardColumns = (checklistId: string) => invoke<T.BoardDto>('get_board_columns', { checklistId });
export const fetchTaskBoard = (checklistId: string) => invoke<T.BoardDto>('fetch_task_board', { checklistId });
export const createBoard = (title: string, category: string) => invoke<T.ChecklistDto>('create_task_board', { title, category });
export const setItemStatus = (checklistId: string, itemLocalId: string, status: string) => invoke<void>('set_item_status', { checklistId, itemLocalId, status });
export const addItem = (checklistId: string, text: string, parentLocalId: string | null, status: string | null) => invoke<T.ItemDto>('add_item', { checklistId, text, parentLocalId, status });
```

`store.ts`: interface gains `createBoard: (title: string, category: string) => Promise<T.ChecklistDto>;`; implementation mirrors `createChecklist` but calls `api.createBoard`.

`ChecklistView.tsx`: `api.addItem(checklistId, newText.trim(), null, null)`.

- [ ] **Step 4: Gates** — `npm test` (all existing component tests must stay green — their item mocks are untyped so no breakage; ChecklistView's add-item test now asserts `add_item` called WITHOUT status → it WILL break: reshape the fence to expect `{ checklistId, text, parentLocalId, status: null }` — DISCLOSED reshape), `npx tsc -p tsconfig.json --noEmit` clean.

- [ ] **Step 5: Commit** — `git commit -m "feat(api): kanban frontend surface — board columns, createBoard, setItemStatus, item status fields"`.

---

### Task 6: KanbanBoard component (TS + vitest/RTL)

**Files:**
- Create: `src/components/KanbanBoard.tsx`
- Create: `src/components/KanbanBoard.test.tsx`
- Modify: `src/styles.css` (board styles — see Step 4)

**Interfaces:**
- Consumes: Task 5 (`api.getBoardColumns/fetchTaskBoard/setItemStatus/addItem`, `T.BoardDto/BoardStatusDto`, `T.ItemDto.status/priority/targetDate`).
- Produces: `KanbanBoard({ checklistId, items, reload }: { checklistId: string; items: ItemDto[]; reload: () => Promise<void> })` — renders `<div class="kanban-board">` with `.kanban-col` per column (sorted by `order`); Task 7 mounts it. Behavior contract: (a) columns = `getBoardColumns` result, refreshed in background by `fetchTaskBoard` (silent catch); (b) cards = TOP-LEVEL items only (`parentLocalId === null`, position-sorted); card in column where `item.status === col.id`; unknown/absent status → FIRST column (ruling 6); (c) card shows text + badges: `priority` chip when set, `targetDate` chip when set, `N subtasks` chip when `children.length > 0`; completed items (or items in an autoComplete column) render `.completed-item` strikethrough; (d) card click → action menu (`.kanban-menu`): one "Move to <label>" button per OTHER column, "Rename" (inline input committing on Enter/blur via `api.setItemText`), "Delete" (`api.deleteItem`); backdrop click closes; (e) DnD: card `draggable` + `onDragStart` sets `dataTransfer('text/plain', localId)` (T17 ruling U: onDrop reads dataTransfer FIRST, `dragId` state as fallback); column `onDragOver` preventDefault + `onDrop` → `api.setItemStatus(checklistId, drag, col.id)` + reload; (f) per-column "+" → inline input → `api.addItem(checklistId, text, null, col.id)` + reload; (g) NO reorder UI (ruling 5).

- [ ] **Step 1: Write failing component tests** (`KanbanBoard.test.tsx`, following ChecklistView.test.tsx's invoke-mock harness):

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import KanbanBoard from './KanbanBoard';

const board = {
  checklistId: 'b1',
  statuses: [
    { id: 'todo', label: 'To Do', color: null, order: 0, autoComplete: false },
    { id: 'in_progress', label: 'In Progress', color: '#3b82f6', order: 1, autoComplete: false },
    { id: 'completed', label: 'Completed', color: null, order: 2, autoComplete: true },
  ],
};
const items = [
  { localId: 'i1', checklistId: 'b1', parentLocalId: null, text: 'alpha', completed: false, position: 0, dirty: false, status: 'todo', priority: 'high', targetDate: '2026-10-01', children: [
    { localId: 'c1', checklistId: 'b1', parentLocalId: 'i1', text: 'sub', completed: false, position: 1, dirty: false, status: null, priority: null, targetDate: null, children: [] },
  ] },
  { localId: 'i2', checklistId: 'b1', parentLocalId: null, text: 'mystery', completed: false, position: 1, dirty: false, status: 'bogus', priority: null, targetDate: null, children: [] },
  { localId: 'i3', checklistId: 'b1', parentLocalId: null, text: 'done-card', completed: true, position: 2, dirty: false, status: 'completed', priority: null, targetDate: null, children: [] },
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'get_board_columns') return Promise.resolve(board);
    if (cmd === 'fetch_task_board') return Promise.resolve(board);
    return Promise.resolve({});
  });
});

describe('KanbanBoard', () => {
  it('renders columns in order with counts and refreshes them in the background', async () => {
    render(<KanbanBoard checklistId="b1" items={items} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('To Do')).toBeInTheDocument());
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('get_board_columns', { checklistId: 'b1' });
    expect(invoke).toHaveBeenCalledWith('fetch_task_board', { checklistId: 'b1' });
  });

  it('groups cards by status; unknown/absent status lands in the FIRST column', async () => {
    const { container } = render(<KanbanBoard checklistId="b1" items={items} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    const cols = container.querySelectorAll('.kanban-col');
    const first = cols[0].textContent ?? '';
    expect(first).toContain('alpha');
    expect(first).toContain('mystery'); // bogus status -> first column (ruling 6)
    expect((cols[2].textContent ?? '')).toContain('done-card');
  });

  it('shows display-only badges (priority, target date, subtask count)', async () => {
    render(<KanbanBoard checklistId="b1" items={items} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('high')).toBeInTheDocument());
    expect(screen.getByText('2026-10-01')).toBeInTheDocument();
    expect(screen.getByText('1 subtask')).toBeInTheDocument();
  });

  it('marks cards in autoComplete columns completed', async () => {
    const { container } = render(<KanbanBoard checklistId="b1" items={items} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('done-card')).toBeInTheDocument());
    const doneCol = container.querySelectorAll('.kanban-col')[2];
    expect(doneCol.querySelector('.kanban-card.completed-item')).not.toBeNull();
  });

  it('menu Move-to calls set_item_status and reloads; backdrop closes', async () => {
    const reload = vi.fn(async () => {});
    render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Move to In Progress'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_status', { checklistId: 'b1', itemLocalId: 'i1', status: 'in_progress' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('menu Rename commits set_item_text; Delete calls delete_item', async () => {
    const reload = vi.fn(async () => {});
    render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByDisplayValue('alpha');
    fireEvent.change(input, { target: { value: 'renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_text', { checklistId: 'b1', itemLocalId: 'i1', text: 'renamed' }));
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('delete_item', { checklistId: 'b1', itemLocalId: 'i1' }));
  });

  it('column + adds a card with the column status', async () => {
    const reload = vi.fn(async () => {});
    render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getAllByText('+').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('+')[0]);
    fireEvent.change(screen.getByPlaceholderText('New card'), { target: { value: 'fresh' } });
    fireEvent.keyDown(screen.getByPlaceholderText('New card'), { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'b1', text: 'fresh', parentLocalId: null, status: 'todo' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('drop on a column moves the card (dataTransfer-first, T17 ruling U)', async () => {
    const reload = vi.fn(async () => {});
    const { container } = render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    const card = screen.getByText('alpha').closest('.kanban-card') as HTMLElement;
    // real dataTransfer — jsdom lacks it; ChecklistView tests use a shim
    const dt = { getData: (t: string) => (t === 'text/plain' ? 'i1' : ''), setData: () => {} };
    fireEvent.dragStart(card, { dataTransfer: dt });
    const targetCol = container.querySelectorAll('.kanban-col')[2];
    fireEvent.drop(targetCol, { dataTransfer: dt });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_status', { checklistId: 'b1', itemLocalId: 'i1', status: 'completed' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });
});
```

(CAUTION: the menu-Move test line with `within(...).getByText(...)` is deliberately awkward — write it plainly: `fireEvent.click(screen.getByText('alpha')); fireEvent.click(screen.getByText('Move to In Progress'));` — the menu buttons are plain text; use RTL plain queries. The `menu` role is optional — implement WITHOUT role="menu" and query by text. Keep the test harness honest, not clever.)

- [ ] **Step 2: RED** — module not found.

- [ ] **Step 3: Implement KanbanBoard.tsx** (full component; the tests above are the contract):

```tsx
import { useEffect, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import * as api from '../api/client';
import type { BoardStatusDto, ItemDto } from '../api/types';

export default function KanbanBoard({ checklistId, items, reload }: {
  checklistId: string; items: ItemDto[]; reload: () => Promise<void>;
}) {
  const [columns, setColumns] = useState<BoardStatusDto[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [newCard, setNewCard] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cached = await api.getBoardColumns(checklistId);
        if (!cancelled) setColumns(cached.statuses);
      } catch { /* uncached + no client: defaults render below */ }
      try {
        const fresh = await api.fetchTaskBoard(checklistId); // live refresh, silent on failure
        if (!cancelled) setColumns(fresh.statuses);
      } catch { /* offline: cache stays */ }
    })();
    return () => { cancelled = true; };
  }, [checklistId]);

  const cols: BoardStatusDto[] = columns ?? [];
  const top = items.filter((i) => i.parentLocalId === null).sort((a, b) => a.position - b.position);
  const validIds = new Set(cols.map((c) => c.id));
  const firstId = cols.slice().sort((a, b) => a.order - b.order)[0]?.id;
  const cardsFor = (col: BoardStatusDto) =>
    top.filter((i) => i.status === col.id || (col.id === firstId && (!i.status || !validIds.has(i.status))));

  const move = async (localId: string, status: string) => {
    setMenuFor(null);
    await api.setItemStatus(checklistId, localId, status);
    await reload();
  };
  const onDrop = async (colId: string, e: DragEvent) => {
    const drag = e.dataTransfer.getData('text/plain') || dragId;
    setDragId(null);
    if (!drag) return;
    await move(drag, colId);
  };
  const rename = async (localId: string) => {
    setRenaming(null);
    if (!renameText.trim()) return;
    await api.setItemText(checklistId, localId, renameText.trim());
    await reload();
  };
  const addCard = async (colId: string) => {
    if (!newCard.trim()) return;
    await api.addItem(checklistId, newCard.trim(), null, colId);
    setNewCard('');
    setAddingTo(null);
    await reload();
  };

  return (
    <div className="kanban-board">
      {(menuFor || renaming) && <div className="kanban-backdrop" onClick={() => { setMenuFor(null); setRenaming(null); }} />}
      {cols.map((col) => (
        <div className="kanban-col" key={col.id}
             onDragOver={(e) => e.preventDefault()}
             onDrop={(e) => onDrop(col.id, e)}>
          <div className="kanban-col-head">
            <span className="kanban-dot" style={col.color ? { background: col.color } : undefined} />
            <span className="kanban-col-title">{col.label}</span>
            <span className="kanban-count">{cardsFor(col).length}</span>
          </div>
          <div className="kanban-cards">
            {cardsFor(col).map((item) => (
              <div key={item.localId}
                   className={`kanban-card${item.completed || col.autoComplete ? ' completed-item' : ''}${menuFor === item.localId ? ' menu-open' : ''}`}
                   draggable
                   onDragStart={(e) => { setDragId(item.localId); e.dataTransfer.setData('text/plain', item.localId); }}
                   onClick={(e) => {
                     e.stopPropagation();
                     if (renaming) return;
                     setMenuFor((m) => (m === item.localId ? null : item.localId));
                   }}>
                {renaming === item.localId ? (
                  <input value={renameText} autoFocus
                         onChange={(e) => setRenameText(e.target.value)}
                         onBlur={() => rename(item.localId)}
                         onKeyDown={(e: KeyboardEvent) => e.key === 'Enter' && rename(item.localId)} />
                ) : (
                  <span className="kanban-card-text">{item.text}</span>
                )}
                <span className="kanban-badges">
                  {item.priority && <span className="kanban-badge">{item.priority}</span>}
                  {item.targetDate && <span className="kanban-badge">{item.targetDate}</span>}
                  {item.children.length > 0 && <span className="kanban-badge">{item.children.length} subtask{item.children.length === 1 ? '' : 's'}</span>}
                </span>
                {menuFor === item.localId && (
                  <div className="kanban-menu" onClick={(e) => e.stopPropagation()}>
                    {cols.filter((c) => c.id !== col.id).map((c) => (
                      <button key={c.id} onClick={() => move(item.localId, c.id)}>Move to {c.label}</button>
                    ))}
                    <button onClick={() => { setRenameText(item.text); setRenaming(item.localId); setMenuFor(null); }}>Rename</button>
                    <button className="kanban-danger" onClick={async () => { setMenuFor(null); await api.deleteItem(checklistId, item.localId); await reload(); }}>Delete</button>
                  </div>
                )}
              </div>
            ))}
            {addingTo === col.id ? (
              <input className="kanban-add-input" placeholder="New card" autoFocus value={newCard}
                     onChange={(e) => setNewCard(e.target.value)}
                     onBlur={() => { setAddingTo(null); setNewCard(''); }}
                     onKeyDown={(e: KeyboardEvent) => e.key === 'Enter' && addCard(col.id)} />
            ) : (
              <button className="kanban-add" onClick={() => setAddingTo(col.id)}>+</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
```

(Implementation notes: the backdrop is rendered INSIDE .kanban-board above the columns — z-index layering per CSS below. Cards render badges + menu inline; completed styling covers BOTH `item.completed` and autoComplete columns per the interface. If a test above needs an exact class/query tweak, adapt the TEST to the implementation's real DOM and disclose — the BEHAVIOR asserts are the contract.)

- [ ] **Step 4: CSS** — append to `src/styles.css` (uses existing tokens; follows the ≤700px mobile pattern for column width):

```css
/* ---------- kanban board ---------- */
.kanban-board { display: flex; gap: 10px; align-items: flex-start; overflow-x: auto; padding-bottom: 8px; position: relative; min-height: 200px; }
.kanban-col { flex: 0 0 auto; width: 260px; display: flex; flex-direction: column; gap: 8px; background: var(--panel); border: 1px solid var(--border-soft); border-radius: 10px; padding: 10px; max-height: 70vh; }
.kanban-col-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.kanban-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); flex: 0 0 auto; }
.kanban-count { margin-left: auto; background: var(--panel-input); border-radius: 8px; padding: 0 6px; font-size: 11px; }
.kanban-cards { display: flex; flex-direction: column; gap: 6px; overflow-y: auto; }
.kanban-card { position: relative; background: var(--panel-input); border: 1px solid var(--border-soft); border-radius: 8px; padding: 8px 10px; cursor: grab; font-size: 14px; }
.kanban-card.completed-item .kanban-card-text { text-decoration: line-through; opacity: 0.65; }
.kanban-badges { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.kanban-badge { font-size: 10.5px; background: var(--badge-surface); color: var(--muted); border-radius: 6px; padding: 1px 5px; }
.kanban-add { border-style: dashed; background: transparent; color: var(--muted); width: 100%; }
.kanban-add-input { width: 100%; }
.kanban-menu { position: absolute; z-index: 60; top: 100%; left: 8px; right: 8px; margin-top: 2px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 10px 24px rgba(0,0,0,0.35); display: flex; flex-direction: column; padding: 4px 0; }
.kanban-menu button { background: transparent; border: none; text-align: left; padding: 7px 12px; border-radius: 0; font-size: 13.5px; }
.kanban-menu button:hover { background: var(--row-hover); }
.kanban-menu .kanban-danger { color: var(--danger); }
.kanban-backdrop { position: fixed; inset: 0; z-index: 55; background: transparent; }
```

Plus in the EXISTING `@media (max-width: 700px)` block: `.kanban-col { width: 82vw; max-width: 340px; }` (horizontal scroll on phones; columns stay readable).

- [ ] **Step 5: Gates** — `npm test` green (KanbanBoard tests pass), `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit** — `git commit -m "feat(ui): KanbanBoard component — columns, cards, badges, menu moves, DnD, per-column add"`.

---

### Task 7: Wiring — ChecklistView board switch, ChecklistList "+ New board" + chip, App fence, px-check (TS)

**Files:**
- Modify: `src/components/ChecklistView.tsx` (board-vs-list switch)
- Modify: `src/components/ChecklistList.tsx` (+ New board button, board chip)
- Modify: `src/App.test.tsx` (App-level fence)
- Modify: `src/components/ChecklistList.test.tsx` (create board fence)
- Test: same files

**Interfaces:**
- Consumes: Task 5 (`store.createBoard`, `T.ItemDto.status`), Task 6 (`KanbanBoard`).
- Produces: user-facing behavior only (no new exports).

- [ ] **Step 1: Write failing tests** —

App.test.tsx (new fence; adapt the file's existing mock harness — it already mocks `get_connection/list_checklists/list_categories/get_prefs/sync_status`):

```tsx
  it('kanban-type checklists render the board view; plain ones keep the checklist', async () => {
    let requested: string | null = null;
    const boardMeta = { id: 'kb', title: 'Sprint', category: 'Work', updatedAt: null, dirty: false, listType: 'kanban', items: [] };
    const plainMeta = { id: 'pl', title: 'Plain', category: 'Work', updatedAt: null, dirty: false, listType: 'simple',
        items: [{ localId: 'i1', checklistId: 'pl', parentLocalId: null, text: 't', completed: false, position: 0, dirty: false, status: null, priority: null, targetDate: null, children: [] }] };
    invoke.mockImplementation((cmd: string, args?: { id?: string }) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://x', version: '1.25.0' });
      if (cmd === 'list_notes') return Promise.resolve([]);
      if (cmd === 'list_checklists') return Promise.resolve([
        { id: 'kb', title: 'Sprint', category: 'Work', dirty: false, completed: false, listType: 'kanban' },
        { id: 'pl', title: 'Plain', category: 'Work', dirty: false, completed: false, listType: 'simple' },
      ]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'get_checklist') {
        requested = args?.id ?? null;
        return requested === 'kb' ? Promise.resolve(boardMeta) : Promise.resolve(plainMeta);
      }
      if (cmd === 'get_board_columns' || cmd === 'fetch_task_board') return Promise.resolve({ checklistId: 'kb', statuses: [
        { id: 'todo', label: 'To Do', color: null, order: 0, autoComplete: false },
        { id: 'completed', label: 'Completed', color: null, order: 1, autoComplete: true },
      ] });
      if (cmd === 'get_prefs') return Promise.resolve(null);
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false, lastError: null });
      return Promise.resolve(null);
    });
    render(<App />);
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Checklists' }));
    fireEvent.click(await screen.findByText('Sprint'));
    // board renders with its columns; the plain checkbox list does NOT
    await waitFor(() => expect(screen.getByText('To Do')).toBeInTheDocument());
    expect(requested).toBe('kb');
    // open the plain list: checklist view with checkboxes
    fireEvent.click(await screen.findByText('Plain'));
    await waitFor(() => expect(screen.getByText('t')).toBeInTheDocument());
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
  });
```

(CAUTION: `get_checklist` must return the BOARD meta for kb — the mock above's `(invoke as any).__id` trick is WRONG; write two clean branches keyed on a captured id variable: `let requested = ''; if (cmd === 'get_checklist') { /* App calls get_checklist(id) — capture args[1].id and branch */ }`. Follow the file's existing invoke-arg inspection patterns. The CONTRACT: kanban list → columns visible (To Do header), plain list → checkboxes.)

ChecklistList.test.tsx:

```tsx
  it('+ New board calls create_task_board via the store and renders the button', async () => {
    // existing harness mocks; create_task_board returns a checklist dto
    fireEvent.click(screen.getByText('+ New board'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_task_board', { title: 'New board', category: 'Uncategorized' }));
  });

  it('kanban-type lists show a board chip in the list', () => {
    // list_checklists mock with listType 'kanban' -> row contains 'board' chip
  });
```

- [ ] **Step 2: RED** — board never renders / button absent.

- [ ] **Step 3: Implement** —

`ChecklistView.tsx`: keep the existing load effect; store the meta list:

```tsx
  const [listMeta, setListMeta] = useState<ChecklistDto | null>(null);
  // in the load effect: setListMeta(list);
  const isBoard = !!listMeta && (listMeta.listType === 'kanban' || listMeta.listType === 'task');
```

Render: keep `#checklist-head` as-is for BOTH modes; then `{isBoard ? <KanbanBoard checklistId={checklistId} items={items} reload={reload} /> : (<ul>…existing…</ul>)}`. Import KanbanBoard. The rename input overlay/checkbox markup stays untouched for plain lists (zero fence churn).

`ChecklistList.tsx`:

```tsx
import { useStore } from '../stores/store';

export default function ChecklistList({ checklists }: { checklists: ChecklistDto[] }) {
  const { selectedChecklistId, selectChecklist, createChecklist, createBoard, connection } = useStore();
  return (
    <section id="checklists">
      <div className="section-head">
        <h2>Checklists</h2>
        <button className="new-btn" onClick={() => createBoard('New board', 'Uncategorized')} disabled={!connection}
                title={connection ? 'Create a kanban board' : 'Connect to create boards'}>+ New board</button>
        <button className="new-btn" onClick={() => createChecklist('New checklist', 'Uncategorized')}>+ New checklist</button>
      </div>
      <ul>
        {checklists.map((c) => (
          <li key={c.id} className={c.id === selectedChecklistId ? 'selected' : ''} onClick={() => selectChecklist(c.id)}>
            <span className="item-title">{c.title}{c.dirty ? ' •' : ''}</span>
            {(c.listType === 'kanban' || c.listType === 'task') && <span className="chip board-chip">board</span>}
            <span className="chip">{c.category}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

(One CSS line: `.board-chip { color: var(--accent-text); }`.)

- [ ] **Step 4: Gates** — `npm test` + `npx tsc --noEmit` green; disclosed reshapes listed in the report.

- [ ] **Step 5: px-check screenshots** — build (`npm run build`), serve dist over http, Playwright with the `__TAURI_INTERNALS__` shim (cwd=/tmp for the playwright package; the listen-promise pitfall: `await new Promise((r) => { server.listen(port, r); })` — NEVER `server.listen(port, () => log)` inside the Promise executor). Capture at 412×916 (open a mocked kanban board: hamburger → list → board; menu open state) and 1280×800. VIEW the screenshots (agent vision) and confirm: columns render, cards grouped, badges show, menu opens/closes, desktop unchanged for plain lists. Save the script + screenshots under /tmp (throwaway); note results in the report.

- [ ] **Step 6: Commit** — `git commit -m "feat(ui): kanban boards wired into checklist view + list (board chip, + New board)"`.

---

### Task 8: Ship v0.11.0 (standing ship procedure)

**Files:**
- Modify: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (version 0.10.8 → 0.11.0)
- Modify: `package-lock.json` (`npm install --package-lock-only`), `src-tauri/Cargo.lock` (`cargo update -p jotty-client`)
- Modify: `~/.hermes/skills/software-development/jotty-client/SKILL.md` (status entry — done by the controller at close, not the implementer)

**Interfaces:** none (ship task).

- [ ] **Step 1: Full gates fresh** — `npm test`, `npx tsc --noEmit`, `cargo test` (expect ignored count unchanged at 5: 4 pre-existing + the new live kanban test; re-census by RUNNING). Zero new warnings.
- [ ] **Step 2: Version bump** — 0.11.0 in the three files, then `npm install --package-lock-only` and `cargo update -p jotty-client`.
- [ ] **Step 3: Commit + push** — verify `git ls-remote origin main` == local HEAD.
- [ ] **Step 4: Desktop build** — `npx tauri build` (EXIT 0; deb + appimage + rpm; linuxdeploy download failure → deb-only fallback per T19).
- [ ] **Step 5: Android build** — `source /tmp/android-env.sh` (recreate from the skill's toolchain section if /tmp was wiped: ANDROID_HOME=/home/zeus/android-sdk, NDK_HOME=…/ndk/27.0.12077973, JAVA_HOME=/home/zeus/java/jdk-17.0.20.1+1), delete any stale `/tmp/page.jotty.desktop-server-addr`, then `npx tauri android build --target aarch64 --apk` (background + notify; ~5-10 min). Verify: `$ANDROID_HOME/build-tools/34.0.0/apksigner verify` + `aapt dump badging` (versionName 0.11.0, minSdk 26) + sha256.
- [ ] **Step 6: Tag + releases** — `git tag -a v0.11.0 -m …` + `git tag -a v0.11.0-android-preview -m …` + push tags. `~/.local/bin/gh release create v0.11.0 <rpm> <deb> <appimage> --title v0.11.0 --notes-file <notes>` (notes: changelog + install commands + COMPUTED sha256 of all three bundles); `gh release create v0.11.0-android-preview <apk> --prerelease --title …` (notes: same changelog + apk sha256).
- [ ] **Step 7: Verify releases** — download each asset back; sha256 must equal the local builds byte-for-byte (GitHub API sizes can disagree with `ls` — checksums are the truth). `gh release view --json assets` state=uploaded.
- [ ] **Step 8: Report** — census (test counts per gate), release URLs, sha256 table, disclosed reshapes/rulings, deferred minors. Controller updates the skill ledger + memory at close.

---

## Final whole-branch review checklist (controller)

- Deferred minors ledgered during the loop (voice-notes precedent).
- Spec §2–§7 coverage: board view ✓ (T6/T7), badges ✓ (T6), no column mgmt ✓, creation ✓ (T3/T7), move semantics ✓ (T3/T4), offline ✓ (T3 cache fallback + T6), conflicts ✓ (T4), live test ✓ (T4).
- Sync invariants untouched: the only new op is additive; plain-checklist flows byte-identical (payload fences green).
- Desktop parity screenshots before ship; Android APK verified (apksigner + aapt + sha256).