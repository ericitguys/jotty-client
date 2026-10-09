# Spec — P8: Kanban card detail editing (menu sub-panels, no score)

**Date:** 2026-10-09 · **Roadmap:** Plane CAPTUREPIP #8 · **Status:** DESIGN LOCKED
**User rulings (2026-10-09, clarify 'use option 2' applied across the form):** card MENU sub-panels (no modal); editable set EXCLUDES score; two separate SDD runs, p8 first; no package build/release (release ask comes after, controller never packages without a go).
**Wire truth:** `references/jotty-kanban-p8p9-wire-facts.md` (live-probed 1.28.0, read alongside `references/jotty-kanban-api.md`).

## Goal

From a board card, edit its upstream-writable rich fields: **text** (exists),
**description** (new), **priority** (new), **targetDate + startDate** (start
date is new in the UI), **estimatedTime** (new, whole hours). Score and
assignee OUT (score = opaque upstream integer the user chose not to surface;
assignee = upstream rejects writes, cards never carry it). `time` is the
worklog — read-only by design (400 on write).

## Wire law (probe-verified 2026-10-09)

- PATCH `/api/checklists/{listId}/items/{indexPath}` accepts
  text/description/priority/score/startDate/targetDate/estimatedTime, partial,
  null clears; fractional numbers (score, estimatedTime) are TRUNCATED
  server-side → client sends integers only.
- All card-field replay ops resolve the index path via the snapshot +
  text-verified resolver (check-op class: a mis-targeted write stamps the
  WRONG card). New ops MUST ride `resolve_item_target` with text verification.

## Current code shape (verified 2026-10-09)

- `checklist_items` columns: status, priority, target_date, start_date exist;
  **`description` and `estimated_time` do NOT exist** → migration v6 adds both
  (`description TEXT`, `estimated_time INTEGER`).
- `models::ServerItem` parses status/description/priority/score/dates/
  estimatedTime (+children) — arrival side exists; the fields are DROPPED at
  the DB boundary today; reconcile must carry description + estimated_time +
  (score excluded by scope — do not store).
- Outbox ops (push.rs arms): "text" (patch_item), "set_date" (targetDate +
  optional startDate second PATCH), "check", "status", "set_reminder",
  "reorder". client.rs: patch_item(text), update_item_target_date,
  update_item_start_date — separate single-field PATCHes.
- UI: KanbanBoard.tsx menu sub-panel idiom (dating/reminding/repeating
  modes inside the per-card menu); ItemDto carries
  status/priority/targetDate/startDate but NOT description/estimatedTime.

## Design

1. **Backend (T1)** — schema + parse + ops:
   - Migration v6; ItemRow + ItemDto gain description, estimated_time.
   - models: keep ServerItem fields; reconcile carries the two new fields
     (server wins on clean pulls; dirty rows untouched — existing rules).
   - client.rs: `update_item_fields(list_id, path, description: Option<&str>,
     estimated_time: Option<i64>)` — hmm, ONE method per arm to mirror the
     existing single-field style: `update_item_description`,
     `update_item_estimated_time` (PATCH body {description: s|null}
     / {estimatedTime: n|null}).
   - New outbox ops: "set_note_desc" & "set_est_time" (checklist_item),
     payload {checklist_id, item_local_id, description|estimatedTime} with
     null = clear; push arms resolve via the snapshot + text-verified
     resolver, then one PATCH each (target-date-arm shape).
   - Commands: set_item_description_inner / set_item_est_time_inner (ONE tx:
     row write + dirty=1 + op enqueue; kanban-family gate? — description/est
     apply to ANY checklist item (upstream PATCH is item-generic) — BUT the
     UI surfaces them only on board cards for p8; gates mirror set_item_text
    _inner's gate shape), + command registrations.
2. **Frontend (T2)** — menu sub-panels per P8 ruling:
   - "Details" sub-panel (kanban-menu swap, mode `detailFor`): textarea
     (description, Save/Back), priority row (critical/high/medium/low +
     Clear), estimated-time number input (whole hours, Clear), start-date +
     target-date rows (two DateDropdowns — EXTEND saveDate to send both
     through the existing set_date op; date panel folds INTO the details
     panel? NO — keep set-date as its own row, details panel holds
     description/priority/est only; dates already have a panel; start date
     joins it as a second DateDropdown with one Save).
   - api.ts bindings + store wiring untouched (commands called via reload).
   - Menu gains: "Details" row (new), "Set date" panel gains Start-date row.
   - Badge additions? — NO new badges (scope-tight; existing priority/date
     badges remain).

## Tests (RED first, every task; whole-suite gates after)

- T1: wiremock update_item_description/estimated_time bodies (null clear);
  ops replay arms resolve-then-PATCH (hit-counter per endpoint, wrong-path
  isolation per T12 counter-mock discipline); reconcile carry (pull fills
  description/est_time; dirty rows protected); dto round-trip; suite-count
  arithmetic in the ledger.
- T2: RTL panels — open Details from a card menu (getByText), edit
  description save → invoke recorded, priority picks → recorded, est-time
  integer normalize (2.5 → 2), clear paths, panel close/Escape, native-date
  eradication preserved (DateDropdown), existing fence tests byte-untouched
  (green-green reshape disclosure allowed only for the additive menu row).

## Out of scope

score/assignee; worklog time write; new badges; offline column ops (p9's
space); any package/release step (separate user gate).