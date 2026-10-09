# Plan — P9: Board column/status editor (2 tasks, sequential)

**Spec:** docs/superpowers/specs/2026-10-09-board-columns-p9-design.md
**Wire facts:** skills/software-development/jotty-client/references/jotty-kanban-p8p9-wire-facts.md (statuses CRUD live-probed 1.28.0)
**Run ledger:** .superpowers/sdd/2026-10-09-board-columns-p9/progress.md
**RUNS AFTER P8 CLOSES** (its HEAD is this plan's BASE; dispatch records BASE then).
No package build anywhere in this run.

## Global constraints

Identical to the P8 plan's Global constraints block (TDD RED first; gates incl. census 18
Δ0 and vitest/tsc for the UI task; explicit-path staging; repo identity; sync invariants;
RTL laws; NO cargo fmt). Column mutations are ONLINE-ONLY (pre-ruled — live upstream
calls, no outbox ops, no cache-table writes outside the fetch_task_board refresh path).

---

### Task 1 — client methods: statuses CRUD (Rust, client.rs only)

**Step 1 (RED):** wiremock fences in client.rs tests:
- `add_board_status(board_id, S)` → POST /api/tasks/{board_id}/statuses body
  EXACTLY {id, label, color?, order, autoComplete?} — absent Option fields send NO key
  (probe: omitted autoComplete → false; always send explicit order integer).
- `update_board_status(board_id, status_id, S2)` → PUT /api/tasks/{board_id}/statuses/{ENCODED id}
  partial body (absent = untouched).
- `delete_board_status(board_id, status_id)` → DELETE .../statuses/{ENCODED id}, no body.
- URL-encoding fence: a status id with a space/unicode ("In Review α") must hit the
  encoded path (hit-counter mock keyed on the ENCODED path).
- Non-2xx → AppError (api_send contract).

**Step 2 (GREEN):** three methods; types: a small BoardStatusPatch {label?, color?,
order?, autoComplete?} with Option fields omitted by key (serde skip_serializing_if).

**Step 3:** cargo gates + census; commit `feat(board-columns): statuses CRUD client methods + encoded-path fences`.

```rust
pub struct BoardStatusPatch { pub label: Option<String>, pub color: Option<String>, pub order: Option<i64>, pub auto_complete: Option<bool> } // camelCase out
pub async fn add_board_status(&self, board_id: &str, id: &str, label: &str, color: Option<&str>, order: i64, auto_complete: Option<bool>) -> AppResult<()>;
pub async fn update_board_status(&self, board_id: &str, status_id: &str, patch: &BoardStatusPatch) -> AppResult<()>;
pub async fn delete_board_status(&self, board_id: &str, status_id: &str) -> AppResult<()>;
```

---

### Task 2 — commands + column menu UI (commands/mod.rs + dto + TS)

**Step 1 (RED):**
- Commands: add_board_column_inner / update_board_column_inner / delete_board_column_inner
  + reorder arm (move_up/move_down computed CONTROLLER-side order swap via TWO
  update calls; the inner takes status_id + direction, reads the cached columns,
  swaps, issues the two client calls sequentially, refresh rides the UI reload) —
  ONE tx is NOT applicable (online-only class): commands are thin async wrappers over
  client calls + the post-success fetch_task_board refresh EXACTLY like
  create_task_board does (grep its shape). Kanban-family gate on checklist_id (mirror
  fetch_task_board's gate).
- tauri commands registered: add_board_column, update_board_column, delete_board_column,
  move_board_column(checklist_id, status_id, direction: "up"|"down").
- types.ts + bindings: BoardStatusDto already exists (mirror its fields); new
  api.addBoardColumn / updateBoardColumn / deleteBoardColumn / moveBoardColumn.
- RTL fences: column-head ⋯ button opens col menu; Add flow (input label → Add →
  api.addBoardColumn recorded once → reload); palette row (8 swatches + none) adds
  color key only when picked; rename → PUT recorded; autoComplete toggle → PUT; reorder
  up on col idx1 → TWO updateBoardColumn calls with SWAPPED orders (assert both recorded
  bodies: order values exchanged, ids correct); delete guard ≤2 columns refuses (no
  invoke); delete >2 columns → confirm row names destination column label + card count;
  delete → api.deleteBoardColumn + reload; error path: command rejects → inline error
  row in the menu, prior state untouched.
- BoardStatusDto id/label/color/order/autoComplete fields census vs dto.rs.

**Step 2 (GREEN)** — implement UI per spec §Design (menu inside kanban-col-head, existing
kanban-menu/backdrop idiom, palette DOM swatches, danger rows).

**Step 3:** FULL gates + commit
`feat(board-columns): per-board column editor in the card-menu idiom (add/rename/color/order/auto/delete)`.

---

### Pre-close

Whole-branch review over the P9 span (both tasks same branch), then tracker #9, then the
P8+P9 release ask to the user (no packaging).