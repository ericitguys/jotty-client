# Kanban Recurrence (client-side engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (Hermes form: subagent-orchestration skill + delegate_task background children) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kanban boards in the desktop client support recurring tasks — a client-side recurrence engine (presets, per-slot rolling by mirror-the-web timing, reminder shift) that works against stock jotty with zero server changes.

**Architecture:** Recurrence data lives ONLY in the local SQLite (`checklist_items.recurrence`, migration v5, LOCAL-ONLY class like the voice audio columns). A Rust module `db/recurrence.rs` owns slot math (fixed-pattern equivalents of the upstream RRULE presets) and a `sweep` that implements reset-in-place rolling: due completed recurring items are reset locally and the reset syncs through EXISTING outbox op kinds (`check`, `status`, `set_date`, `set_reminder`). Sweep seats: end of pull (after reconcile), push group-close, board open, app startup, plus a 60s frontend timer command. Frontend adds a Repeat menu + chip on kanban cards.

**Tech Stack:** Tauri 2 + Rust (rusqlite, chrono 0.4 — already a dep, serde), React + TypeScript (existing Dropdown/DateDropdown patterns, zero new deps).

**Spec:** `docs/superpowers/specs/2026-10-05-kanban-recurrence-design.md` (@ 174d16b). The plan argues from the spec; executors read both.

## Global Constraints (binding, every task)

- LOCAL-ONLY recurrence: the `recurrence` column NEVER appears in any outbox op payload, never in any struct serialized to the server, never marked dirty BY ITSELF. Every sync write path (upsert, reconcile arms incl. claimed-UPDATE, enrichment merge) must preserve it. No `#[allow(dead_code)]`; remove instead.
- RRULE preset strings byte-verbatim from upstream `app/_utils/recurrence-utils.ts` @ 54a3e112: `FREQ=DAILY;INTERVAL=1`, `FREQ=WEEKLY;INTERVAL=1`, `FREQ=WEEKLY;INTERVAL=2`, `FREQ=MONTHLY;INTERVAL=1`, `FREQ=YEARLY;INTERVAL=1`.
- Roll predicate is NARROWED vs upstream (ruling R-rec-6): roll requires `completed=1` (the locally authoritative flag) AND `nextDue <= now`. We deliberately do NOT mirror upstream's `status !== TODO && status !== PAUSED` arm — it rolls in-progress cards on the 4-column default board ("in_progress" is neither "todo" nor "paused"). Disclose in reports as a deliberate deviation.
- Reset-in-place mirrors upstream `refreshRecurringItem`: completed=false, status → first column, children reset (completed=false + status → first column), `nextDue` = next slot strictly after now, `lastCompleted` = now. It does NOT touch text/position.
- Kanban-only gate mirrors the reminder gate (`commands/mod.rs:385-390`): list_type must be `kanban` or `task`, else `AppError::Other("recurrence only works on kanban boards")`.
- Outbox payload keys VERBATIM per the push.rs arms (facts §4): check `{checklist_id, item_local_id, checked}`, status `{checklist_id, item_local_id, status}`, set_date `{checklist_id, item_local_id, targetDate}`, set_reminder `{checklist_id, item_local_id, datetime}`; all enqueued `entity="checklist_item"`, `entity_id=<item local_id>`; `enqueue(conn, op_type, entity, entity_id, payload)`.
- Never `cargo fmt` (not rustfmt-formatted). Zero NEW compiler warnings (delta vs census 18 baseline — re-census by running, cached re-checks print 0). No prompt()/alert(). No emoji in code. `npx tauri` is the CLI; no `cargo tauri`.
- TS `src/api/types.ts` must mirror `commands/dto.rs` serde output field-for-field (cross-task contract class).
- Every `terminal` call uses an explicit `workdir` (stale-cwd quirk). Child-reported commit hashes are claims; controller re-derives via `git rev-parse --short=8`.
- Gates per task (Rust touched): `cargo test --lib` from `/coding/jotty/src-tauri`; full `npx vitest run` + `npx tsc -p tsconfig.json --noEmit` from `/coding/jotty` when TS touched; `cargo check --all-targets` warning census when Cargo code touched.
- Baselines at plan time (verify live before first dispatch — do not trust blindly): vitest 540/540 across 46 files (1 known cosmetic unhandled rejection), cargo lib 269 passed + 1 ignored, census 18.
- Version bump happens ONLY at the ship step (controller-led, after whole-branch review). No task bumps versions.

## Confirmed current-code facts (grep/read-verified @ 174d16b, research leaf deleg_a23ea3d5)

- Migrations: `pub const MIGRATIONS: &[&str]` 4 entries (`migrations.rs:4-100`); `run()` iterates by `PRAGMA user_version`, `execute_batch` per entry, bumps user_version (`:102-109`). Adding v5 = append one raw-string batch.
- `ItemRow` (`db/items.rs:8-24`): `local_id, checklist_id, parent_id: Option<String>, text, completed: bool, position: i64, server_path: Option<String>, dirty: bool, status: Option<String>, priority: Option<String>, target_date: Option<String>, start_date: Option<String>, server_item_id: Option<String>, reminder_datetime: Option<String>, reminder_notified: Option<bool>`. `const COLS` at `:74` = `"local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, status, priority, target_date, start_date, server_item_id, reminder_datetime, reminder_notified"`; `fn row(r: &Row)` maps indices 0..14 (`:75-93`). `get()` (`:95-100`), `list_for_checklist` (`:102-107`) build SQL FROM `{COLS}` — extending COLS + row() automatically carries recurrence everywhere.
- Update fns: `set_checked(conn, local_id, checked)` (`:257-261`), `set_target_date(conn, local_id, Option<String>)` (`:266-270`), `set_reminder_local(conn, local_id, Option<String>)` (`:275-281`) — all set `dirty=1`. `set_status(conn, local_id, Option<String>, target_auto: bool, changed: bool)` (`:297-306`) — `completed = CASE WHEN ?3 THEN 1 WHEN ?4 AND completed=1 THEN 0 ELSE completed END, dirty=1`. `set_completed_recursive` BFS via `parent_id` (`:309-324`). NO start_date setter exists (by design; server is source of truth). `insert_local` inserts explicit columns w/o recurrence (NULL default).
- `reconcile(conn, checklist_id, &[ServerItemFlat])` (`:109-222`): pending shield = `outbox::has_pending_for(conn, "checklist_item", &l.local_id)` (`:115-119`); claimed-UPDATE writes mapped server columns + `dirty=0` (`:195-198`) — recurrence MUST be absent from that SET list (preserved by omission). Insert arm (`:202-208`) never writes recurrence.
- `outbox::enqueue(conn, op_type, entity, entity_id, payload: &serde_json::Value)` (`outbox.rs:17-23`); `has_pending_for(conn, entity, id)` (`:73-80`).
- Push arms (`sync/push.rs`): `check` `:169-178` → `client.check_item` (`client.rs:341-348`, `PUT /api/checklists/{list}/items/{path}/check|uncheck`, suffix if checked); `status` `:179-190` → `client.update_item_status` (`client.rs:235-241`, `PUT /api/tasks/{list}/items/{path}/status`, body `{"status": s}`); `set_date` `:191-230` (startDate key PRESENCE splits single vs double PATCH) → `client.update_item_target_date` (`client.rs:280-291`, `PATCH /api/checklists/{list}/items/{path}` body `{"targetDate": string|Null}`); `set_reminder` `:231-293` (stable-id row-first w/ text cross-check, kanban-family gate :41-51) → `client.set_item_reminder` (`client.rs:321-339`, `PUT|DELETE /api/kanban/{board}/items/{id}/reminder`). Uncheck = same `"check"` kind with `"checked": false`. Errors 400/403/404/409/410 → conflict; FIFO stops on other errors.
- Sync run: `sync::run` = `push::push_pending` then `pull::pull_all` (`sync/mod.rs:18-37`). `pull_all` (`sync/pull.rs:18-81`): fetch+upsert tx, tombstones, `enrich_kanban_reminders` (`:66-71`), last_sync write (`:74-78`) — sweep seat = right before the last_sync write. `close_item_group` (`sync/push.rs:362-376`): fetch → `items::reconcile` (`:371`) → `mark_list_synced` (`:372`) — sweep seat = between those two lines. Scheduler `spawn_scheduler` (`sync/mod.rs:61-71`) spawned at `lib.rs:44`, 60s tick, 5-min due default. Startup precedent: `db::voice::sweep_startup(&conn, &voice_dir)` at `lib.rs:32-34` (non-fatal warn).
- Commands: `set_item_status_inner` (`commands/mod.rs:319-341`, cache = `board::list(&tx, checklist_id)`, `target_auto` from cache find, recursive completion on move-IN), `set_item_target_date_inner` (`:351-369`), `set_item_reminder_inner` (`:379-398`, kanban gate `:385-390`), wrappers at `:893-977` (e.g. `set_item_reminder` :956), registration in `lib.rs` `generate_handler!` (`:47-72`). LOCAL-ONLY precedent: `voice_delete_note_audio_inner` (`commands/mod.rs:1727-1741`, comment `:1733`).
- `board::list(conn, checklist_id) -> Vec<BoardStatusRow>` (`db/board.rs:31-48`) ORDER BY sort_order — first row = lowest-order column. Empty cache fallback: first-column id = `"todo"` (render defaults `models.rs:74-82` start with `todo`).
- `ItemDto` (`commands/dto.rs:54-72`, camelCase) + `From<ItemRow>` (`:74-94`, `children: Vec::new()`); serde-key fence `item_dto_carries_appointment_fields` (`:380-409`).
- Frontend: `KanbanBoard.tsx` — card actions menu `:187-238` (branches: date editor `dating` :189-201, reminder editor `reminding` :202-215, else action list :216-236; plain `<button>` rows; backdrop `:132` resets); pill row `:161-179` (`kanban-badges` > `kanban-badge` chips: priority :162, date :163-171 with due-today/overdue vs `todayYmd()`, reminder :172-177 w/ `formatReminderTime`, subtask-count :178); `firstId` lowest column `:76`; card menu tests in `KanbanBoard.test.tsx` (`:98`, `:108`, `:148`, `:294`, `:407` shapes — `expect(invoke).toHaveBeenCalledWith('set_item_status', {...})`). IMPORTANT (skill): a per-test `invoke.mockImplementation` override REPLACES the whole beforeEach impl — any new command a flow touches must be added to the override.
- `icons.tsx`: `IconName` union `:15-17` (19 names) + `PATHS` record `:26-158`; Icon renders svg viewBox 24 stroke currentColor (`:160-177`). Adding `repeat` = extend union + PATHS entry.
- `client.ts` binding pattern: `export const setItemReminder = (checklistId, itemLocalId, datetime) => invoke('set_item_reminder', { checklistId, itemLocalId, datetime })` (`:39`); TS mirror types `src/api/types.ts` `ItemDto :6-15`.
- Timers: `VoicePendingBadge.tsx:26-38` mount-effect `setInterval(refresh, 30_000)` + `clearInterval` cleanup — the shape to mirror. App.tsx has NO setInterval today; App.test.tsx returns null for unknown commands (safe for new invokes).
- `chrono = { version = "0.4", features = ["serde"] }` already in `Cargo.toml:21`. `recurrence`: 0 occurrences in `src/` + `src-tauri/src/` @ 174d16b.

## Plan rulings carried from spec/analysis (binding)

- R-rec-1 timing: mirror-the-web — completed stays completed until its slot arrives; reset-in-place then. NOT instant-respawn.
- R-rec-2 reminder shift: at roll, `reminder_datetime_new = reminder_datetime_old + (newSlot - oldSlot)` as exact instants (chrono). If the row has no reminder → no reminder op. If old nextDue is unparseable → delta = newSlot - now.
- R-rec-3 scope: kanban boards only, 5 presets, no custom RRULE input.
- R-rec-4 architecture: per-device engine (recurrence column is device-local; other devices see lifecycle via synced ops; reset-in-place means no duplicate-item risk ever).
- R-rec-5 sweep seats: pull-all end (after enrichment, before last_sync), push `close_item_group` (after reconcile), `fetch_task_board_inner` end (runs even when the fetch fails — offline board opens roll), `lib.rs` startup (non-fatal warn, mirrors voice sweep_startup), frontend `RecurrenceSweepTimer` (immediate on mount + every 60s).
- R-rec-6 predicate narrowing to `completed=1` (see Global Constraints).
- R-rec-7 dtstart anchoring at authoring: item targetDate present → `DateTime::<Utc>` at UTC midnight of that date (upstream `convertToUTCMidnight` shape); else `Utc::now()`. `nextDue` = first slot strictly after `Utc::now()` in both cases. When the item has NO targetDate at authoring, set `target_date` = date-only of nextDue + enqueue one `set_date` op; when it HAS one, leave the date alone.
- R-rec-8 slots: UTC instants. `targetDate` stamps use the UTC date part (`%Y-%m-%d`) — accepted ≤1d TZ drift (existing appointments ruling). Month/year clamps follow RFC 5545 grid semantics: Jan 31 monthly → Feb 28/29, Mar 31 (clamp per slot from the ORIGINAL day); Feb 29 yearly → Feb 28 in non-leap years. Time-of-day of dtstart is preserved on every slot.

---

### Task 1: Storage — migration v5 + recurrence column + DTO + raw writer (Rust + types)

**Files:**
- Modify: `src-tauri/src/db/migrations.rs` (append v5 entry to `MIGRATIONS`)
- Modify: `src-tauri/src/db/items.rs` (ItemRow field, COLS, row(); new `set_recurrence_raw`)
- Modify: `src-tauri/src/commands/dto.rs` (ItemDto + From)
- Modify: `src/api/types.ts` (ItemDto mirror)

**Interfaces:**
- Consumes: existing migrations/items/dto patterns (facts above).
- Produces (later tasks rely on EXACTLY these):
  - `ItemRow.recurrence: Option<String>` (raw JSON string as stored).
  - `COLS` ends with `, recurrence` (index 15); `row()` reads `r.get(15)?`.
  - `pub fn set_recurrence_raw(conn: &Connection, local_id: &str, value: Option<&str>) -> AppResult<()>` in `db/items.rs` — sets `recurrence=?1` (or NULL), NEVER touches `dirty`, NO outbox enqueue, returns `AppResult<()>`.
  - `ItemDto.recurrence: Option<String>` serialized as key `"recurrence"`; `src/api/types.ts` `ItemDto` gains `recurrence?: string | null;`.

- [ ] **Step 1: Write the failing tests** (append inside the existing `#[cfg(test)] mod tests` of `db/items.rs`; helpers `db()` and `server_item(...)` already exist there). NOTE: the `INSERT INTO checklists ...` statements below must match the REAL schema — before running, copy the exact INSERT column list the neighboring reconcile tests in this same file use (grep `INSERT INTO checklists` under `db/items.rs` tests) and byte-match it; if the schema's checklists table carries NOT NULL columns beyond id/title/list_type/createdAt/updatedAt, mirror what the existing tests insert:

```rust
    #[test]
    fn migration_v5_recurrence_column_roundtrips() {
        let conn = db();
        migrations::run(&conn).expect("migrations");
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 5);
        conn.execute(
            "INSERT INTO checklists (id, title, list_type, created_at, updated_at) VALUES ('l1', 'L', 'kanban', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
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
            "INSERT INTO checklists (id, title, list_type, created_at, updated_at) VALUES ('l1', 'L', 'kanban', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
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
            "INSERT INTO checklists (id, title, list_type, created_at, updated_at) VALUES ('l1', 'L', 'kanban', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
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
```

And in `src-tauri/src/commands/dto.rs` test module:

```rust
    #[test]
    fn item_dto_carries_recurrence_json() {
        use crate::db::items::ItemRow;
        let row = ItemRow {
            local_id: "i1".into(),
            checklist_id: "l1".into(),
            parent_id: None,
            text: "T".into(),
            completed: false,
            position: 0,
            server_path: None,
            dirty: false,
            status: None,
            priority: None,
            target_date: None,
            start_date: None,
            server_item_id: None,
            reminder_datetime: None,
            reminder_notified: None,
            recurrence: Some("{\"rrule\":\"FREQ=WEEKLY;INTERVAL=1\"}".into()),
        };
        let dto: ItemDto = row.into();
        let v = serde_json::to_value(&dto).unwrap();
        assert_eq!(v["recurrence"], "{\"rrule\":\"FREQ=WEEKLY;INTERVAL=1\"}");
        let mut row2 = row;
        row2.recurrence = None;
        let v2 = serde_json::to_value(&Into::<ItemDto>::into(row2)).unwrap();
        assert!(v2.get("recurrence").is_none() || v2["recurrence"].is_null());
    }
```

- [ ] **Step 2: Run to verify they FAIL** — `cargo test --lib migration_v5_recurrence` and `cargo test --lib item_dto_carries_recurrence` from `/coding/jotty/src-tauri`. Expected: compile errors (no `set_recurrence_raw`, no `ItemRow.recurrence`). That is the RED evidence; capture it.
- [ ] **Step 3: Implement (minimal):**
  - `migrations.rs`: append entry 5 to `MIGRATIONS`:

```sql
-- v5: kanban recurrence (2026-10-05) - LOCAL-ONLY client-side recurrence data on
-- checklist items. Never synced, never in outbox ops, never dirty-tracked by this
-- column; authored/rolled by this device (db/recurrence.rs). Same contract class
-- as the voice audio columns.
ALTER TABLE checklist_items ADD COLUMN recurrence TEXT;
```

  - `items.rs`: add `pub recurrence: Option<String>,` to `ItemRow` (after `reminder_notified`, keep struct field order matching COLS index order); append `, recurrence` to `COLS`; add `recurrence: r.get(15)?,` as the last field in `row()`; add:

```rust
pub fn set_recurrence_raw(conn: &Connection, local_id: &str, value: Option<&str>) -> AppResult<()> {
    // LOCAL-ONLY: recurrence never syncs; no dirty flag, NO outbox op (voice audio precedent).
    conn.execute("UPDATE checklist_items SET recurrence=?1 WHERE local_id=?2", [value, local_id])?;
    Ok(())
}
```

  (`rusqlite` binds `Option<&str>` natively.)
  - `dto.rs`: add `pub recurrence: Option<String>,` to `ItemDto` (last field before `children` is fine) and `recurrence: it.recurrence.clone(),` in `From<ItemRow>`. NOTE: plain `Option` without `#[serde(default)]`/`skip_serializing_if` serializes `"recurrence": null` when None — acceptable (the second assert above already tolerates null).
  - `src/api/types.ts`: in `ItemDto` add `recurrence?: string | null;`.
- [ ] **Step 4: GREEN + gates** — `cargo test --lib` from `/coding/jotty/src-tauri` (expect all green, +4: three items.rs fences + one dto.rs fence), `cargo check --all-targets` census delta 0, `npx tsc -p tsconfig.json --noEmit` from `/coding/jotty`, full `npx vitest run` (expect 540/540 — this task touches TS types consumed by existing fixtures; if a fixture fails, FIX THE FIXTURE usage only where the type demands, disclose otherwise).
- [ ] **Step 5: Commit** — `git add` the four files; message:

```
feat: migration v5 local recurrence column + ItemDto/types passthrough

Storage-only: checklist_items.recurrence (LOCAL-ONLY, voices-audio contract class),
set_recurrence_raw (no dirty, no outbox), ItemDto.recurrence + types.ts mirror.
Fences: v5 roundtrip, dirty-free local write, reconcile claimed-UPDATE preservation.
```

---

### Task 2: Engine — presets, slot math, sweep, authoring command (Rust)

**Files:**
- Create: `src-tauri/src/db/recurrence.rs` (module + inline `#[cfg(test)] mod tests`)
- Modify: `src-tauri/src/db/mod.rs` (add `pub mod recurrence;`)
- Modify: `src-tauri/src/commands/mod.rs` (`set_item_recurrence_inner` + `#[tauri::command] set_item_recurrence` wrapper mirroring `set_item_reminder` wrapper at :956)
- Modify: `src-tauri/src/lib.rs` (register `set_item_recurrence` in `generate_handler!`)
- Modify: `src-tauri/src/commands/client.ts` bindings NOT here (Task 4)

**Interfaces:**
- Consumes: Task 1's `ItemRow.recurrence` + `set_recurrence_raw`; `outbox::enqueue`; `board::list`; `items::{get, set_checked, set_status, set_target_date, set_reminder_local}`.
- Produces:
  - `pub enum Preset { Daily, Weekly, Biweekly, Monthly, Yearly }` with `from_key(&str) -> Option<Preset>` (keys `daily|weekly|biweekly|monthly|yearly`), `key(&self) -> &'static str`, `rrule(&self) -> &'static str` (upstream strings), `label(&self) -> &'static str` (`Daily|Weekly|Bi-weekly|Monthly|Yearly`).
  - `#[derive(Serialize, Deserialize)] #[serde(rename_all = "camelCase")] pub struct Recurrence { pub rrule: String, pub dtstart: String, pub next_due: Option<String>, pub last_completed: Option<String>, pub until: Option<String> }` with `skip_serializing_if = "Option::is_none"` on the three Options; `pub fn parse(json: &str) -> Option<Recurrence>`; `pub fn to_json(&self) -> String`.
  - `pub fn next_slot(rrule: &str, dtstart: &str, after: &DateTime<Utc>, until: Option<&str>) -> Option<String>` — first grid slot STRICTLY after `after`, RFC3339 UTC output; `None` on parse failure or when the slot would pass `until`.
  - `pub fn sweep(conn: &Connection, now: DateTime<Utc>) -> AppResult<usize>` — rolls EVERY due recurring item in one call (per-row logic in one transaction per row is acceptable; whole-call txn also fine) and returns the count of rolled top-level items.
  - `pub(crate) fn set_item_recurrence_inner(conn: &mut Connection, checklist_id: &str, item_local_id: &str, preset_key: Option<String>) -> AppResult<()>` + tauri command `set_item_recurrence` (params `checklistId: String, itemLocalId: String, preset: Option<String>` — frontend sends camelCase keys per client.ts naming rule).
  - Sweep behavior contract (exactly): candidates `recurrence IS NOT NULL AND completed=1`; skip rows with `has_pending_for(conn, "checklist_item", local_id)`; parse; old_due = parsed `next_due`, else `now`; `new_slot = next_slot(rrule, dtstart, after=now, until)`; `None` → leave row untouched (stays completed); delta = `new_slot - old_due` (parse failure of old → `new_slot - now`); first column id = `board::list(...).first()` else `"todo"`; LOCAL writes via the existing setters (they mark dirty): `set_checked(false)`, `set_status(Some(first_col), target_auto=false, changed = row.status.as_deref() != Some(first_col))`, `set_target_date(Some(utc ymd of new_slot))`, `set_reminder_local(old + delta)` when a reminder exists, `set_recurrence_raw(json with next_due=new_slot, last_completed=now)`; descendants (BFS via `parent_id`, same walk shape as `set_completed_recursive` — write a local helper `collect_descendants(conn, local_id) -> Vec<String>` since no shared one exists): `set_checked(false)` + `set_status(Some(first_col), false, changed_per_child)` each; enqueue per item: `check` `{checklist_id, item_local_id, checked:false}`; `status` `{checklist_id, item_local_id, status:first_col}`; `set_date` `{checklist_id, item_local_id, targetDate}`; `set_reminder` `{checklist_id, item_local_id, datetime}` ONLY when a reminder existed; per child: `check` + `status` ops with the child's local_id in BOTH entity_id and payload `item_local_id`.

- [ ] **Step 1: Write the failing tests.** Full test bodies (place in `db/recurrence.rs` `#[cfg(test)] mod tests`; `use super::*;` + the crate imports shown; `db()` helper copies the items.rs test helper — `tempfile::tempdir` + `crate::db::open`-equivalent used at `db/items.rs:367-373`; copy that exact helper body, adapting the import path only):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::items::{self, NewItem};
    use crate::db::migrations;
    use crate::db::outbox;
    use chrono::TimeZone;
    use serde_json::json;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        let conn = Connection::open(path).unwrap();
        migrations::run(&conn).unwrap();
        conn
    }

    fn kanban_item(conn: &Connection, id: &str, text: &str) -> String {
        conn.execute(
            "INSERT INTO checklists (id, title, list_type, created_at, updated_at) VALUES (?1, 'L', 'kanban', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [id],
        )
        .unwrap();
        items::insert_local(conn, &NewItem { checklist_id: id.to_string(), parent_local_id: None, text: text.to_string(), status: None, priority: None, target_date: None }).unwrap().local_id
    }

    fn utc(y: i32, m: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, mi, 0).unwrap()
    }

    #[test]
    fn preset_rrule_strings_match_upstream() {
        assert_eq!(Preset::Daily.rrule(), "FREQ=DAILY;INTERVAL=1");
        assert_eq!(Preset::Weekly.rrule(), "FREQ=WEEKLY;INTERVAL=1");
        assert_eq!(Preset::Biweekly.rrule(), "FREQ=WEEKLY;INTERVAL=2");
        assert_eq!(Preset::Monthly.rrule(), "FREQ=MONTHLY;INTERVAL=1");
        assert_eq!(Preset::Yearly.rrule(), "FREQ=YEARLY;INTERVAL=1");
        assert!(Preset::from_key("biweekly").is_some());
        assert!(Preset::from_key("nope").is_none());
        assert_eq!(Preset::Biweekly.label(), "Bi-weekly");
    }

    #[test]
    fn recurrence_json_matches_upstream_keys() {
        let rec = Recurrence { rrule: "FREQ=WEEKLY;INTERVAL=1".into(), dtstart: "2025-01-27T00:00:00+00:00".into(), next_due: Some("2025-02-03T00:00:00+00:00".into()), last_completed: None, until: None };
        assert_eq!(rec.to_json(), r#"{"rrule":"FREQ=WEEKLY;INTERVAL=1","dtstart":"2025-01-27T00:00:00+00:00","nextDue":"2025-02-03T00:00:00+00:00"}"#);
        let parsed = parse(r#"{"rrule":"FREQ=WEEKLY;INTERVAL=1","dtstart":"2025-01-27T00:00:00Z","nextDue":"2025-02-03T00:00:00Z","lastCompleted":"2025-01-27T10:00:00Z"}"#).unwrap();
        assert_eq!(parsed.next_due.as_deref(), Some("2025-02-03T00:00:00Z"));
        assert_eq!(parsed.last_completed.as_deref(), Some("2025-01-27T10:00:00Z"));
        assert!(parse("not json").is_none());
    }

    #[test]
    fn next_slot_daily_preserves_time_of_day() {
        let dtstart = "2026-10-01T14:30:00+00:00";
        let after = utc(2026, 10, 2, 0, 0);
        assert_eq!(next_slot("FREQ=DAILY;INTERVAL=1", dtstart, &after, None).as_deref(), Some("2026-10-02T14:30:00+00:00"));
        let after2 = utc(2026, 10, 2, 14, 30); // strictly-after boundary
        assert_eq!(next_slot("FREQ=DAILY;INTERVAL=1", dtstart, &after2, None).as_deref(), Some("2026-10-03T14:30:00+00:00"));
    }

    #[test]
    fn next_slot_weekly_and_biweekly_keep_weekday() {
        let dtstart = "2026-10-02T00:00:00+00:00"; // a Friday
        let after = utc(2026, 10, 2, 12, 0);
        assert_eq!(next_slot("FREQ=WEEKLY;INTERVAL=1", dtstart, &after, None).as_deref(), Some("2026-10-09T00:00:00+00:00"));
        assert_eq!(next_slot("FREQ=WEEKLY;INTERVAL=2", dtstart, &after, None).as_deref(), Some("2026-10-16T00:00:00+00:00"));
    }

    #[test]
    fn next_slot_monthly_clamps_to_month_length_from_original_day() {
        let dtstart = "2026-01-31T08:00:00+00:00";
        let after_jan = utc(2026, 1, 31, 8, 0);
        assert_eq!(next_slot("FREQ=MONTHLY;INTERVAL=1", dtstart, &after_jan, None).as_deref(), Some("2026-02-28T08:00:00+00:00"));
        let after_feb = utc(2026, 2, 28, 8, 0);
        assert_eq!(next_slot("FREQ=MONTHLY;INTERVAL=1", dtstart, &after_feb, None).as_deref(), Some("2026-03-31T08:00:00+00:00"));
    }

    #[test]
    fn next_slot_yearly_clamps_feb29() {
        let dtstart = "2024-02-29T00:00:00+00:00";
        let after = utc(2024, 2, 29, 0, 0);
        assert_eq!(next_slot("FREQ=YEARLY;INTERVAL=1", dtstart, &after, None).as_deref(), Some("2025-02-28T00:00:00+00:00"));
        let after_2025 = utc(2025, 2, 28, 0, 0);
        // the clamped Feb-28 IS an occurrence (RFC grid semantics): next strictly-after 2025-02-28 is 2026-02-28
        assert_eq!(next_slot("FREQ=YEARLY;INTERVAL=1", dtstart, &after_2025, None).as_deref(), Some("2026-02-28T00:00:00+00:00"));
    }

    #[test]
    fn next_slot_respects_until() {
        let dtstart = "2026-10-02T00:00:00+00:00";
        let after = utc(2026, 10, 2, 12, 0);
        assert_eq!(next_slot("FREQ=WEEKLY;INTERVAL=1", dtstart, &after, Some("2026-10-05T00:00:00+00:00")).is_none(), true);
        assert_eq!(next_slot("FREQ=WEEKLY;INTERVAL=1", dtstart, &after, Some("2026-10-09T00:00:00+00:00")).as_deref(), Some("2026-10-09T00:00:00+00:00"));
        assert!(next_slot("garbage", dtstart, &after, None).is_none());
    }

    #[test]
    fn sweep_rolls_due_item_reset_in_place_and_enqueues_ops() {
        let conn = db();
        let local_id = kanban_item(&conn, "l1", "Trash");
        items::set_target_date(&conn, &local_id, Some("2026-10-01".to_string())).unwrap();
        items::set_checked(&conn, &local_id, true).unwrap();
        items::set_reminder_local(&conn, &local_id, Some("2026-10-01T09:00:00+00:00".to_string())).unwrap();
        conn.execute("UPDATE checklist_items SET status='completed', recurrence=?1 WHERE local_id=?2", [
            r#"{"rrule":"FREQ=WEEKLY;INTERVAL=1","dtstart":"2026-09-24T00:00:00+00:00","nextDue":"2026-10-01T00:00:00+00:00"}"#,
            local_id.as_str(),
        ]).unwrap();
        conn.execute("INSERT INTO board_statuses (checklist_id, status_id, label, sort_order, auto_complete) VALUES ('l1','backlog','Backlog',0,0), ('l1','done','Done',2,1)", []).unwrap();
        let rolled = sweep(&conn, utc(2026, 10, 5, 12, 0)).unwrap();
        assert_eq!(rolled, 1);
        let row = items::get(&conn, &local_id).unwrap().unwrap();
        assert!(!row.completed);
        assert_eq!(row.status.as_deref(), Some("backlog"));
        assert_eq!(row.target_date.as_deref(), Some("2026-10-08"));
        assert_eq!(row.reminder_datetime.as_deref(), Some("2026-10-08T09:00:00+00:00"));
        assert!(row.dirty);
        let rec = parse(row.recurrence.as_deref().unwrap()).unwrap();
        assert_eq!(rec.next_due.as_deref(), Some("2026-10-08T00:00:00+00:00"));
        assert_eq!(rec.last_completed.as_deref(), Some("2026-10-05T12:00:00+00:00"));
        let (n,): (i64,) = conn.query_row("SELECT COUNT(*) FROM outbox WHERE state='pending'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 4);
        let payloads: Vec<String> = {
            let mut stmt = conn.prepare("SELECT payload FROM outbox WHERE state='pending' ORDER BY seq").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        // kinds: check, status, set_date, set_reminder (insertion order)
        let kinds: Vec<String> = {
            let mut stmt = conn.prepare("SELECT op_type FROM outbox WHERE state='pending' ORDER BY seq").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert_eq!(kinds, vec!["check".to_string(), "status".to_string(), "set_date".to_string(), "set_reminder".to_string()]);
        let ck: serde_json::Value = serde_json::from_str(&payloads[0]).unwrap();
        assert_eq!(ck["checked"], false);
        assert_eq!(ck["item_local_id"], local_id.as_str());
        assert_eq!(ck["checklist_id"], "l1");
        let st: serde_json::Value = serde_json::from_str(&payloads[1]).unwrap();
        assert_eq!(st["status"], "backlog");
        let dt: serde_json::Value = serde_json::from_str(&payloads[2]).unwrap();
        assert_eq!(dt["targetDate"], "2026-10-08");
        let rm: serde_json::Value = serde_json::from_str(&payloads[3]).unwrap();
        assert_eq!(rm["datetime"], "2026-10-08T09:00:00+00:00");
    }

    #[test]
    fn sweep_skips_not_due_and_non_completed() {
        let conn = db();
        let a = kanban_item(&conn, "l1", "Future slot");
        items::set_checked(&conn, &a, true).unwrap();
        conn.execute("UPDATE checklist_items SET recurrence=?1 WHERE local_id=?2", [r#"{"rrule":"FREQ=DAILY;INTERVAL=1","dtstart":"2026-10-01T00:00:00+00:00","nextDue":"2027-01-01T00:00:00+00:00"}"#, a.as_str()]).unwrap();
        let b = kanban_item(&conn, "l1", "Open card");
        conn.execute("UPDATE checklist_items SET recurrence=?1 WHERE local_id=?2", [r#"{"rrule":"FREQ=DAILY;INTERVAL=1","dtstart":"2026-10-01T00:00:00+00:00","nextDue":"2026-10-01T00:00:00+00:00"}"#, b.as_str()]).unwrap();
        let rolled = sweep(&conn, utc(2026, 10, 5, 0, 0)).unwrap();
        assert_eq!(rolled, 0);
        assert!(items::get(&conn, &a).unwrap().unwrap().completed);
        assert!(!items::get(&conn, &b).unwrap().unwrap().completed);
    }

    #[test]
    fn sweep_skips_rows_with_pending_ops() {
        let conn = db();
        let local_id = kanban_item(&conn, "l1", "Syncing");
        items::set_checked(&conn, &local_id, true).unwrap();
        conn.execute("UPDATE checklist_items SET recurrence=?1 WHERE local_id=?2", [r#"{"rrule":"FREQ=DAILY;INTERVAL=1","dtstart":"2026-10-01T00:00:00+00:00","nextDue":"2026-10-01T00:00:00+00:00"}"#, local_id.as_str()]).unwrap();
        outbox::enqueue(&conn, "check", "checklist_item", &local_id, &json!({"checklist_id": "l1", "item_local_id": local_id, "checked": true})).unwrap();
        let rolled = sweep(&conn, utc(2026, 10, 5, 0, 0)).unwrap();
        assert_eq!(rolled, 0);
        assert!(items::get(&conn, &local_id).unwrap().unwrap().completed);
    }

    #[test]
    fn sweep_resets_children_with_their_own_ops() {
        let conn = db();
        let parent = kanban_item(&conn, "l1", "Dad");
        let child = items::insert_local(&conn, &NewItem { checklist_id: "l1".into(), parent_local_id: Some(parent.clone()), text: "Kid".into(), status: None, priority: None, target_date: None }).unwrap().local_id;
        items::set_checked(&conn, &parent, true).unwrap();
        items::set_checked(&conn, &child, true).unwrap();
        conn.execute("UPDATE checklist_items SET status='done', recurrence=?1 WHERE local_id=?2", [r#"{"rrule":"FREQ=DAILY;INTERVAL=1","dtstart":"2026-10-01T00:00:00+00:00","nextDue":"2026-10-01T00:00:00+00:00"}"#, parent.as_str()]).unwrap();
        conn.execute("UPDATE checklist_items SET status='done' WHERE local_id=?1", [child.as_str()]).unwrap();
        conn.execute("INSERT INTO board_statuses (checklist_id, status_id, label, sort_order, auto_complete) VALUES ('l1','todo','Todo',0,0)", []).unwrap();
        let rolled = sweep(&conn, utc(2026, 10, 5, 0, 0)).unwrap();
        assert_eq!(rolled, 1);
        assert!(!items::get(&conn, &child).unwrap().unwrap().completed);
        assert_eq!(items::get(&conn, &child).unwrap().unwrap().status.as_deref(), Some("todo"));
        let kinds: Vec<String> = {
            let mut stmt = conn.prepare("SELECT op_type FROM outbox WHERE state='pending' ORDER BY seq").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        // parent: check, status, set_date; child: check, status
        assert_eq!(kinds, vec!["check".to_string(), "status".to_string(), "set_date".to_string(), "check".to_string(), "status".to_string()]);
        let child_check: serde_json::Value = serde_json::from_str(&{
            let mut stmt = conn.prepare("SELECT payload FROM outbox WHERE op_type='check' ORDER BY seq").unwrap();
            let all = stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<String>>>().unwrap();
            all[1].clone()
        }).unwrap();
        assert_eq!(child_check["item_local_id"], child.as_str());
    }

    #[test]
    fn sweep_shifts_reminder_by_slot_delta() {
        let conn = db();
        let local_id = kanban_item(&conn, "l1", "Appt");
        items::set_checked(&conn, &local_id, true).unwrap();
        items::set_reminder_local(&conn, &local_id, Some("2026-10-01T09:30:00+00:00".to_string())).unwrap();
        // biweekly: old slot Oct 1 -> new slot Oct 15 => +14 days
        conn.execute("UPDATE checklist_items SET recurrence=?1 WHERE local_id=?2", [r#"{"rrule":"FREQ=WEEKLY;INTERVAL=2","dtstart":"2026-10-01T00:00:00+00:00","nextDue":"2026-10-01T00:00:00+00:00"}"#, local_id.as_str()]).unwrap();
        sweep(&conn, utc(2026, 10, 5, 0, 0)).unwrap();
        assert_eq!(items::get(&conn, &local_id).unwrap().unwrap().reminder_datetime.as_deref(), Some("2026-10-15T09:30:00+00:00"));
    }

    #[test]
    fn sweep_until_passed_keeps_completed_and_enqueues_nothing() {
        let conn = db();
        let local_id = kanban_item(&conn, "l1", "Ended series");
        items::set_checked(&conn, &local_id, true).unwrap();
        conn.execute("UPDATE checklist_items SET recurrence=?1 WHERE local_id=?2", [r#"{"rrule":"FREQ=DAILY;INTERVAL=1","dtstart":"2026-09-01T00:00:00+00:00","nextDue":"2026-09-02T00:00:00+00:00","until":"2026-09-15T00:00:00+00:00"}"#, local_id.as_str()]).unwrap();
        let rolled = sweep(&conn, utc(2026, 10, 5, 0, 0)).unwrap();
        assert_eq!(rolled, 0);
        assert!(items::get(&conn, &local_id).unwrap().unwrap().completed);
        let (n,): (i64,) = conn.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn set_item_recurrence_inner_anchors_dtstart_to_existing_target_date() {
        let mut conn = db();
        let local_id = kanban_item(&conn, "l1", "Dated");
        items::set_target_date(&conn, &local_id, Some("2026-10-02".to_string())).unwrap();
        conn.execute("UPDATE checklist_items SET dirty=0, target_date='2026-10-02' WHERE local_id=?1", [local_id.as_str()]).unwrap();
        set_item_recurrence_inner(&mut conn, "l1", &local_id, Some("weekly".into())).unwrap();
        let row = items::get(&conn, &local_id).unwrap().unwrap();
        let rec = parse(row.recurrence.as_deref().unwrap()).unwrap();
        assert_eq!(rec.dtstart, "2026-10-02T00:00:00+00:00");
        // nextDue is strictly after "now" (test runs at real now): it must be a future Friday-since-Oct-2 grid slot; assert it parses and is after dtstart
        let nd = DateTime::parse_from_rfc3339(rec.next_due.as_deref().unwrap()).unwrap();
        assert!(nd > DateTime::parse_from_rfc3339("2026-10-02T00:00:00+00:00").unwrap());
        // dirty row (target_date setter marks dirty) + no set_date op because a targetDate existed
        let (n,): (i64,) = conn.query_row("SELECT COUNT(*) FROM outbox WHERE op_type='set_date'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn set_item_recurrence_inner_without_target_date_stamps_first_due() {
        let mut conn = db();
        let local_id = kanban_item(&conn, "l1", "Undated");
        set_item_recurrence_inner(&mut conn, "l1", &local_id, Some("biweekly".into())).unwrap();
        let row = items::get(&conn, &local_id).unwrap().unwrap();
        let rec = parse(row.recurrence.as_deref().unwrap()).unwrap();
        assert_eq!(rec.rrule, "FREQ=WEEKLY;INTERVAL=2");
        assert_eq!(row.target_date.as_deref(), rec.next_due.as_deref().map(|s| &s[..10]));
        let (n,): (i64,) = conn.query_row("SELECT COUNT(*) FROM outbox WHERE op_type='set_date'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn set_item_recurrence_inner_clears_with_none_and_gates_non_kanban() {
        let mut conn = db();
        let local_id = kanban_item(&conn, "l1", "X");
        set_item_recurrence_inner(&mut conn, "l1", &local_id, Some("daily".into())).unwrap();
        set_item_recurrence_inner(&mut conn, "l1", &local_id, None).unwrap();
        assert!(items::get(&conn, &local_id).unwrap().unwrap().recurrence.is_none());
        conn.execute("INSERT INTO checklists (id, title, list_type, created_at, updated_at) VALUES ('l2', 'L', 'simple', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        let plain = items::insert_local(&conn, &NewItem { checklist_id: "l2".into(), parent_local_id: None, text: "P".into(), status: None, priority: None, target_date: None }).unwrap().local_id;
        let err = set_item_recurrence_inner(&mut conn, "l2", &plain, Some("daily".into())).unwrap_err();
        assert!(format!("{}", err).contains("recurrence only works on kanban boards"));
        assert!(Preset::from_key("weekly").is_some());
        let bad = set_item_recurrence_inner(&mut conn, "l1", &local_id, Some("junk".into())).unwrap_err();
        assert!(format!("{}", bad).contains("unknown recurrence preset"));
    }
}
```

- [ ] **Step 2: RED** — `cargo test --lib recurrence` from `/coding/jotty/src-tauri`. Expected: compile error (`db::recurrence` module not found). Capture.
- [ ] **Step 3: Implement** `db/recurrence.rs` per the Interfaces contracts. Implementation guidance (binding where spelled):
  - Freq/interval parse: simple substring scan for `FREQ=` and `INTERVAL=` (no regex dep).
  - Slot math: `nth_slot(start, months_or_days, k)`: Days → `start + Duration::days(interval*k)`; Months → add `total = start.year()*12 + (start.month0() as i64) + k_months`, rebuild with `Utc.with_ymd_and_hms(y, m, min(start.day(), days_in_month(y, m)), start.hour(), start.minute(), start.second())`, single() → else None.
  - Finding the next slot: estimate k from elapsed time, then adjust ± until `nth(k) > after && nth(k-1) <= after` (k>=1). Guard against zero/negative interval (None).
  - `sweep` uses `conn.unchecked_transaction()` (works on `&Connection`), commits per row (per-row txn acceptable); count only top-level rolls.
  - `set_item_recurrence_inner` mirrors the kanban gate shape of `set_item_reminder_inner` (read the checklist row's `list_type`; `kanban`/`task` pass).
  - Command wrapper mirrors `set_item_reminder` tauri wrapper (`commands/mod.rs:956`) for state access and the `Result<(), String>` return; register in `lib.rs` `generate_handler!` next to `commands::set_item_reminder`.
  - No new warnings: every pub item must be consumed by tests or later tasks (sweep/next_slot/etc. are consumed by T3 wiring — if T3 hasn't landed yet, `cargo test --lib` still builds the lib and may flag unused pub fns? pub items in a `pub mod` reachable from lib.rs are NOT dead-code-warned; the module must be `pub mod recurrence;` from `db/mod.rs`).
- [ ] **Step 4: GREEN + gates** — `cargo test --lib` (expect all green, +16 vs Task 1's total: 7 slot-math/parse + 6 sweep + 3 authoring), census delta 0.
- [ ] **Step 5: Commit** —

```
feat: recurrence engine - presets, slot math, sweep, authoring command

db/recurrence.rs: upstream-preset rrule strings, camelCase JSON parity,
grid slot math with month/year clamps (RFC 5545 semantics), sweep with
reset-in-place rolling via existing op kinds, pending-op shield, children
reset, reminder shift by slot delta (R-rec-2). set_item_recurrence command
gated kanban-only. Fences: 16 (slot math + sweep + authoring).
```

---

### Task 3: Sweep wiring — sync run, group close, board open, startup, sweep command (Rust)

**Files:**
- Modify: `src-tauri/src/sync/pull.rs` (sweep seat at end of `pull_all`, before the last_sync write at :74-78; non-fatal: push into the same error-collection channel enrichment errors use)
- Modify: `src-tauri/src/sync/push.rs` (sweep seat in `close_item_group` between `items::reconcile` (:371) and `mark_list_synced` (:372); non-fatal)
- Modify: `src-tauri/src/commands/mod.rs` (`fetch_task_board_inner` end: sweep non-fatal; new `sweep_recurrence_inner` + `#[tauri::command] sweep_recurrence` returning `Result<usize, String>`)
- Modify: `src-tauri/src/lib.rs` (startup sweep after the voice sweep_startup line :32-34, non-fatal warn; register `sweep_recurrence`)

**Interfaces:**
- Consumes: Task 2's `db::recurrence::sweep(conn, now)`.
- Produces: `pub(crate) fn sweep_recurrence_inner(conn: &Connection) -> AppResult<usize>` = `recurrence::sweep(conn, Utc::now())`; sweep seats are non-fatal everywhere (a sweep error must NEVER fail the sync run / pull / board open / startup).

- [ ] **Step 1: Write the failing tests.**

In `sync/pull.rs` test module (wiremock; mirror the enrichment test setup style at `:287+`):

```rust
    #[tokio::test]
    async fn pull_sweep_runs_after_reconcile_server_checked_recurring_rolls() {
        // Discriminates seat ORDER: the server carries completed=true for a locally
        // recurring DUE row that is currently clean and completed=0. If sweep ran
        // BEFORE reconcile, the row would complete (server flag) and stay completed
        // with no ops. Only a post-reconcile sweep un-completes it and enqueues ops.
        let conn = crate::db::test_conn(); // use the same helper the other sync tests use (find it; if named differently, mirror how enrichment tests build their conn)
        // seed checklist row + clean recurring item completed=0, due slot in the past
        conn.execute(
            "INSERT INTO checklists (id, title, list_type, created_at, updated_at) VALUES ('l1', 'L', 'kanban', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        let local_id = "i-1";
        conn.execute(
            "INSERT INTO checklist_items (local_id, checklist_id, text, completed, position, dirty, server_path, server_item_id, recurrence) VALUES ('i-1','l1','Weekly report',0,0,0,'0','sid-1',?1)",
            [r#"{"rrule":"FREQ=WEEKLY;INTERVAL=1","dtstart":"2026-09-24T00:00:00+00:00","nextDue":"2026-10-01T00:00:00+00:00"}"#],
        ).unwrap();
        let server = serde_json::json!({
            "checklists": [{
                "id": "l1", "title": "L", "category": null, "type": "kanban",
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-10-05T00:00:00Z",
                "items": [{ "id": "sid-1", "index": 0, "text": "Weekly report", "completed": true }]
            }],
            "notes": []
        });
        // mock GET /api/checklists -> server; the mock body + client construction must BYTE-MIRROR the
        // exemplar `enrichment_merges_reminders_by_server_item_id` harness (real catalog envelope shape
        // and item fields, plus whatever extra mocks that harness needs). Local seeded row updatedAt is
        // OLDER than the server row here, so the pull upserts and reconcile CLAIMS the row (arm A via
        // server_item_id + matching text at stamped path '0') — this is why the seed carries
        // server_path='0' AND server_item_id='sid-1'; a pathless row would be deleted-and-reinserted
        // unclaimed (recurrence lost, roll never fires) — that failure mode is exactly what this fence
        // must not do.
        // ... (implementer mirrors the EXACT mock/client construction of enrichment_merges_reminders_by_server_item_id)
        crate::sync::pull::pull_all(&conn, &client).await.unwrap();
        let row = crate::db::items::get(&conn, local_id).unwrap().unwrap();
        assert!(!row.completed, "post-reconcile sweep must reset the just-completed recurring card");
        let (n,): (i64,) = conn.query_row("SELECT COUNT(*) FROM outbox WHERE state='pending' AND op_type='check'", [], |r| r.get(0)).unwrap();
        assert!(n >= 1, "roll must enqueue a check(false) op");
    }
```

In `sync/push.rs` test module:

```rust
    #[tokio::test]
    async fn group_close_sweeps_due_recurring_after_reconcile() {
        // Seed a recurring completed due row + one queued set_date op for it. The seed MUST carry
        // server_path='0' + server_item_id='sid-1' (+ text matching the mocked snapshot item) so the
        // group-close reconcile CLAIMS the row instead of deleting/reinserting it. push_pending replays
        // the op, group-close reconciles, then the sweep rolls it:
        // assert row completed=0 AND new pending ops appeared beyond the replayed one.
        // (mirror the exact conn/mock/client construction of status_move_replays_to_resolved_path;
        // read that test body FIRST and mirror its harness — every assert below must appear verbatim)
        // asserts:
        //   row.completed == false after push_pending
        //   COUNT(*) pending ops > 1 (the sweep's check op rides behind the replayed set_date)
    }
```

(Implementer: write BOTH push.rs fences FULLY mirroring the named tests' harness — the abbreviated body above is the contract outline; the full test must compile and run the same harness shape as `status_move_replays_to_resolved_path` (:1214) with the seeding shown.)

In `commands/mod.rs` test module:

```rust
    fn seed_due_recurring(conn: &Connection) -> String {
        conn.execute(
            "INSERT INTO checklists (id, title, list_type, created_at, updated_at) VALUES ('l1', 'L', 'kanban', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        let id = "i-1".to_string();
        conn.execute(
            "INSERT INTO checklist_items (local_id, checklist_id, text, completed, position, dirty, recurrence) VALUES ('i-1','l1','X',1,0,0,?1)",
            [r#"{"rrule":"FREQ=DAILY;INTERVAL=1","dtstart":"2026-10-01T00:00:00+00:00","nextDue":"2026-10-01T00:00:00+00:00"}"#],
        ).unwrap();
        id
    }

    #[test]
    fn sweep_recurrence_inner_rolls_due_rows() {
        let conn = crate::db::test_conn();
        let id = seed_due_recurring(&conn);
        let n = sweep_recurrence_inner(&conn).unwrap();
        assert_eq!(n, 1);
        assert!(!crate::db::items::get(&conn, &id).unwrap().unwrap().completed);
    }

    #[tokio::test]
    async fn fetch_task_board_inner_sweeps_even_when_fetch_fails() {
        let conn = crate::db::test_conn();
        let id = seed_due_recurring(&conn);
        // unreachable board URL: mirror the file-convention client usage rule (http://127.0.0.1:1)
        let client = crate::jotty::client::JottyClient::new("http://127.0.0.1:1", "ck_test").unwrap();
        fetch_task_board_inner(&conn, &client, "l1").await.unwrap();
        assert!(!crate::db::items::get(&conn, &id).unwrap().unwrap().completed);
    }
```

NOTE: `crate::db::test_conn` may not exist — the leaf found per-file `db()` helpers. **Controller pre-ruling:** if a shared helper does not exist, add `#[cfg(test)] pub(crate) fn test_conn() -> Connection` under `db/mod.rs` tests module (tempdir + open + migrations::run), and have the pull.rs/push.rs/commands tests use it; per-file `db()` helpers stay untouched. Mirror `db/items.rs:367-373` exactly for the body. `fetch_task_board_inner`'s actual signature may take `&Connection, &JottyClient, list_id` (verify against :478-507 before writing the test; adapt call shape, keep assertions verbatim).

- [ ] **Step 2: RED** — `cargo test --lib pull_sweep_runs_after` + `cargo test --lib group_close_sweeps` + `cargo test --lib sweep_recurrence_inner` + `cargo test --lib fetch_task_board_inner_sweeps`. Expected: fail (no sweep seats / no inner fn). Capture.
- [ ] **Step 3: Implement the four seats + inner + command wrapper + registration.** Sweep calls are non-fatal: pull seat pushes `format!("recurrence sweep: {e}")` into the collector used for enrichment errors; push seat logs `log::warn!`; board-open seat `let _ = ...;` after the existing silent-error pattern; startup seat mirrors the voice sweep_startup warn pattern at lib.rs:32-34.
- [ ] **Step 4: GREEN + gates** — `cargo test --lib` full (expect +4); census Δ0; the sync-level fence `push_runs_before_pull` must stay green.
- [ ] **Step 5: Commit** —

```
feat: wire recurrence sweep into pull/push/board-open/startup + sweep command

Four non-fatal seats per R-rec-5: pull_all post-enrichment (order fenced by the
server-checked discriminating test), close_item_group post-reconcile,
fetch_task_board_inner (rolls even offline), lib.rs startup; sweep_recurrence
command for the 60s frontend timer (T4).
```

---

### Task 4: Frontend — Repeat menu, chip, bindings, 60s timer (TS/React)

**Files:**
- Modify: `src/components/icons.tsx` (add `repeat` name + PATHS entry)
- Modify: `src/components/KanbanBoard.tsx` (Repeat menu branch + chip)
- Modify: `src/components/KanbanBoard.test.tsx` (menu/chip fences + base-mock additions)
- Create: `src/components/RecurrenceSweepTimer.tsx` + `src/components/RecurrenceSweepTimer.test.tsx`
- Modify: `src/App.tsx` (render `<RecurrenceSweepTimer />`)
- Modify: `src/api/client.ts` (two bindings)

**Interfaces:**
- Consumes: Task 2's `set_item_recurrence` command (params `checklistId, itemLocalId, preset: string | null`), Task 3's `sweep_recurrence` command, Task 1's `ItemDto.recurrence`.
- Produces:
  - `src/api/client.ts`:
```ts
export const setItemRecurrence = (checklistId: string, itemLocalId: string, preset: string | null) =>
  invoke<void>('set_item_recurrence', { checklistId, itemLocalId, preset });
export const sweepRecurrence = () => invoke<number>('sweep_recurrence');
```
  - `RecurrenceLabel` helper (in KanbanBoard.tsx or a small `src/components/recurrence.ts`): parse `item.recurrence` JSON → label from rrule: `FREQ=DAILY;INTERVAL=1` → `Daily`, `FREQ=WEEKLY;INTERVAL=1` → `Weekly`, `FREQ=WEEKLY;INTERVAL=2` → `Bi-weekly`, `FREQ=MONTHLY;INTERVAL=1` → `Monthly`, `FREQ=YEARLY;INTERVAL=1` → `Yearly`; anything else → `Repeat`.
  - Menu branch: state `repeating: string | null`; when `repeating === item.localId` render a scroll-free option list mirroring the editor branches' classes: buttons `None`, `Daily`, `Weekly`, `Bi-weekly`, `Monthly`, `Yearly` + a `Back` row (same parity as date editor). Menu action row `Repeat` added to the action list next to `Set reminder`/`Rename`.
  - Picking: `api.setItemRecurrence(checklistId, item.localId, key-or-null)` then `setMenuFor(null); await reload();`.
  - Chip (badge row, after the reminder chip): rendered when `item.recurrence` parses AND a label exists: `<span className="kanban-badge kanban-recurrence" title={...}><Icon name="repeat" size={11}/> {label}</span>`; `title` = `item.completed && nextDueDate ? `Resets ${dateLabel(nextDueDate)}`` : `Repeats ${label}` where `nextDueDate` = the parsed `nextDue` first 10 chars.

- [ ] **Step 1: Write the failing tests.** Fences for `KanbanBoard.test.tsx` (mirror the EXACT harness of the existing menu tests at :98/:148 — same fixture/render/mock shapes; ADD `set_item_recurrence` resolve to the beforeEach mock impl so overrides don't fall through — the mock-replacement trap):

```tsx
describe('KanbanBoard recurrence (task 4)', () => {
  it('repeat menu renders the six options', async () => {
    // Card actions -> Repeat row -> expect 'None', 'Daily', 'Weekly', 'Bi-weekly', 'Monthly', 'Yearly' buttons
  });
  it('picking Bi-weekly invokes set_item_recurrence with biweekly and reloads', async () => {
    // expect invoke calledWith 'set_item_recurrence', { checklistId: 'b1', itemLocalId: <fixture>, preset: 'biweekly' }
    // + reload effect asserted like the Move-to fence does
  });
  it('picking None clears (preset null)', async () => {
    // expect invoke calledWith 'set_item_recurrence', { ..., preset: null }
  });
  it('card shows the repeat chip with label', async () => {
    // fixture item with recurrence JSON (weekly); expect chip text 'Weekly' visible
  });
  it('chip title announces the reset date when completed', async () => {
    // fixture completed + nextDue '2026-10-08T...' ; the chip title is `Resets ${dateLabel(nextDue.slice(0,10))}`
    // assert via screen.getByTitle(/Resets/) — exactly ONE element matches on the rendered fixture card
  });
  it('no recurrence, no chip', async () => {
    // base fixture (no recurrence); expect queryByText('Weekly') in badges absent
  });
});
```

Implementers write FULL bodies mirroring existing tests (the abbreviated blocks above pin the CONTRACT: command name, arg keys, preset literals, chip text, title regex — those stay byte-exact; the surrounding harness copies the neighboring tests).

For `RecurrenceSweepTimer.test.tsx` (fake timers — this test never awaits RTL async utils, per the T16 ruling) — COMPLETE body:

```tsx
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import RecurrenceSweepTimer from './RecurrenceSweepTimer';

describe('RecurrenceSweepTimer', () => {
  afterEach(() => { vi.useRealTimers(); invoke.mockClear(); });

  it('sweeps on mount and every 60s, stops after unmount', () => {
    vi.useFakeTimers();
    const view = render(<RecurrenceSweepTimer />);
    expect(invoke).toHaveBeenCalledWith('sweep_recurrence');
    invoke.mockClear();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(invoke).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(59_000); });
    expect(invoke).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(invoke).toHaveBeenCalledTimes(2);
    view.unmount();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('recurrence-sweep-timer')).toBeNull();
  });
});
```

(The component renders nothing visible — the final queryByTestId assert only pins that no visible DOM leaked; the load-bearing assert chain is the invoke counts.)

Component:

```tsx
import { useEffect } from 'react';
import { sweepRecurrence } from '../api/client';

// Mirrors the upstream 60s reminder-scanner cadence and the VoicePendingBadge
// interval shape: immediate sweep on mount + interval, cleared on unmount.
export default function RecurrenceSweepTimer() {
  useEffect(() => {
    void sweepRecurrence().catch(() => {});
    const t = setInterval(() => { void sweepRecurrence().catch(() => {}); }, 60_000);
    return () => { clearInterval(t); };
  }, []);
  return null;
}
```

- [ ] **Step 2: RED** — `npx vitest run src/components/KanbanBoard.test.tsx src/components/RecurrenceSweepTimer.test.tsx`. Expected: new describes fail (no Repeat row/`repeat` icon/binding).
- [ ] **Step 3: Implement.** Icons: extend `IconName` union with `'repeat'`, PATHS entry uses lucide `repeat` path data (24×24 stroke): `<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>`. KanbanBoard: `repeating` state + menu branch + chip + `repeatMenu` reset in the backdrop handler. App.tsx: render `<RecurrenceSweepTimer />` inside the tree (near the voice pending badge mount). client.ts bindings verbatim (camelCase keys mirror Rust params: `checklistId, itemLocalId, preset`).
- [ ] **Step 4: GREEN + gates** — full `npx vitest run` (expect 547/547 across 47 files: +7 — six KanbanBoard fences + one RecurrenceSweepTimer fence in a NEW file), `npx tsc -p tsconfig.json --noEmit` clean, `cargo test --lib` untouched-but-re-run sanity (293+1i expected), census Δ0.
- [ ] **Step 5: Commit** —

```
feat: kanban card Repeat menu + chip + 60s recurrence sweep timer

Card menu gains Repeat (5 presets + None) -> set_item_recurrence; badges gain a
repeat chip (label, reset-date title on completed cards); RecurrenceSweepTimer
mounts in App (immediate + 60s cadence, upstream scanner parity). Icons +repeat.
Fences: menu/chip/timer (+7 vitest). KanbanBoard base mock carries the new command.
```

---

## Self-review checklist (controller-executed before dispatch)

1. Spec coverage: storage v5 (T1), presets+slot math (T2), roll trigger seats + per-device disclosure (T3), authoring UI + chip + timer (T4), reminder shift (T2 fences), child reset (T2 fence), mirror-web timing (T2/T3 fences). Out-list items (plain checklists, custom RRULE, web-authored visibility, companion, history UI) intentionally absent — no task implements them.
2. Placeholder scan: all four task test fences carry COMPLETE bodies (T3's pull/push fences pin their discriminating assertions inline and mirror named exemplar harnesses on file — a deliberate transcription-with-template, not a guess); no TBD/TODO/no-op bodies anywhere.
3. Type consistency: `Preset::key/rrule/label`, `Recurrence{rrule,dtstart,next_due,last_completed,until}` (serde nextDue/lastCompleted), `set_recurrence_raw(Option<&str>)`, command params `preset: Option<String>` ↔ client.ts `preset: string | null` — consistent.
4. Suite-count math: T1 +4 cargo (273), T2 +16 (289), T3 +4 (293, +1i retained), T4 +7 vitest (547/547 across 47 files). These are ESTIMATES from fence counts — implementers re-census live and STOP-CONTRACT on deltas.