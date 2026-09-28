# Appointments Phase 2 — implementation plan (jotty desktop client)

**Date:** 2026-09-28
**Spec:** `docs/superpowers/specs/2026-09-27-appointments-phase2-design.md` (commit e5e57961 — binding authority)
**Repo:** /coding/jotty, work on `main` (single-maintainer repo; every task commit is reviewed before the next dispatch)
**Execution:** SDD via background subagents; ledger `.superpowers/sdd/2026-09-28-appointments-phase2/progress.md`
**Baselines (re-censused by running, 2026-09-28 00:52 UTC):** vitest **384/384** across 37 files, tsc clean, prompt()-grep 0, cargo **209 passed + 1 ignored** (the extra ignored bins are the integration binaries; the count that matters is the lib's `209 passed; 0 failed; 1 ignored` line), warnings census **18** (Δ must be 0). rustc/cargo 1.98.1, node v26.7.0.

## Global constraints (binding for every task)

1. **TDD**: failing test first → minimal GREEN. Fence tests are binding byte-exact code (census contract: report shas of fenced blocks).
2. **Suite gates**: full `npx vitest run` (expect 384 + the task's new TS tests), `npx tsc -p tsconfig.json --noEmit` clean, `cargo test` (lib line `209 passed; 0 failed; 1 ignored` + task's new Rust tests), **zero NEW compiler warnings** (census 18 baseline, delta 0; re-run `cargo check --all-targets 2>&1 | grep -c '^warning'` when Rust touched). Prose expected-counts vs fences: the FENCE is binding; report actual deltas rather than guessing.
3. Never `cargo fmt` (repo is not rustfmt-formatted). No new crates unless the plan says so (this plan adds NONE — serde/chrono/uuid already in tree).
4. Types contract: TS types mirror the Rust serde camelCase wire (dto.rs) — census field-by-field against the real structs, not against other plan text.
5. `prompt()/alert()/confirm()` stay eradicated: any new user input goes through in-app modals (portal pattern).
6. Sync invariants 1-7 (jotty-client skill) bind: one tx per local mutation + enqueue; push FIFO before pull; reconcile never touches dirty/pending rows; server_item_id NEVER participates in identity matching (stored attribute only — identity stays server_path + text fallback).
7. Commit identity: `git -c user.name=zeus -c user.email=zeus@local commit`. Never run `cargo fmt`. Commit messages conventional.
8. The outbox payload column is a JSON **String** — parse with serde_json before indexing (push.rs:33 precedent).
9. jsdom/RTL rules (standing): fake timers only in tests that never await RTL async utils; `getByText` matches text nodes only; wrap matched row text in elements; component tests that mock `invoke` must re-mock EVERY command the flow touches or spread the base impl; fixture datetimes use `new Date().toISOString()`-derived values when a timer consumes them.

## Pre-dispatch scan rulings (standing plan-phase lesson — verify counts before relying)

- **NewItem NOT extended** (spec §5.2 deviation, ruled): NewItem has ~22 construction sites (6 in items.rs tests, 5 commands/mod.rs, 11 push.rs tests); every local creation path writes None for dates/reminders — fields would be dead weight at every site. Locally-authored dates/reminders ride the existing two-step create→set_date op + the new set_reminder op (exactly how target_date already works: add_item_inner enqueues a separate set_date). NO signature change; 22 call sites untouched.
- **ServerItemFlat.id IS the stable server id** (`flatten`: `id: it.id.clone()`, db/items.rs:34,47) — reconcile just needs to STORE it into the new server_item_id column; no new struct field for the id. ServerItemFlat gains ONLY `start_date`.
- **get_task exists and returns the full board** (client.rs:206, GET /api/tasks/{id}, envelope {"task": …}) and its ServerChecklist carries items — but upstream's tasks GET maps items via `toApiItem` which **drops reminder**; only /api/kanban/{boardId} (`transformBoard`) carries `reminder:{datetime,notified?}` (verified in /tmp/jotty-upstream @ b5458a2: api-item.ts has no reminder; api-transforms.ts transformItem carries it; kanban route: `NextResponse.json({ board: transformBoard(board) })`). So the enrichment fetch uses a NEW client method get_kanban_board → GET /api/kanban/{id} with the {"board": …} envelope; ServerItem gains `reminder` (parsed object, serde default) for that path only.
- **Reminder write is a SEPARATE endpoint from set_date's PATCH**: PUT /api/kanban/{boardId}/items/{itemId}/reminder JSON body {datetime} sets; DELETE (same route, body reminder:"") clears — NOT an empty PUT (PUT without datetime → 400 "Datetime is required"). Client method: set_item_reminder(board_id, item_id, Some(iso)) → PUT; None → DELETE.
- **listMode** is `'notes' | 'checklists'` (store.ts:43) with 15 non-test references; the sidebar tab row (Sidebar.tsx:18-27) and App.tsx ternary (185-188) are the UI gates. 'agenda' joins the union — App renders the third list when listMode==='agenda'; spec-consistent selections keep flipping listMode as today.
- **Voice extraction prompt lives in voice_ai.rs** (TIDY_SYSTEM_PROMPT:34, EXTRACT_SYSTEM_PROMPT:36, tidy():166, extract_tasks():184, parse_tasks():242 tolerant-array parser). Appointments extraction = a NEW prompt + parser fn beside them (extract_appointment), NOT a mutation of the tidy prompt — the tidy step's output contract (cleaned text) is consumed by the review UI verbatim and stays byte-frozen.
- **Voice→board save flow** is TS-store-side (saveVoiceNoteWithBoard, store.ts:161: voiceSaveNote → createBoard/addItem per task). The appointment save follows the same store-side orchestration shape (api calls in sequence; local tx per op lives in Rust commands).
- **get_checklist_inner** nests children from flat rows (attach_items); ChecklistRow carries list_type: String.
- **reconcile writes explicit column lists** (UPDATE at items.rs:117-121, INSERT at 123-129, insert_local INSERT at 154-158) — all three gain start_date + server_item_id; `COLS` const (items.rs:68) + `row()` reader gain the two fields; ItemRow struct too.
- **pull_all** (sync/pull.rs:15-85): upsert tx → tombstone tx → last_sync_at. Enrichment inserts AFTER the tombstone tx, BEFORE last_sync_at write, and must never abort the pull (per-item non-fatal collection, spec §5.3).
- **Push arm pattern**: every item op arm = fetch_list_snapshot → resolve_item_target(…, false) → client call (set_date arm at push.rs:174, byte-shape in comments). The reminder arm follows the same shape but resolves to the STABLE ID instead of an index path (row's server_item_id, else snapshot item id at the resolved path).
- **SyncReportDto** {pending, conflicts, lastSyncAt} (dto.rs:218) gains enrichment_errors — check its TS mirror + SyncBadge usage at review time (badge renders only what it knows; new field is additive/optional on the wire).

## Task 1 — schema v4 + carry server identity & dates through the data layer

**Files:** `src-tauri/src/db/migrations.rs` (v4 block), `src-tauri/src/db/mod.rs` (migration test), `src-tauri/src/db/items.rs` (ItemRow, COLS, row(), NewItem NO-CHANGE, reconcile UPDATE+INSERT arms, insert_local INSERT), `src-tauri/src/db/checklists.rs` (only if upsert/reconcile call sites need the flat struct change — grep `ServerItemFlat {`), `src-tauri/src/jotty/models.rs` (flatten maps start_date; ServerItem gains `reminder` + `reminder_notified` fields with serde defaults — consumed in T2/T3), `src-tauri/src/commands/dto.rs` (ItemDto gains startDate, serverItemId, reminderDatetime, reminderNotified; From<ItemRow> extends; `children` Vec stays last).

```sql
-- v4 (additive only):
ALTER TABLE checklist_items ADD COLUMN start_date TEXT;
ALTER TABLE checklist_items ADD COLUMN server_item_id TEXT;
ALTER TABLE checklist_items ADD COLUMN reminder_datetime TEXT;
ALTER TABLE checklist_items ADD COLUMN reminder_notified INTEGER;
```

Behavior: flatten() maps `start_date: it.start_date.clone()`; reconcile's matched-UPDATE stores `start_date=?8, server_item_id=?9` (from s.start_date / s.id) and resets them to NULL only when the server row lacks the value (same LWW semantics as target_date — the catalog is truth for these columns); the adopt-INSERT carries both. insert_local writes NULL for all four new columns (dirty=1 local rows; values arrive via ops or reconcile). ServerItem keeps parsing (id, start_date already there); add:

```rust
#[serde(default)] pub reminder: Option<crate::jotty::models::ServerReminder>,
```

with

```rust
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerReminder { pub datetime: String, #[serde(default)] pub notified: Option<bool> }
```

Tests (fences in Task 1):
1. `migration_v4_adds_appointment_columns` — open fresh db, run migrations, PRAGMA table_info(checklist_items) contains start_date, server_item_id, reminder_datetime, reminder_notified (shape: mod.rs v3 test).
2. `reconcile_captures_server_item_id_and_start_date` — seed checklist + server items [{id:"srv-1", text:"Dentist", startDate:"2026-10-01", targetDate:"2026-10-01"}, {text:"no-id item"}]; reconcile; assert row1.server_item_id=="srv-1" && row1.start_date=="2026-10-01", row2 both None.
3. `reconcile_update_arm_updates_dates_by_path` — existing row matched by path; server carries new start/target; UPDATE arm writes them (and text-adopt arm too: separate test `reconcile_text_adopt_carries_new_columns`).
4. `item_dto_carries_appointment_fields` — ItemDto::from a row with all four set; assert DTO fields (serde camelCase via a serde_json::to_value assert: startDate, serverItemId, reminderDatetime, reminderNotified).
5. `flatten_maps_start_date` (models unit) — nested ServerItem flatten keeps start_date on children.

Expected: lib test filter `db::items` grows; report exact counts. Fence count: **6 test fns** (5 above + v3-style migration shape may add 1) — plan says 5; implementer reports the delta (binding = fences).

## Task 2 — client: get_kanban_board + set_item_reminder (wiremock-tested)

**Files:** `src-tauri/src/jotty/models.rs` (KanbanBoard/BoardItem parse structs — reuse ServerChecklist? NO: the /api/kanban/{id} item shape is transformItem: {id, index, text, status, completed, priority?, score?, assignee?, reminder?, children?} — a new `ServerKanbanItem` + `KanbanBoard {id, title, category, statuses: Option<Vec<ServerStatus>>, items: Vec<ServerKanbanItem>, createdAt, updatedAt}`), `src-tauri/src/jotty/client.rs` (get_kanban_board, set_item_reminder), wiremock tests in client.rs tests mod (follow get_task's envelope test precedent).

- `get_kanban_board(board_id) -> AppResult<KanbanBoard>`: GET /api/kanban/{id}; MUST unwrap the top-level `"board"` envelope (get_task precedent; a bare parse = the get_categories silent-empty class). Envelope-shape wiremock test mandatory: pinned response `{"board": {"id":"b1","title":"Appointments","category":"Life","statuses":[...],"items":[{"id":"srv-1","index":0,"text":"Dentist","status":"todo","completed":false,"reminder":{"datetime":"2026-10-01T09:00:00.000Z","notified":false}}],"createdAt":"...","updatedAt":"..."}}`; assert parsed board.items[0].reminder == Some(ServerReminder{datetime, notified}).
- Reminder absent → `reminder: None` (serde default; a second test mounts a board with NO reminder key → parses to None, not an error).
- `set_item_reminder(board_id, item_id, datetime: Option<&str>)`: Some(iso) → PUT /api/kanban/{boardId}/items/{itemId}/reminder body {"datetime": iso}; None → DELETE same URL body {} (upstream DELETE route appends reminder:"" — the EMPTY body is the clear). Wiremock tests: PUT asserted on method+path+JSON body; DELETE asserted on method+path; non-2xx → AppError::Api (error mapping matches existing api_send paths).
- Parse failure of a malformed board → Err (never silently-empty: the get_categories envelope lesson).

Tests (client.rs tests mod): 4 fns (envelope+reminder parse, reminder-absent, PUT shape, DELETE clear).

## Task 3 — sync: enrichment pass + set_reminder op + set_date startDate extension

**Files:** `src-tauri/src/sync/pull.rs` (enrichment fn + call site in pull_all), `src-tauri/src/sync/push.rs` (set_reminder arm; set_date arm startDate), `src-tauri/src/sync/mod.rs` (SyncReport carries enrichment_errors → dto), `src-tauri/src/commands/dto.rs` (SyncReportDto gains `enrichment_errors: usize`), `src-tauri/src/db/items.rs` (set_reminder row writer: reminder columns, NOT dirty — enrichment is a server-mirror; local set_reminder command variant marks dirty), `src-tauri/src/commands/mod.rs` (set_item_reminder_inner command: kanban-gate + dirty row + enqueue), `src-tauri/src/commands/lib.rs`? (command registration — check lib.rs invoke_handler list; add set_item_reminder + list_agenda in T4 together).

**Enrichment (pull_all tail, after tombstone tx, before last_sync_at):**

```rust
// for every checklist row (deleted_at IS NULL, dirty=0) with list_type in kanban family
// ("kanban" or legacy "task"): get_kanban_board(id) → merge per item:
// match by server_item_id (row.server_item_id == Some(srv.id)); fallback: server_path→index-path
// (s.index/DFS path "0", "0.1") then text tiebreak — SAME resolution order as reconcile.
// PER-ITEM shield: skip items with a pending outbox op for ("checklist_item", local_id).
// write reminder_datetime + reminder_notified; server shows none → clear both (server truth).
// per-board failure (network/404/500/parse) → enrichment_errors += 1, keep last-known, continue.
```

- Enrichment writes must NOT set dirty (server-mirror only; the dirty flag is owned by local edits + ops).
- Per-ITEM pending shield (spec §5.3 fix): `outbox::has_pending_for(conn, "checklist_item", &local_id)` per candidate row; siblings still enrich.
- PullStats gains `enrichment_errors: usize`; SyncReportDto mirrors (additive; SyncBadge untouched this task — badge ignores unknown fields; TS type gains optional field in T5).
- Wiremock tests (pull.rs tests): (1) enrichment merges reminders (board mock with reminder → local row reminder_datetime set, notified=0/1 mapped); (2) server-no-reminder clears local reminder; (3) per-item pending-op shield (item with pending set_reminder op untouched; sibling enriched); (4) board 500 → stats.enrichment_errors==1, pull still Ok, other boards unaffected, last_sync_at still written; (5) envelope mismatch (bare object, no "board" key) → counted as enrichment error, local values NOT zeroed.

**set_date startDate extension (push.rs set_date arm):** payload MAY carry "startDate"; replay PATCHes present keys:

- client.rs `update_item_target_date` gains a sibling `update_item_dates(list_id, path, start_date: Option<&str>, target_date: Option<&str>, include_start: bool, include_target: bool)`? NO — simpler + back-compat: keep update_item_target_date byte-identical; add `update_item_start_date(list_id, path, start_date: Option<&str>)` PATCHing only startDate. The set_date replay reads `payload["startDate"]`: absent → old behavior (PATCH targetDate only); present → PATCH startDate AND targetDate (two sequential PATCHes, targetDate first — preserves the existing single-op semantics; both ride the same resolved path from ONE fetch_list_snapshot). Payload contract: `{checklist_id, item_local_id, targetDate, startDate?}` (startDate key present ONLY when the command got one — byte-identical legacy payloads, pinned by existing fence `item_set_date_ops_replay_as_target_date_patches` staying green unmodified).
- commands/mod.rs `set_item_target_date_inner` gains an optional `start_date: Option<String>` param → payload gains "startDate" key only when Some; the tauri command `set_item_target_date` gains an optional arg (TS passes undefined = absent — check `invoke` arg forwarding: Rust `Option<String>` + serde from_value tolerates missing key when the TS side omits it; verify with the existing optional-arg precedent update wrappers). Frontend caller changes ride T6/T7.
- New wiremock tests: set_date with startDate present → PATCH body has BOTH keys; legacy payload → PATCH body has targetDate only (assert body key count).

**set_reminder op ("checklist_item","set_reminder") payload {checklist_id, item_local_id, datetime}:**

- Enqueue site: commands/mod.rs `set_item_reminder_inner(conn, checklist_id, item_local_id, datetime: Option<String>)` — gate: owning list must be kanban family (read ChecklistRow.list_type; non-kanban → Err BEFORE writing) — UI gates too; the inner is the defense. Row write: reminder_datetime + dirty=1 (local edit owns the server write). Enqueue op.
- Replay arm (push.rs): fetch_list_snapshot → resolve_item_target(…, false) [index-path/text, same as set_date] → THEN resolve stable id: row.server_item_id if Some; else the snapshot item at the resolved path's `id` field (ServerItem.id — flatten carries it; extend fetch_list_snapshot's retained struct if needed — CHECK: snapshot items are ServerItem-flat? read push.rs fetch_list_snapshot — it fetches the checklist catalog and matches by path; its items carry ServerItem.id) → call client.set_item_reminder(list_id, item_id, datetime). Neither id source → mark_conflict "server does not expose stable item ids".
- Kanban-gate at replay: owning list's list_type (from the local checklist row) non-kanban → mark_conflict with "reminders only work on kanban boards" (upstream would 404/400 anyway; conflict is the resolvable path).
- Ordering note: create → set_date → set_reminder replay FIFO-clean (same shape as existing set_date-after-create; each op re-fetches snapshots — fine).
- Wiremock tests: (1) reminder op on item with row server_item_id → PUT to /api/kanban/{boardId}/items/{srv-id}/reminder with {"datetime": iso}; hit-counter the PUT endpoint; (2) row server_item_id NULL + snapshot item carries id → PUT uses snapshot id; (3) neither → conflict counted, op state='conflict'; (4) clear (payload datetime null) → DELETE hit; (5) non-kanban owning list → conflict without any HTTP hit (assert the board PUT counter == 0).

## Task 4 — list_agenda command + AgendaEntryDto

**Files:** `src-tauri/src/commands/dto.rs` (AgendaEntryDto), `src-tauri/src/commands/mod.rs` (list_agenda_inner + #[tauri::command] list_agenda), lib.rs registration.

```rust
#[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")]
pub struct AgendaEntryDto {
    pub checklist_id: String, pub checklist_title: String,
    pub item_local_id: String, pub text: String, pub completed: bool,
    pub start_date: Option<String>, pub target_date: Option<String>,
    pub reminder_datetime: Option<String>, pub reminder_notified: Option<bool>,
    pub status: Option<String>, pub position: i64,
}
```

`list_agenda_inner(conn)`: single SQL — join checklist_items (target_date NOT NULL, no parent filter: children included) with checklists (deleted_at IS NULL, dirty=0, list_type any) ORDER BY target_date ASC, position ASC. Pure local read, no network (ruling P precedent). Command wrapper maps error to String.

Tests: (1) returns dated items across two lists sorted by target_date; (2) excludes deleted lists + tombstoned/deleted items + undated items; (3) reminder/notified pass through; (4) children with dates included (join on item rows directly — no nesting filter).

## Task 5 — TS types + client bindings (mirror + invoke wrappers)

**Files:** `src/api/types.ts` (ItemDto gains `startDate?: string | null; serverItemId?: string | null; reminderDatetime?: string | null; reminderNotified?: boolean | null;` — census against dto.rs after T1 lands, not against this plan text; AgendaEntryDto; SyncReportDto enrichment_errors optional), `src/api/client.ts` (`listAgenda = () => invoke<T.AgendaEntryDto[]>('list_agenda')`, `setItemReminder = (checklistId, itemLocalId, datetime: string | null) => invoke<void>('set_item_reminder', { checklistId, itemLocalId, datetime })`, `setItemTargetDate` gains optional startDate arg (Rust Option tolerates the absent key — verify at T1's DTO test), `setItemStartDate`? NO — the spec's single set_date op carries both; TS exposes `setItemTargetDate(checklistId, itemLocalId, targetDate, startDate?)`).

Tests: a types-mirror unit (existing pattern: dto census test file? check src/api/types test if one exists — if none, a small structural test asserting the invoke arg shape via the existing mock harness in App.test? Keep: NO new test file if the repo has no types-mirror precedent — the Rust side pins the wire; TS side gets coverage via component tests in T6/T7. Standing rule says types.ts MUST mirror — reviewer checks field-by-field.)

## Task 6 — AgendaView + sidebar third tab + plain-list date chips

**Files:** `src/components/AgendaView.tsx` (+ test), `src/components/Sidebar.tsx` (third tab), `src/stores/store.ts` (ListMode gains 'agenda'; selectAgenda semantics via setListMode('agenda')), `src/App.tsx` (listMode==='agenda' → <AgendaView/> in the left list pane, list-only style), `src/components/ChecklistList.tsx` (row date chip: item-less lists only — SKIP: dates live on items not lists; instead ChecklistView rows gain a date chip read from item.targetDate — display-only), `src/styles.css` (agenda styles, .agenda-*), tests: AgendaView.test.tsx, Sidebar.test.tsx additions, App.test.tsx wiring test.

- AgendaView: `useEffect` → api.listAgenda(); groups = Overdue (< today, not completed), Today, Tomorrow, Next 7 days, Later (computed from targetDate's date-key in local TZ — `new Date(iso)` and compare y/m/d; date-only strings parse as UTC midnight — disclose: same rule as upstream toDateKey, drift ≤ 1 day only for date-only strings from other TZs, acceptable v1); entry = text + checklist title + time (ISO carries it) + 🔔 chip (dimmed when reminderNotified) + completed style; click → selectChecklist(checklistId) + highlight `#item-<localId>` (ChecklistView has id=item-<localId> rows — scrollIntoView best-effort in a try/catch).
- Sidebar: third tab button Agenda (sec-toggle, selected when listMode==='agenda').
- App: `{listMode === 'agenda' ? <AgendaView/> : listMode === 'notes' ? <NoteList .../> : <ChecklistList .../>}` — agenda stays list-only (nothing opens in the right pane until a click-through).
- ChecklistView row: `{item.targetDate && <span className="item-date-chip">{item.targetDate}</span>}` next to item-text (pure addition — RTL text-matcher fences stay green).
- Vitest: AgendaView groups/reminder chip/click-through (3 fns), sidebar third tab (1), App agenda wiring (1), ChecklistView chip (1) — 6 fns expected.

## Task 7 — kanban reminder UI (chip + set/clear modal)

**Files:** `src/components/KanbanBoard.tsx` (reminder chip on card + menu rows Set reminder/Clear reminder + datetime-local input in the menu (kanban-date-edit pattern — it's an in-menu inline editor, NOT window.prompt), `src/styles.css` chip style, `src/components/KanbanBoard.test.tsx` additions.

- Chip: `{item.reminderDatetime && <span className={`kanban-badge kanban-reminder${item.reminderNotified ? ' notified' : ''}`}>🔔 {formatReminder(item.reminderDatetime)}</span>}` — formatReminder: local short datetime (toLocaleString or manual y/m/d hh:mm; tests assert on the raw ISO substring to avoid TZ-dependent assertions — pin the chip test to `toContainText('🔔')` + the raw ISO substring).
- Menu rows: "Set reminder" → inline editor (input type="datetime-local" prefilled from reminderDatetime) → Save → api.setItemReminder(checklistId, localId, value || null) → reload; "Clear reminder" only when set → setItemReminder(…, null).
- saveVoiceNoteWithBoard NOT touched here. Tests: chip renders (set + notified dimming via class), set flow dispatches setItemReminder with the typed value, clear flow passes null, no prompt() anywhere (grep gate).

## Task 8 — voice → appointment (extraction + review UI + save flow)

**Files:** `src-tauri/src/voice_ai.rs` (APPT_EXTRACT_SYSTEM_PROMPT + extract_appointment fn + tolerant parse of {title?, date?, time?} — a JSON OBJECT, not the tasks array), `src-tauri/src/commands/mod.rs` (voice_extract_appointment command: model gate like extract_tasks; NO db write), `src/api/client.ts` (voiceExtractAppointment), `src/components/VoiceNoteReview.tsx` (Appointment flow: board select + title/date/time/reminder fields, save = saveVoiceNoteWithBoard extension), `src/stores/store.ts` (VoiceBoardInput gains appointment?: {text: string; targetDate: string | null; reminderDatetime: string | null; boardId: string | null} — when present the board stage creates the card via addItem → setItemTargetDate → setItemReminder on targetBoardId instead of the tasks loop), tests: voice_ai.rs unit (prompt + parse), commands test (model gate), VoiceNoteReview.test.tsx (extraction prefill + manual edit + save dispatch), store test (appointment branch enqueues the three ops via the api mocks).

- Prompt: `pub const APPT_EXTRACT_SYSTEM_PROMPT: &str = "You extract ONE appointment from a voice-memo transcript. Reply with ONLY a JSON object — no prose, no code fences: {\"title\": string, \"date\": \"YYYY-MM-DD\" | null, \"time\": \"HH:MM\" | null, \"reminder\": true}. date/time null when the transcript does not name them. Never invent facts. If no appointment exists, reply with {\"title\": null}."` + `extract_appointment(model, text) -> AppResult<AppointmentDraft>` (parse: strip fences, first '{' .. last '}', serde_json::from_str, title null → Ok(None)-style; tolerant like parse_tasks). Commands fn voice_extract_appointment(text) -> Option<AppointmentDto> (title/date/time/reminder flag).
- TargetDate format: upstream accepts ISO date strings; when time known → `{date}T{time}:00` (local, no TZ suffix — upstream truncates to date-key for display and the scanner parses naive local; verify vs references/upstream-jotty-facts.md datetime shape during implementation, disclose the exact chosen format in the report).
- Reminder default: time known → the appointment datetime; date-only → NO reminder (user adds one in the kanban UI).
- Save (store): the appointment branch reuses saveVoiceNoteWithBoard's note-save stage, then for the board stage: api.addItem(boardId, title, null, null) → api.setItemTargetDate(boardId, itemLocalId, targetDate) → api.setItemReminder(boardId, itemLocalId, reminderDatetime) — each call is its own Rust tx (existing invariant); no new Rust orchestration needed.
- VoiceNoteReview: third action button "Save as appointment" (alongside note/board) → shows the appointment panel (board select = existing kanban boards dropdown, title/date/time prefilled from extraction, reminder toggle defaulting per the rule) → save → onClose.

## Task 9 — integration + whole-branch readiness (dev instance round-trip)

**Files:** `src-tauri/tests/integration_real.rs` (EXTEND the existing #[ignore]-gated file — env JOTTY_TEST_URL/JOTTY_TEST_API_KEY; SKIPPED without env is the EXPECTED reportable outcome, never fabricate), README/docs not required.

- Test (ignored+env-gated, compiles in default run): connect real instance → create board "Agenda test" → addItem + setItemTargetDate + setItemReminder → verify the kanban GET (get_kanban_board) returns the reminder → web-side file segment contains `reminder:{` (docker exec grep) → pull_all → local row carries reminder_datetime + server_item_id.
- docker compose config parse check (no up): `docker compose -f dev/docker-compose.yml config` exit 0.
- If no daemon/env: report SKIPPED + parse-only; never fabricate.

## Ship (post-tasks, controller-run)

1. Final whole-branch review (review-package merge-base..HEAD; matrix: vitest + tsc + cargo + warnings census + prompt()-grep).
2. Version bump v0.20.0 (package.json, tauri.conf.json, Cargo.toml, both lockfiles), gates re-run, build desktop + android, tag, release, re-hash assets, ledger + skill updates.

## Global Constraints (repeat of the binding block for brief extraction)

- TDD red→green per fence; fence bytes = binding (census contract, sha quoted with convention incl. trailing newline).
- Gates: vitest full + tsc + cargo lib (`209 passed; 0 failed; 1 ignored` baseline + task fences) + warnings Δ0 (18 baseline).
- Sync invariants 1-7 (skill) bind; server_item_id is NEVER an identity key.
- No new crates; no cargo fmt; repo-local commit identity via -c flags; conventional commits.
- prompt()/alert()/confirm() stay eradicated.
- TS types mirror dto.rs wire shapes (census field-by-field at implementation time).
- Integration tests env-gated; SKIPPED without env is reportable; NEVER fabricate a run.