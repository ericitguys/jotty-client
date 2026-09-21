# Kanban Boards (v2 feature) — Design

Status: approved design, 2026-09-20. User request: "on the desktop client and
android i want to support the kaban checklist". Scope questions answered via
clarify the same day (card details display-only; columns site-managed; board
creation in-client). No code written yet; this spec precedes the
implementation plan. Kanban was an explicit v1 non-goal of
`2026-09-15-jotty-offline-client-design.md`; this spec supersedes that line.

## 1. Problem

The user's jotty instance hosts kanban boards (checklists of type
`kanban`/`task`). The desktop/Android client currently pulls them as plain
checklists: item `status` is dropped at the DB boundary, columns are unknown,
and toggling a checkbox mutates `completed` without touching the column —
diverging from the site, where the board IS the primary UI.

## 2. Decisions (approved in brainstorm, 2026-09-20)

1. **Board view replaces the plain list** for kanban-type checklists
   (`listType` `kanban` or legacy `task`) on desktop AND Android — one
   responsive component.
2. **Card details are display-only** (badges: priority, target date,
   subtask count). Editing those fields happens on the site (smallest sync
   surface, ships fastest).
3. **Columns are site-managed.** The client fetches + caches columns; no
   add/rename/delete column UI.
4. **Boards can be created in-client** ("+ New board") with the default
   column set via the API.
5. **Completion = moving to the autoComplete column.** Cards carry no
   checkbox (matches the site's board).
6. **Movement UX:** drag & drop between columns on desktop (HTML5 DnD, same
   contract as ChecklistView T17); tap → action menu ("Move to…" / rename /
   delete) on all platforms (this is the touch path — HTML5 DnD does not
   fire on Android touch).
7. **v1 card move = status change only.** Upstream's web drop ALSO reorders
   the underlying item list (dropItem → applyDrop renumber); the client does
   status only, so a card lands at its existing item-order position within
   the target column. Within-column reordering is a non-goal (v1).

## 3. Upstream API + file facts (source-verified 2026-09-20, /tmp/jotty-upstream @ b5458a2 = origin/main)

Kanban lists are ordinary checklists: `type: "kanban"` (legacy `"task"` is a
read alias — `isKanbanType` covers both). YAML frontmatter carries
`checklistType: kanban` + `statuses: [{id,label,color?,order,autoComplete?}]`;
each item line embeds ` | status:<id>` metadata (omitted when status is
`todo`). `completed` stays a separate checkbox flag.

- `GET /api/checklists` (existing catalog pull): items already include
  `status` for kanban lists (`toApiItem(item, index, isKanbanType)`) plus
  description/priority/score/dates when present. The catalog does NOT
  include the list's `statuses` columns, and does not expose
  `isArchived` (archived cards will render; upstream API limitation).
- `GET /api/tasks/{uuid}` → `{ "task": { id(uuid), title, category,
  statuses|null, items(with status), createdAt, updatedAt } }`. 400 when the
  list is not kanban-type; 404 unknown. `statuses: null` → client falls back
  to the default set (below).
- `PUT /api/tasks/{uuid}/items/{indexPath}/status` body `{"status":"x"}` →
  server `applyStatus`: sets item.status; if the target status has
  `autoComplete` → item.completed=true AND all children completed=true; if
  the item was completed and the status CHANGED (away from previous) →
  completed=false; appends `history` entry. Response `{"success":true}`.
- `POST /api/checklists/{uuid}/items` accepts `status` for kanban lists
  (defaults to first/`todo` server-side when omitted).
- `PATCH /api/checklists/{uuid}/items/{indexPath}` writable fields:
  text, description, priority, score, startDate, targetDate, estimatedTime
  (v1 client: text only — existing update op).
- Check/uncheck endpoints PRESERVE item.status (server only flips
  `completed`) — existing client ops are safe for board items.
- `POST /api/tasks` `{title, category?, statuses?}` → creates a `kanban`-type
  list (makeList type=kanban, statusesStr) → `{success, data:{...}}`. Without
  statuses the site UI still shows the default set; the client sends the
  default set explicitly.
- Column CRUD (`POST/PUT/DELETE /api/tasks/{uuid}/statuses[/{statusId}]`)
  exists but is a non-goal (decision 3). Deleting a column auto-moves its
  items to the first column server-side — the client must tolerate columns
  disappearing between opens (unknown item status → first column).
- **Shape trap:** the API's default-statuses fallback uses `name`
  (`{id, name, order}`) while real persisted statuses and the site's
  `DEFAULT_KANBAN_STATUSES` use `label` — the client parser must accept both
  (`label` preferred, `name` alias).
- **Default column set (site UI truth, `_consts/kanban.ts`):** todo/To Do 0,
  in_progress/In Progress 1, completed/Completed 2 (autoComplete: true),
  paused/Paused 3. The site ALSO coerces a `completed` column with
  `autoComplete === undefined` to autoComplete:true — mirror that coercion.
  NOTE the two distinct default uses: this 4-column set is the RENDERING
  fallback when a list carries `statuses: null` (site parity, §7); new
  boards are CREATED with the 3-column set (§6).
- **Card grouping (getColumnItems):** cards = TOP-LEVEL items only
  (children are subtasks inside the card, never separate cards); item goes
  to the column with `item.status === statusId`; items with an unknown or
  absent status belong to the FIRST column (sorted by order).
- Index paths (`"0"`, `"0.1"`) address items; the status route resolves
  them to the server item id internally — same addressing class as all
  other item mutations (no stable server-side mutation IDs).

## 4. Architecture

Same shape as the rest of the client: pure stock-API calls, SQLite truth
local, outbox replay. Nothing server-side changes.

```
BoardView (React, shared desktop/Android)
  renders from LOCAL SQLite only (items + cached columns)
  open-time: fetch_task_board -> GET /api/tasks/{uuid} -> cache columns
             (render immediately from cache; columns refresh when it lands)
  mutations: local row update (dirty=1) + outbox enqueue, like every list op
```

- ChecklistView keeps rendering plain lists; App/ChecklistView chooses
  KanbanBoard when `listType` is `kanban`/`task`.
- Columns come ONLY from the open-time fetch (the catalog pull cannot see
  them). Freshness gap = same as any pull-interval staleness; acceptable and
  disclosed. First-ever offline open with no cache → default column set.
- `fetch_task_board` NEVER blocks rendering: BoardView mounts from cache,
  the fetch refreshes columns in the background (failure = keep cache,
  silent — offline is a normal state, not an error surface).

## 5. Data model

Migration v3 (PRAGMA user_version 3):

```sql
ALTER TABLE checklist_items ADD COLUMN status TEXT;            -- NULL = unknown/absent
CREATE TABLE board_statuses (
  checklist_id TEXT NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  status_id    TEXT NOT NULL,
  label        TEXT NOT NULL,
  color        TEXT,
  sort_order   INTEGER NOT NULL,
  auto_complete INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (checklist_id, status_id)
);
CREATE INDEX idx_board_statuses ON board_statuses(checklist_id, sort_order);
```

- `board_statuses` is a CACHE, never dirty-tracked; rewritten wholesale on
  each successful `fetch_task_board` (delete + insert in one transaction).
  Not touched by sync pull. Cascade on list delete mirrors items.
- `checklist_items.status` participates in the EXISTING dirty/upsert
  machinery: pull writes server status into clean rows (server wins);
  dirty rows keep their local status until the op replays (unchanged rule).
- DTO surface: `ItemDto` gains `status: string | null`; `BoardDto`
  `{ checklistId, statuses: [{id,label,color,order,autoComplete}] }` for the
  cached columns; `get_checklist` payload unchanged apart from item status.
  `types.ts` mirrors dto.rs (camelCase) — the T15 contract.

## 6. Flows

**Move card (drag or menu):**
1. Optimistic local update mirroring server `applyStatus` semantics: set
   `status`; target autoComplete → completed=1 + all descendant rows
   completed=1; status change away from previous on a completed row →
   completed=0. Row(s) marked dirty=1. ONE transaction.
2. Enqueue outbox op `item_status` — payload
   `{checklistId, itemLocalId, storedPath, text, newStatus}` — entity=item.
3. Push replay resolves the target with the EXISTING claim/resolve
   machinery, text-verified (check-op class per sync invariant 7 — a
   mis-targeted status move edits the wrong card, same hazard class as a
   mis-targeted check), then
   `PUT /api/tasks/{uuid}/items/{resolvedPath}/status`.
4. Server refusals (400/403/404) → `mark_conflict` (existing
   classification + ConflictDialog keep-mine/take-server). 401/5xx/timeout
   stay transient.

**Add card:** column "+" → inline input → local insert (status=column,
dirty=1, temp localId) + existing create op whose payload now carries
`status` for kanban lists (server default when omitted = first status).
Reuses the create remap temp_id → server uuid path.

**Rename / delete card:** existing update/delete ops, unchanged (server
preserves status through them — verified).

**Create board ("+ New board" in the checklist list header):**
`create_task_board(title, category)` → `POST /api/tasks` with the default
column set sent explicitly — todo, in_progress, completed with
`autoComplete: true` (3 columns; the site's rendering fallback additionally
shows `paused` for `statuses: null` lists, §3/§7, but new boards don't need
a paused column unless the user adds one on the site) → refreshAll → open
the board. Online-only (disabled offline, consistent with all creation
flows).

**Board open:** `fetch_task_board(uuid)` → 200: rewrite `board_statuses`
cache; 404/400 (old instance or non-kanban): keep cache (or default set),
silent. Response items are NOT written to item rows (pull owns item truth;
avoids a second upsert path fighting the dirty guard).

**Offline:** board renders items + last cached columns; moves/adds enqueue
and replay on next successful sync (existing outbox semantics); no cache →
default column set; unknown statuses → first column.

## 7. Limits and error handling

- No `GET /api/checklists/{uuid}` exists upstream (PUT/DELETE only) — board
  columns ride `GET /api/tasks/{uuid}` exclusively. 404 there on a kanban
  list means the instance predates the tasks API: board still renders from
  cache/defaults; moves enqueue and will conflict on push. Disclosed; user's
  instance is current (1.25.x, verified 2026-09).
- `isArchived` items render as cards (API limitation, §3) — cosmetic.
- `time`/`timeEntries`, `history`, assignee, reminders: parsed if present,
  never rendered in v1.
- Legacy `task`-type lists whose items carry `paused`/`in_progress` but have
  `statuses: null` render with the default 4-column set (site parity) —
  `paused` cards visible, moves into it allowed (site-managed columns are
  authoritative on next open).

## 8. Testing

- **Rust (wiremock):** envelope shapes (get_task unwrap `{task:...}` with
  `name`-alias fallback statuses; create_task `{success,data}`); status-move
  replay (resolved path asserted via per-endpoint hit counters, drift +
  text-mismatch → sentinel conflict per invariant 7), autoComplete
  local-mirror semantics (children cascade, completed flip-back), create
  op carries status, pull writes status into clean rows and NOT dirty rows,
  board_statuses cache rewrite, 404 → cache retained.
- **TS (vitest+RTL):** BoardView render (columns/order/counts, badges,
  unknown-status → first column), move via menu calls store action, DnD
  contract (dataTransfer-first, T17 ruling U), add-card inline input,
  App-level fence: kanban-type list renders the board, plain list still
  renders ChecklistView; "+ New board" flow (mocked invoke).
- **Integration (env-gated, #[ignore]):** live instance round-trip — fetch
  board columns, move a card, verify GET shows the new status, move back.
- Gates at every task: full `npx vitest run` (NODE_OPTIONS=--no-webstorage
  already in npm test), `npx tsc --noEmit`, `cargo test` + zero NEW
  warnings (delta vs stash-verified baseline; ~15 pre-existing
  unused-import warnings are baseline noise).

## 9. Build and ship

- Minor bump: 0.11.0 in package.json + tauri.conf.json + Cargo.toml +
  both lockfiles (`npm install --package-lock-only`, `cargo update -p
  jotty-client`).
- Ship procedure per skill: TDD → gates → commit → push → `npx tauri build`
  (deb+appimage+rpm) → tag `v0.11.0` + `v0.11.0-android-preview` → gh
  release with computed sha256s (android arm64 apk via `npx tauri android
  build --target aarch64 --apk`; gen/android fixups already in place).
- Desktop parity after mobile-facing changes: screenshots at 412px +
  1280px (Playwright + __TAURI_INTERNALS__ shim, serve dist over http —
  NEVER file://).

## 10. Non-goals (v1)

- Column management UI (add/rename/delete; server endpoints exist when we
  want it later).
- Editing card fields (description/priority/dates/score) — display-only
  badges.
- Within-column card reordering (drop = status change only, §2.7) and
  cross-column position control.
- Sub-task (children) management on cards; children render as a count
  badge only.
- Time tracking, reminders, assignee, history UI, archived-card handling.
- Recurrence (upstream has it; untouched).