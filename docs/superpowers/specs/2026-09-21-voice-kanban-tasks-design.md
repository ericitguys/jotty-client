# Voice Note → Kanban Tasks — Design

Status: approved design, 2026-09-21. User request (Discord): "in the android
app, i would like the AI that transcribe the notes to also offer to make a
kanban tasks". Scope questions answered via clarify the same day — user picked
all recommended defaults: offer lives in the voice review overlay next to Save;
preview the extracted tasks (edit/remove) before creating; all cards land in
the first column; new board each time named after the note. Design approved in
chat the same day. Builds on two shipped features:
`2026-09-18-voice-notes-design.md` (record → transcribe → tidy → review →
save) and `2026-09-20-kanban-boards-design.md` (boards, columns, card adds).

## 1. Problem

The voice-note flow ends in a plain note: the user records a memo that lists
things to do, the AI transcribes it, and the tasks stay buried in prose. The
client can already create kanban boards and add cards, but only by hand, one
card at a time. The missing piece: let the same AI that transcribes the memo
also pull the tasks out of it and offer to turn them into a board.

## 2. Decisions (approved in brainstorm, 2026-09-21)

1. **The offer lives in the voice review overlay**, next to Save: a
   "Save + kanban board" action. Not offered after save (note panel is a
   non-goal for v1).
2. **Extraction runs on exactly what the transcript editor shows** — raw or
   tidied, as edited by the user. The editor state is the source of truth;
   the staging row's stored transcripts are not re-read for this.
3. **Preview before create**: extraction produces an editable list of task
   titles (edit text, remove rows, add rows); nothing is created until the
   user confirms. Cancel at preview = no note, no board, back to review.
4. **All cards go to the first column.** The AI extracts titles only; no
   column assignment (v1 non-goal).
5. **New board each time**, titled after the note (the review overlay's title
   field). No board picker (v1 non-goal).
6. **Save semantics: "Save + kanban board" is one user flow.** Confirm saves
   the note first, then creates the board, then adds cards. The note save is
   NOT conditional on the board succeeding (a failed board creation never
   loses the memo). Cancel at preview saves nothing.
7. **Extraction is always user-initiated.** No auto-extraction on save; no
   re-extraction from the note panel.
8. **Same AI model as the tidy step** (the one `aiModel` setting). A separate
   extraction-model setting is a non-goal.

## 3. API facts (all previously verified — nothing new upstream)

- **No new jotty endpoints.** Board creation is the existing
  `POST /api/tasks` (`create_task_board`, kanban spec §6 — sends the default
  3-column set todo / in_progress / completed[autoComplete]). Card creation is
  the existing `POST /api/checklists/{uuid}/items` via the create op —
  server default when `status` is omitted = **first column** (kanban spec
  §3), which is exactly decision 4.
- **No new OpenWebUI endpoints.** Extraction is a chat completion against the
  same `/api/v1/chat/completions` (dual-path rule, persisted suffix) the tidy
  pass already uses; model from the same `aiModel` pref; key from the same
  keyring entry.
- Cards added with `status: null` locally render in the first column
  (ruling 6 of the kanban plan: unknown/absent status → first column) and
  replay to the server default. No reorder ops are involved — the
  reorder-forbidden ruling (kanban plan ruling 5) is untouched.

## 4. Architecture

Same shape as everything else: server-facing calls in the Rust core, frontend
orchestrates the sequence, existing sync invariants untouched.

**Rust — one new command, one new client method:**

- `voice_ai.rs`: `EXTRACT_SYSTEM_PROMPT` (fixed, mirror of the tidy prompt's
  discipline): extract actionable tasks from a voice transcript; each task a
  short imperative title in the transcript's language; merge duplicates; do
  not invent facts; reply with ONLY a JSON array of strings — no prose, no
  code fences, `[]` when there are no tasks.
- `VoiceAiClient::extract_tasks(model, text) -> AppResult<(Vec<String>,
  Suffix)>` — same request shape as `tidy` (chat completions,
  `choices[0].message.content`). **Tolerant parse:** strip Markdown code
  fences if present, take the first `[...]` array, require strings (numbers
  are stringified, other shapes → error). Returns `Ok(vec![])` for an
  honestly-empty result — the frontend distinguishes "no tasks found" from an
  error.
- `commands/mod.rs`: `voice_extract_tasks(text: String) -> Vec<String>` —
  mirrors `voice_tidy` exactly (`build_ai_client` + `ai_model`; unconfigured
  base URL / model → the same "not configured — open Settings" error class).
  Stateless: takes the text, returns the tasks; touches no table and no
  staging row. Registered in `lib.rs`.

**Frontend — VoiceNoteReview gains a second primary action:**

- `Save + kanban board` button next to Save. Disabled when the transcript is
  empty or the jotty connection is down (the board part is live-only,
  consistent with "+ New board" — hint text says the board needs a
  connection). Note-only Save keeps working with no connection.
- Tap → `extracting` phase (spinner/label, buttons disabled) → calls
  `voice_extract_tasks` with the current editor text. Failure → notice in the
  overlay, still in review, retry by tapping again.
- Empty result → "no tasks found" notice, no preview.
- **Preview state** (same overlay surface, replaces the transcript view): one
  editable text input per task, remove (×) per row, "+ add task" row, header
  shows board title + category as they will be used (the overlay's current
  title/category fields, live), Cancel and Create buttons. At least one
  non-empty task required to enable Create.
- Confirm → the pipeline below. Back on the review view afterwards is NOT the
  case — on full success the app navigates to the new board (the note save
  already navigated per the existing onSaved path; board selection wins).

Orchestration lives in the store (new action `saveVoiceNoteWithBoard`) so the
component stays presentational and the sequence is testable without the
overlay.

## 5. Data model

**No schema change.** Migration stays at v3. Extraction results are
ephemeral frontend state (lost on overlay close/cancel — acceptable and
disclosed; the transcript itself is untouched). The staging row, `notes`
columns, outbox, and `board_statuses` are all exactly as shipped.

## 6. Flows

**Extract:** tap (enabled: transcript non-empty + connected) →
`voice_extract_tasks(current text)` → success: preview with N editable rows;
AI/config error: notice, remain in review; network/5xx: retryable notice;
401/403: "check AI settings" message (same auth-error classes as transcribe).

**Confirm (strict order):**
1. The overlay's existing save path — `voice_save_note(recordingId, title,
   category, useTidied, contentOverride)` for a fresh recording (single-tx:
   note + audio_path + outbox create + staging delete) or the normal
   `update_note` path in re-transcribe mode (overlay opened from a saved
   note). Either way the memo is now safe no matter what happens next.
2. `store.createBoard(title, category)` — the existing live `POST /api/tasks`
   + inline pull_all + local row, which already refreshes and selects the new
   board. Title = the note title (empty → fallback "Tasks from voice note");
   category = the overlay's category field. Failure here (network/4xx): the
   note is already saved; notice names the failure, flow stops, no cards are
   created, no half-board exists (the endpoint is create-all-or-nothing).
3. `addItem(boardId, task, null, null)` per task (status omitted → server
   default = first column; local row status NULL → renders first column).
   These are local + outbox like every card add — a card add that fails
   locally is impossible short of a bug; replay handles the server side.
   Empty-string rows are filtered out at Create time.
4. `refreshAll` + the board is already selected by `createBoard` → the app
   shows the board with all cards in the first column. A completion toast is
   NOT shown (the board IS the confirmation).

**Cancel:** at any point before Create → nothing persisted, overlay state
back to review (transcript/title/category edits preserved — they live in the
same component state as before).

**Offline:** the button is disabled with the hint (decision above). The note
can still be saved via plain Save; a board can be made later by hand
(+ New board + cards).

## 7. Limits and error handling

- Extraction quality is model-bound (user runs gemma3 via Ollama — ledgered
  2026-09-20): short imperative extraction with the pinned JSON-only prompt;
  fence-stripping + first-array tolerance for wrapped replies. A reply with
  no parseable array = error notice, never a fabricated task list.
- No cap on extracted tasks (the preview is the filter — the user removes
  what they don't want); gemma3 on an 8-min memo maxes out well below
  pathological sizes.
- Board title collisions are allowed (jotty titles are not unique — same as
  "+ New board").
- Duplicate extraction runs replace the preview list (no dedup against the
  previous run — stateless).
- The overlay's extracting/preview states must not lose the transcript being
  edited: title/category/transcript live in component state that the preview
  renders beside, never over.

## 8. Testing

- **Rust (wiremock):** extract request shape (auth header, model, messages
  with EXTRACT_SYSTEM_PROMPT, text in the user role), plain-array parse,
  fence-wrapped array parse, numeric items stringified, object/garbage →
  Err, `[]` → Ok empty, dual-path fallback on 404, suffix persisted,
  unconfigured model / base URL → typed error; command test: returns
  Vec<String>, camelCase-free plain strings.
- **TS (vitest + RTL):** button enable/disable matrix (transcript empty,
  offline, ready); extracting state disables actions + calls
  `voice_extract_tasks` with the EDITOR text (edited, and per raw/tidied
  toggle); empty result notice; preview row edit/remove/add + Create disabled
  when all rows empty; confirm call ORDER pinned (save-first — voice_save_note in fresh-recording
  mode, update_note in re-transcribe mode → create_task_board → addItem×N
  with status null → navigation to the new board); cancel at preview persists
  nothing; createBoard failure after save
  → notice + note still saved (save call happened first); extraction failure
  → notice, remains in review; store action `saveVoiceNoteWithBoard` tested
  at store level mirroring store.test createBoard fences.
- **Integration (env-gated, `#[ignore]`):** live extraction round-trip against
  OpenWebUI (`JOTTY_TEST_OWEBUI_URL` / `JOTTY_TEST_OWEBUI_KEY`) — never
  fabricated.
- **Visual:** Playwright px-check of the overlay's two new states (preview
  rows, button states) at 412px AND 1280px (Android + desktop parity).

## 9. Build and ship

- Minor bump: **v0.12.0** in package.json + tauri.conf.json + Cargo.toml +
  both lockfiles.
- Standing ship procedure (skill): TDD → full gates (vitest, tsc, cargo,
  zero NEW warnings; re-census by RUNNING the gates) → commit → push →
  `npx tauri build` (deb + appimage + rpm, sha256) → release v0.12.0.
- **Android preview in the SAME run** (`v0.12.0-android-preview`): source
  `/tmp/android-env.sh`; verify the version surfaces from tauri.conf.json
  into the APK (versionName 0.12.0, versionCode auto-bumped — confirm via
  `aapt dump badging`, fix in gen/android if the injection needs a manual
  nudge); `npx tauri android build --target aarch64 --apk`
  (minutes — background + poll); verify `apksigner verify` + `aapt dump
  badging` (versionName/minSdk 26) + sha256; `gh release create
  v0.12.0-android-preview <apk> --prerelease` with notes; verify via
  `gh release download` + re-hash. This SUPERSEDES the pending "v0.11.0
  android APK" follow-up: the user's in-app updater walks prereleases
  newest-first and will jump straight to the v0.12.0 preview (0.10.8 → 0.12.0,
  picking up kanban boards + this feature in one update).
- Desktop parity gates re-run after any mobile-facing change (same shapes as
  the kanban run: cargo / vitest / tsc / warnings byte-identical).

## 10. Non-goals (v1)

- AI column assignment or per-card column picking (all cards → first column).
- Choosing an existing board as the target.
- "Make board from this note" on saved notes (note panel) — review overlay
  only, per decision 1.
- Sub-tasks: each extracted task is one top-level card (no children).
- Separate extraction-model setting; auto-extraction; re-extraction from the
  note panel; dictation into the editor.
- Persisting preview state across app restarts (staging stays as shipped).