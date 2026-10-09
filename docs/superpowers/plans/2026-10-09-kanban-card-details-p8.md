# Plan — P8: Kanban card detail editing (2 tasks)

**Spec:** docs/superpowers/specs/2026-10-09-kanban-card-details-p8-design.md
**Wire facts:** skills/software-development/jotty-client/references/jotty-kanban-p8p9-wire-facts.md (live-probed 1.28.0 2026-10-09)
**Run ledger:** .superpowers/sdd/2026-10-09-kanban-card-details-p8/progress.md
**BASE at dispatch:** c25e7b7 (P10 keystore feature). No package build anywhere in this run.

## Global constraints (every task)

- TDD law: RED first, watched, per task; vertical tracer per slice.
- Gates: `cargo test --lib --manifest-path src-tauri/Cargo.toml` (349+1i baseline),
  `cargo check --all-targets --manifest-path src-tauri/Cargo.toml` (census **18**, delta 0),
  vitest/tsc for frontend tasks (`npx vitest run` 636/636 across 54 files baseline;
  `npx tsc -p tsconfig.json --noEmit` clean). NEVER route gate output through head/tail.
  Every cargo invocation carries `--manifest-path src-tauri/Cargo.toml`. DISPLAY=:99 rides
  cargo test only. NO cargo fmt. Zero NEW warnings.
- Repo-local commits: `git -c user.name=zeus -c user.email=zeus@local commit`; stage
  explicit paths, never `git add -A`. Push after controller merge only.
- Sync invariants (SKILL.md §§ync): every local mutation = ONE tx (row write + outbox
  enqueue). Item-op replay resolves via snapshot + TEXT-VERIFIED resolver
  (resolve_item_target, check-op class). Never `unwrap_or_default()` a catalog fetch.
- RTL laws: getByByText matches TEXT NODES; fake-timer law; no vitest message args.
- Outbox op payloads: pin keys to what the push arm READS (grep payload[ before authoring).

---

### Task 1 — backend: schema v6 + ops + push arms + client methods (Rust)

**Files:** src-tauri/src/db/migrations.rs, src-tauri/src/db/items.rs, src-tauri/src/models.rs
(reconcile carry), src-tauri/src/jotty/client.rs, src-tauri/src/sync/push.rs.
(No commands/dto — T2 owns the command layer.)

**Step 1 (RED):** tests first, all in the repo's existing test modules:

- migrations: after running v6 on a v5 db (in-memory), `PRAGMA table_info(checklist_items)`
  includes description TEXT + estimated_time INTEGER; v5→v6 is additive (rows survive —
  insert a row at v5, upgrade, row intact with NULL new columns).
- models/reconcile: a server pull with description+estimatedTime fills the new columns on a
  clean row (and does NOT overwrite a dirty row's local values — existing dirty-fence rule);
  ServerItem retains its existing score parse (do NOT remove — arrival-side parse is
  load-bearing for other surfaces even though p8 never stores it).
- client.rs (wiremock): update_item_description sends PATCH /api/checklists/{id}/items/{path}
  body {"description": "..."} — Some → string, None → null (body KEY always present, null
  clears — probe-verified); update_item_estimated_time sends {"estimatedTime": n} integer,
  null clears. Both consume non-2xx as errors (api_send contract unchanged).
- push.rs: new arms ("checklist_item", "set_note_desc") and ("checklist_item", "set_est_time")
  — payload {checklist_id, item_local_id, description|estimatedTime} (null = clear) —
  resolve via fetch_list_snapshot + resolve_item_target (text-verified, update_arm=true
  semantics — WAIT: resolver's update_arm gates STORED-PATH identity; description/est are
  TEXT-VERIFIED writes (target text must match) → pass update_arm=false like check ops; the
  payload never exists without a text-bearing item), then ONE PATCH via the new client
  methods. Hit-counter mocks per endpoint (Arc AtomicUsize) pinned: patch_hits==1,
  stale/other==0 on a drifted-snapshot case (mis-target class discipline).

**Step 2 (GREEN):** minimal implementation; items.rs insert paths (create_item_inner + any
raw INSERT) gain the two columns with NULL defaults; reconcile UPDATE arms extend.

**Step 3:** cargo gates + census; commit `feat(board-details): schema v6 + description/est-time ops + push replay arms`.

**Interfaces (binding):**

```rust
// client.rs
pub async fn update_item_description(&self, list_id: &str, path: &str, description: Option<&str>) -> AppResult<()>;
pub async fn update_item_estimated_time(&self, list_id: &str, path: &str, hours: Option<i64>) -> AppResult<()>;
pub async fn update_item_priority(&self, list_id: &str, path: &str, priority: Option<&str>) -> AppResult<()>;
// db/items.rs — ItemRow/ServerItemFlat gain: pub description: Option<String>, pub estimated_time: Option<i64>
//   ServerItemFlat is rebuilt from ServerItem (flatten): description: it.description.clone(), estimated_time: it.estimated_time.map(|f| f as i64)  (server truncates fractions; ints only cross the DB)
//   COLS constant + row() + INSERT shapes + the clean-row reconcile UPDATE (line ~198) extend with description=?, estimated_time=?
//   checklists.rs INSERT-into-items paths follow the COLS/row() change (compile-forced) — pre-ruled
// push.rs — THREE match arms, payload keys: description (string|null), estimatedTime (int|null), priority (string|null)
//   resolver: resolve_item_target(..., update_arm=false) for ALL THREE (text-verified writes; a rename mid-queue must not
//   re-resolve via stored path — the row text IS the new text; same law as the target-date arm which passes false)
// outbox op kinds (engine-literal match strings): "set_note_desc", "set_est_time", "set_prio" — entity "checklist_item"
// enqueue sites to mirror (shape precedent): commands/mod.rs:478-483 (set_date payload built inline, null via json!)
```

---

### Task 2 — command layer + menu sub-panel UI (Rust commands + TS)

**Files:** src-tauri/src/commands/mod.rs (+dto.rs), src/api/types.ts, src/api/jotty.ts/bindings,
src/components/KanbanBoard.tsx (+ .test.tsx), src/store.ts if needed.

**Step 1 (RED):**

- commands: set_item_description_inner / set_item_est_time_inner — ONE tx (row write,
  dirty=1, outbox enqueue with the T1 payload keys), kanban-or-any gate mirroring
  set_item_text_inner's shape (grep the existing gate; follow it exact); dto ItemDto gains
  description + estimatedTime (serde camelCase); command registrations + lib.rs invoke
  handler names (set_item_description, set_item_est_time). Rust tests: round-trip row
  update + op payload pin (serde_json map of the enqueued op) + gate rejects on unknown
  item. PRIORITY note: the priority OUTBOX OP + client method + push arm live in T1
  (payload {priority}); T2 adds ONLY the command set_item_priority_inner (+registration)
  following the SAME inner shape, plus the types/UI.
- types.ts: ItemDto += description?: string | null; estimatedTime?: number | null
  (mirror dto.rs EXACTLY — cross-task DTO law).
- api bindings (src/api/*): setDescription(checklistId, itemLocalId, value|null),
  setEstimatedTime(checklistId, itemLocalId, hours|null) — invoke wrappers.
- KanbanBoard RTL fences: "Details" menu row opens the sub-panel (mode detailFor); textarea
  prefilled with item.description ?? []; Save → api setDescription invoked once with the
  edited value, panel closes, reload fires; empty textarea Save → null (clear).
  Priority row: five buttons (critical/high/medium/low + "Clear priority"); click → api
  setItemPriority? — WAIT: priority setter must NOT require backend ops (set_item_priority
  INNER does the same ONE-tx+op dance as others; but T1 didn't add the priority op — PRIORITY
  OP lands in THIS task as a push arm extension? NO — keep T1/T2 split honest: the priority
  outbox op + push arm ALSO lands in T2's range? That breaks the file split (push.rs is T1's).
  RULING (controller, pre-ruled now): priority op + arm + client method ALL live in T1; T2
  consumes the command set_item_priority. T1 carries: ops set_note_desc, set_est_time,
  set_prio (payload {priority}); T2: commands for all three + UI. Adjust T1 files: + push.rs
  arm for "set_prio" (PATCH body {priority: s|null}).
- est-time input: non-integer (2.5) normalizes to 2 (Math.trunc) before invoke; negative →
  reject client-side (no invoke); empty → null (clear).
- Start-date row in the existing date panel (T2): second DateDropdown; save → existing
  api.setItemTargetDate with BOTH dates (startDate rides the CURRENT op payload key — no
  new op; clear via null).

**Step 2 (GREEN):** implement; menu row order: Move to…, Details, Set date, Set reminder,
Repeat, Rename, Delete (Details after Move; existing rows byte-untouched = additive).

**Step 3:** FULL gates (cargo + vitest 636+N + tsc + census), WebKitGTK-free — panel is
DOM-only (DateDropdown already engine-proven); commit
`feat(board-details): card detail menu panels (description/priority/est-time/start-date)`.

**Interfaces (binding):**

```ts
// types.ts
interface ItemDto {
  description?: string | null;
  estimatedTime?: number | null;           // whole hours
  // existing fields unchanged
}
// bindings (src/api/...)
setDescription(checklistId: string, itemLocalId: string, value: string | null): Promise<void>;
setEstimatedTime(checklistId: string, itemLocalId: string, hours: number | null): Promise<void>;
setPriority(checklistId: string, itemLocalId: string, value: 'critical'|'high'|'medium'|'low'|'none'|null): Promise<void>;
```

---

### Self-review checklist (controller, pre-dispatch + at close)

- [ ] T1 suite-count = ledger baseline + fence test count (count #[test]/#[tokio::test] in fences).
- [ ] All payload keys match what push arms read (grep payload[).
- [ ] DTO census: types.ts mirrors dto.rs field-for-field after T2.
- [ ] No score/assignee/time-write anywhere (spec excludes them).
- [ ] Census 18 Δ0 both tasks; no cargo fmt; explicit-path staging.
- [ ] Whole-branch review (P8 span) before tracker Done update — P8 stays In Progress until
      review verdict; release ask = user's.