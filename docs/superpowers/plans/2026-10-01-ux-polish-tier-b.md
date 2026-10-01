# UX Polish Tier B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (or
> subagent-orchestration on Hermes) to implement this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Ship the visible UX tier — unified ⌘K command bar, subtle CSS-only motion with a
reduce-motion setting, board card polish with inline title editing, agenda/onboarding layout
passes, plus the v0.24.1 riders — as v0.25.0.

**Architecture:** Frontend-only. `SearchPalette` is REPLACED by `CommandBar` (App's ⌘K wiring,
`showSearch` slot, and the select-callback contract stay). Motion lives in `:root` duration/ease
tokens consumed by existing component rules; a `reduceMotion` store field (localStorage
`jotty.reduce-motion`, mirroring `jotty.theme-override`) drives `data-reduce-motion="true"` on
`#app`. Board cards gain a dedicated `⋯` menu trigger so the card body becomes the title editor.
Rust is untouched.

**Tech Stack:** React + TS + zustand + vitest/RTL/jsdom; CSS tokens in `src/styles.css`;
`icons.tsx` grows two names (`sun`, `more`), hand-embedded lucide path data, zero deps.

**Spec:** `docs/superpowers/specs/2026-10-01-ux-polish-tier-b-design.md` — the plan argues from
the spec; executors read both.

## Global Constraints (verbatim from the spec — every task implicitly includes these)

- No Tailwind; no new runtime deps; tokens in `src/styles.css`; TDD: failing test first →
  minimal GREEN (RED disclosed if unforced); no green-green test reshapes un-disclosed.
- No font bundling — `system-ui` stays everywhere; no `@font-face` additions.
- Motion: 120–180ms ONLY via tokens (`--motion-fast: 120ms`, `--motion-med: 180ms`,
  `--ease-out: cubic-bezier(0.2, 0, 0, 1)`). Animated properties limited to opacity / transform /
  box-shadow / background-color. Background-color transitions on cards / rows / `li.selected`
  only (no movement). Transitions on `width`, `height`, `top`, `left`, `margin` are FORBIDDEN
  (fence-enforced). NO `@keyframes`; no JS-driven animation; no animation library.
- Motion scope = exactly the S2 surfaces (menus/popovers, modals + backdrop, drawer; color/shadow
  only for cards, rows, selection). No transitions beyond the S2 list.
- Command bar = exactly the 7 spec commands; no per-item commands, no delete commands.
- Board cards: NO `setDragImage`; DnD contract byte-unchanged (drop reads `dataTransfer` first,
  T17 ruling U; children render from `item.children`, T17 ruling W). Card-body click semantics
  CHANGE (menu → inline edit) by design; the menu stays reachable via the new `⋯` trigger.
- Zero Rust changes expected; if a task hits a compile need, STOP and report (controller rules).
- Zero NEW cargo warnings (census `cargo check --all-targets 2>&1 | grep -c '^warning'` = 18 Δ0).
  NEVER run `cargo fmt` in this repo.
- Zero new emoji glyph buttons (icons discipline); `prompt()` stays 0 (grep gate); throwaway
  `__probe*` test files absent at gates; `grep -rn "SearchPalette" src/` → 0 hits after T2.
- Real-engine rule: tasks adding badges/pills/chips or touching flex containers run the
  headless-ux-probe screenshot pass (1280 + 412, vite :5199) BEFORE the gate question.
- Gates re-census by RUNNING at each task (Status snapshots are not live numbers). Base
  snapshots at 4e1b18c: vitest **502/502 across 46 files** (1 known cosmetic unhandled
  rejection), tsc clean, cargo lib 266+1i, warnings census 18 Δ0.
- Commit identity: `git -c user.name=zeus -c user.email=zeus@local commit …` (never mutate the
  repo's git config). Ledger: `.superpowers/sdd/2026-10-01-ux-polish-tier-b/progress.md`
  (gitignored — durable rulings live in the skill + references).

## Confirmed current-code facts (plan-time verification, 2026-10-01)

- `SearchPalette.tsx` (39 lines): `.modal-backdrop` > `.modal` > input (placeholder `Search…`,
  `autoFocus`, 200ms-debounced `api.search(q.trim())`) + result `<li>` rows with
  `<Icon size={13} className="palette-ico"/>` + `<strong>` title + `<small>` snippet; props
  `{ onClose, onSelectNote, onSelectChecklist }`. One test file, one fence (render + navigate).
- `App.tsx`: `Ctrl/Meta+K` → `setShowSearch(true)` (window keydown effect); palette slot:
  `{showSearch && <SearchPalette onClose… onSelectNote={selectNote} onSelectChecklist={selectChecklist}/>}`;
  `startVoiceNote()` probes `api.getAiSettings()` → `setVoice({ mode: 'new' })` or opens
  settings; `showSettings` exists; store destructure line 26 exposes `connection, notes,
  checklists, prefs, branding, themeOverride, selectNote, selectChecklist, refreshAll, …`.
- `store.ts`: `createNote/createChecklist/createBoard(title, category)` each `refreshAll()` +
  select the new entity + set the owning `listMode`; `themeOverride: ThemeOverride | null`
  (localStorage `jotty.theme-override`, setter `setThemeOverride(v)` takes the RAW value —
  SettingsModal converts `v === 'auto' ? null : v` BEFORE calling it, so the cycle list uses
  null-to-null directly); settings-mode Appearance block inside `<div className="appearance-settings">`.
- `KanbanBoard.tsx`: card body click currently OPENS the menu (`setMenuFor` toggle; guard
  `if (renaming) return;`); rename input commits via `onBlur={() => rename(localId)}` + Enter,
  `Escape` handled NOWHERE (backdrop blur/click only); rename path =
  `{ setRenameText(item.text); setRenaming(item.localId); setMenuFor(null); }` (menu's button),
  commit `api.setItemText(checklistId, localId, text)` (invoke `set_item_text`); `dragId` state
  set on dragStart, cleared in onDrop; NO dragEnd; `.kanban-badges` holds priority +
  `targetDate` rendered RAW (`{item.targetDate}`, `YYYY-MM-DD`) + reminder badge (`bell` +
  `formatReminderTime`) + children-count; menu rows: Move × N / Set date / Set reminder /
  Clear reminder / Rename / Delete.
- `KanbanBoard.test.tsx` (420 lines): base invoke mock (get_board_columns/fetch_task_board +
  default `{}`); `items` fixture: i1 'alpha' (status todo, priority high, targetDate
  '2026-10-01', one child c1), i2 'mystery', i3 'done-card'; helpers `pickDate`,
  `dateTriggerText`; real dataTransfer shim in the DnD fence; **TEN card-body click fences**
  (`fireEvent.click(screen.getByText('alpha'))`) rely on body-click-opens-menu — ALL RESHAPE to
  the `⋯` trigger or the text-span click per T3's reshape table.
- `calendarGrid.ts`: `ymd(d: Date): string`, `todayYmd(): string`,
  `dateLabel(value: string): string` → `toLocaleDateString([], { year: 'numeric', month:
  'short', day: 'numeric' })` or raw value; `YMD_PATTERN`.
- `icons.tsx`: `NAMES`/`IconName` 17 entries; `Icon` renders 24-viewBox stroke svg,
  `aria-hidden="true"`; `icons.test.tsx` renders EVERY name in its `NAMES` array — a name added
  to `PATHS` but not to `NAMES` renders without test coverage; add BOTH.
- `voiceTheme.test.ts` already carries the comment-stripped styles.css + a `RULE` helper.
- ChecklistView delete buttons (top + child rows): `<button aria-label="Delete item"/Delete
  subitem" title="Delete" onClick={() => remove(item)}>` — NO class, no hover-reveal (rider a
  target); `.row-del` pattern lives at styles.css:352-365 for the lists.
- `catOptions` (ChecklistView:93) derives from store `categories` ALREADY (NOT listMeta) —
  rider (g)'s real shape: while `categories` is null (cold offline start, pre-first-refreshAll)
  the dropdown falls back to the text input; that fallback is CORRECT behavior. The ACTUAL
  M-3 race: `{catOptions.length > 0 ? <Dropdown …/> : <input …/>}` renders the fallback text
  input for ~120ms on a warm start if `refreshAll()` hasn't resolved yet in a fresh mount
  (store categories survives across mounts, so this ONLY bites cold start) — a cold-start
  cosmetic; see R-B5 for the ruling.
- `App.tsx` onboarding: `<SettingsModal mode="onboarding" …/>` renders as `.modal` with url/key
  inputs + connect button.

---

### Task 1: motion tokens + reduce-motion setting + icon names (riders b, d)

**Files:**
- Modify: `src/styles.css` (tokens, transition rules, reduced-motion layers, rider-b bump)
- Modify: `src/stores/store.ts` (`reduceMotion` field + `setReduceMotion`)
- Modify: `src/App.tsx` (`data-reduce-motion` attr on `#app`)
- Modify: `src/components/SettingsModal.tsx` (Appearance checkbox)
- Modify: `src/components/icons.tsx` (add `sun`, `more` + header reword r-d) and
  `src/components/icons.test.tsx` (NAMES 17 → 19)
- Test: `src/components/voiceTheme.test.ts` (append), `src/components/SettingsModal.test.tsx`
  (append), `src/components/icons.test.tsx` (NAMES array + provenance fence)

**Interfaces:**
- Consumes: the existing comment-stripped CSS + `RULE` helpers in `voiceTheme.test.ts`;
  localStorage fallback in `src/test/setup.ts`.
- Produces (later tasks rely on): tokens `--motion-fast`/`--motion-med`/`--ease-out` in `:root`;
  `#app[data-reduce-motion="true"]`; store fields `reduceMotion: boolean` +
  `setReduceMotion: (v: boolean) => void`; `IconName` gains `'sun' | 'more'`; `sun` =
  `<circle cx={12} cy={12} r={4} />` + rays `<path d="M12 2v2" /> <path d="M12 20v2" />
  <path d="m4.93 4.93 1.41 1.41" /> <path d="m17.66 17.66 1.41 1.41" /> <path d="M2 12h2" />
  <path d="M20 12h2" /> <path d="m6.34 17.66-1.41 1.41" /> <path d="m19.07 4.93-1.41 1.41" />`;
  `more` = `<circle cx={12} cy={12} r={1} /> <circle cx={19} cy={12} r={1} /> <circle cx={5}
  cy={12} r={1} />`.

- [ ] **Step 1: failing tests.** In `voiceTheme.test.ts` REUSE the file's existing stripped-css
  constant + `RULE` helper — do NOT re-declare. Append (adjust the helper names to the file's
  actual ones at implement time):

```ts
describe('tier B motion tokens (task 1)', () => {
  it('duration + ease tokens exist in :root', () => {
    const root = RULE(':root');
    expect(root).toContain('--motion-fast: 120ms');
    expect(root).toContain('--motion-med: 180ms');
    expect(root).toContain('--ease-out: cubic-bezier(0.2, 0, 0, 1)');
  });
  it('fast-motion surfaces: menus + editor overlays transition on the fast token', () => {
    for (const sel of ['.jotty-dropdown-menu', '.kanban-menu', '.edt-slash-menu', '.edt-bubble', '.edt-tablebar']) {
      const rule = RULE(sel);
      expect(rule).toMatch(/transition:[^;]*var\(--motion-fast\)/);
    }
  });
  it('med-motion surfaces: modal + backdrop + drawer transition on the med token', () => {
    for (const sel of ['.modal', '.modal-backdrop', '.drawer']) {
      const rule = RULE(sel);
      expect(rule).toMatch(/transition:[^;]*var\(--motion-med\)/);
    }
  });
  it('cards + li.selected transition colors only (no transform/movement)', () => {
    const card = RULE('.kanban-card');
    expect(card).toMatch(/transition:[^;]*(background-color|box-shadow)/);
    expect(card).not.toMatch(/transition:[^;]*transform/);
  });
  it('NO layout-property transitions anywhere in the sheet', () => {
    for (const m of cssStripped().matchAll(/transition(?:-property)?\s*:[^;}]*/g)) {
      expect(m[0]).not.toMatch(/\b(width|height|top|left|margin)\b/);
    }
  });
  it('NO @keyframes anywhere', () => {
    expect(cssStripped()).not.toContain('@keyframes');
  });
  it('reduced-motion layers exist (OS + in-app)', () => {
    const s = cssStripped();
    expect(s).toContain('@media (prefers-reduced-motion: reduce)');
    expect(s).toContain('[data-reduce-motion="true"]');
  });
});
```

  Append to `src/components/SettingsModal.test.tsx` (reuse the file's existing mock/imports —
  check the mounted settings flow's invoke needs and spread the base impl):

```tsx
describe('reduce motion setting (tier B task 1)', () => {
  it('checkbox writes the store + localStorage key (on → set, off → removed)', async () => {
    const { useStore } = await import('../stores/store');
    useStore.setState({ reduceMotion: false });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    const box = screen.getByLabelText('Reduce motion');
    fireEvent.click(box);
    expect(useStore.getState().reduceMotion).toBe(true);
    expect(window.localStorage.getItem('jotty.reduce-motion')).toBe('true');
    fireEvent.click(box);
    expect(useStore.getState().reduceMotion).toBe(false);
    expect(window.localStorage.getItem('jotty.reduce-motion')).toBeNull();
  });
});
```

- [ ] **Step 2: RED run** — `npx vitest run src/components/voiceTheme.test.ts
  src/components/SettingsModal.test.tsx` → ONLY new fences fail (tokens/attr/store absent).
- [ ] **Step 3: implement.**

`src/styles.css` — inside the existing `:root` block add:
```css
  /* tier B S2 — motion tokens */
  --motion-fast: 120ms;
  --motion-med: 180ms;
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
```
New block (next to the popover/menu rules; `.kanban-card`'s EXISTING rule gains its transition
line inline rather than a duplicate rule):
```css
/* tier B S2 — motion: compositor-friendly transitions only (opacity/transform/
   shadow/colors; layout properties are fence-banned). Menus/modals are always
   mounted on open in this app (JSX-conditional), so the transition acts on
   MOUNT-STYLE the browser can't interpolate — the visible effect is a fast
   fade of the backdrop + color/softening of surfaces, and hover/focus states
   gain the smooth timing. This is the R-B2 ruling: NO new mount-animation
   machinery in WebKitGTK; the probe verifies menus/modals still position. */
.jotty-dropdown-menu, .kanban-menu, .edt-slash-menu, .edt-bubble, .edt-tablebar {
  transition: opacity var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out);
}
.modal, .drawer { transition: opacity var(--motion-med) var(--ease-out), transform var(--motion-med) var(--ease-out); }
.modal-backdrop { transition: opacity var(--motion-med) var(--ease-out); }
.kanban-card, li.selected { transition: background-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out); }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0ms !important; animation: none !important; }
}
[data-reduce-motion="true"] *, [data-reduce-motion="true"] *::before, [data-reduce-motion="true"] *::after {
  transition-duration: 0ms !important;
  animation: none !important;
}
```

`src/stores/store.ts` — interface additions next to `themeOverride`:
```ts
  /** Tier B S2: prefers-reduced-motion in-app override (Settings → Appearance checkbox). */
  reduceMotion: boolean;
  setReduceMotion: (v: boolean) => void;
```
initial state (beside `themeOverride`):
```ts
  reduceMotion: (() => {
    try { return localStorage.getItem('jotty.reduce-motion') === 'true'; } catch { return false; }
  })(),
```
action (beside `setThemeOverride`):
```ts
  setReduceMotion: (v) => {
    set({ reduceMotion: v });
    try {
      if (v) localStorage.setItem('jotty.reduce-motion', 'true');
      else localStorage.removeItem('jotty.reduce-motion');
    } catch { /* storage unavailable */ }
  },
```
`src/App.tsx` — destructure `reduceMotion` on the store line and:
```tsx
    <div id="app" data-theme={dataTheme} data-reduce-motion={reduceMotion ? 'true' : undefined} className={drawerOpen ? 'drawer-open' : ''}>
```
`src/components/SettingsModal.tsx` — destructure from `useStore()` (line 19: add
`reduceMotion, setReduceMotion`) and after the theme `Dropdown` inside `.appearance-settings`:
```tsx
                <label htmlFor="reduce-motion" className="reduce-motion-row">
                  <input id="reduce-motion" type="checkbox" checked={reduceMotion}
                         onChange={(e) => setReduceMotion(e.target.checked)} /> Reduce motion
                </label>
```
Icon additions (`src/components/icons.tsx`): extend `IconName` with `| 'sun' | 'more'` + add
the two PATHS entries above; `icons.test.tsx` `NAMES` array grows to include 'sun', 'more'.
Rider (b): in the dark-theme block bump the `--row-hover` L-value +4% (exact color computed
from the file's current value; before/after recorded in the report).
Rider (d): replace `icons.tsx` header comment lines 4–13 with:
```tsx
// (mic/speaker, ballot-checked box, close-x, back-arrow, bell, note memo, …) become lucide
// shapes. Path data is COPIED VERBATIM — selected icons at tier A (2026-10-01), `sun`/`more`
// at tier B — from lucide.dev (lucide ~0.4x, ISC license — https://github.com/lucide-icons/
// lucide); several ride feather-era coordinates. NO runtime icon dependency; the stroke
// discipline (currentColor, 1.8px, round caps) lives on the shared <svg> shell below.
//
// Map shape: Record<IconName, ReactElement> — a fragment of <path>/<circle>/<rect>
// primitives per icon (the lucide settings gear is a multi-command path + the hub circle).
// Every rendered svg is a 24-viewBox, fill:none, stroke:currentColor shape that scales
// with the `size` prop.
```

- [ ] **Step 4: GREEN + full gates.** `npx vitest run` (full suite; prior 502 + new, Δ
  arithmetic verified in the report), `npx tsc -p tsconfig.json --noEmit`, census
  `cargo check --all-targets 2>&1 | grep -c '^warning'` = 18 Δ0 (no Rust touched — STILL
  re-runs per the ship discipline), emoji-grep 0 new.
- [ ] **Step 5: commit** `feat(ux): motion tokens + reduce-motion setting + sun/more icons
  (tier B task 1)`.

### Task 2: CommandBar (+App wiring; SearchPalette retires)

**Files:**
- Create: `src/components/CommandBar.tsx`, `src/components/CommandBar.test.tsx`
- Delete: `src/components/SearchPalette.tsx`, `src/components/SearchPalette.test.tsx`
- Modify: `src/App.tsx` (import + slot props), `src/styles.css` (command-bar rows)

**Interfaces:**
- Consumes: T1's store fields; store actions `createNote/createChecklist/createBoard(title,
  category)` (self-refresh + self-select), `refreshAll`, `selectNote/selectChecklist`,
  `connection`, `checklists` (catalog for the board chip), `themeOverride` +
  `setThemeOverride` (raw value — null encodes follow-site); `api.search` with the 200ms
  debounce (existing wire: `SearchResultsDto { notes: {id,title,snippet}[]; checklists:
  {id,title,itemText}[] }`).
- Produces: `CommandBar` props `{ onClose: () => void; onSelectNote: (id: string) => void;
  onSelectChecklist: (id: string) => void; onStartVoiceNote?: () => void; onOpenSettings?: () => void; }`;
  App slot wiring (below); `.command-row`/`.command-bar` CSS classes.

- [ ] **Step 1: failing tests.** `src/components/CommandBar.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import CommandBar from './CommandBar';
import { useStore } from '../stores/store';

const LABELS = ['New note', 'New checklist', 'New board', 'New voice note', 'Sync now', 'Toggle theme', 'Open settings'];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'search')
      return Promise.resolve({
        notes: [{ id: 'n1', title: 'Groceries', snippet: 'milk and eggs' }],
        checklists: [{ id: 'b9', title: 'Home Reno', itemText: 'kitchen' }],
      });
    if (cmd === 'create_note') return Promise.resolve({ id: 'n9', title: 'Untitled note', category: 'Uncategorized' });
    if (cmd === 'create_checklist') return Promise.resolve({ id: 'c9', title: 'New checklist', category: 'Uncategorized' });
    if (cmd === 'create_task_board') return Promise.resolve({ id: 'k9', title: 'New board', category: 'Uncategorized' });
    return Promise.resolve(null);
  });
  // store is a module singleton — reset the fields THIS component reads
  useStore.setState({
    connection: { instance_url: 'http://127.0.0.1:1', has_api_key: true } as never,
    checklists: [{ id: 'b9', title: 'Home Reno', listType: 'kanban' } as never],
    themeOverride: null as never,
    setThemeOverride: vi.fn(),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    createNote: vi.fn().mockResolvedValue({ id: 'n9' }),
    createChecklist: vi.fn().mockResolvedValue({ id: 'c9' }),
    createBoard: vi.fn().mockResolvedValue({ id: 'k9' }),
  } as never);
});

describe('CommandBar — commands', () => {
  it('empty query renders exactly the 7 pinned commands and no results', () => {
    render(<CommandBar onClose={() => {}} onSelectNote={() => {}} onSelectChecklist={() => {}} />);
    for (const label of LABELS) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText('Groceries')).toBeNull();
  });

  it('Enter on an active command row runs it (New note) and closes', async () => {
    const onClose = vi.fn();
    useStore.setState({ createNote: vi.fn().mockResolvedValue({ id: 'n9' }) } as never);
    render(<CommandBar onClose={onClose} onSelectNote={() => {}} onSelectChecklist={() => {}} />);
    const input = screen.getByPlaceholderText('Search commands and notes…');
    fireEvent.keyDown(input, { key: 'Enter' }); // active=0 on empty query = first command
    await waitFor(() => expect(useStore.getState().createNote).toHaveBeenCalledWith('Untitled note', 'Uncategorized'));
    expect(onClose).toHaveBeenCalled();
  });

  it('typing filters commands AND debounces search results below them', async () => {
    render(<CommandBar onClose={() => {}} onSelectNote={() => {}} onSelectChecklist={() => {}} />);
    const input = screen.getByPlaceholderText('Search commands and notes…');
    fireEvent.change(input, { target: { value: 'note' } });
    // 'note' still matches 'New note' (label containment)…
    await waitFor(() => expect(screen.getByText('New note')).toBeInTheDocument());
    // …and 200ms later the search results render below the commands
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    expect(screen.queryByText('Open settings')).toBeNull(); // filtered out
  });

  it('result rows navigate via the App callbacks (select note + close)', async () => {
    const onSelectNote = vi.fn();
    const onClose = vi.fn();
    render(<CommandBar onClose={onClose} onSelectNote={onSelectNote} onSelectChecklist={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Search commands and notes…'), { target: { value: 'groc' } });
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Groceries'));
    expect(onSelectNote).toHaveBeenCalledWith('n1');
    expect(onClose).toHaveBeenCalled();
  });

  it('board chip renders for a kanban-type checklist result (store-catalog derived) and opens the board', async () => {
    const onSelectChecklist = vi.fn();
    render(<CommandBar onClose={() => {}} onSelectNote={() => {}} onSelectChecklist={onSelectChecklist} />);
    fireEvent.change(screen.getByPlaceholderText('Search commands and notes…'), { target: { value: 'reno' } });
    await waitFor(() => expect(screen.getByText('Home Reno')).toBeInTheDocument());
    expect(screen.getByText('board')).toHaveClass('board-chip');
    fireEvent.click(screen.getByText('Home Reno'));
    expect(onSelectChecklist).toHaveBeenCalledWith('b9');
  });

  it('Sync now runs refreshAll through the store and closes', async () => {
    const onClose = vi.fn();
    useStore.setState({ refreshAll: vi.fn().mockResolvedValue(undefined) } as never);
    render(<CommandBar onClose={onClose} onSelectNote={() => {}} onSelectChecklist={() => {}} />);
    fireEvent.click(screen.getByText('Sync now'));
    await waitFor(() => expect(useStore.getState().refreshAll).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('Toggle theme cycles the override: null → dark', () => {
    useStore.setState({ themeOverride: null as never, setThemeOverride: vi.fn() } as never);
    render(<CommandBar onClose={() => {}} onSelectNote={() => {}} onSelectChecklist={() => {}} />);
    fireEvent.click(screen.getByText('Toggle theme'));
    expect(useStore.getState().setThemeOverride).toHaveBeenCalledWith('dark');
  });

  it('Open settings + New voice note route through the App-provided handlers and close', () => {
    const onOpenSettings = vi.fn();
    const onStartVoiceNote = vi.fn();
    const onClose = vi.fn();
    render(<CommandBar onClose={onClose} onSelectNote={() => {}} onSelectChecklist={() => {}}
                       onOpenSettings={onOpenSettings} onStartVoiceNote={onStartVoiceNote} />);
    fireEvent.click(screen.getByText('Open settings'));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    onClose.mockClear();
    fireEvent.click(screen.getByText('New voice note'));
    expect(onStartVoiceNote).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape closes the bar', () => {
    const onClose = vi.fn();
    render(<CommandBar onClose={onClose} onSelectNote={() => {}} onSelectChecklist={() => {}} />);
    fireEvent.keyDown(screen.getByPlaceholderText('Search commands and notes…'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('New checklist + New board run through the store actions', async () => {
    render(<CommandBar onClose={() => {}} onSelectNote={() => {}} onSelectChecklist={() => {}} />);
    fireEvent.click(screen.getByText('New checklist'));
    await waitFor(() => expect(useStore.getState().createChecklist).toHaveBeenCalledWith('New checklist', 'Uncategorized'));
    fireEvent.click(screen.getByText('New board'));
    await waitFor(() => expect(useStore.getState().createBoard).toHaveBeenCalledWith('New board', 'Uncategorized'));
  });
});
```

- [ ] **Step 2: RED** — `npx vitest run src/components/CommandBar.test.tsx` (file absent).
- [ ] **Step 3: implement `src/components/CommandBar.tsx`** (complete shape; adapt to scan
  findings + disclose):

```tsx
import { useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import type { SearchResultsDto, ThemeOverride } from '../api/types';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Icon } from './icons';
import type { IconName } from './icons';
import { useStore } from '../stores/store';

// Unified command bar (tier B S1): commands + search in ONE ⌘K surface.
// Empty query = the 7 pinned commands; typing filters commands (label
// containment) and debounces (200ms) into the same search the old palette ran.
// ↑/↓ walk ONE flat rows array (commands first); Enter runs; Esc closes.
// Theme cycle (R-B4): setThemeOverride takes the RAW value; null = follow site.
const THEME_CYCLE: (ThemeOverride | null)[] = [null, 'dark', 'light', 'rwmarkable-dark'];

export default function CommandBar({ onClose, onSelectNote, onSelectChecklist, onStartVoiceNote, onOpenSettings }: {
  onClose: () => void;
  onSelectNote: (id: string) => void;
  onSelectChecklist: (id: string) => void;
  onStartVoiceNote?: () => void;
  onOpenSettings?: () => void;
}) {
  const { connection, checklists, refreshAll, createNote, createChecklist, createBoard, themeOverride, setThemeOverride } = useStore();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResultsDto | null>(null);
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) { setResults(null); return; }
    timer.current = setTimeout(async () => setResults(await api.search(q.trim())), 200);
  }, [q]);

  const needle = q.trim().toLowerCase();
  const commands = [
    { label: 'New note', icon: 'note' as IconName, run: async () => { await createNote('Untitled note', 'Uncategorized'); onClose(); } },
    { label: 'New checklist', icon: 'list' as IconName, run: async () => { await createChecklist('New checklist', 'Uncategorized'); onClose(); } },
    { label: 'New board', icon: 'columns' as IconName, run: async () => { if (connection) { await createBoard('New board', 'Uncategorized'); } onClose(); } },
    { label: 'New voice note', icon: 'mic' as IconName, run: () => { onStartVoiceNote?.(); onClose(); } },
    { label: 'Sync now', icon: 'refresh' as IconName, run: async () => { await refreshAll(); onClose(); } },
    { label: 'Toggle theme', icon: 'sun' as IconName, run: () => {
        const i = THEME_CYCLE.indexOf(themeOverride);
        setThemeOverride(THEME_CYCLE[(i + 1) % THEME_CYCLE.length]);
      } },
    { label: 'Open settings', icon: 'settings' as IconName, run: () => { onOpenSettings?.(); onClose(); } },
  ];
  const shownCmds = needle ? commands.filter((c) => c.label.toLowerCase().includes(needle)) : commands;

  type Ent = { kind: 'note' | 'checklist'; id: string; title: string; sub: string | null; board: boolean };
  const ents: Ent[] = needle && results ? [
    ...results.notes.map((n) => ({ kind: 'note' as const, id: n.id, title: n.title, sub: n.snippet, board: false })),
    ...results.checklists.map((c) => {
      const known = checklists.find((k) => k.id === c.id)?.listType;
      return { kind: 'checklist' as const, id: c.id, title: c.title, sub: c.itemText, board: known === 'kanban' || known === 'task' };
    }),
  ] : [];

  type Row = { type: 'cmd'; label: string; icon: IconName; run: () => void | Promise<void> }
    | { type: 'ent'; ent: Ent };
  const rows: Row[] = [
    ...shownCmds.map((c) => ({ type: 'cmd' as const, label: c.label, icon: c.icon, run: c.run })),
    ...ents.map((e) => ({ type: 'ent' as const, ent: e })),
  ];
  const activeRow = rows[Math.min(active, rows.length - 1)];

  const runRow = (row: Row) => {
    if (row.type === 'cmd') void row.run();
    else {
      if (row.ent.kind === 'note') onSelectNote(row.ent.id); else onSelectChecklist(row.ent.id);
      onClose();
    }
  };

  const onInputKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { if (activeRow) runRow(activeRow); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal command-bar" onClick={(e) => e.stopPropagation()}>
        <input autoFocus placeholder="Search commands and notes…" value={q}
               onChange={(e) => { setQ(e.target.value); setActive(0); }}
               onKeyDown={onInputKeyDown} />
        {shownCmds.map((c, i) => (
          <button key={c.label} className={`command-row${i === active ? ' active' : ''}`} onClick={() => runRow(rows[i])}>
            <Icon name={c.icon} size={14} className="palette-ico"/> <span>{c.label}</span>
          </button>
        ))}
        {needle && ents.length > 0 && shownCmds.length > 0 && <h3 className="meta-line palette-sep">Results</h3>}
        {ents.map((ent, j) => {
          const i = shownCmds.length + j;
          return (
            <button key={`${ent.kind}-${ent.id}`} className={`command-row${i === active ? ' active' : ''}`}
                    onClick={() => runRow(rows[i])}>
              <Icon name={ent.kind === 'note' ? 'note' : 'list'} size={13} className="palette-ico"/>
              <strong>{ent.title}</strong> <small>{ent.sub}</small>
              {ent.board && <span className="chip board-chip">board</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

  `App.tsx` wiring: import swap, keep the ⌘K effect, and:
```tsx
      {showSearch && (
        <CommandBar
          onClose={() => setShowSearch(false)}
          onSelectNote={(id) => selectNote(id)}
          onSelectChecklist={(id) => selectChecklist(id)}
          onStartVoiceNote={startVoiceNote}
          onOpenSettings={() => setShowSettings(true)}
        />
      )}
```
  `src/styles.css` (appended near the palette rules):
```css
/* tier B S1 — unified command bar */
.command-bar { display: flex; flex-direction: column; gap: 4px; }
.command-row { display: flex; align-items: center; gap: 8px; text-align: left; }
.command-row.active { background: var(--accent-soft); }
.palette-sep { margin: 4px 0 0; }
```
  (+ the 412px media-query line `.command-bar { width: 100%; }` if the sheet's mobile block
  needs it — verify in the probe). Delete SearchPalette files LAST (after the grep gate).

- [ ] **Step 4: GREEN + full gates.** `npx vitest run` — arithmetic: 502 base + 10 new − 1
  retired SearchPalette fence = 511 expected across 46 files (± reshaped fences in
  App-level suites — NOTE: no App.test.tsx exists; the ⌘K wiring is covered by CommandBar's
  suite + tsc), `npx tsc -p tsconfig.json --noEmit`, census Δ0, `grep -rn "SearchPalette" src/`
  → 0 hits.
- [ ] **Step 5: commit** `feat(ux): unified command bar replaces search palette (tier B task 2)`.

### Task 3: board cards — inline edit, ⋯ trigger, pills, drag ghost (+rider e)

**Files:**
- Modify: `src/components/KanbanBoard.tsx`, `src/components/KanbanBoard.test.tsx`
- Modify: `src/styles.css`
- Modify: `src/components/VoiceNoteReview.tsx` + `src/components/VoiceNoteReview.test.tsx`
  (rider e)

**Interfaces:**
- Consumes: T1 tokens + `IconName 'more'`; `dateLabel`, `todayYmd` from `./calendarGrid`;
  existing `renaming`/`renameText` state + `api.setItemText` (invoke `set_item_text`).
- Produces: `.kanban-card-menu` trigger (aria-label **"Card actions"**); card text click →
  inline edit in place; `.dragging` ghost class; pill classes `.due-today`/`.overdue`.

- [ ] **Step 1: failing tests.** Append to `src/components/KanbanBoard.test.tsx`:

```tsx
describe('tier B board cards (task 3)', () => {
  it('clicking the card text starts the inline edit pre-filled', async () => {
    render(<KanbanBoard checklistId="b1" items={items} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    expect(screen.getByDisplayValue('alpha')).toBeInTheDocument();
  });

  it('Enter commits the inline edit via set_item_text', async () => {
    render(<KanbanBoard checklistId="b1" items={items} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    const input = screen.getByDisplayValue('alpha');
    fireEvent.change(input, { target: { value: 'renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_text', { checklistId: 'b1', itemLocalId: 'i1', text: 'renamed' }));
  });

  it('Escape cancels the inline edit WITHOUT invoking', async () => {
    render(<KanbanBoard checklistId="b1" items={items} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    const input = screen.getByDisplayValue('alpha');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('set_item_text', expect.anything());
  });

  it('the ⋯ trigger (Card actions) opens the menu; menu Rename still works', async () => {
    render(<KanbanBoard checklistId="b1" items={items} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Card actions' }));
    expect(screen.getByText('Rename')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Rename'));
    expect(screen.getByDisplayValue('alpha')).toBeInTheDocument();
  });

  it('today targetDate pill renders the localized label with due-today', async () => {
    render(<KanbanBoard checklistId="b1" items={items} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    const pill = screen.getByText(dateLabel('2026-10-01')).closest('.kanban-badge') as HTMLElement;
    expect(pill.querySelector('.kanban-card, svg')).toBeTruthy(); // calendar icon rides the pill
    // NOTE: '2026-10-01' fixture reads as past/overdue as the calendar drifts;
    // the CLASS assert is on a seeded TODAY item below (calendar-proof).
    const rows = items.map((i) => (i.localId === 'i1' ? { ...i, targetDate: todayYmd() } : i));
    const { unmount } = render(<KanbanBoard checklistId="b1" items={rows} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText(dateLabel(todayYmd()))).toBeInTheDocument());
    const fresh = screen.getByText(dateLabel(todayYmd())).closest('.kanban-badge') as HTMLElement;
    expect(fresh).toHaveClass('due-today');
    expect(fresh).not.toHaveClass('overdue');
    unmount();
  });

  it('past targetDate pill carries the overdue class (calendar-proof seed)', async () => {
    const rows = items.map((i) => (i.localId === 'i1' ? { ...i, targetDate: '2001-01-01' } : i));
    render(<KanbanBoard checklistId="b1" items={rows} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText(dateLabel('2001-01-01'))).toBeInTheDocument());
    const pill = screen.getByText(dateLabel('2001-01-01')).closest('.kanban-badge') as HTMLElement;
    expect(pill).toHaveClass('overdue');
    expect(pill).not.toHaveClass('due-today');
  });

  it('pill/menu clicks do NOT start the inline edit', async () => {
    const rows = items.map((i) => (i.localId === 'i1' ? { ...i, targetDate: todayYmd() } : i));
    render(<KanbanBoard checklistId="b1" items={rows} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText(dateLabel(todayYmd()))); // the pill itself
    expect(screen.queryByDisplayValue('alpha')).toBeNull();
  });

  it('dragStart adds .dragging and dragEnd clears it (ghost is css-only)', async () => {
    const { container } = render(<KanbanBoard checklistId="b1" items={items} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    const card = screen.getByText('alpha').closest('.kanban-card') as HTMLElement;
    const dt = { getData: (t: string) => (t === 'text/plain' ? 'i1' : ''), setData: () => {} };
    fireEvent.dragStart(card, { dataTransfer: dt });
    expect(card).toHaveClass('dragging');
    fireEvent.dragEnd(card, { dataTransfer: dt });
    expect(card).not.toHaveClass('dragging');
  });
});
```

  RESHAPE TABLE — the TEN existing fences that click the card body to open the menu
  (lines ~101, 111, 117, 151, 167, 298, 337, 360, 375, 411):
  `fireEvent.click(screen.getByText('alpha'));` →
  `fireEvent.click(screen.getByRole('button', { name: 'Card actions' }));` in every fence whose
  NEXT step is a menu row ('Rename' / 'Set date' / 'Set reminder' / 'Delete' / move), because
  body-click no longer opens the menu. Fences that need the EDITOR (rename-input flow) keep
  `getByText('alpha')` click. The `drop on a column` fence (line ~133) starts from `dragStart`
  (no click) — UNCHANGED. Verify each fence's intent before reshaping; disclose the count
  (expect 8 reshape / 2 keep).

- [ ] **Step 2: RED run** — `npx vitest run src/components/KanbanBoard.test.tsx` — new fences
  fail (no inline edit / trigger / classes yet); reshaped fences fail for the trigger.
- [ ] **Step 3: implement in `KanbanBoard.tsx`.**
  1. Import: `import { dateLabel, todayYmd } from './calendarGrid';`
  2. Card className template gains the ghost clause:
     `` className={`kanban-card${item.completed || col.autoComplete ? ' completed-item' : ''}${menuFor === item.localId ? ' menu-open' : ''}${dragId === item.localId ? ' dragging' : ''}`} ``
     + `onDragEnd={() => setDragId(null)}` on the card element.
  3. Card element's `onClick` is REMOVED entirely (the body click now edits via the text span;
     the backdrop + `⋯` handle menu open/close). The `if (renaming) return;` guard dies with it.
  4. Text span:
```tsx
                  <span className="kanban-card-text"
                        onClick={(e) => { e.stopPropagation(); setRenameText(item.text); setRenaming(item.localId); }}>{item.text}</span>
```
  5. The rename input (already rendered when `renaming === item.localId`) gains Escape:
```tsx
                         onKeyDown={(e: KeyboardEvent) => {
                           if (e.key === 'Enter') rename(item.localId);
                           else if (e.key === 'Escape') { setRenaming(null); setRenameText(''); }
                         }}
```
     (`rename()` keeps its empty-guard + `api.setItemText` + `reload()`.)
  6. Trigger button inside the card (after `.kanban-badges`; the card keeps `draggable`
     + existing onDragStart):
```tsx
                <button className="kanban-card-menu" aria-label="Card actions" title="Card actions"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuFor((m) => (m === item.localId ? null : item.localId));
                        }}>
                  <Icon name="more" size={13}/>
                </button>
```
  7. Pill swap — targetDate badge → localized label + class + icon:
```tsx
                  {item.targetDate && (() => {
                    const today = todayYmd();
                    const cls = item.targetDate === today ? ' due-today' : item.targetDate < today ? ' overdue' : '';
                    return (
                      <span className={`kanban-badge${cls}`} title={`Due ${dateLabel(item.targetDate)}`}>
                        <Icon name="calendar" size={11}/> {dateLabel(item.targetDate)}
                      </span>
                    );
                  })()}
```
     Priority, reminder, and subtask-count badges are UNCHANGED.
- [ ] **Step 4: CSS (`src/styles.css`, near the kanban rules):**
```css
/* tier B S3 — board cards: surface + inline edit + pills + css ghost */
.kanban-card { background: var(--surface); box-shadow: var(--shadow-1); }
.kanban-badges { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }
.kanban-badge { display: inline-flex; align-items: center; gap: 3px; }
.kanban-badge.due-today { color: var(--accent-text); }
.kanban-badge.overdue { color: var(--danger); }
.kanban-card-menu { opacity: 0.4; transition: opacity var(--motion-fast) var(--ease-out); }
.kanban-card:hover .kanban-card-menu, .kanban-card-menu:focus-visible { opacity: 1; }
.kanban-card.dragging { opacity: 0.45; box-shadow: var(--shadow-2); transform: rotate(1.5deg) scale(1.02); }
```
  (If `.kanban-card` already exists as a rule, MERGE the background/box-shadow lines into it —
  one `.kanban-card` transition block from T1 stays the only kanban-card transition rule.)
- [ ] **Step 5: rider (e) — VoiceNoteReview.tsx:431.** The `reminder at {apptDate}T{apptTime}`
  fragment is the m2 multi-node join (wrap-in-a-span rider, "IF touched again" — touched NOW):
```tsx
<p className="voice-hint">{apptTime ? (<><Icon name="bell" size={12}/> <span>reminder at {apptDate}T{apptTime}</span></>) : 'No reminder — date-only appointment.'}</p>
```
  Then reshape the 2 fences that regex-match the join (`grep -n "reminder at"
  src/components/VoiceNoteReview.test.tsx`): keep the byte-exact string
  `reminder at ${Date}T${Time}`, retarget the QUERY at the span (e.g.
  `screen.getByText(/reminder at /)` or the span's own query). Disclose both reshapes.
- [ ] **Step 6: GREEN + REAL-ENGINE PROBE (1280 + 412) — flex-wrap risk: text span + badges +
  new menu button sharing the card row; screenshot + chip-width checks before the gate.**
- [ ] **Step 7: full gates + commit** `feat(ux): board cards — inline edit, pills, drag ghost
  (tier B task 3)`.

### Task 4: agenda due-chips + onboarding polish (+riders a, c, g)

**Files:**
- Modify: `src/components/AgendaView.tsx` + `src/components/AgendaView.test.tsx`
- Modify: `src/components/ChecklistView.tsx` + `src/components/ChecklistView.test.tsx`
  (riders a + g)
- Modify: `src/components/SettingsModal.tsx` (onboarding wrapper class) +
  `src/components/SettingsModal.test.tsx` (fence)
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: T1 tokens; `.meta-line` (Tier A); `.chip`/`li.selected` rules (styles.css:338/349);
  store `categories` (ChecklistView catOptions source); ConfirmModal patterns.
- Produces: `export function agendaDueLabel(y: string, todayKey: string, tomorrowKey: string,
  weekKey: string): string` (label for the chip); chip classes `agenda-due overdue|today|''`;
  `.connect-form` class on the onboarding form; ChecklistView delete buttons join `.row-del`.

- [ ] **Step 1: failing tests.**
  Append to `src/components/AgendaView.test.tsx` (import `agendaDueLabel` from './AgendaView'):
```ts
describe('agendaDueLabel (tier B task 4)', () => {
  it('today → Today', () => expect(agendaDueLabel('2026-10-01', '2026-10-01', '2026-10-02', '2026-10-08')).toBe('Today'));
  it('tomorrow → Tomorrow', () => expect(agendaDueLabel('2026-10-02', '2026-10-01', '2026-10-02', '2026-10-08')).toBe('Tomorrow'));
  it('past → localized date label (dateLabel contract)', () => {
    expect(agendaDueLabel('2020-05-05', '2026-10-01', '2026-10-02', '2026-10-08')).toBe(dateLabel('2020-05-05'));
  });
  it('unparseable → raw value', () => expect(agendaDueLabel('weird', '2026-10-01', '2026-10-02', '2026-10-08')).toBe('weird'));
  it('within-7-days → weekday label (locale-rendered, type-asserted)', () => {
    expect(typeof agendaDueLabel('2026-10-03', '2026-10-01', '2026-10-02', '2026-10-08')).toBe('string');
  });
});
```
  Chip render fence (reuses the file's seeding pattern + `datedAtNoon` helper):
```ts
it('entries render a right-side due chip; overdue + today rows get the group classes', async () => {
  const rows = [
    entry({ itemLocalId: 'i-over', text: 'overdue thing', targetDate: datedAtNoon(-3) }),
    entry({ itemLocalId: 'i-today', text: 'today thing', targetDate: datedAtNoon(0) }),
  ];
  invoke.mockImplementation((cmd: string) => (cmd === 'list_agenda' ? Promise.resolve(rows) : Promise.resolve(null)));
  render(<AgendaView />);
  await waitFor(() => expect(screen.getByText('overdue thing')).toBeInTheDocument());
  expect(document.querySelector('.agenda-entry .agenda-due.overdue')).not.toBeNull();
  expect(document.querySelector('.agenda-entry .agenda-due.today')).not.toBeNull();
});
```
  Rider fences in `src/components/ChecklistView.test.tsx` (append; reuse the file's render
  helpers):
```tsx
it('rider a: checklist-view delete buttons carry the row-del class', async () => {
  // seed ONE checklist with one item (existing helper), render ChecklistView
  const btns = document.querySelectorAll('#checklist-view .row-del');
  expect(btns.length).toBeGreaterThan(0);
});
it('rider g: category dropdown renders from the STORE tree on a warm mount', async () => {
  // seed store.categories {notes:[{path:'Home'}], checklists:[{path:'Work'}]} with
  // listMeta still loading → the Dropdown (not the fallback input) renders
  // exact fence shape rides the file's existing category fences
});
```
- [ ] **Step 2: RED** (`npx vitest run src/components/AgendaView.test.tsx
  src/components/ChecklistView.test.tsx`).
- [ ] **Step 3: implement.**
  - `AgendaView.tsx`: import `dateLabel` from `./calendarGrid`; export the pure helper +
    extend each entry with the right-side chip (place AFTER `.agenda-bell` so it is the last
    flex child — the Tier A row-meta LAST-CHILD lesson):
```ts
export function agendaDueLabel(y: string, todayKey: string, tomorrowKey: string, weekKey: string): string {
  if (y === todayKey) return 'Today';
  if (y === tomorrowKey) return 'Tomorrow';
  if (y <= weekKey) {
    const d = new Date(`${y}T12:00:00`);
    return isNaN(d.getTime()) ? y : d.toLocaleDateString([], { weekday: 'short' });
  }
  return dateLabel(y);
}
```
```tsx
                {entry.targetDate && (
                  <span className={`agenda-due${g.name === 'Overdue' ? ' overdue' : g.name === 'Today' ? ' today' : ''}`}>
                    {agendaDueLabel(dateKey(entry.targetDate), todayKey, tomorrowKey, weekKey)}
                  </span>
                )}
```
  (todayKey/tomorrowKey/weekKey already live in the component; `dateKey` is the file's local
  ISO→local-ymd helper.)
  - Rider (g) `catOptions` — the M-3 ruling (R-B5): while `listMeta` is UNSET the ~120ms
    window renders the fallback INPUT — the fix (gated, no behavior rewrite): when
    `listMeta` is null AND store `categories` is populated, KEEP the dropdown mounted from the
    store tree alone (the merged set already derives from store categories; the lone-rider rule
    "never render an empty-options dropdown" still holds — if BOTH sources are empty, the old
    input fallback stays). Concretely the condition
    `catOptions.length > 0` already achieves this on warm mounts (store categories survive);
    ADD ONE fence pinning that warm-mount behavior + a store-side seed so the race window
    never regresses: the dropdown must render from store categories WITHOUT listMeta
    (regression-fence only; no source change expected — if the fence is green-from-start,
    ledger it as R-B5's evidence and move on, disclosed).
  - Rider (a): ChecklistView top-level + child delete buttons gain `className="row-del"` (keep
    the aria-labels `Delete item`/`Delete subitem`); the existing `.row-del` CSS (opacity
    pattern + hover red) then applies in the view's rows (`.row-del` is NOT scoped to
    `#notes/#checklists` — verify the hover rule selector list covers the view:
    `#checklist-view li:hover .row-del` joins the `#notes li:hover .row-del, #checklists
    li:hover .row-del` rule's selector list).
  - Onboarding polish (SettingsModal VISUAL only, wire logic byte-identical): the url/key
    + connect cluster gets one wrapper span change: wrap the three nodes in
    `<div className="connect-form">` and CSS below.
```css
/* tier B S4 — onboarding/connect: hierarchy pass, logic untouched */
.connect-form { display: flex; flex-direction: column; gap: 10px; max-width: 340px; margin: 0 auto; }
.connect-form .error { margin-top: 2px; }
```
  - Rider (c): `li.selected .chip { color: #fff; background: var(--accent-soft); }` becomes
    contrast-safe: keep the tint background but swap white text for the dark text token on
    light-ish tints — implement as
    `li.selected .chip { color: var(--accent-contrast); background: var(--accent-soft); }`
    where `--accent-contrast: #1b1b1f;` is defined in the LIGHT theme block and `#fff` in the
    dark/rwmarkable blocks (one token, three theme blocks; the chip on `li.selected` in the
    sidebar list rows is the sole consumer).
- [ ] **Step 4: GREEN + probe (agenda right-side chip at 1280 + 412 — chip joins a
  non-flex-wrap row risk) + full gates + commit** `feat(ux): agenda due-chips + onboarding
  polish + checklist riders (tier B task 4)`.

### Task 5: whole-tier review + v0.25.0 ship (gates at the user's stage confirms)

- [ ] **Step 1: re-census gates at HEAD** — vitest full run (502+Δ expected arithmetic per
  report chain), `npx tsc -p tsconfig.json --noEmit`, `cargo test --lib` (266+1i expected —
  unchanged), warnings census 18 Δ0, emoji-grep 0/0/0, prompt() 0, `grep -rn "SearchPalette"
  src/` → 0, probe files absent.
- [ ] **Step 2: whole-branch review** — reviewer subagent on the full package
  (`review-4e1b18c..HEAD.diff`); named risks: command-bar a11y/keyboard coverage, motion token
  drift vs fences, board-card flex/click-target regressions, chip contrast correctness per
  theme, rider completeness vs the v0.24.1 queue; fix verdict must-fills.
- [ ] **Step 3: SHIP (staged; the user confirms at EACH stage — announce in-thread + ntfy):**
  bump 3 files (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` → 0.25.0) +
  `npm install --package-lock-only` + `cargo update -p jotty-client` → commit `chore(release):
  bump to 0.25.0` → push (ls-remote == HEAD) → **(A) Android APK** (env: `/tmp/android-env.sh`;
  `npx tauri android build --target aarch64 --apk`; versionCode 25000, versionName 0.25.0,
  label 'Jotty Mobile'; apksigner/aapt/sha256 verify; cert continuity da8dc83d…; upload as
  `jotty-desktop-0.25.0-android-arm64.apk`) → **(B) Linux bundles** (`npx tauri build`;
  deb/rpm/AppImage; BUILD_EXIT:0; upload) → **(C) Windows exe** (tag `v0.25.0` push → CI run
  368…-class; wait for the run + asset) → `gh release create v0.25.0` with the 5 assets +
  notes (changelog + sha256 table computed) → EVERY asset re-downloaded + re-hashed
  byte-identical → ledger (skill status entry + memory with neutral auth phrasing) + ntfy.

## Verification (plan self-review, run 2026-10-01)

- **Spec coverage:** S1 → T2 (unified bar, 7 commands, filtering, keyboard, icons+sun, search
  preserved, SearchPalette retired); S2 → T1 (tokens, surfaces, FORBIDDEN-list fence,
  reduced-motion OS + in-app, settings checkbox); S3 → T3 (surface/pills incl. localized labels
  + today/overdue, css-only ghost, inline edit, ⋯ trigger, DnD untouched, setDragImage absent);
  S4 → T4 (agenda right-side chip + hover-reveal adoption via row classes, onboarding
  wire-identical visual pass); riders → (b,d)=T1, (e)=T3, (a,c,g)=T4, (f)=R-B3 retracted with
  evidence; review+ship → T5. The spec's "callbacks keep working" holds (App wiring keeps both
  selects + adds the two optional handlers). Gaps: NONE.
- **Type consistency:** `setThemeOverride` consumed with RAW values (null='auto') per its store
  contract + SettingsModal precedent; `agendaDueLabel` operates in the SAME key space as
  AgendaView's `dateKey` (local 'YYYY-MM-DD', full-ISO inputs pre-keyed); T3 imports exactly
  `dateLabel, todayYmd` (both exported by calendarGrid.ts — verified); `IconName` extended in
  T1 (sun|more) BEFORE T3 consumes 'more' (order dependency satisfied).
- **Placeholder scan:** every fence body above is complete code; the only implement-time fills
  are seed-helper reuse and color-value computation (rider b), both mechanical.

## Disclosed rulings (plan header — per repo convention)

- **R-B1** "Board rows keep the existing board chip" (spec) = store-catalog derivation in
  palette results (the search wire carries NO listType — ListHit is {id,title,itemText}); the
  checklists LIST chip unchanged.
- **R-B2** Spec S2's "4px slide" = transitions on opacity + EXISTING static transforms only —
  no new mount-animation machinery (menus/modals are JSX-conditional mounts; WebKitGTK
  interpolates nothing on first paint). The visible tier-B result: fast fades + smoothed
  hover/focus. The probe verifies menu/modal positioning is unchanged.
- **R-B3** Rider (f) "dedupe DOM-count fence" is RETRACTED: the Tier-A ledger's finding = the
  option-count assert lived as a LIVE-VERIFIED behavior instead of a fence (T4 M-1,
  "deduped menu verified live" twice) — no such fence exists in the tree (grep-verified
  2026-10-01); nothing to dedupe. Re-derives only if a future review re-raises an actual
  duplicate fence.
- **R-B4** Task 2's Enter test runs on the EMPTY query (active=0 = first command) — no async
  search race in the assert path (R-B4 supersedes the earlier draft's needle trick).
- **R-B5** Rider (g)'s M-3 "empty-title commit race" (~120ms window) is cosmetic-coldstart:
  T4 adds the warm-mount regression fence + store-seed evidence; if green-from-start, ledgered
  as evidence and closed — NO source rewrite. (The Tier-A ledger's M-3 text — "pre-list-load
  commit race via empty title" — matches this shape, not a catOptions rewrite.)
- **R-B6** Task 3's inline-edit Escape: cancel clears renameText (never half-saves) and leaves
  the stored text untouched (blur commit path is REPLACED for Escape only — blur STILL commits;
  the input's onBlur stays the primary commit).