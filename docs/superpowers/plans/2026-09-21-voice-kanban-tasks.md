# Voice Note → Kanban Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the voice review overlay, the AI extracts task titles from the transcript and (after an editable preview) saves the note and creates a kanban board with one card per task in the first column.

**Architecture:** One stateless Rust command (`voice_extract_tasks`) mirroring `voice_tidy` (same OpenWebUI chat path, same settings), a zustand store action `saveVoiceNoteWithBoard` orchestrating save → createBoard → addItem×N, and preview/confirm UI in VoiceNoteReview. No schema change; existing sync invariants untouched.

**Tech Stack:** Tauri 2 (Rust core), React + TypeScript + zustand, vitest+RTL, cargo wiremock.

**Spec:** `docs/superpowers/specs/2026-09-21-voice-kanban-tasks-design.md` (executors read both; the plan argues from the spec).

## Global Constraints

- **Baselines are snapshots — re-census by RUNNING the gates immediately before citing them.** As of v0.11.0 (`19e3c17`): `npx vitest run` 113/113, `npx tsc -p tsconfig.json --noEmit` clean, `cargo test` 187 passed + 5 ignored, zero NEW compiler warnings (delta vs stash-verified baseline; ~15 pre-existing unused-import warnings are baseline noise).
- Tests run via `npm test` (NODE_OPTIONS=--no-webstorage is in the test script; bare `npx vitest run` breaks jsdom localStorage on node ≥25). Rust tests: `cargo test` from `src-tauri/`.
- **NEVER run `cargo fmt` in jotty.** Commit identity: `git -c user.name=zeus -c user.email=zeus@local`. Conventional commits on main.
- Version bumps touch 4 spots: `package.json` + `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml`, then `npm install --package-lock-only` and `cargo update -p jotty-client`.
- Android build env: source `/tmp/android-env.sh` first (recreate per the skill's Android section if missing). apksigner lives at `$ANDROID_HOME/build-tools/34.0.0/apksigner` (NOT ~/.local/bin). gh is `~/.local/bin/gh`.
- Env-gated live tests (`#[ignore]`, `JOTTY_TEST_OWEBUI_URL`/`JOTTY_TEST_OWEBUI_KEY`): never fabricate a run.
- When a plan task changes a function signature: grep ALL call sites and write the count into the brief (T2 kanban lesson). This plan is purely additive — no existing signature changes.
- Store/API test mocks use camelCase keys (the real DTO casing).
- Playwright: chromium binary in ~/.cache/ms-playwright, playwright package resolves only from /tmp/node_modules (run px-check scripts with cwd=/tmp); serve dist over http (NEVER file://) and addInitScript the `__TAURI_INTERNALS__` shim before goto.

---

### Task 1: Rust extraction surface (client method + command)

**Files:**
- Modify: `src-tauri/src/voice_ai.rs` (EXTRACT_SYSTEM_PROMPT const next to TIDY_SYSTEM_PROMPT line 34; `extract_tasks` method next to `tidy` ~line 163; `parse_tasks` next to `parse_choice` ~line 210)
- Modify: `src-tauri/src/commands/mod.rs` (new command after `voice_tidy` ~line 1250)
- Modify: `src-tauri/src/lib.rs` (register `commands::voice_extract_tasks` in the invoke_handler list next to voice_tidy line 91)
- Test: wiremock/unit tests inside `src-tauri/src/voice_ai.rs` tests mod (mirrors `tidy_sends_model_system_and_user_and_parses_choice` at ~line 451) + a command-level config-error test in `src-tauri/src/commands/mod.rs` tests (mirror the `voice_tidy` empty-model fence at ~line 1887)

**Interfaces:**
- Consumes: existing `VoiceAiClient::chat_once(suffix, &Value)`, `parse_choice(&Value)`, dual-path 404 pattern, `build_ai_client(&state)` + `ai_model(&conn)` + `persist_ai_suffix(conn, sfx)` in commands/mod.rs.
- Produces: `pub const EXTRACT_SYSTEM_PROMPT: &str`; `VoiceAiClient::extract_tasks(&self, model: &str, text: &str) -> AppResult<(Vec<String>, Suffix)>`; `pub(crate) async fn voice_extract_tasks_inner(ai: &VoiceAiClient, model: &str, text: &str) -> AppResult<Vec<String>>`; Tauri command `voice_extract_tasks(text: String) -> Result<Vec<String>, String>` (frontend arg casing: `{ text }`). Later tasks consume the command via `invoke<string[]>('voice_extract_tasks', { text })`.

- [ ] **Step 1: Write the failing tests** (in voice_ai.rs tests mod — same imports as the tidy tests; `client()` helper builds `VoiceAiClient::new(server_uri, "sk-test", Suffix::V1)`)

```rust
#[tokio::test]
async fn extract_tasks_sends_prompt_and_parses_plain_array() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
        .and(wiremock::matchers::body_partial_json(serde_json::json!({
            "model": "llama3",
            "messages": [
                {"role": "system", "content": EXTRACT_SYSTEM_PROMPT},
                {"role": "user", "content": "memo text"}
            ]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{"message": {"role": "assistant", "content": "[\"Buy milk\",\"Call dentist\"]"}}]
        })))
        .mount(&s).await;
    let (tasks, sfx) = client(&s.uri()).extract_tasks("llama3", "memo text").await.unwrap();
    assert_eq!(tasks, vec!["Buy milk", "Call dentist"]);
    assert_eq!(sfx, Suffix::V1);
}

#[tokio::test]
async fn extract_tasks_tolerates_code_fenced_array() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{"message": {"content": "```json\n[\"Task A\", \"Task B\"]\n```"}}]
        })))
        .mount(&s).await;
    let (tasks, _) = client(&s.uri()).extract_tasks("llama3", "memo").await.unwrap();
    assert_eq!(tasks, vec!["Task A", "Task B"]);
}

#[tokio::test]
async fn extract_tasks_stringifies_numbers_and_errors_on_objects() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{"message": {"content": "[1, 2]"}}]
        })))
        .mount(&s).await;
    let (tasks, _) = client(&s.uri()).extract_tasks("llama3", "memo").await.unwrap();
    assert_eq!(tasks, vec!["1", "2"]);
    // object item → error, never a fabricated list
    let s2 = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{"message": {"content": "[{\"title\": \"x\"}]"}}]
        })))
        .mount(&s2).await;
    assert!(client(&s2.uri()).extract_tasks("llama3", "memo").await.is_err());
}

#[tokio::test]
async fn extract_tasks_empty_array_is_ok_and_no_array_is_err() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{"message": {"content": "[]"}}]
        })))
        .mount(&s).await;
    let (tasks, _) = client(&s.uri()).extract_tasks("llama3", "memo").await.unwrap();
    assert!(tasks.is_empty());
    // prose reply (no parseable array) → Err
    let s2 = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{"message": {"content": "I found some tasks in your memo."}}]
        })))
        .mount(&s2).await;
    assert!(client(&s2.uri()).extract_tasks("llama3", "memo").await.is_err());
}

#[tokio::test]
async fn extract_tasks_404_falls_back_to_plain() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(404)).mount(&s).await;
    Mock::given(method("POST")).and(path("/api/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{"message": {"content": "[\"T\"]"}}]
        })))
        .mount(&s).await;
    let (tasks, sfx) = client(&s.uri()).extract_tasks("llama3", "memo").await.unwrap();
    assert_eq!(tasks, vec!["T"]);
    assert_eq!(sfx, Suffix::Plain);
}

#[test]
fn parse_tasks_strips_fences_and_takes_first_array() {
    assert_eq!(parse_tasks("[\"a\",\"b\"]").unwrap(), vec!["a", "b"]);
    assert_eq!(parse_tasks("```json\n[\"a\"]\n```").unwrap(), vec!["a"]);
    assert_eq!(parse_tasks("Sure! [\"a\"] hope this helps").unwrap(), vec!["a"]);
    assert_eq!(parse_tasks("[]").unwrap(), Vec::<String>::new());
    assert!(parse_tasks("no array here").is_err());
    assert!(parse_tasks("[{\"a\":1}]").is_err());
}

#[tokio::test]
#[ignore] // env-gated live run: JOTTY_TEST_OWEBUI_URL / JOTTY_TEST_OWEBUI_KEY — never fabricated
async fn live_extract_tasks_roundtrip() {
    let url = std::env::var("JOTTY_TEST_OWEBUI_URL").expect("set JOTTY_TEST_OWEBUI_URL");
    let key = std::env::var("JOTTY_TEST_OWEBUI_KEY").expect("set JOTTY_TEST_OWEBUI_KEY");
    let ai = crate::voice_ai::VoiceAiClient::new(&url, &key, crate::voice_ai::Suffix::V1).unwrap();
    let (tasks, _) = ai.extract_tasks("gemma3", "I need to buy milk tomorrow and email the dentist about my cleaning.").await.unwrap();
    println!("{tasks:?}");
    assert!(!tasks.is_empty());
}
```

- [ ] **Step 2: Run to verify RED** — `cargo test extract_tasks` in src-tauri → FAIL (no method/const).
- [ ] **Step 3: Implement** — EXTRACT_SYSTEM_PROMPT:

```rust
pub const EXTRACT_SYSTEM_PROMPT: &str = "You extract actionable tasks from a voice-memo transcript. Reply with ONLY a JSON array of strings — no prose, no Markdown, no code fences. Each element is one short imperative task title in the transcript's language. Merge duplicates and drop pure small talk. Never invent facts that are not in the transcript. If the transcript contains no tasks, reply with [].";
```

Method (mirrors `tidy` exactly, dual-path included):

```rust
pub async fn extract_tasks(&self, model: &str, text: &str) -> AppResult<(Vec<String>, Suffix)> {
    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": EXTRACT_SYSTEM_PROMPT},
            {"role": "user", "content": text}
        ]
    });
    match self.chat_once(self.suffix, &body).await {
        Ok(v) => Ok((parse_tasks(&parse_choice(&v)?)?, self.suffix)),
        Err(AppError::Api { status: 404, .. }) => {
            let other = self.other();
            let v = self.chat_once(other, &body).await?;
            Ok((parse_tasks(&parse_choice(&v)?)?, other))
        }
        Err(e) => Err(e),
    }
}
```

`parse_tasks` (tolerant: trim, strip fences, first `[` → last `]`, strings pass, numbers stringify, anything else → Err):

```rust
fn parse_tasks(content: &str) -> AppResult<Vec<String>> {
    let trimmed = content.trim();
    let stripped = if trimmed.starts_with("```") {
        let inner = trimmed.trim_start_matches("```").trim_start_matches("json").trim();
        inner.trim_end_matches("```").trim()
    } else {
        trimmed
    };
    let start = stripped.find('[').ok_or_else(|| AppError::Other("extraction reply contains no JSON array".into()))?;
    let end = stripped.rfind(']').ok_or_else(|| AppError::Other("extraction reply has no closing bracket".into()))?;
    if end < start {
        return Err(AppError::Other("extraction reply has malformed array".into()));
    }
    let arr = serde_json::from_str::<Vec<serde_json::Value>>(&stripped[start..=end])
        .map_err(|e| AppError::Other(format!("extraction reply is not a JSON array: {e}")))?;
    arr.into_iter()
        .map(|v| match v {
            serde_json::Value::String(s) => Ok(s),
            serde_json::Value::Number(n) => Ok(n.to_string()),
            _ => Err(AppError::Other("extraction reply contains a non-string task".into())),
        })
        .collect()
}
```

Commands + registration:

```rust
pub(crate) async fn voice_extract_tasks_inner(
    ai: &crate::voice_ai::VoiceAiClient,
    model: &str,
    text: &str,
) -> AppResult<Vec<String>> {
    if model.trim().is_empty() {
        return Err(crate::error::AppError::Other(
            "AI model not configured — pick one in Settings".into(),
        ));
    }
    let (tasks, sfx) = ai.extract_tasks(model, text).await?;
    Ok(tasks) // suffix persisted by the command wrapper (needs the db lock)
}

#[tauri::command]
pub async fn voice_extract_tasks(
    state: tauri::State<'_, AppState>,
    text: String,
) -> Result<Vec<String>, String> {
    let ai = build_ai_client(&state).await.map_err(|e| e.to_string())?;
    let model = { let conn = state.db.lock().await; ai_model(&conn).map_err(|e| e.to_string())? };
    let tasks = voice_extract_tasks_inner(&ai, &model, &text).await.map_err(|e| e.to_string())?;
    if let Some(sfx) = ai.last_suffix() {
        let conn = state.db.lock().await;
        persist_ai_suffix(&conn, sfx).map_err(|e| e.to_string())?;
    }
    Ok(tasks)
}
```

NOTE on suffix persistence: `extract_tasks` returns `(Vec<String>, Suffix)` like `tidy`; if holding the tuple through the command is cleaner than a `last_suffix` field, persist via the returned pair instead — implementer's choice, but the suffix MUST be persisted (mirror voice_tidy_inner's `persist_ai_suffix`). Command-level test (config fence, mirroring the voice_tidy empty-model test shape): empty model in prefs → `voice_extract_tasks_inner` errors with the Settings message; happy path exercised at client level (wiremock above).

- [ ] **Step 4: Run full cargo gates** — `cargo test` (expect 187+6-ish new = ~193 passed, 5 ignored, zero NEW warnings).
- [ ] **Step 5: Commit** — `git -c user.name=zeus -c user.email=zeus@local commit` after `git add src-tauri/src/voice_ai.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs`; message: `feat(rust): voice_extract_tasks — AI task extraction from a transcript`.

### Task 2: TS api wrapper + store action `saveVoiceNoteWithBoard`

**Files:**
- Modify: `src/api/client.ts` (after `voiceSaveNote` ~line 48)
- Modify: `src/stores/store.ts` (interface line after `createBoard` line 30; implementation after `createBoard` ~line 130)
- Test: `src/stores/store.test.ts` (new describe block after the createBoard one)

**Interfaces:**
- Consumes: `api.voiceSaveNote(recordingId, title, category, useTidied, contentOverride)`; `api.updateNote(id, title, content, category)`; `api.addItem(checklistId, text, parentLocalId, status)` (status null = server default first column); `get().createBoard(title, category)` (refreshes + selects the board).
- Produces: `api.voiceExtractTasks(text: string) => invoke<string[]>('voice_extract_tasks', { text })`; `useStore.saveVoiceNoteWithBoard(input: VoiceBoardInput) => Promise<{ noteId: string; boardId: string }>` where

```ts
export interface VoiceBoardInput {
  recordingId: string | null; // new/resume modes
  noteId: string | null;      // retranscribe mode
  title: string;
  category: string;
  useTidied: boolean;
  text: string;
  tasks: string[];
  noteSavedId?: string | null; // set on retry after a board-stage failure
}
```

Board-stage failures rethrow `Object.assign(new Error(message), { boardStage: true, noteId })` (save-stage failures rethrow the plain save error).

- [ ] **Step 1: Write the failing tests** (store.test.ts; the file's invoke-mock harness is already in place)

```ts
describe('store.saveVoiceNoteWithBoard', () => {
  const boardRow = { id: 'b1', title: 'Errands', category: 'Home', dirty: false, completed: false, listType: 'kanban', items: [] };
  const noteRow = { id: 'n1', title: 'Memo', content: 'x', category: 'Home', audioPath: '/v/r1.wav', audioDurationSecs: 4, createdAt: null, updatedAt: null, deletedAt: null, dirty: true };
  const input = {
    recordingId: 'r1', noteId: null, title: 'Errands', category: 'Home',
    useTidied: false, text: 'buy milk, call dentist', tasks: ['Buy milk', 'Call dentist'],
  };

  it('saves the note first, then creates the board, then adds one card per task', async () => {
    const calls: string[] = [];
    invoke.mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd === 'voice_save_note') return Promise.resolve(noteRow);
      if (cmd === 'create_task_board') return Promise.resolve(boardRow);
      if (cmd === 'add_item') return Promise.resolve({});
      return Promise.resolve(null);
    });
    const res = await useStore.getState().saveVoiceNoteWithBoard(input);
    expect(res).toEqual({ noteId: 'n1', boardId: 'b1' });
    expect(calls).toEqual(['voice_save_note', 'create_task_board', 'add_item', 'add_item']);
    expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'b1', text: 'Buy milk', parentLocalId: null, status: null });
    expect(useStore.getState().selectedChecklistId).toBe('b1');
  });

  it('retranscribe mode saves via update_note', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'update_note') return Promise.resolve({ ...noteRow, id: 'n2' });
      if (cmd === 'create_task_board') return Promise.resolve(boardRow);
      if (cmd === 'add_item') return Promise.resolve({});
      return Promise.resolve(null);
    });
    await useStore.getState().saveVoiceNoteWithBoard({ ...input, recordingId: null, noteId: 'n2' });
    expect(invoke).toHaveBeenCalledWith('update_note', { id: 'n2', title: 'Errands', content: 'buy milk, call dentist', category: 'Home' });
  });

  it('board-stage failure rethrows with boardStage + noteId (note stays saved)', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_save_note') return Promise.resolve(noteRow);
      if (cmd === 'create_task_board') return Promise.reject('api error 400: nope');
      return Promise.resolve(null);
    });
    await expect(useStore.getState().saveVoiceNoteWithBoard(input)).rejects.toMatchObject({ boardStage: true, noteId: 'n1' });
  });

  it('retry with noteSavedId skips the save step entirely', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'create_task_board') return Promise.resolve(boardRow);
      if (cmd === 'add_item') return Promise.resolve({});
      return Promise.resolve(null);
    });
    await useStore.getState().saveVoiceNoteWithBoard({ ...input, noteSavedId: 'n1' });
    expect(invoke).not.toHaveBeenCalledWith('voice_save_note', expect.anything());
    expect(invoke).toHaveBeenCalledWith('create_task_board', { title: 'Errands', category: 'Home' });
  });

  it('empty title falls back to "Tasks from voice note" and empty task rows are filtered', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_save_note') return Promise.resolve(noteRow);
      if (cmd === 'create_task_board') return Promise.resolve({ ...boardRow, id: 'b2' });
      if (cmd === 'add_item') return Promise.resolve({});
      return Promise.resolve(null);
    });
    await useStore.getState().saveVoiceNoteWithBoard({ ...input, title: '   ', tasks: ['  ', 'Real task', ''] });
    expect(invoke).toHaveBeenCalledWith('create_task_board', { title: 'Tasks from voice note', category: 'Home' });
    expect(invoke).toHaveBeenCalledTimes(3); // save + board + ONE add_item
  });
});
```

- [ ] **Step 2: Run RED** — `npm test -- store.test` → `saveVoiceNoteWithBoard` not a function.
- [ ] **Step 3: Implement** — wrapper in client.ts:

```ts
export const voiceExtractTasks = (text: string) => invoke<string[]>('voice_extract_tasks', { text });
```

Store (interface + implementation):

```ts
saveVoiceNoteWithBoard: (input: VoiceBoardInput) => Promise<{ noteId: string; boardId: string }>;
```

```ts
saveVoiceNoteWithBoard: async (input) => {
  const boardTitle = input.title.trim() || 'Tasks from voice note';
  let noteId = input.noteSavedId ?? null;
  if (!noteId) {
    const note = input.noteId
      ? await api.updateNote(input.noteId, input.title, input.text, input.category)
      : await api.voiceSaveNote(input.recordingId as string, input.title, input.category, input.useTidied, input.text);
    noteId = note.id;
    // Sidebar/list freshness even if the board part fails below.
    await get().refreshAll();
  }
  try {
    const board = await get().createBoard(boardTitle, input.category); // refreshAll + selects the board
    for (const raw of input.tasks) {
      const text = raw.trim();
      if (text) await api.addItem(board.id, text, null, null);
    }
    return { noteId: noteId as string, boardId: board.id };
  } catch (e) {
    throw Object.assign(new Error(String(e)), { boardStage: true, noteId });
  }
},
```

(Add `VoiceBoardInput` export to store.ts or types.ts — implementer's choice, keep it exported for the component + tests.)

- [ ] **Step 4: Run TS gates** — `npm test` (113 + ~6 new), `npx tsc -p tsconfig.json --noEmit` clean.
- [ ] **Step 5: Commit** — `feat(ui): voice → board store action + extract wrapper`.

### Task 3: VoiceNoteReview — board action, extraction, preview, confirm

**Files:**
- Modify: `src/components/VoiceNoteReview.tsx` (button in the review-phase `.voice-actions` div ~line 244; new preview JSX block; orchestration via `useStore`)
- Modify: `src/components/VoiceNoteReview.test.tsx` (new describe blocks)
- Modify: `src/styles.css` (small additions: `.board-preview` rows styling in the SAME area as the existing voice styles; base rules before the EOF @media block if any mobile override is needed — kanban T6 source-order lesson)

**Interfaces:**
- Consumes: Task 1 `api.voiceExtractTasks(text)`; Task 2 `useStore` → `connection`, `saveVoiceNoteWithBoard`; existing component state (`currentText()`, `title`, `category`, `view`/`tidiedText` for useTidied, `rec`, `mode`, `noteId`, `onClose`).
- Produces: no prop changes (App untouched). New internal states: `extracting: boolean`, `preview: string[] | null`, `savedNoteId: string | null`. New phase behavior: preview replaces the transcript view; Cancel returns to review (preview discarded).

- [ ] **Step 1: Write the failing tests** (component tests; NOTE: VoiceNoteReview currently does not use the store — the tests must seed the store: `useStore.setState({ connection: { ... } as T.ConnectInfo })` for connected tests, `connection: null` for offline. Mock `voice_extract_tasks` in the invoke map: `if (cmd === 'voice_extract_tasks') return Promise.resolve(['Buy milk', 'Call dentist']);` plus `create_task_board`/`add_item` rows per Task 2. The component imports `useStore` from '../stores/store' — the store module's OWN invoke mock is NOT active in this file; the component test's top-level `invoke` mock serves both.)

```tsx
describe('VoiceNoteReview board flow', () => {
  // reach review phase: render mode="new", click Stop (transcribe auto-fires,
  // enterReview lands in phase=review) — reuse the harness defaults above.

  it('board button: enabled when connected with a transcript, disabled offline and when empty', async () => {
    useStore.setState({ connection: { url: 'x' } as never });
    render(<VoiceNoteReview mode="new" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    const btn = await screen.findByRole('button', { name: /kanban board/i });
    expect(btn).toBeEnabled();
    useStore.setState({ connection: null });
    render(<VoiceNoteReview mode="new" onClose={() => {}} />);
    // offline instance: disabled with a connect hint (title attr)
  });

  it('tap extracts from the EDITOR text and shows the editable preview', async () => {
    // reach review with rawTranscript 'Hello world. Second sentence.'
    // edit the textarea to 'Edited transcript'
    fireEvent.click(screen.getByRole('button', { name: /kanban board/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_extract_tasks', { text: 'Edited transcript' }));
    // preview rows exist, edit + remove + add work
    fireEvent.change(await screen.findByDisplayValue('Buy milk'), { target: { value: 'Buy oat milk' } });
    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]);
    fireEvent.click(screen.getByRole('button', { name: /\+ add task/i }));
    // board title/category inputs mirror the overlay fields (title prefilled from transcript)
    expect(screen.getByDisplayValue(/Hello world/)).toBeInTheDocument();
  });

  it('empty extraction shows the no-tasks notice and stays in review', async () => {
    invoke.mockImplementation((cmd: string) => cmd === 'voice_transcribe'
      ? Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'Hello world.', lastError: null })
      : cmd === 'voice_extract_tasks' ? Promise.resolve([])
      : cmd === 'voice_start_recording' ? Promise.resolve(recordedRow)
      : cmd === 'voice_stop_recording' ? Promise.resolve(recordedRow) : Promise.resolve(null));
    // extract → notice 'No tasks found' visible, transcript editor still present
  });

  it('extraction failure keeps the review view with a retryable error', async () => {
    // voice_extract_tasks rejects 'api error 500' → error line rendered, button re-enabled
  });

  it('confirm runs save → board → adds, then closes; board selection wins (no onSaved call)', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    useStore.setState({ connection: { url: 'x' } as never });
    render(<VoiceNoteReview mode="new" onClose={onClose} onSaved={onSaved} />);
    fireEvent.click(screen.getByText('Stop'));
    fireEvent.click(await screen.findByRole('button', { name: /kanban board/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Create/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSaved).not.toHaveBeenCalled();
    const order = invoke.mock.calls.map((c) => c[0]);
    expect(order.indexOf('voice_save_note')).toBeLessThan(order.indexOf('create_task_board'));
    expect(order.indexOf('create_task_board')).toBeLessThan(order.indexOf('add_item'));
    expect(useStore.getState().selectedChecklistId).toBe('b1');
  });

  it('board-stage failure: notice names it, note marked saved, Create retries WITHOUT re-saving', async () => {
    const onSaved = vi.fn();
    let boardCalls = 0;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_save_note') return Promise.resolve({ id: 'n1', title: 'T', content: 'x', category: 'Uncategorized', audioPath: '/v/r1.wav', audioDurationSecs: 4, createdAt: null, updatedAt: null, deletedAt: null, dirty: true });
      if (cmd === 'create_task_board') {
        boardCalls += 1;
        return boardCalls === 1 ? Promise.reject('api error 400: nope') : Promise.resolve({ id: 'b1', title: 'T', category: 'Uncategorized', dirty: false, completed: false, listType: 'kanban', items: [] });
      }
      if (cmd === 'add_item') return Promise.resolve({});
      if (cmd === 'voice_transcribe') return Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'Hello world.', lastError: null });
      if (cmd === 'voice_start_recording' || cmd === 'voice_stop_recording') return Promise.resolve(recordedRow);
      return Promise.resolve(null);
    });
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={onSaved} />);
    fireEvent.click(screen.getByText('Stop'));
    fireEvent.click(await screen.findByRole('button', { name: /kanban board/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Create/i }));
    expect(await screen.findByText(/Note saved — board creation failed/)).toBeInTheDocument();
    const savesAfterFirst = invoke.mock.calls.filter((c) => c[0] === 'voice_save_note').length;
    expect(savesAfterFirst).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));
    await waitFor(() => expect(boardCalls).toBe(2));
    expect(invoke.mock.calls.filter((c) => c[0] === 'voice_save_note').length).toBe(1); // STILL 1
  });

  it('cancel at preview persists nothing and returns to review with edits intact', async () => {
    // enter preview → Cancel → transcript textarea back, no create/save invokes beyond extraction
  });
});
```

(The final test code must be completed to the file's existing harness conventions — every test must assert concrete DOM/invocation outcomes as sketched; no placeholder assertions.)

- [ ] **Step 2: Run RED.**
- [ ] **Step 3: Implement** — component shape:

```tsx
const { connection, saveVoiceNoteWithBoard } = useStore();
const [extracting, setExtracting] = useState(false);
const [preview, setPreview] = useState<string[] | null>(null);
const [savedNoteId, setSavedNoteId] = useState<string | null>(null);
const boardEnabled = !!connection && !!currentText().trim() && !busy && !extracting && phase === 'review';
```

Board button (review actions div, next to Save):

```tsx
<button className="primary" disabled={!boardEnabled || extracting}
        title={connection ? 'Extract tasks with AI and create a board' : 'Connect to create boards'}
        onClick={() => void startBoardFlow()}>
  {extracting ? 'Extracting…' : 'Save + kanban board'}
</button>
```

```tsx
const startBoardFlow = async () => {
  setExtracting(true); setNotice(null); setError(null);
  try {
    const tasks = await api.voiceExtractTasks(currentText());
    if (!mounted.current) return;
    if (tasks.length === 0) setNotice('No tasks found in this transcript.');
    else setPreview(tasks.filter((t) => t.trim()).length ? tasks : [tasks.join('')]); // never an all-empty preview from a non-empty reply
  } catch (e) {
    if (mounted.current) setError(fmt(e));
  } finally {
    if (mounted.current) setExtracting(false);
  }
};
```

Preview block (new `phase === 'review' && preview` conditional BEFORE the transcript view; title/category inputs SHARED with review — same state, so edits propagate):

```tsx
{phase === 'review' && preview && (
  <div className="board-preview">
    <h3>Board tasks</h3>
    <p className="voice-hint">Board “{(title.trim() || 'Tasks from voice note')}” in “{category}” — every card starts in the first column.</p>
    {preview.map((t, i) => (
      <div className="board-task-row" key={i}>
        <input value={t} onChange={(e) => setPreview(preview.map((v, j) => (j === i ? e.target.value : v)))} />
        <button aria-label={`Remove task ${i + 1}`} onClick={() => setPreview(preview.filter((_, j) => j !== i))}>×</button>
      </div>
    ))}
    <button onClick={() => setPreview([...preview, ''])}>+ add task</button>
    <div className="voice-actions">
      <button className="primary" disabled={busy || !preview.some((t) => t.trim())}
              onClick={() => void createBoardFromTasks()}>Create</button>
      <button onClick={() => { setPreview(null); }}>Cancel</button>
    </div>
    {boardNotice && <p className="voice-hint">{boardNotice}</p>}
  </div>
)}
```

Confirm handler:

```tsx
const [boardNotice, setBoardNotice] = useState<string | null>(null);
const createBoardFromTasks = async () => {
  setBusy(true); setError(null);
  try {
    await saveVoiceNoteWithBoard({
      recordingId: mode === 'retranscribe' ? null : rec?.id ?? null,
      noteId: mode === 'retranscribe' ? noteId ?? null : null,
      title, category,
      useTidied: view === 'tidied' && tidiedText != null,
      text: currentText(),
      tasks: preview ?? [],
      noteSavedId: savedNoteId,
    });
    if (!mounted.current) return;
    onClose(); // board is selected by the store; NOT onSaved (board wins)
  } catch (e) {
    if (!mounted.current) return;
    const err = e as Error & { boardStage?: boolean; noteId?: string };
    if (err.boardStage) {
      setSavedNoteId(err.noteId ?? null);
      setBoardNotice(`Note saved — board creation failed: ${fmt(e)} Adjust the tasks and try again.`);
    } else {
      setError(fmt(e));
    }
  } finally {
    if (mounted.current) setBusy(false);
  }
};
```

While `preview` is open the transcript view is replaced; the review-phase board button and Save stay hidden inside the preview block (preview renders INSTEAD of the textarea + old actions — structure the JSX so exactly one of them renders).

- [ ] **Step 4: Run TS gates** — `npm test`, tsc clean (expect ~113+6 store + ~7 component new).
- [ ] **Step 5: Px-check** (playwright, cwd=/tmp, dist served over http, __TAURI_INTERNALS__ shim): 412px AND 1280px — (a) review phase with the new button, (b) preview state with 3 rows. Vision-verify both screenshots.
- [ ] **Step 6: Commit** — `feat(ui): board action in the voice review — extract, preview, confirm`.

### Task 4: Ship v0.12.0 (desktop + android preview)

**Files:**
- Modify: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` + both lockfiles → 0.12.0
- Modify: `CHANGELOG.md` (new 0.12.0 section)

**Interfaces:** consumes everything shipped by Tasks 1–3.

- [ ] **Step 1: Re-run FULL gates fresh** — `npm test` (all green), `npx tsc -p tsconfig.json --noEmit`, `cargo test` (zero NEW warnings vs stash-verified baseline). Record actual counts in the report.
- [ ] **Step 2: Bump versions** — 0.11.0 → 0.12.0 in the 4 spots; `npm install --package-lock-only`; `cargo update -p jotty-client`. CHANGELOG entry (feature summary + note that the android preview carries kanban boards too, jumping installed previews 0.10.8 → 0.12.0).
- [ ] **Step 3: Commit + push** — verify `git ls-remote origin main` == local HEAD.
- [ ] **Step 4: Desktop bundles** — `npx tauri build` (deb + appimage + rpm; linuxdeploy download failure → deb-only fallback per T19). Compute sha256 for each asset.
- [ ] **Step 5: Release desktop** — tag `v0.12.0` + push tag; `gh release create v0.12.0 <rpm> <deb> <appimage> --title v0.12.0 --notes-file <notes>`; verify `gh release view --json assets` state=uploaded; download + re-hash one asset.
- [ ] **Step 6: Android preview** — source `/tmp/android-env.sh` (recreate per skill Android section if missing); confirm versionName 0.12.0 via `aapt dump badging` post-build (tauri.conf.json injects it; nudge gen/android only if the badging disagrees); `npx tauri android build --target aarch64 --apk` (minutes: background + poll via process_manage; delete stale `/tmp/page.jotty.desktop-server-addr` first; kill leftover java procs if gradle complains). Verify `$ANDROID_HOME/build-tools/34.0.0/apksigner verify --print-certs` + `aapt dump badging` (versionName/minSdk 26) + sha256.
- [ ] **Step 7: Release android** — `gh release create v0.12.0-android-preview <apk> --prerelease` with notes (feature + the 0.10.8 → 0.12.0 updater jump). Verify by `gh release download` + re-hash.
- [ ] **Step 8: Ledger** — update the jotty-client skill status entry + memory (neutral auth phrasing).

---

## Plan rulings (disclosed, load-bearing — amend the spec if any is wrong)

1. **Spec §4 "orchestration lives in the store" is amended into a STORE ACTION + COMPONENT RETRY-STATE split:** the store action owns the save→board→items sequence and board-stage error annotation; the component owns `savedNoteId` (retry skips the save) and preview state. Rationale found while planning: App's `noteSaved` callback does selectNote + nonce bump (note wins) which contradicts "board wins"; the board path calls `onClose` only, and the store's `createBoard` already selects the board + refreshes. No App.tsx changes needed.
2. **Board-stage failure does NOT close the overlay** — the spec's "notice, flow stops" is realized as: preview stays open, boardNotice explains the note IS saved, Create retries from the board step with `noteSavedId` (a second save would duplicate the note). Plain Save stays disabled? No — Save remains available only while nothing is saved; after a board-stage failure the Save button hides (note exists) and the preview's Cancel returns to a review view where Save is disabled with the boardNotice visible. (Concrete: render Save with `disabled={busy || !!savedNoteId}`.)
3. **Suffix persistence moves to the command wrapper** (Task 1 code): `extract_tasks` returns the suffix like `tidy`, the command persists it under a scoped lock (NOT held across the network await — deliberately unlike voice_tidy which holds the db mutex across the await; extract writes no table so it doesn't need to).
4. **Preview discard on Cancel** — going back to review drops the task list (re-extract to get it back); the transcript/title/category edits persist (shared state). Cheaper than keeping both views' state in sync, and "nothing created" is the spec's promise.
5. **Extraction input = `currentText()`** — the same expression the tidy button and Save use; the raw/tidied toggle therefore flows into extraction exactly as it flows into the saved note.
6. **`voice_extract_tasks` arg casing is `{ text }`** — single lowercase word, no camelCase mapping needed; the invoke mock + Rust arg name must stay `text`.
7. **Empty-result vs error are distinct UI states** (notice vs error) — an honest `[]` is NOT an error (gemma3 may find no tasks in prose-y memos).