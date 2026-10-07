# Triage View (P2) Implementation Plan — capture pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the manual triage surface: a keyboard-first TriageView over `!INBOX` notes with client-validated route enum, move+rename and promote-to-board primitives (local-first, outbox replayed), stale-guard, and discard.

**Architecture:** Reuse the existing outbox/local-first engine. A note move = the existing `update_note` path extended with `originalCategory` (the probe-verified one-call move+rename wire primitive). Promote = ONE transaction inserting the board item + note move (`PROCESSED` + provenance line), both replayed by the existing push engine. TriageView replaces the plain inbox list when the `!INBOX` zone is selected; no AI in P2 (P3 adds suggestion badges on the same route enum).

**Tech Stack:** Rust (tauri 2, rusqlite), React TS + zustand, vitest + RTL, wiremock for client tests.

**Spec:** `docs/superpowers/specs/2026-10-06-atomic-capture-ai-triage-design.md` (§2 zones, §4 TODO zone, §5 triage view + rules, §6 lifecycle, §9 P2 line). Facts: `.superpowers/sdd/2026-10-07-capture-p2-p3/facts.md` (leaf-verified @ `34438b5`).

## Global Constraints

- **Zone literals:** `!INBOX` (existing `INBOX_CATEGORY`/`isCaptureZone`, store.ts:10-12); `PROCESSED` is introduced by P2 promote/move ONLY — never elsewhere; P4 owns `PROCESSED/Archive/YYYY-MM` (do not build it).
- **originalCategory law:** the note-update wire body carries `originalCategory` ONLY when the category actually changes (payload key omitted otherwise → queued old ops byte-stable, autosave path unchanged). `update_note_inner` computes it from the PRE-patch row; the push arm reads it optionally; `client.update_note` gains `original_category: Option<&str>`.
- **Stale-guard law:** EVERY triage apply revalidates inside its tx: note row exists AND `deleted_at IS NULL`, else `AppError::Other("stale: note no longer exists")` — and ZERO outbox ops enqueue on failure.
- **Promote atomicity:** promote is ONE `conn.transaction()`: board item insert + item create op + note update + note update op + provenance content — all-or-nothing. Board FK (`foreign_keys=ON`) makes a missing board fail the tx.
- **Provenance line (spec §6, greppable):** `format!("↳ {} → Board \"{}\" / item \"{}\"", Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true), board_title, trimmed_card_text)` appended as `format!("{}\n\n{}", row.content.trim_end(), line)`.
- **One-tx law (standing):** every local mutation = ONE transaction (entity + outbox op). No nested transactions — promote composes row helpers (`items::insert_local`, `notes::update_local`, `outbox::enqueue`) inside a single tx, replicating `add_item_inner`'s enqueue shape (`{"checklist_id","item_local_id","text","parent_local_id"}`, NO `status` key when None, NO set_date op — facts §2/§6).
- **No server fork / stock API 1.28.0.** No new crates, no new npm deps. No `cargo fmt`. Warnings census: `cargo check --all-targets 2>&1 | grep -c '^warning'` = **18, Δ0 gate**.
- **Byte-frozen fences (must not change):** card-wall DOM classes + `styles.css` card-wall block (incl. `li.selected` rider-c block, styles.css:365-366); `.back-btn` base rule; CommandBar 7-pinned-commands fence (P2 adds NO CommandBar/palette changes); `.command-row`/modal classes; sidebar `.count` chip. **Consciously amended in P2 (disclose in reports):** the App full-swap ternary gains ONE sibling branch `inboxSelected ? <TriageView …> : …` before the agenda branch (listMode STAYS 3 values; TriageView renders `<section id="triage">`, keeps `main` list-only semantics); the App window-key listener gains a Ctrl+Shift+I branch.
- **Do NOT touch:** `visibleNotes` prefs-bypass IIFE (P1 rider — the filteredNotes inbox branch stays as-is, now dead-on-mount for NoteList); `QuickCapture`; VoiceNoteReview (title helper is RE-IMPLEMENTED in `src/triage/titles.ts`, VoiceNoteReview.tsx:9-15 stays untouched).
- **P2 has NO AI calls, NO OpenWebUI use, NO AI-assisted anything** — P3 layers that on the route enum.
- **Amendment pre-rule:** an existing test that pins a 3-key PUT body for a CATEGORY-CHANGING update (if any exists) must be amended to expect `originalCategory` — disclose the amendment; category-unchanged bodies must remain 3-key.
- **Gates per task:** `NODE_OPTIONS=--no-webstorage npx vitest run` ≥566 passing, zero NEW failures (known cosmetic unhandled rejection at ChecklistView.tsx:26-31 excluded); `npx tsc -p tsconfig.json --noEmit` clean; `DISPLAY=:99 cargo test --lib --manifest-path src-tauri/Cargo.toml` ≥301 + 1i, zero NEW failures; census = 18 Δ0 (Rust tasks; re-run for TS-only tasks after Cargo.toml changes — none planned). **Re-measure baselines by RUNNING the gates immediately before each dispatch** (2026-10-07 clean-HEAD measurement @ `34438b5`: vitest 566/48 files, cargo 301+1i, census 18).
- **Tauri ACL:** app-owned custom commands need NO capabilities grants; P2 adds NO plugins.
- **Tests conventions:** RTL mock `@tauri-apps/api/core` (`invoke` spy), store reset `useStore.setState({…} as never)`; RTL `getByText` matches TEXT NODES only — wrap interpolated text in elements; keyboard tests `fireEvent.keyDown(window, {key, ctrlKey, shiftKey})`; guard any `scrollIntoView` call (`typeof el.scrollIntoView === 'function'`). Rust: inline `#[cfg(test)] mod tests`, tempfile `db()` helper; `board_statuses` FK → seed checklist row first.
- **Commits:** conventional message, body explains behavior + test counts; `git -c user.name=zeus -c user.email=zeus@local commit`.

## Review Focus

1. **Same note triaged concurrently from two surfaces** (phone moved/deleted server-side, desktop applies): expected = the apply fails safe or wins by LWW — never duplicates or resurrects. Pinned by the stale-guard tests (T2) + the 404→conflict classifier (T1 pin: body carries originalCategory; server 404 lands in `mark_conflict`, nothing silent).
2. **Move to a not-yet-existing category** (e.g. `LIBRARY/Docs` first use): expected = ONE PUT, no pre-creation call, implicit server-side category creation. Pinned by move-flow test asserting exactly one `update_note` invoke.
3. **Promote interrupted mid-flow** (board absent / FK violation): expected = NOTHING enqueued, note untouched in `!INBOX`. Pinned by T2's failure tests.
4. **Empty inbox / zero cards**: expected = friendly empty state, j/k/a/m/x no-crash, no division-by-zero in clamping. Pinned by T3 tests.
5. **Typing inside triage modals**: expected = j/k/a/m/x NEVER fire while an input/textarea/contenteditable has focus or a modal is open. Pinned by T3/T4 guard tests.

---

### Task 1: Note move/rename wire upgrade (originalCategory end-to-end)

**Files:**
- Modify: `src-tauri/src/jotty/client.rs` (update_note, ≈:183-189 + wiremock tests module ≈:404+)
- Modify: `src-tauri/src/sync/push.rs` (update arm ≈:90-103)
- Modify: `src-tauri/src/commands/mod.rs` (update_note_inner ≈:62-79)
- Test: co-located wiremock + push tests (find the existing update_note wiremock test and the push note-update test as fences)

**Interfaces:**
- Produces: `JottyClient::update_note(&self, id: &str, title: &str, content: &str, category: &str, original_category: Option<&str>) -> AppResult<ServerNote>` — body `{"title","content","category"}` + `"originalCategory"` **only when Some**.
- Produces: `update_note_inner` enqueues payload `{"title","content","category"}` + `"originalCategory": <pre-patch category>` **only when `patch.category` is Some and ≠ pre-patch row category** (capture pre-patch row via `notes::get` BEFORE `notes::update_local`; payload stays the post-patch merged copy per Ruling H).
- Produces: push update arm passes `payload.get("originalCategory").and_then(Value::as_str)` as the new arg.
- Consumes: unchanged TS `api.updateNote(id,title,content,category)` — untouched, byte-stable call sites (client.ts:10, NoteEditor.tsx:52-55, store.ts:211).

- [ ] **Step 1: RED wiremock tests** (client.rs tests): `update_note_with_original_category_sends_key` (Some("HOME") → body has `originalCategory == "HOME"`, still 3 base keys) and `update_note_without_original_category_omits_key` (None → body == exactly `{"title","content","category"}`).
- [ ] **Step 2: RED push test** (sync push tests): `note_update_arm_passes_original_category` — payload with `originalCategory` → PUT body carries it; second test: payload without → body omits it.
- [ ] **Step 3: Run them** — `cargo test --lib` — expected: NEW tests FAIL (compile error accepted as RED for the signature change; disclose the shape).
- [ ] **Step 4: Implement** the three surfaces above (signature change ripples to: push arm call site; existing wiremock update_note tests; any direct client.rs tests calling update_note — amend minimally, disclose each).
- [ ] **Step 5: `update_note_inner` original-category capture** + test `update_note_inner_stamps_original_category_when_category_changes` (patch category HOME→WORK → payload has `originalCategory:"HOME"` + merged fields) + `update_note_inner_omits_original_category_when_category_unchanged` (same category → byte-stable 3-key payload; also covers title/content-only edits).
- [ ] **Step 6: Gates:** cargo --lib (≥301+1i, zero NEW failures, census 18 Δ0), vitest (≥566, TS untouched — sanity), tsc.
- [ ] **Step 7: Commit** `feat(capture): originalCategory on note moves (one-call move+rename primitive)`.

### Task 2: promote_note_to_board primitive (one tx, provenance, stale-guard)

**Files:**
- Modify: `src-tauri/src/commands/mod.rs` (new `promote_note_to_board_inner` + tauri command `promote_note_to_board` near add_item ≈:254-292)
- Modify: `src-tauri/src/lib.rs` (register ≈:60-72 cluster)
- Test: co-located `#[cfg(test)]` block

**Interfaces:**
- Produces: `pub(crate) fn promote_note_to_board_inner(conn: &mut Connection, note_id: &str, board_id: &str, card_text: &str, new_title: &str) -> AppResult<NoteDto>`
- Produces: tauri command `promote_note_to_board(state, note_id: String, board_id: String, card_text: String, new_title: String) -> Result<NoteDto, String>`; TS binding lands in Task 5 as `promoteNoteToBoard(noteId, boardId, cardText, newTitle)` → `invoke('promote_note_to_board', {noteId, boardId, cardText, newTitle})`.
- Consumes: `items::insert_local(&tx, &items::NewItem{checklist_id, parent_local_id: None, text, status: None, priority: None, target_date: None})`; `outbox::enqueue(&tx, "create", "checklist_item", &item_local_id, payload)`; `notes::update_local`; `notes::get`; `db::checklists` row read for board title (read the exact helper name in db/checklists.rs — stop-contract if absent).
- Semantics (ONE tx, in order): (1) pre-patch note row via `notes::get` — None or `deleted_at.is_some()` → `Err(AppError::Other("stale: note no longer exists"))`, NO enqueues; (2) board row — missing → `Err(AppError::Other("board not found"))`, NO enqueues (seed checklist row before item insert: FK law); (3) `card_text.trim()` empty → `Err(Other("empty card text"))`; (4) item insert (trimmed text); (5) enqueue item-create op — payload EXACTLY `{"checklist_id": board_id, "item_local_id": <uuid>, "text": trimmed, "parent_local_id": null}` (no status/date keys — plain-list byte-stability law); (6) provenance line per Global Constraints onto content; (7) `notes::update_local` with `title: Some(if new_title.trim().is_empty() { row.title } else { new_title.trim().to_string() })`, `content: Some(new_content)`, `category: Some("PROCESSED")`; (8) enqueue note-update op payload `{"title","content","category"}` merged + `"originalCategory": <pre-patch category>` (always present here — category always changes); (9) return the updated row as `NoteDto`.

- [ ] **Step 1: RED tests** — `promote_happy_path_atomic` (assert note row: category=PROCESSED, title=new, content ends with provenance line; assert ONE item row on board with trimmed text; assert outbox has EXACTLY 2 rows: seq1 = item create w/ 4-key payload, seq2 = note update w/ 3+1 keys, both entity/kind correct); `promote_stale_note_fails_without_enqueues` (soft-delete the note first → Err "stale", outbox EMPTY, no item row); `promote_missing_board_fails_without_enqueues` (nonexistent board_id → Err "board not found", outbox EMPTY — FK or explicit check, either acceptable, disclose which fired); `promote_blank_title_keeps_entropy_title`; `promote_trims_card_text_and_rejects_empty`; `provenance_line_format_is_greppable` (assert the exact `↳ ` prefix + ` → Board "` + `" / item "` structure + RFC3339 `Z` timestamp).
- [ ] **Step 2: Run** — expect compile-RED on missing fn, then behavioral RED as tests are added.
- [ ] **Step 3: Implement** per Semantics above; register command in lib.rs.
- [ ] **Step 4: Gates:** cargo --lib (≥301+1i baseline +5 new = **≥306+1i expected, zero NEW failures**; census 18 Δ0); vitest sanity; tsc.
- [ ] **Step 5: Commit** `feat(capture): promote_note_to_board primitive (atomic promote + provenance)`.

### Task 3: Route enum + title helper + TriageView shell (list, selection, keyboard)

**Files:**
- Create: `src/triage/routes.ts`, `src/triage/routes.test.ts`, `src/triage/titles.ts`, `src/triage/titles.test.ts`, `src/components/TriageView.tsx`, `src/components/TriageView.test.tsx`

**Interfaces:**
- Produces: `TRIAGE_ROUTES = ['TODO','COMMANDS','DOCS','NOISE'] as const`; `type TriageRoute = (typeof TRIAGE_ROUTES)[number]`; `isTriageRoute(v: unknown): v is TriageRoute` (case-SENSITIVE); `TRIAGE_MOVE_PRESET: {COMMANDS: 'LIBRARY/Commands', DOCS: 'LIBRARY/Docs'}`.
- Produces: `titleFromText(text: string): string` — first sentence via `trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed`, truncate >60 → first 57 + '…' (mirror of VoiceNoteReview.tsx:9-15 logic, re-implemented per Do-NOT-touch rule).
- Produces: `TriageView({ notes }: { notes: T.NoteDto[] })` — full-screen `<section id="triage">`: header h2 `Triage` + `<span class="triage-count">{N}</span>`; `ul.triage-list` of `li.triage-card(.selected)` each with `.triage-title` span, `.triage-snippet` p (single-line: `n.content.replace(/\s+/g,' ').trim().slice(0,160)`), `.triage-date`, action row buttons `Promote` / `Move…` / `Discard`; sorts internally `createdAt` desc (tiebreak `id`); `empty` state: `li.triage-empty` with `Inbox is empty 🎉`; activeIndex state, j/k clamp+select (guard: skip when `e.defaultPrevented`, when target is input/textarea/contenteditable, or when the modal-open ref is true — mirror into a ref each render, stale-closure law); `scrollIntoView` guarded call on selection change; action buttons + a/m/x keys call THE SAME no-op-later handler set (Task 4 wires real flows; Task 3 handlers are placeholders that still guard keys) — NOTE: implement the key handler CALLING the current onAction mapping so Task 4 only changes the mapping.
- Consumes: `isCaptureZone` from store (for internal zone filtering safety-net: view filters its OWN list defensively too).

- [ ] **Step 1: RED unit tests** — routes.test.ts: valid member true; invalid string false; case-sensitive (`todo` false); non-string false. titles.test.ts: sentence split; no-punctuation falls back to whole trimmed text; >60 truncates at 57 + '…'.
- [ ] **Step 2: RED component tests** — TriageView.test.tsx: renders cards sorted newest-first (seed notes with createdAt out of order; query `.triage-snippet` texts in DOM order); j/k moves `.selected` (fireEvent.keyDown(window)); keys ignored while input focused (render a focused input inside the section? — use the modal-less guard test: fire keydown with target an input element); empty inbox renders `triage-empty`; buttons render with exact labels.
- [ ] **Step 3: Gates:** vitest (≥566 + 9 new = **≥575**), tsc; cargo untouched (skill census rule N/A — no Cargo.toml change).
- [ ] **Step 4: Commit** `feat(triage): route enum, title helper, TriageView shell (keyboard-first list)`.

### Task 4: Triage actions wired (promote/move modals, discard, apply flows)

**Files:**
- Create: `src/components/TriagePromoteModal.tsx`, `src/components/TriageMoveModal.tsx` (+ co-located tests `TriagePromoteModal.test.tsx`, `TriageMoveModal.test.tsx`)
- Modify: `src/components/TriageView.tsx` (real handlers + error line), `src/components/TriageView.test.tsx`
- Modify: `src/api/client.ts` (add `promoteNoteToBoard` binding — Task 2's command)

**Interfaces:**
- Consumes: `promoteNoteToBoard` (Task 2 command shape); `api.updateNote(id, title, content, category)` (unchanged signature — move flows through it and the Rust layer attaches originalCategory); store `deleteNote`, `refreshAll`; `Dropdown` component (contract facts §11); boards list = `useStore(s => s.checklists).filter(c => c.listType === 'kanban' || c.listType === 'task')` (STOP-CONTRACT: verify `ChecklistDto.listType` values against dto.rs before authoring — if the field/name differs, STOP and report, do not improvise).
- Produces: `TriagePromoteModal({isOpen, onClose, onConfirm(boardId, cardText, newTitle), boards: {id, title}[], defaultText, defaultTitle, error?})` — Dropdown for board (placeholder when no boards: `No kanban boards yet` and confirm disabled), card-text input (defaultValue = first non-empty line of content, max 120: `content.split('\n').map(s=>s.trim()).find(Boolean)?.slice(0,120) ?? ''`), title input (defaultValue = `titleFromText(content)`); `.modal-card` markup + PromptModal behavior law (re-seed on open, focus, Escape closes without confirm).
- Produces: `TriageMoveModal({isOpen, onClose, onConfirm(category, newTitle), presets: string[], defaultCategory, defaultTitle})` — category input + preset chips (`LIBRARY/Commands`, `LIBRARY/Docs` clickable fills input), rename input (empty → keep current title).
- Produces (TriageView apply flow): `a`/Promote → TriagePromoteModal → onConfirm: `await api.promoteNoteToBoard(n.id, boardId, cardText, newTitle)` then `await useStore.getState().refreshAll()`; `m`/Move… → TriageMoveModal → `await api.updateNote(n.id, newTitle.trim() || n.title, n.content, category.trim())` + refreshAll; `x`/Discard → ConfirmModal (destructive, title `Discard capture`, confirmText `Discard`) → `useStore.getState().deleteNote(n.id)` + NO extra refresh (deleteNote already refreshes); on ANY error: error line renders the stringified error (`.triage-error`, `String(e)` strip style); after successful apply: clear modal, clamp activeIndex to the new list length.
- Keep: the stale-guard is SERVER-side (Rust); the view additionally re-checks the note still exists in `store.notes` before opening a modal (defensive double-guard; if gone, clear selection).

- [ ] **Step 1: RED modal tests** — each modal: renders with defaults; Escape/Cancel close without confirm; confirm passes exact values (mock-free props tests mirroring PromptModal.test.tsx shapes).
- [ ] **Step 2: RED flow tests** (TriageView.test.tsx, invoke mocked): promote flow invokes `promote_note_to_board` with `{noteId, boardId, cardText, newTitle}` exact args; move flow invokes `update_note` with `{id, title, content, category}` (title falls back to note title when rename blank; category from preset chip click); discard opens ConfirmModal and `delete_note` invoked on confirm; apply failure renders the error line and does NOT clear the modal; note missing from store → modal never opens.
- [ ] **Step 3: Gates:** vitest (≥575 + ~12 = **~587**, exact count from fences — arithmetic in report), tsc.
- [ ] **Step 4: Commit** `feat(triage): promote/move/discard flows with HITL modals`.

### Task 5: App integration + CSS + visual QA probes

**Files:**
- Modify: `src/App.tsx` (ternary sibling branch + Ctrl+Shift+I listener branch ≈:187-204/:234-244), `src/styles.css` (new `#triage` block at FILE END — never inside the card-wall block)
- Modify: `src/App.test.tsx` (+ integration tests)

**Interfaces:**
- Produces: App swaps `inboxSelected ? <TriageView notes={inboxNotes} />` BEFORE the agenda branch; `inboxNotes = (notes ?? []).filter(n => isCaptureZone(n.category)).sort(createdAt desc, id tiebreak)` computed in App (visibleNotes untouched).
- Produces: Ctrl+Shift+I branch (same listener block as Ctrl+Shift+J): `e.preventDefault(); useStore.getState().selectCategory({type:'notes', path:'!INBOX'});` — comment mirrors the :193-195 freshness note.
- Produces: `#triage` CSS block at styles.css end: `.triage-card` list rows in the established card idiom (`var(--row)` bg, 1px `var(--border-soft)`, radius 10), `.selected` = accent border/tint, `.triage-snippet` muted single-line ellipsis, `.triage-error` = `var(--danger)`, buttons ride existing `.row-del`-family sizing patterns; phone media ≤700 adjustments in the same block (412px probe gate).
- **Visual QA gate (standing rule — jsdom is blind):** run the headless-ux-probe screenshot tour at 1280 AND 412 width (references/headless-ux-probe.md recipe; vite :5199 + invoke shim fixtures including 2 fake !INBOX notes) — attach both PNGs to the task report; screenshots MUST show cards, selection highlight, and no clipped action rows.

- [ ] **Step 1: RED integration tests** (App.test.tsx): 'selecting the !INBOX category renders TriageView instead of NoteList' (store.setState selectedCategory + notes fixtures → `screen.getByText('Triage')` heading + grocery-note NOT rendered); 'plain notes list unaffected' (no inbox selection → normal card-wall renders, no `Triage` heading); 'Ctrl+Shift+I opens triage' (`fireEvent.keyDown(window, {key:'I', ctrlKey:true, shiftKey:true})` → triage heading).
- [ ] **Step 2: Implement** App changes + CSS block.
- [ ] **Step 3: Gates:** vitest (≥587 + 3), tsc; cargo --lib sanity (no Cargo change — still ≥301+1i, census 18).
- [ ] **Step 4: Visual probe pass** (1280 + 412 screenshots; fix layout gaps found — disclose any CSS amendments).
- [ ] **Step 5: Commit** `feat(triage): wire TriageView into app shell + !INBOX hotkey + styling`.

---

## Self-Review appendix (controller, completed pre-dispatch)

- **Spec coverage:** §5 card list newest-first (T3), route enum validated client-side (T3, closed set in code — P3 reuses `isTriageRoute`), move/promote primitives PUT+originalCategory (T1+T2+T4), stale-guard (T2 server law + T4 defensive UI guard), keyboard-first j/k + a/x (T3/T4; `m` added as the manual-move key — DISCLOSED P2 addition, spec pins only j/k/a/x), discard = user-confirmed delete only (T4, ConfirmModal destructive), §6 lifecycle on promotion (T2: item + PROCESSED + rename + provenance), §4 boards stay the TODO surface, promote = item NOT note-move (T2 payload shape). §5 AI items (badges, board suggestions, tag curation, confidence) deliberately absent — P3 plan.
- **Deliberate CUTS (ledgered):** (a) no open-note-from-triage affordance in P2 — reading happens via the sidebar `!INBOX` node → existing list view, or post-move in the destination category; snippet carries the 160-char preview. (b) `!INBOX/*` nested-zone notes: triage lists via `isCaptureZone` (startsWith) — consistent with zone definition. (c) No CommandBar/palette/CommandBar-fence changes in P2 (rider).
- **Snippet-vs-tests coherence:** Task 4 flow tests assert exact invoke args (mirrors P1 T2 pattern, proven shape); promote tests assert outbox row COUNT + payload keys (stronger than op-count-only); FK seeding law honored (seed checklist row before item asserts).
- **Type consistency:** `promote_note_to_board` (Rust cmd) ↔ `promoteNoteToBoard` (TS, Task 5 lands the binding but Task 4 flow tests mock `invoke` directly — binding order safe since invoke is mocked); `isTriageRoute` shared T3↔(P3); `originalCategory` key spelled camelCase on the wire (serde law), passthrough only.
- **Baseline arithmetic (stop-contract for implementers):** measured clean-HEAD @ `34438b5` on 2026-10-07: vitest 566 (48 files), cargo 301+1i, census 18. Expected per task = this baseline + the task's fence count; implementers re-run gates and STOP on any delta they cannot attribute, per standing rule.
- **Fences amended (disclosed):** App ternary +1 sibling branch; App key listener +1 branch (Ctrl+Shift+I). Everything else in the frozen list untouched. `listMode` stays 3 values.
- **Proportion check:** plan carries exact signatures + test assertions only; bodies stay implementer-written except the promote semantics sequence (algorithm the tests do not determine) and the provenance format (spec-fixed).