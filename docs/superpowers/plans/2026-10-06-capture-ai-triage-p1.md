# Capture Foundation (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the capture foundation of the atomic-capture design: a `quick_capture` command (entropy titles), the pinned quick-capture UI with in-app hotkey, the `!INBOX` isolation surfaces, and the companion-repo `jot` CLI.

**Architecture:** Capture = atomic note creation into the `!INBOX` category via the EXISTING local-first pipeline (`create_note_tx` = entity row + outbox op in one transaction — voice_save_note precedent), surfaced by a pinned input + hotkey on the notes wall, isolated from default views, mirrored by a standalone `jot` CLI in the companion repo posting `POST /api/notes` directly.

**Tech Stack:** Tauri 2 + Rust (rusqlite/chrono/uuid), React 18 + TS + zustand, vitest+RTL, pytest (companion).

**Spec:** `docs/superpowers/specs/2026-10-06-atomic-capture-ai-triage-design.md` (commit 5b0e92e) — the plan argues from the spec; executors read both. Scope = spec §3 (capture) + §2 (zone model, `!INBOX` + `PROCESSED` literals only — `LIBRARY/TODO` routing is P2) + §8 KPI 1-2. §5 (triage/AI) and §7 (retention jobs) are later plans.

## Confirmed current-code facts (leaf-verified @ 5b0e92e, /tmp/jotty-probe/p1-facts.md)

- `create_note_tx(tx: &rusqlite::Transaction, title: &str, content: &str, category: &str) -> AppResult<NoteRow>` — `src-tauri/src/commands/mod.rs:32-48`; single source of truth for note creation (entity + outbox op, Ruling-E payload `{temp_id, title, content, category}`); used by `create_note_inner` :22-27 and `voice_save_note_inner` :1694-1728.
- `notes::insert_local(conn, &NewNote{title, content, category})` — `src-tauri/src/db/notes.rs:98-107` (uuid v4 id, dirty=1, FTS refresh).
- `notes::list(conn, include_deleted)` — db/notes.rs:142-148, **no category param**; isolation is CLIENT-side (App.tsx:56-64 `inCategory` + `visibleNotes` chains).
- `AppError` variants (`src-tauri/src/error.rs`): `Db/Http/Api/Keyring/NotConnected/InvalidConfig/Conflict/Other(String)` — empty-capture uses `Other`.
- db/notes.rs already imports `chrono::Utc`, `rusqlite::Connection`, `OptionalExtension` — no new deps; NO `rand` crate exists (use `uuid` bytes).
- Note `create` push arm: `sync/push.rs:66-89` → `client.create_note(title, content, category)` → `POST /api/notes` (`jotty/client.rs:175-181`) — unchanged by this plan; local note ids remap via outbox `temp_id`.
- App keydown listener: `src/App.tsx:168-177` only handles Ctrl/Cmd+K → CommandBar (`showSearch` state :48). No test covers it; jsdom keyboard precedent = `fireEvent.keyDown(window, ...)` + raw `window.dispatchEvent(new KeyboardEvent(...))`.
- CommandBar `(ex-SearchPalette)`: `src/components/CommandBar.tsx` (107 lines) maps `SearchResultsDto.notes` (`{id,title,snippet}`, NO category) at :51-57; test file `src/components/CommandBar.test.tsx` (131 lines, 7-commands fence :39-43).
- Store: `src/stores/store.ts` — `createNote` action :160-165 (create + refreshAll + select); `AppState` fields :7-30; `App.tsx:56-64` category filtering, `visibleNotes` :67-74; full-swap ternary :202-212 (`listMode: 'notes'|'checklists'|'agenda'` — stays 3 values, no new mode).
- Card-wall fences (byte-frozen, DO NOT touch): `li > .card-head(.item-title+.mic-badge+chips+.row-del) + .card-body>.row-snippet + .card-foot>.row-age`; CSS `src/styles.css` card-wall block; `#app>main` full-swap rules; categories derive: `.archive` skipped (db/categories.rs:39-58) — `!INBOX` MUST stay derived (it appears in the sidebar with count = access point).
- Baselines @ HEAD: vitest **47 files / 557 passed** (known cosmetic: 2-3 unhandled rejections, `ChecklistView.tsx:31` null-`.items`, pre-ruled not a gate break); cargo lib **294 passed + 1 ignored**; warnings census **18** (delta = 0 gate). GTK fence needs `DISPLAY=:99`. Test script: `NODE_OPTIONS=--no-webstorage vitest run --passWithNoTests` (package.json:9).
- Commands tests live in `src-tauri/src/commands/mod.rs:1850+ mod tests`; db/notes tests at `db/notes.rs:158-273` with `db()` tempfile helper :164-171 (leak via `std::mem::forget`).
- Companion: Python ≥3.11 (pyproject.toml:9), flat modules `src/jotty_companion/*.py`, NO CLI infra (no argparse anywhere), no `[project.scripts]`, sole dep python-dateutil (dev: pytest≥7); pytest via `.venv` (`source .venv/bin/activate && python3 -m pytest -q`), suite 90/90; HTTP precedent = stdlib-urllib `NtfyClient.push` (ntfy_client.py:36-55); Docker CMD `python -m jotty_companion.main`.
- Git: repo-LOCAL identity required — commit with `git -c user.name=zeus -c user.email=zeus@local commit`; NEVER run `cargo fmt`; packages never committed; main is the working branch (this repo commits directly on main per 10 prior runs).

## Global Constraints

- **Entropy title format (spec §3, load-bearing):** `cap_<epochms>_<rand4>` — epochms = `Utc::now().timestamp_millis()` (13-digit class at 2026), rand4 = exactly 4 lowercase hex chars derived from `uuid::Uuid::new_v4()` bytes. Uniqueness: check-unique loop against `notes WHERE category='!INBOX' AND title=? AND deleted_at IS NULL` (local domain only; the companion CLI relies on rand4 + the probe-proven sequential-suffix server behavior — never add a server GET loop).
- **Category literals:** `!INBOX` (capture target, case-sensitive), sidebar shows it with live count; `PROCESSED` reserved (P4) — do not create it anywhere in P1.
- **No server fork / no upstream API changes** (2026-09-15 lock). No new crates, no new npm deps. No `cargo fmt`. Zero NEW compiler warnings (census 18, delta 0).
- **Local-mutation invariant:** every local note mutation = ONE transaction (entity + outbox op) — T1 must route through `create_note_tx`, never a fresh INSERT.
- **Sync invariants untouched:** push→pull order, FIFO replay, LWW+dirty — no changes in sync/ for P1.
- **Fences (byte-frozen, must not change):** card-wall DOM classes + `styles.css` card-wall block; App full-swap ternary chain shape (listMode stays 3 values); `.back-btn` promoted base rule; CommandBar exactly-7-pinned-commands fence; CommandBar `.command-row`/modal classes.
- **Gates per task:** full `npx vitest run` (≥557 passing, zero NEW failures; the 2-3 known unhandled-rejection noise lines excluded); `npx tsc -p tsconfig.json --noEmit` clean; `DISPLAY=:99 cargo test --lib --manifest-path src-tauri/Cargo.toml` (≥294 + 1i, zero NEW failures); warnings census via `cargo check --all-targets 2>&1 | grep -c '^warning'` = 18 Δ0 (T1/T4 Rust-relevant tasks; re-run even for frontend-only changes after Cargo.toml changes — none planned).
- **Tauri ACL standing rule:** any new JS-side `@tauri-apps/api` call must be checked against `src-tauri/capabilities/default.json` — P1 adds NONE (plain `window` keydown + existing commands only).
- **Tests:** RTL = mock `@tauri-apps/api/core` (module mock, `invoke` spy), store reset via `useStore.setState({...} as never)`; RTL `getByText` matches TEXT NODES only (wrap interpolated text in elements); keyboard tests via `fireEvent.keyDown(window, {key, ctrlKey, shiftKey})` pattern. Rust: inline `#[cfg(test)] mod tests`, tempfile `db()` helper pattern.
- **Commits:** conventional message; body explains behavior + test counts; `git -c user.name=zeus -c user.email=zeus@local commit`. One commit per task minimum (multi-commit fine).

---

### Task 1: `capture_title` + `quick_capture` command (Rust)

**Files:**
- Modify: `src-tauri/src/db/notes.rs` (add `capture_title` near `insert_local`, ~:98; extend `mod tests` :158)
- Modify: `src-tauri/src/commands/mod.rs` (add `quick_capture_inner` near `create_note_inner` :22-27, add `#[tauri::command] quick_capture` near :830, extend `mod tests` :1850+)
- Modify: `src-tauri/src/lib.rs` (add `quick_capture,` to `generate_handler!` after `create_note,` :59)

**Interfaces:**
- Consumes: `create_note_tx` (commands/mod.rs:32-48), `NewNote`/`insert_local` shape, `AppError::Other`, `chrono::Utc`, `uuid::Uuid`.
- Produces (T2 consumes): `#[tauri::command] pub async fn quick_capture(state: tauri::State<'_, AppState>, text: String) -> Result<NoteDto, String>` — invoke from JS as `invoke<NoteDto>('quick_capture', { text })`; on success returns the created note (id = temp uuid until push remaps, category `!INBOX`, content = trimmed text). Also produces `pub fn capture_title(conn: &Connection) -> String` (db/notes.rs).

- [ ] **Step 1: Write the failing tests** — append to the existing `mod tests` in `src-tauri/src/db/notes.rs`:

```rust
    #[test]
    fn capture_title_matches_spec_format() {
        let conn = db();
        for _ in 0..20 {
            let t = super::capture_title(&conn);
            let parts: Vec<&str> = t.split('_').collect();
            assert_eq!(parts.len(), 3, "format cap_<epochms>_<rand4>, got {t}");
            assert_eq!(parts[0], "cap");
            assert_eq!(parts[1].len(), 13, "epochms, got {t}");
            assert!(parts[1].parse::<i64>().is_ok(), "epochms numeric, got {t}");
            assert_eq!(parts[2].len(), 4, "rand4, got {t}");
            assert!(
                parts[2].chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "rand4 lowercase hex, got {t}"
            );
        }
    }

    #[test]
    fn capture_title_is_unique_under_same_millisecond() {
        let conn = db();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..200 {
            assert!(seen.insert(super::capture_title(&conn)), "duplicate title in 200 same-ms calls");
        }
    }

    #[test]
    fn capture_title_avoids_existing_inbox_titles() {
        let conn = db();
        let first = super::capture_title(&conn);
        super::insert_local(
            &conn,
            &super::NewNote {
                title: first.clone(),
                content: "x".into(),
                category: "!INBOX".into(),
            },
        )
        .expect("seed inbox note");
        let second = super::capture_title(&conn);
        assert_ne!(first, second, "must not reuse a live !INBOX title");
    }
```

- [ ] **Step 2: Run to verify RED** — `DISPLAY=:99 cargo test --lib capture_title --manifest-path src-tauri/Cargo.toml`
  Expected: FAIL — `cannot find function capture_title` (compile error counts as RED).

- [ ] **Step 3: Implement `capture_title`** — add to `src-tauri/src/db/notes.rs` directly above `insert_local`:

```rust
/// Entropy title for capture-zone notes (spec 2026-10-06 section 3): `cap_<epochms>_<rand4>`.
/// Titles are filename-deriving upstream — uniqueness inside !INBOX is LOAD-BEARING
/// (concurrent same-title creates lose data silently; probed 2026-10-06, see spec appendix).
/// Uses uuid::Uuid bytes for the random part (no rand dep). Check-unique loop vs live !INBOX rows.
pub fn capture_title(conn: &Connection) -> String {
    loop {
        let ms = Utc::now().timestamp_millis();
        let b = uuid::Uuid::new_v4().as_bytes();
        let title = format!("cap_{}_{:02x}{:02x}", ms, b[0], b[1]);
        let taken: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE category = '!INBOX' AND title = ?1 AND deleted_at IS NULL",
                [&title],
                |r| r.get(0),
            )
            .unwrap_or(1);
        if taken == 0 {
            return title;
        }
    }
}
```

- [ ] **Step 4: GREEN** — `DISPLAY=:99 cargo test --lib capture_title --manifest-path src-tauri/Cargo.toml` → 3 passed.

- [ ] **Step 5: Write failing command tests** — append to `mod tests` in `src-tauri/src/commands/mod.rs` (mirror the file's existing command-test seeding; the sqlite test style is already proven at :1850+; the essential asserts are binding):

```rust
    #[test]
    fn quick_capture_creates_inbox_note_and_outbox_op() {
        let conn = test_conn(); // use the file's existing local-db test helper; if none exists in mod tests, mirror db/notes.rs `db()` tempfile pattern
        let dto = super::quick_capture_inner(&mut conn.lock_wrapped(), "check disk on web-01")
            .expect("capture");
        assert_eq!(dto.category, "!INBOX");
        assert_eq!(dto.content, "check disk on web-01");
        assert!(dto.title.starts_with("cap_"), "entropy title, got {}", dto.title);
        assert!(dto.dirty, "local capture is dirty until pushed");
        // outbox op = ('create','note', temp_id, payload with !INBOX)
        let op = /* read the single outbox row via the file's existing outbox test access pattern */;
        assert_eq!(op.op_type, "create");
        assert_eq!(op.entity, "note");
        let payload: serde_json::Value = serde_json::from_str(&op.payload).expect("payload json");
        assert_eq!(payload["category"], "!INBOX");
        assert_eq!(payload["content"], "check disk on web-01");
    }

    #[test]
    fn quick_capture_rejects_empty_text() {
        let conn = test_conn();
        let err = super::quick_capture_inner(&mut conn.lock_wrapped(), "   ")
            .expect_err("empty input rejected");
        assert!(err.to_string().contains("empty"), "message mentions empty: {err}");
    }
```

  **NOTE (binding, plan-verbatim adaptation allowed and disclosed):** the two `conn.lock_wrapped()` / `test_conn()` / outbox-row-access pseudoints must be replaced with the TEST FILE'S REAL conveniences (the commands tests already have a temp-db helper + outbox access pattern at :1850+ — read the neighbors FIRST and mirror their seeding; asserts above are the spec). Disclose the adaptation in the report.

- [ ] **Step 6: RED** — `DISPLAY=:99 cargo test --lib quick_capture --manifest-path src-tauri/Cargo.toml` → FAIL (no `quick_capture_inner`).

- [ ] **Step 7: Implement** — near `create_note_inner` (commands/mod.rs :22-48):

```rust
pub fn quick_capture_inner(conn: &mut Connection, text: &str) -> AppResult<NoteDto> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(AppError::Other("empty capture: nothing to store".into()));
    }
    let title = crate::db::notes::capture_title(conn);
    let mut tx = conn.transaction()?;
    let row = create_note_tx(&tx, &title, trimmed, "!INBOX")?;
    tx.commit()?;
    Ok(NoteDto::from(row))
}

#[tauri::command]
pub async fn quick_capture(state: tauri::State<'_, AppState>, text: String) -> Result<NoteDto, String> {
    let mut conn = state.db.lock().await;
    quick_capture_inner(&mut conn, &text).map_err(|e| e.to_string())
}
```

  (Shape deviation disclosure duty: `capture_title(conn)` takes the shared `&Connection` borrow BEFORE the tx is opened — if the borrow checker objects to the ordering, compute the title AFTER `transaction()` using `&tx` (deref-coerced `&Connection`) — both call shapes compile; pick the one that compiles, keep the check-unique loop.)

- [ ] **Step 8: Register** — `src-tauri/src/lib.rs` line ~59 block: insert `quick_capture,` after `create_note,`.

- [ ] **Step 9: Full gates** — `DISPLAY=:99 cargo test --lib --manifest-path src-tauri/Cargo.toml` → 297 passed + 1 ignored (294 + 3 new). Warnings census = 18 Δ0. No cargo fmt.

- [ ] **Step 10: Commit** — `git add -A && git -c user.name=zeus -c user.email=zeus@local commit -m "feat(capture): quick_capture command with entropy titles (cap_<epochms>_<rand4>)` + `body: routes through create_note_tx (entity + outbox in one tx); empty input -> AppError::Other; +3 db tests +2 command tests; gates: cargo 297+1i, census 18 d0"`.

### Task 2: Quick-capture UI + hotkey (frontend)

**Files:**
- Create: `src/components/QuickCapture.tsx`, `src/components/QuickCapture.test.tsx`
- Modify: `src/api/client.ts` (add `quickCapture` wrapper near `createNote` :7)
- Modify: `src/stores/store.ts` (add `quickCapture` action near `createNote` :160-165 + AppState type)
- Modify: `src/App.tsx` (render pinned strip above the notes wall + hotkey branch in the :168-177 listener)
- Modify: `src/styles.css` (append a `.quick-capture` block AT FILE END — never inside the card-wall block)
- Modify: `src/App.test.tsx` (2 new tests)

**Interfaces:**
- Consumes: `invoke<NoteDto>('quick_capture', { text })` from T1 (JS arg key `text`, camelCase convention).
- Produces: `api.quickCapture(text: string): Promise<T.NoteDto>` (src/api/client.ts); store action `quickCapture: async (text: string) => Promise<T.NoteDto>` (state unchanged except refresh); component `QuickCapture({ focusSignal, onSubmit }: { focusSignal: number; onSubmit: (text: string) => Promise<unknown> })` — exported, rendered by App only while the notes wall is active.

- [ ] **Step 1: RED tests** — `src/components/QuickCapture.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuickCapture } from './QuickCapture';

describe('QuickCapture', () => {
  it('renders an input and does not submit empty text', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<QuickCapture focusSignal={0} onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/capture/i);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits trimmed text on Enter and clears the field', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<QuickCapture focusSignal={0} onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/capture/i);
    fireEvent.change(input, { target: { value: '  renew vpn cert  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('renew vpn cert');
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('shows a persistent error line if submit rejects', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('offline queue full'));
    render(<QuickCapture focusSignal={0} onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/capture/i);
    fireEvent.change(input, { target: { value: 'save me' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/offline queue full/i)).toBeTruthy());
  });

  it('focuses the input when focusSignal increments', () => {
    const { rerender } = render(<QuickCapture focusSignal={0} onSubmit={vi.fn()} />);
    const input = screen.getByPlaceholderText(/capture/i);
    rerender(<QuickCapture focusSignal={1} onSubmit={vi.fn()} />);
    expect(document.activeElement).toBe(input);
  });
});
```

  App-level additions in `src/App.test.tsx` (mirror the file's existing seed helper for `useStore.setState`; asserts binding — read the neighbor tests FIRST):

```tsx
describe('Quick capture (capture-foundation P1)', () => {
  it('Ctrl+Shift+J focuses the capture input from anywhere in the app', async () => {
    // seed + render App per the file's existing helper; mount the notes wall (listMode 'notes', no selection)
    // fireEvent.keyDown(window, { key: 'J', ctrlKey: true, shiftKey: true });
    // expect(document.activeElement?.getAttribute('placeholder')).toMatch(/capture/i);
  });

  it('submitting a capture posts quick_capture with the text and stays on the wall', async () => {
    // seed; type into the capture input; fireEvent.keyDown(input, {key:'Enter'});
    // await waitFor(() => expect(invoke).toHaveBeenCalledWith('quick_capture', { text: '...' }));
    // assert the wall still renders (no editor opened)
  });
});
```

  **EXEMPLAR-FENCE DISCLOSURE (sanctioned shape):** the two App-level test bodies are pinned ASSERT SKETCHES, not complete code — the implementer must complete them using the file's existing seed/render helper (App.test.tsx :35+ pattern), keeping the asserts verbatim. All other fences are complete code.

- [ ] **Step 2: RED run** — `NODE_OPTIONS=--no-webstorage npx vitest run src/components/QuickCapture.test.tsx` → FAIL (module missing). The App tests join at GREEN.

- [ ] **Step 3: Implement api + store**:

```ts
// src/api/client.ts (near createNote :7)
export const quickCapture = (text: string) => invoke<T.NoteDto>('quick_capture', { text });
```

```ts
// src/stores/store.ts — AppState action (next to createNote :160-165)
quickCapture: async (text: string) => {
  const note = await api.quickCapture(text);
  await get().refreshAll();
  return note;
},
```

  (AppState type: add `quickCapture: (text: string) => Promise<T.NoteDto>;` beside `createNote`'s type.)

- [ ] **Step 4: Implement component** — `src/components/QuickCapture.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';

export function QuickCapture({ focusSignal, onSubmit }: { focusSignal: number; onSubmit: (text: string) => Promise<unknown> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  const submit = async () => {
    const text = value.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text);
      setValue('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="quick-capture">
      <input
        ref={inputRef}
        placeholder={`Capture (Ctrl+Shift+J)...`}
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {error && <div className="quick-capture-error">{error}</div>}
    </div>
  );
}
```

  (If `e instanceof Error` narrows poorly under the repo tsconfig, use `e instanceof Error ? e.message : String(e)` — already the plan shape; do NOT let the catch swallow into silence.)

- [ ] **Step 5: Wire App.tsx** — (a) import QuickCapture; (b) add state `const [qcFocus, setQcFocus] = useState(0);`; (c) extend the existing keydown listener (:168-177) with a second branch AFTER the Ctrl/Cmd+K branch (do not touch the K branch):

```tsx
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setListMode('notes');
        setQcFocus((n) => n + 1);
      }
```

  (`setListMode` is the store action :150-153; call via `useStore.getState().setListMode('notes')` if the listener is outside the hook's closure — mirror how the K branch calls `setShowSearch(true)` and use the same access pattern.) (d) render the strip inside the `list-only` main above the ternary, gated to the notes wall:

```tsx
{!selectedNoteId && !selectedChecklistId && listMode === 'notes' && (
  <QuickCapture focusSignal={qcFocus} onSubmit={(text) => useStore.getState().quickCapture(text)} />
)}
```

  (Place it INSIDE `<main>` before the swap ternary :202-212 — the ternary chain itself must remain byte-identical.)

- [ ] **Step 6: styles.css append (file end):**

```css
.quick-capture { padding: 0 10px 10px; }
.quick-capture input { width: 100%; box-sizing: border-box; }
.quick-capture-error { color: var(--danger, #c0392b); font-size: 12px; padding: 4px 2px; }
```

- [ ] **Step 7: GREEN + gates** — full `NODE_OPTIONS=--no-webstorage npx vitest run` → all pass (≥557 + new; the known ChecklistView null-items rejections remain, NOT new), `npx tsc -p tsconfig.json --noEmit` clean. Screenshot pass NOT required (no card-wall CSS touched) but a jsdom presence assert lives in the App tests (component renders on the wall).

- [ ] **Step 8: Commit** — `feat(capture): quick-capture UI + hotkey (Ctrl+Shift+J)`; body: behavior + test counts.

### Task 3: `!INBOX` isolation + inbox surface (frontend)

**Files:**
- Modify: `src/stores/store.ts` (export `isCaptureZone` helper + AppState unchanged)
- Modify: `src/App.tsx` (:56-64 filtering)
- Modify: `src/components/CommandBar.tsx` (filter note hits :51-57)
- Modify: `src/App.test.tsx` (+2 tests), `src/components/CommandBar.test.tsx` (+1 test)

**Interfaces:**
- Consumes: category literal `!INBOX` (T1 writes it); store `notes` rows (category available client-side); CommandBar api.search result shape `{notes:{id,title,snippet}[]}` (no category on hits — resolve via store).
- Produces: `export const isCaptureZone = (category: string | null | undefined): boolean` in `src/stores/store.ts` (P2 triage + P3 AI reuse it for route validation).

- [ ] **Step 1: RED tests** — in `src/App.test.tsx` (complete bodies; seed helper = the file's existing one):

```tsx
  it('capture-zone notes are hidden from the notes wall until the inbox category is selected', () => {
    // seed store: note A {category: 'Work', title:'work note'}, note B {category: '!INBOX', title:'cap_1_aaaa'}
    // render App; expect screen.getByText('work note')toBeTruthy(); expect(screen.queryByText('cap_1_aaaa')).toBeNull();
    // select the inbox category: useStore.getState().selectCategory({ type:'notes', path:'!INBOX' });
    // expect B visible, A hidden (assert via queryByText toggles)
  });

  it('inbox surface shows the capture count next to the category node', () => {
    // seed store with 2 inbox notes + 1 other; render App; sidebar !INBOX node renders with .count chip '2'
    // (mirror how Sidebar tests assert counts: src/components/Sidebar.test.tsx)
  });
```

  in `src/components/CommandBar.test.tsx` (complete body):

```tsx
  it('search results exclude capture-zone notes', async () => {
    // seed store notes: [{id:'n1', title:'Normal', category:'Work'}, {id:'inbox1', title:'cap_1_bbbb', category:'!INBOX'}];
    // invoke mock search returns {notes:[{id:'n1',...},{id:'inbox1',...}], checklists:[]};
    // open palette (render App? NO — render CommandBar directly with mocked search per the file's pattern);
    // type 'cap' or trigger search; expect row for n1 present, row for inbox1 ABSENT
  });
```

  **EXEMPLAR-FENCE DISCLOSURE (sanctioned):** seed/assert mechanics mirror each test file's existing helper (CommandBar.test.tsx :14-35 mock+reset pattern, App.test.tsx :35+ seed pattern); the asserts written above are binding.

- [ ] **Step 2: RED run** — new tests fail (inbox visible everywhere today).

- [ ] **Step 3: Implement store helper** (top of `src/stores/store.ts`, exported):

```ts
export const INBOX_CATEGORY = '!INBOX';
export const isCaptureZone = (category: string | null | undefined): boolean =>
  !!category && category === INBOX_CATEGORY || (!!category && category.startsWith(`${INBOX_CATEGORY}/`));
```

- [ ] **Step 4: Implement App filtering** — rework ONLY the notes branch of App.tsx :56-64 (checklists branch untouched):

```tsx
    const inboxSelected =
      selectedCategory?.type === 'notes' && isCaptureZone(selectedCategory.path);
    const filteredNotes = selectedCategory?.type === 'notes'
      ? notes.filter((n) =>
          inboxSelected
            ? isCaptureZone(n.category)
            : inCategory(n.category, selectedCategory.path) && !isCaptureZone(n.category),
        )
      : notes.filter((n) => !isCaptureZone(n.category));
```

  (`inCategory(cat, path)` stays :56-64 as-is; `visibleNotes` chain (:67-74) continues to apply on top for non-inbox views — when inboxSelected, ALSO ensure the 'pinned'/'recent' preference filter does not swallow inbox cards: if inboxSelected, bypass prefs (`const visibleNotes = inboxSelected ? filteredNotes : applyDefaultNoteFilter(filteredNotes, prefs...)` — mirror the existing chain shape at :67-74, keep its variable names).

- [ ] **Step 5: Implement CommandBar exclusion** — in the results-mapping block (:48-57), filter BEFORE mapping (insert above the notes map):

```tsx
    const notesById = new Map((useStore.getState().notes ?? []).map((n) => [n.id, n] as const));
    const noteHits = (results?.notes ?? []).filter((h) => {
      const n = notesById.get(h.id);
      return !n || !isCaptureZone(n.category);
    });
```

  then map `noteHits` instead of `results.notes` (unknown ids stay visible). Import `isCaptureZone` from the store module.

- [ ] **Step 6: GREEN + gates** — full vitest (≥557 + new, known noise excluded), tsc clean.

- [ ] **Step 7: Commit** — `feat(capture): isolate !INBOX from default views + expose inbox surface`; body: filtering semantics + counts.

### Task 4: `jot` CLI (jotty-companion repo)

**Files (repo /coding/jotty-companion, branch master):**
- Create: `src/jotty_companion/jot.py`, `tests/test_jot.py`
- Modify: `pyproject.toml` (add `[project.scripts]` section), `README.md` (Capture section)

**Interfaces:**
- Consumes: stock `POST /api/notes` `{title, content, category}` + `x-api-key` (verified wire shape); stdlib only (urllib/json/uuid/time/argparse — NO new deps).
- Produces: console script `jot` (entry point `jotty_companion.jot:main`) + module run `python -m jotty_companion.jot`; exit 0 = captured, prints `captured <title>`; exit 1 = config/network/server error (stderr one-liner); env: `JOTTY_URL`, `JOTTY_API_KEY` (jot reads env directly — NOT service Config; the reminder service config stays untouched).

- [ ] **Step 1: RED tests** — `tests/test_jot.py`:

```python
from __future__ import annotations

import io
import json
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import pytest

from jotty_companion import jot


def test_capture_title_format():
    t = jot.capture_title()
    head, ms, rand = t.split('_')
    assert head == 'cap'
    assert len(ms) == 13 and ms.isdigit()
    assert len(rand) == 4
    assert all(c in '0123456789abcdef' for c in rand)


def test_build_payload_trims_and_defaults_category():
    p = jot.build_payload('  renew vpn cert  ')
    assert p['content'] == 'renew vpn cert'
    assert p['category'] == '!INBOX'
    assert p['title'].startswith('cap_')


def test_main_success_exit_zero_and_prints_captured_title(monkeypatch, capsys):
    monkeypatch.setenv('JOTTY_URL', 'http://127.0.0.1:1')
    monkeypatch.setenv('JOTTY_API_KEY', 'ck_test')
    captured: dict = {}

    class R:
        status = 201

        def read(self):
            return json.dumps({'success': True, 'data': {'id': 'x', 'title': captured.get('title')}}).encode()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        captured['url'] = req.full_url
        captured['body'] = json.loads(req.data.decode())
        captured['key'] = req.headers.get('X-api-key')
        return R()

    with mock.patch.object(jot.urllib.request, 'urlopen', fake_urlopen):
        rc = jot.main(['renew', 'vpn', 'cert'])

    assert rc == 0
    assert captured['url'].endswith('/api/notes')
    assert captured['key'] == 'ck_test'
    assert captured['body']['content'] == 'renew vpn cert'
    assert captured['body']['category'] == '!INBOX'
    assert captured['body']['title'].startswith('cap_')
    out = capsys.readouterr().out
    assert out.startswith('captured cap_')


def test_main_missing_env_fails_fast(monkeypatch, capsys):
    monkeypatch.delenv('JOTTY_URL', raising=False)
    monkeypatch.delenv('JOTTY_API_KEY', raising=False)
    rc = jot.main(['hello'])
    assert rc == 1
    assert 'JOTTY_URL' in capsys.readouterr().err and 'JOTTY_API_KEY' in capsys.readouterr().err


def test_main_http_error_exits_one(monkeypatch, capsys):
    monkeypatch.setenv('JOTTY_URL', 'http://127.0.0.1:1')
    monkeypatch.setenv('JOTTY_API_KEY', 'ck_test')

    def boom(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 401, 'Unauthorized', hdrs=None, fp=None)

    with mock.patch.object(jot.urllib.request, 'urlopen', boom):
        rc = jot.main(['hello'])
    assert rc == 1
    assert '401' in capsys.readouterr().err
```

- [ ] **Step 2: RED run** — `. .venv/bin/activate && python3 -m pytest tests/test_jot.py -q` → FAIL (module missing). Pass explicit workdir `/coding/jotty-companion` on every terminal call.

- [ ] **Step 3: Implement** — `src/jotty_companion/jot.py`:

```python
"""jot - one-shot capture into a stock jotty !INBOX via POST /api/notes.

Capture is atomic CREATION with an entropy title (cap_<epochms>_<rand4>);
concurrent same-title creates lose data upstream (probed 2026-10-06) - the
title scheme is load-bearing. Uniqueness rides on epochms+rand4: if a title
still collides, the server suffixes -1/-2 (probe-proven safe for sequential
creates); no server round-trips are added.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

INBOX = '!INBOX'


def capture_title() -> str:
    return f"cap_{int(time.time() * 1000)}_{uuid.uuid4().hex[:4]}"


def build_payload(text: str, category: str = INBOX) -> dict:
    return {'title': capture_title(), 'content': text.strip(), 'category': category}


def post_note(url: str, key: str, payload: dict, timeout: float = 5.0):
    req = urllib.request.Request(
        url.rstrip('/') + '/api/notes',
        data=json.dumps(payload).encode(),
        headers={'x-api-key': key, 'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog='jot', description='capture text into jotty !INBOX')
    parser.add_argument('text', nargs='+', help='text to capture')
    parser.add_argument('-c', '--category', default=INBOX)
    args = parser.parse_args(argv)

    url = os.environ.get('JOTTY_URL')
    key = os.environ.get('JOTTY_API_KEY')
    missing = [name for name, val in (('JOTTY_URL', url), ('JOTTY_API_KEY', key)) if not val]
    if missing:
        print(f'jot: missing env: {", ".join(missing)}', file=sys.stderr)
        return 1

    payload = build_payload(' '.join(args.text), args.category)
    started = time.monotonic()
    try:
        status, _body = post_note(url, key, payload)
    except urllib.error.HTTPError as e:
        print(f'jot: server error {e.code}', file=sys.stderr)
        return 1
    except (urllib.error.URLError, OSError) as e:
        print(f'jot: cannot reach jotty at {url}: {e}', file=sys.stderr)
        return 1
    elapsed_ms = int((time.monotonic() - started) * 1000)
    print(f'captured {payload["title"]} ({elapsed_ms} ms, http {status})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
```

  **Binding note: the env names are `JOTTY_URL` and `JOTTY_API_KEY` and the success line starts `captured cap_` — tests pin them exactly.**

- [ ] **Step 4: pyproject entry point** — add to `pyproject.toml` after `[project]`'s dependency block:

```toml
[project.scripts]
jot = "jotty_companion.jot:main"
```

- [ ] **Step 5: GREEN** — `python3 -m pytest tests/test_jot.py -q` → 5 passed; then FULL suite `python3 -m pytest -q` → 95/95 (90 + 5).

- [ ] **Step 6: README** — append a `## jot capture CLI` section: install (`pip install -e .[dev]`), usage `jot "renew vpn cert"`, `-c CATEGORY` override, env JOTTY_URL/JOTTY_API_KEY examples, the never-same-title rule one-liner.

- [ ] **Step 7: Commit** — `feat(jot): capture CLI posting entropy-titled notes to !INBOX` + body; push master.

---

## Self-Review appendix (controller, completed pre-dispatch)

- Spec coverage: spec §3 capture (T1/T2/T4), §2 zone model literals (T1/T3), KPI 1-2 (structural + latency print in T4; local instant = existing pipeline). §5/§6/§7/P2-P4 features intentionally absent (later plans). Inbox count chip = sidebar existing `.count` (T3 asserts it).
- No placeholders: every code block complete; TWO disclosed exemplar-fence sketches (T2 App tests, T3 seeds) sanctioned by the outline-exemplar ruling with binding asserts inline.
- Type consistency: `quick_capture`/`quickCapture` naming checked across T1→T2; `isCaptureZone` produced T3, declared for P2/P3 reuse; NoteDto camelCase consumed via `T.NoteDto`.
- Snippet-vs-tests: T2 component passes its own 4 tests (empty → no call; trimmed call + cleared; error line; focus-on-signal). T1 snippets: `capture_title` loop compiles (scalar bind, no tuple shape); `quick_capture_inner` uses `AppError::Other` (confirmed variant) and `create_note_tx` (confirmed). T4 self-parse: argparse join → content 'renew vpn cert' matches test.
- T2/T3 serialize on App.tsx (dispatch order T2 → T3, disclosed). T4 parallel-safe (other repo) but sequential per SDD rule.
- Known baseline risks: App full-swap fences — T2 adds a sibling node INSIDE main (no ternary edit); if a byte-fence asserts exact main children, the RED run will surface it and the implementer discloses + reviewer adjudicates. CommandBar 7-command fence untouched (T3 filters entity rows only).