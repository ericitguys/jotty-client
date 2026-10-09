# Spec — P9: Board column/status editor (menu-idiom, per board)

**Date:** 2026-10-09 · **Roadmap:** Plane CAPTUREPIP #9 · **Status:** DESIGN LOCKED
**User rulings:** column editor inside the EXISTING card-menu/panel idiom (no dedicated
modal/panel component); two separate SDD runs (p8 ships first); no package build.
**Wire truth:** `references/jotty-kanban-p8p9-wire-facts.md` —
statuses CRUD live-probed 1.28.0: POST `/api/tasks/{id}/statuses` NEEDS `id`+`label`
(free-form ids OK incl. spaces/unicode — URL-encode paths), PUT `.../statuses/{statusId}`
partial ({label?, color?, order?, autoComplete?}), DELETE `.../statuses/{statusId}` moves
its cards to the FIRST-BY-ORDER column (no protected column); order = explicit per-status
integer, no reorder endpoint (a reorder = N_PUTs or one ordered batch from the client);
multiple autoComplete columns allowed server-side.

## Goal

Per-board column management: **add / rename / recolor / delete / reorder / autoComplete
toggle** — written THROUGH to upstream (the board render + every other surface follows),
then the local `board_statuses` cache refreshes via the existing fetch_task_board path.

## Design

1. **Sync class: ONLINE-ONLY ops** (pre-ruled): column mutations are LIVE upstream calls,
   exactly like create_task_board — no new outbox op kinds, nothing queued. Offline → the
   panel shows the existing connect/sync error inline; nothing half-applies. Card moves and
   field edits keep their existing queued-op paths (unchanged).
2. **UI shape (option-2 ruling):** each column header gets a small `⋯` menu button
   (kanban-col-head) opening the SAME sub-panel idiom KanbanBoard already uses
   (kanban-menu swaps inside a backdrop — no new component family):
   - **Add column**: label input + color swatch row (fixed palette of 8 + none — pure DOM;
     NO native `<input type=color>` — webview-native-input eradication law, see the
     WebKitGTK datetime lesson) + "Add" → client-side id = label-slugified
     (lowercase, [a-z0-9]+ collapsed to `-`), collision → `-{n}` suffix; POST with
     order = max(order)+1.
   - **Rename**: inline text input → PUT {label}.
   - **Color**: swatch row → PUT {color}; "None" → PUT {color: null}? (probe said PUT
     accepts {label,color,order}; color-null acceptance UNPROBED — rule: send the swatch
     value only, and reuse the palette; a "clear color" row sends no color KEY at all
     (absent = untouched — partial-update semantics verified).
   - **Reorder**: Move-up / Move-down rows → swap `order` values with the adjacent column,
     TWO PUTs (each column carries its new explicit order); refresh once after both.
   - **autoComplete toggle**: row → PUT {autoComplete: !current}.
   - **Delete**: inline confirm row — shows "N card(s) move to <first-by-order column>"
     (count from the local board state) + danger styling; guarded: refuse when the board
     has ≤2 columns (pre-ruled client-side guard; server has none and allows collapsing
     the board to one/zero columns).
3. **Cache discipline:** every successful mutation ends with the existing board refresh
   (fetch_task_board → cache rewrite) so the offline-first render and the server agree;
   NO direct cache-table writes from the editor (single-writer law stays with the fetch
   path).
4. **State:** panel mode lives in KanbanBoard (colMenuFor + sub-mode) like the card menu;
   column menus close on backdrop/DnD start like card menus do.

## Tests (RED first)

- client.rs (wiremock): add_board_status (POST body {id,label,color?,order?,autoComplete?}),
  update_board_status (PUT partial — absent keys not sent), delete_board_status (DELETE,
  no body) — per-endpoint shapes + non-2xx mapping.
- KanbanBoard RTL: column-head menu opens; add flow (label → Add → POST recorded →
  refresh fires); rename PUT recorded; swatch color PUT recorded; autoComplete toggle PUT
  recorded; delete-guard: ≤2 columns → refuse + NO invoke; delete with cards → confirm
  row shows the destination column label; delete PUT→refresh; reorder emits two ordered
  PUTs (order assertions on recorded bodies); offline-error path: invoke rejects → panel
  error line, state unchanged.
- Existing fences byte-untouched (additive menu button + rows; any reshape disclosed).

## Out of scope

Status-id editing (ids are wire values on existing cards — rename only edits label);
drag-reorder of columns (order swaps via menu suffice v1); shared-board column rights
(upstream permission surface unprobed — same rights as any board edit); package/release
steps.