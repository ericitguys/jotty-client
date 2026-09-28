# Appointments Phase 2 — client dates, reminders, agenda, voice→appointment

**Date:** 2026-09-27
**Status:** Draft for user review
**Repo:** /coding/jotty (desktop client)
**Predecessors:** 2026-09-25 appointments discussion (requirements locked); `/coding/jotty-companion` (Phase 1, built, deploy pending); research reference `references/jotty-calendar-recurrence-reminders.md` (jotty-client skill).

## 1. Goal

The user runs his life's appointments through jotty. The web app already supports kanban-only item dates, reminders, and recurrence (user-confirmed working on his server, 2026-09-25). The desktop client currently carries only `target_date` (kanban cards). This phase closes the appointments gap **in the client**:

1. Item dates round-trip fully (start + target).
2. Kanban reminders are visible and settable from the client.
3. A cross-board Agenda view answers "what's coming" without opening boards.
4. Voice capture can file an appointment (text + date + reminder) in one flow.

## 2. Non-goals (do not relitigate without the user)

- **Recurrence in the client** — upstream-blocked: no REST endpoint reads OR writes recurrence (re-verified 2026-09-27 @ b5458a2, still tip of upstream main). The web app stays the authoring surface; the companion handles recurrence roll-forward server-side. An upstream issue draft (appendix A) asks for recurrence over REST; when upstream ships it, a follow-up phase adds client support.
- **Push notifications from the client** — that is the companion's job (reads files; REST cannot deliver reminders to API-key clients: websocket is session-cookie auth only).
- CalDAV / native-calendar sync, booking links (user explicitly rejected 2026-09-25).
- Time tracking, assignees, scores (kanban fields beyond this phase's scope).

## 3. Verified upstream wire facts (source @ b5458a2, 2026-09-27)

| Capability | Read | Write |
|---|---|---|
| startDate/targetDate | `GET /api/checklists` catalog — items carry both (`toApiItem`, app/_utils/api-item.ts) | `PATCH /api/checklists/{listId}/items/{indexPath}` — validated string-or-null per field; other fields untouched (client already PATCHes targetDate here) |
| Reminder | `GET /api/kanban/{boardId}` — `transformBoard`/`transformItem` (app/_utils/kanban/api-transforms.ts) carry `reminder: {datetime, notified?}` per item (kanban boards only) | `PUT /api/kanban/{boardId}/items/{itemId}/reminder` body `{datetime}` sets; same route with empty body clears (route appends `reminder: ""` → cleared) |
| Stable item id | Both reads carry it: `ApiItem.id` / `TransformedItem.id` (disk truth: `metadata:{"id":"<fileUuid>-<epochMs>"}`) | Reminder PUT (and kanban item PUT) address items BY THIS ID, not by index path |
| Recurrence | **nowhere** | **nowhere** |

Envelope shapes (get_categories lesson — every new getter needs an envelope-shape test):
- `GET /api/kanban/{boardId}` → `{"board": transformBoard}` where transformBoard = `{id, title, category, statuses[], items[], createdAt, updatedAt}`.
- Reminder on the wire (kanban GET) is a PARSED object `{datetime, notified?}` — not the file's JSON-string form.
- `GET /api/checklists/{id}` single is 405; the sync uses the catalog endpoint — unchanged.

Date-string convention (calendar-utils.ts `toDateKey`): targetDate may be date-only (`2026-10-01`) or full ISO (`2026-09-25T09:00:00.000Z`); upstream truncates to a local date key for calendar display. The client keeps the raw string (existing behavior) and renders via the same truncate rule.

## 4. Current client state (facts this design builds on)

- `checklist_items` columns (v1+v3): local_id, checklist_id, parent_id, text, completed, position, server_path, dirty, **status, priority, target_date** (v3 added for kanban).
- `ServerItem` (jotty/models.rs) parses `id: Option<String>`, `start_date`, `target_date` — but `id` and `start_date` are DROPPED today (not stored; `ServerItemFlat` carries id but `reconcile` ignores it; start_date never leaves the parse).
- `ItemDto` carries status/priority/targetDate; TS types mirror.
- UI: kanban card date badge + "Set date" editor exist (KanbanBoard.tsx); plain checklist rows show no dates.
- Writes: outbox op `("checklist_item","set_date")` → `PATCH …/items/{path}` targetDate only (null clears). Item create accepts only `{text,status,parentIndex}` upstream — dates ride the separate set_date op (existing two-step preserved).
- The client does NOT persist the server item id anywhere (needed for reminder writes).

## 5. Design

### 5.1 Schema (migration v4)

```sql
ALTER TABLE checklist_items ADD COLUMN start_date TEXT;
ALTER TABLE checklist_items ADD COLUMN server_item_id TEXT;
ALTER TABLE checklist_items ADD COLUMN reminder_datetime TEXT;   -- ISO string, upstream format
ALTER TABLE checklist_items ADD COLUMN reminder_notified INTEGER; -- 0/1, from kanban GET
```

- `server_item_id` is the upstream stable id (`ApiItem.id`). Source of truth = server; never written by the client; absent for items that exist only locally (offline-created, create-op still pending).
- All four additive; sync's explicit column lists extend; no dirty-tracking change (see 5.3 for which fields are server-mirrored vs locally-owned).

### 5.2 Rust layer

- `ServerItemFlat` + `reconcile`: carry + store `start_date` and `server_item_id` (both already parsed on `ServerItem`). Reconcile UPDATE arms set them; text-fallback adoption and path matching unchanged. `server_item_id` NEVER participates in identity matching (identity stays server_path + text fallback — sync invariant 7 untouched); it is a stored attribute.
- `NewItem` gains `start_date`, `reminder_datetime` (local creation paths default None).
- `ItemDto` gains `startDate`, `serverItemId`, `reminderDatetime`, `reminderNotified` (camelCase, serde) — `types.ts` mirrors (`src/api/types.ts` MUST match dto.rs wire shapes — standing rule).
- New client methods (jotty/client.rs):
  - `get_kanban_board(board_id) -> KanbanBoardDto` — GET `/api/kanban/{id}`, unwraps the `{"board": …}` envelope; models carry statuses + items (`id`, `text`, `status`, `completed`, `reminder{datetime,notified}`), serde defaults, envelope-shape wiremock test mandatory.
  - `set_item_reminder(board_id, item_id, datetime: Option<&str>)` — PUT `/api/kanban/{boardId}/items/{itemId}/reminder`; `Some(iso)` sets, `None` clears (empty body).
- New command `list_agenda(conn) -> Vec<AgendaEntryDto>` — pure local read (no network, mirrors "no network in a getter"): every non-deleted item with `target_date NOT NULL`, joined to its checklist (`title`, `list_type`), sorted by target_date ascending; fields: checklist_id, checklist_title, item_local_id, text, completed, startDate, targetDate, reminderDatetime, status. Children included (they can carry dates too).

### 5.3 Sync semantics

**Dates (start/target) — server-mirrored, client-authorable.**
- Pull: reconcile stores start_date alongside target_date (same LWW path, checklist-level updatedAt governs).
- Write: extend the existing `("checklist_item","set_date")` op: payload MAY carry `startDate` alongside `targetDate`; replay PATCHes whichever keys the payload contains (null clears that field). Back-compat: payload without startDate → byte-identical behavior (targetDate-only PATCH).

**Reminder — locally-owned value, server-enriched, kanban-only.**
- The checklist catalog NEVER returns reminders, so reconcile must NOT touch `reminder_*` columns (they would be invisible to it anyway — explicit column lists). Reminder state changes only via: (a) local user edit (outbox op), (b) kanban enrichment below.
- **Kanban enrichment** (new, after a successful catalog pull in pull_all): for each checklist row with `list_type` kanban-family, GET the kanban board and merge per item: match by `server_item_id` (fallback: stored server_path → index-path mapping, text tiebreaker — same resolution order as reconcile), write `reminder_datetime` + `reminder_notified`; clear local values when the server shows none. The pending shield is PER-ITEM: an item with a pending reminder-write op (dirty row / unresolved op for that item) is skipped — never clobber an in-flight write; sibling items on the same board still enrich.
- Enrichment failure (network/500/404) is NON-FATAL: keep last-known values, count it in the SyncReport (`enrichment_errors`), never abort the pull, never tombstone (tombstoning stays catalog-snapshot-only).
- Envelope: unknown shape → wiremock-pinned; a failed parse must not zero reminders (parse error = enrichment error, same non-fatal path).

**Reminder write op** `("checklist_item","set_reminder")` payload `{item_local_id, datetime}` (null = clear):
- Replay: resolve target via the existing snapshot machinery → need the STABLE ID: use the row's `server_item_id`; if NULL (e.g. created offline, create-op replayed this run), take it from the fresh snapshot's item id at the resolved path (snapshot items carry `id`); if the snapshot item has no id either (old server) → conflict with message "server does not expose stable item ids".
- Replay asserts the owning list is kanban-family (UI gates this; replay defends): non-kanban → mark_conflict with a clear message. Upstream routes gate this server-side too (404/400 → conflict path).
- Ordering: reminder op rides the normal FIFO; the two-step create→date→reminder sequence for a fresh appointment is create → set_date → set_reminder, all resolved against post-create snapshots (same shape as existing set_date-after-create).

### 5.4 Kanban enrichment + agenda consistency

- `fetch_task_board` (existing board fetch, statuses column cache) and the enrichment fetch share the same endpoint; enrichment adds only the reminder merge (statuses cache path untouched — separate concern).
- Agenda reads local rows only — zero network in the getter (ruling P precedent). Stale reminders after an offline period are acceptable v1 behavior; the next sync heals them.

### 5.5 Frontend

**Types/client (src/api):** `Item` gains `startDate?`, `reminderDatetime?`, `reminderNotified?`, `serverItemId?`; client methods `getKanbanBoard(id)` (exposed for tests), agenda via a new `list_agenda` invoke.

**Agenda view (new sidebar section):**
- Sidebar gains a third tab: Notes | Checklists | **Agenda** (same `.sec-tabs` pattern, store `listMode: 'agenda'`).
- Right pane (full-width, list-only mode) renders `AgendaView`: groups = Overdue (target_date < today, not completed), Today, Tomorrow, Next 7 days, Later; entries show text, owning checklist title, time-of-day if the date string carries it, reminder chip (🔔 + local time, dimmed when `notified`), completed state.
- Clicking an entry selects the owning checklist (listMode flips to checklists, existing selection semantics) and scrolls/highlights the item row — reuse ChecklistView's `id=item-<localId>` focus lookup.
- Date arithmetic uses the item's raw string truncated to date-key (upstream `toDateKey` rule) in the user's local timezone — same as upstream; a full ISO datetime from another timezone displays on its local-date key (matches web behavior; disclosed).

**Kanban cards:** keep the existing date badge + Set date. Add a reminder affordance in the card detail row menu (Set reminder / Clear reminder → datetime input, portal-modal pattern per the prompt()-eradication rule — NO window.prompt). Cards show a 🔔 chip when `reminderDatetime` is set (dimmed when notified).

**Plain checklists:** rows show the date badge (text-only chip, no editor in v1 — dates on plain lists are settable via the existing set_date path only if we add UI; v1 = display-only on plain lists, full editing stays kanban cards. Dates remain writable on kanban cards + via voice).

**Voice → appointment (VoiceNoteReview):**
- New target alongside Note / Kanban task: **Appointment** — board picker (existing kanban targets list) + extracted fields.
- Extraction rides the existing tidy step: the LLM tidy prompt is extended to ALSO return structured `{date?: ISO, reminder?: ISO}` when the transcript names a day/time ("next Tuesday 9am dentist"). The raw transcript stays authoritative; extracted values are PRE-FILLED and editable in the review UI before save. No LLM = no extraction (fields start empty; manual entry works).
- Save = create item (text) on the chosen board → set_date (targetDate [+ startDate if distinct]) → set_reminder (default: the appointment datetime when a time-of-day is known; no reminder for date-only unless the user adds one). All three ride the outbox as one transactional local-write batch (same invariant 1: entity + ops in ONE tx).
- Review UI shows the three values as editable fields (date, time, reminder toggle) — jsdom-testable, portal-parity modals only.

### 5.6 Error handling

- Reminder PUT against a non-kanban list → upstream 4xx → mark_conflict (existing 400/403 classification); UI message: "Reminders only work on kanban boards."
- Enrichment with a board that vanished mid-pull (404) → treat as transient enrichment error, keep last-known; the catalog tombstone pass (which requires a clean snapshot) governs deletion.
- Voice extraction garbage (unparseable date) → field left empty, never a guessed value; user fills manually.
- All datetimes stored as the upstream-format strings; client never invents timezone conversions except display-time truncation (5.5).

### 5.7 Testing

- **Cargo wiremock:** get_kanban_board envelope-shape test (pinned `{"board":…}` shape from api-transforms.ts); enrichment merge (set + clear + dirty-shield skip + non-fatal 500 + parse-error non-zeroing); set_reminder replay (id from row; id from fresh snapshot when NULL; non-kanban → conflict; clear = empty body); set_date with startDate (incl. back-compat byte-identical targetDate-only payload); start_date + server_item_id reconcile capture (path-match and text-adopt arms).
- **Vitest:** AgendaView (groups, chips, click-through selection), sidebar third tab, kanban reminder chip + set/clear modal (portal, no prompt()), voice appointment target (extraction prefill, manual edit, save dispatches the three ops), types mirror.
- **Integration (dev instance, docker-first):** real round-trip — create dated+reminder item via client ops → verify file segment on the jotty container (`reminder:{…}` line) → pull → reminder survives; web-set reminder appears in client after enrichment.
- **Gates:** full vitest + tsc + cargo test + warnings-delta-0 census immediately before citing (baselines drift; re-census by running).

## 6. Ship plan

- New minor version (feature): v0.20.0, executed via SDD (subagent plan after spec approval) per standing process; full ship procedure (gates, bump ×3 + lockfiles, build, tag, release, re-hash).
- The plan phase will grep call sites for every signature this spec changes (NewItem, ItemDto, reconcile, set_date op) and write the counts into briefs (standing plan-phase lesson).

## Appendix A — Upstream issue draft (recurrence + reminder over REST)

> **Title:** Expose item `reminder` and `recurrence` via the REST API
>
> The REST item payloads (`toApiItem` in `app/_utils/api-item.ts`) include `startDate`/`targetDate` but drop `reminder` and `recurrence`, and no REST write path accepts them (the kanban item routes accept `reminder` but recurrence has neither read nor write). Third-party/API-key clients therefore cannot display or manage these kanban features: the web UI authors them via internal server actions, and the websocket reminders are session-cookie-only, so API-key clients are excluded from reminder delivery entirely.
>
> Request: (1) include `reminder` and `recurrence` in item payloads on the checklist/board read endpoints; (2) accept them on item create/patch routes (or dedicated sub-routes like the existing `/reminder` one). This would let desktop/mobile clients round-trip what the web app already supports. Context: building an offline-first desktop client (jotty·page desktop) and a server-side push companion; both currently must read the markdown files directly or go without.