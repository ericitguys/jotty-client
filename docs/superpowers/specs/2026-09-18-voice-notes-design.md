# Voice Notes (v2 feature) — Design

Status: approved design, 2026-09-18. Brainstormed from the §13 v2 candidate in
`2026-09-15-jotty-offline-client-design.md`. No code written yet; this spec
precedes the implementation plan.

## 1. Problem

The user wants to capture voice memos and land them in jotty as notes: record
in the desktop client, transcribe, optionally clean up, review, save. The
client is offline-first, but the user runs a private OpenWebUI server and
wants it to do the transcription (self-hosted STT, not a SaaS API, not a
bundled model).

## 2. Decisions (approved in brainstorm, 2026-09-18)

1. **Pipeline:** record → transcribe (OpenWebUI) → optional per-note LLM
   "tidy" pass (same OpenWebUI server) → review/edit → save as note.
2. **Tidy is optional, per note, with fallback:** server unreachable or
   disabled → raw transcript, visible "not tidied" notice.
3. **Audio is a first-class local artifact:** kept in the client's app-data
   dir; per-note re-listen, re-transcribe, and delete. Never synced (jotty
   has no attachment API — the synced note is the transcript text).
4. **Entry point: memo flow only** — dedicated "New voice note" button →
   record → review → save as a new note. No dictation-into-editor in v1.
5. **One config surface:** a single "AI server" settings section (base URL +
   API key) serves both transcription and tidy; tidy model picked from the
   instance's model list.
6. **Offline behavior:** capture always works offline; only transcription
   needs the server. Unreachable at record-stop → "pending transcription"
   state, auto-retried when the server is reachable again.

## 3. OpenWebUI API facts (verified 2026-09-18)

Sources: docs.openwebui.com (api-keys, audio troubleshooting, OpenAI STT
integration pages) and the OpenWebUI API reference (mintlify "Transcribe
Audio" page). OpenWebUI moves fast — re-verify at implementation time.

- `POST {base}/api/v1/audio/transcriptions` — multipart form: `file`
  (required; flac/m4a/mp3/mpeg/wav/webm accepted), `language` (optional
  ISO-639-1 hint). Auth: `Authorization: Bearer <api-key>`.
- Response: `{"text": "...", "filename": "..."}` (OpenAI-compatible).
- The engine is server-side config (Admin → Audio): default local
  faster-whisper; can proxy OpenAI/Deepgram/Azure/Mistral. Transparent to
  the client.
- Default-engine upload cap: 20 MB (Azure 200 MB). Server does format
  conversion/compression/chunking for some engines — do not rely on it.
- API keys: `sk-` + 32 hex, created per user (Settings → Account → API
  keys). Admin master switch (Admin Panel → Settings → Authentication →
  API Keys) must be ON; non-admin accounts need the "API Keys" feature
  permission. An account holds ONE key. Alternative custom header
  (CUSTOM_API_KEY_HEADER) exists — out of scope; we send standard
  `Authorization: Bearer`.
- Models: `GET {base}/api/v1/models`; chat: `POST {base}/api/v1/chat/completions`
  (OpenAI-compatible body, `choices[0].message.content`).
- **Path drift:** docs show both `/api/...` and `/api/v1/...` forms across
  versions. Client rule: try `/api/v1/...` first; on 404 retry the
  non-versioned path; persist the working suffix per instance (settings).

## 4. Architecture

All server-facing calls run in the Rust core. Existing sync code is NOT
modified. New modules:

- `src-tauri/src/audio.rs` — capture via `cpal` (default input device,
  device-native rate, downmix to mono, linear resample to 16 kHz), write
  16-bit PCM WAV via `hound` to `<app_data>/voice/<uuid>.wav`. File is
  created when recording starts (a crash leaves a valid partial file).
- `src-tauri/src/voice_ai.rs` — OpenWebUI client on the existing reqwest
  stack (30s timeout, `multipart` feature added): transcribe (multipart
  POST), tidy (chat completions), models list (GET). Dual-path rule from
  §3. Key read from OS keyring (service `jotty-desktop`, account
  `openwebui-key` — same keyring crate patterns as the jotty API key).
- New Tauri commands (26-command layer pattern): `voice_start_recording`,
  `voice_stop_recording`, `voice_transcribe`, `voice_tidy`,
  `voice_delete_recording`, `voice_save_note`, `voice_list_unsaved`,
  `ai_get_models`. Settings gains `aiBaseUrl` + `aiModel` + `aiLanguageHint`
  (plain prefs, not sensitive); the key lives only in the keyring.

Frontend:

- `VoiceNoteReview` view: timer while recording, stop, audio playback,
  editable transcript, tidy toggle ("raw" / "tidied" switch), title
  (pre-filled from the transcript's first sentence, editable), category
  (default Uncategorized), Save / Delete.
- "New voice note" button in the NoteList header. If the AI server is
  unconfigured, it prompts to open Settings.
- Settings modal: new "AI server" section — base URL, API key field,
  tidy model dropdown (from `ai_get_models`), language hint (optional,
  free text, default empty = engine default), "Test connection" button
  (GET models).
- NoteEditor: when the open note has audio (`audio_path` set), a
  VoiceNote panel: audio player, duration, re-transcribe, delete audio.
  Re-transcribe opens the review overlay pre-filled with the new
  transcript; Save runs the normal `update_note` path (outbox update op).
- Notes list: mic badge on notes with pending transcription.

## 5. Data model

- New SQLite table `voice_recordings` (staging, local-only):
  `id` (uuid), `path`, `duration_secs`, `raw_transcript` (nullable),
  `tidied_transcript` (nullable), `state`, `created_at`.
  States: `recording` → `recorded` → `transcribing` → `transcribed`
  (`tidied_transcript` may fill later) | `transcription_failed`
  (reachable/5xx, retryable) | `transcription_failed_auth` (401/403).
- `notes` gains `audio_path TEXT NULL` (+ `audio_duration_secs REAL NULL`),
  set only by `voice_save_note`. Local-only columns: sync/pull/push/reconcile
  use explicit column lists — during implementation, verify no `SELECT *`
  on notes in sync code; if any exists, extend its explicit list (a
  nullable added column must never reach the sync engine).
- `voice_save_note(recordingId, title, category, useTidied)` runs in ONE
  transaction: create note via the existing create-note inner (entity +
  outbox enqueue, unchanged invariants), set `notes.audio_path` +
  duration, delete the staging row. Audio file stays on disk, referenced
  by path.
- FTS5: transcripts become note content at save → voice notes are
  full-text searchable with zero extra work.

## 6. Flows

**Record:** start → staging row (`recording`) + WAV opened → timer → stop →
duration recorded, state `recorded` → frontend auto-calls
`voice_transcribe`. Cancel anytime → staging row + file deleted.

**Transcribe:** `transcribing` → on success `transcribed` + raw_transcript;
on network/5xx → `transcription_failed` (pending, retried); on 401/403 →
`transcription_failed_auth` (distinct "check API key" message). Saving is
never blocked by transcription state.

**Retry:** on every successful `do_sync` (the client already knows the
server is reachable), attempt all pending: staging rows in
`transcription_failed`, and saved notes with `audio_path` set and empty
content. Retry writes the RAW transcript (update_note via the normal
outbox path for saved notes; badge clears). Tidy is never auto-applied.

**Tidy:** per-note toggle in review; fixed system prompt (fix punctuation,
paragraphs, filler, obvious slips only when context is clear; structure
with headings/bullets when warranted; never invent facts; reply with only
the cleaned text). Stores BOTH raw and tidied; editor shows tidied when
present, one-click raw toggle. Failure/unreachable → raw + notice.

**Save:** single transaction (§5). Content = tidied if `useTidied` and
tidied exists, else raw. Navigate to the saved note.

**Startup sweep:** staging rows in `recording` state (no live owner after
restart) and unreferenced `voice/*.wav` files are deleted. Unsaved
non-recording staging rows SURVIVE restart; at launch, if any exist, a
resume prompt offers "resume review" (opens the review overlay) or
"discard" (row + file deleted). No silent data loss.

## 7. Limits and error handling

- Recording cap: **8 minutes** (16 kHz mono 16-bit ≈ 1.92 MB/min →
  ≈ 15.4 MB, safe margin under the 20 MB engine cap; the originally
  sketched 10 min = 19.2 MB was too close). At cap: auto-stop + notice.
- No mic / permission denied at start: clear error, no partial state.
- Unreachable server: pending state + badge + auto-retry (§6) + manual
  retry button.
- 401/403: distinct message pointing at Settings; transcription state
  does not consume retry loops.
- Malformed/oversize responses: transcription_failed, retryable; error
  text surfaced in the review view and badge tooltip.
- Tidy failure: never mutates the transcript; notice only.

## 8. Testing

- Rust (wiremock + units): transcribe multipart shape (field name, auth
  header, WAV bytes), response parse `{text}`, dual-path 404 fallback,
  tidy request/response, models parse, all state transitions incl.
  failed-auth vs failed-network, `voice_save_note` single-tx atomicity
  (note + audio_path + outbox + staging delete), retry hook (sync-success
  triggers attempts; saved-note fill path), orphan sweep, WAV writer with
  synthetic samples (NO real mic in CI; capture device access is gated),
  settings/keyring storage round-trip (keyring via the untestable-headless
  convention: desktop smoke check remains a release gate).
- Frontend (vitest + RTL): review view states (recording timer, stop →
  transcribing → editable transcript, tidy toggle + raw view, save wiring,
  cancel), NoteList button + unconfigured prompt, settings section,
  mic badge, NoteEditor voice panel.
- Integration (env-gated, `#[ignore]`, skipped by default): live OpenWebUI
  transcriptions round-trip with env vars (`JOTTY_TEST_OWEBUI_URL`,
  `JOTTY_TEST_OWEBUI_KEY`); never fabricate a run.

## 9. Build and ship

- New crates: `cpal` (needs `libasound2-dev` on the dev box — one-time apt
  install), `hound`; reqwest `multipart` feature on.
- Version: minor bump → v0.10.0 in all four spots + both lockfiles.
- Standard standing ship procedure (TDD → full gates → bump → commit →
  push → build → release with re-hashed assets → ledger).

## 10. Non-goals (v1)

Dictation into the open editor, TTS, in-app model management beyond the
tidy-model dropdown, automatic audio deletion, client-side audio
compression, live level meter/waveform, multi-recording takes per note.

## 11. Server prerequisites (user-side)

1. OpenWebUI instance reachable from the desktop running jotty-client
   (same availability window as the jotty server).
2. Admin Panel → Settings → Authentication → API Keys master switch ON;
   your account can create a key (Settings → Account → API Keys).
3. STT engine configured (default local faster-whisper is fine).
4. At least one chat model available for the tidy pass.