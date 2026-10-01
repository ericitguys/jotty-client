# UX Polish Pass (Tier A) — Design

**Date:** 2026-10-01
**Status:** Approved direction (user picked Option A from the 2026-10-01 UX assessment; Option B kept for a future pass)
**Repo convention:** no Tailwind, no new runtime deps for styling; tokens in `src/styles.css`; TDD everywhere.

## Goal

Close the gap between the app's solid structure and the surface polish modern notes/tools apps
(Linear, Notion, Raycast, Things-class) set — WITHOUT changing the app's identity, its 3-pane
information architecture, or its faithful mirror of jotty·page's theme colors. Everything ships
with the existing rwmarkable-dark / dark / light themes intact.

Option A scope (from the assessment the user approved):

1. A real icon set (no emoji/text-glyph buttons).
2. A deliberate type hierarchy (scale, weights, muted meta lines).
3. Layered surfaces (elevation + softer borders) so popovers/modals read ABOVE the page.
4. Hover-reveal row actions everywhere it matters (already partially true — make it uniform).
5. Instant-apply category in the checklist view (dedicated Save button dies).
6. Completed-item grouping at the bottom of checklists.
7. Row metadata (notes: snippet + age; checklists: counts + age).
8. Assorted cramped/awkward affordances fixed (buttons that wrap, dead voids, scrollbar weight).

## Non-goals (Option B back pocket — explicitly deferred, do NOT build here)

- Palette-as-command-bar (Raycast-style: new-note/new-checklist commands inside ⌘K).
- Motion pass beyond hover/focus transitions (no springs, no skeleton shimmer animations).
- Board card polish (drag ghosts, fancy edges) beyond what falls out of tokens/elevation.
- Custom bundled font (stays system-ui; Inter-class bundling is Option B).
- Kanban interactions redesign (inline cards, count pills) — chips stay chips.
- Any data-model, sync, or upstream-API changes beyond the read-only counts addition in §2.
- Onboarding screen redesign (stays).

## Locked design decisions

### L1 — Icons: one static icon module, zero new deps

`src/components/icons.tsx` exports a single `Icon` component:
```tsx
export type IconName = 'mic' | 'plus' | 'search' | 'settings' | 'refresh' | 'trash' | 'x' | 'check'
  | 'note' | 'list' | 'columns' | 'calendar' | 'bell' | 'chevron-down' | 'menu' | 'back' | 'arrow-up' | 'clock';
export const Icon = ({ name, size = 15, strokeWidth = 1.8, className }: { name: IconName; size?: number; strokeWidth?: number; className?: string }): ReactElement;
```
- Implementation: hand-embedded SVG path data copied from the lucide-react 0.4x set (24×24 viewBox,
  stroke-based, `fill: none`), rendered as inline `<svg>` with `stroke="currentColor"`, rounded
  caps/joins. Pure function, no state, no external imports — offline-safe and tree-shaken by design.
- Usage sites replaced (ALL of them, grep-enforced — no emoji buttons survive):
  - `NoteList`: "🎙 New voice note" → `<Icon mic>` + "New voice note"; row `mic-badge` 🎙️ → `<Icon mic>` + tone hint; `✕` → `<Icon x>`.
  - `ChecklistList`: `✕` → `<Icon x>`; "+ New board" / "+ New checklist" → icon+label buttons that
    NEVER wrap (`white-space: nowrap` + flex row header, see L6).
  - `Sidebar`: `☰` menu-btn → `<Icon menu>`; `Refresh`/`Settings` text buttons get icons, keep labels.
  - `App` back-btn `←` → `<Icon back>`.
  - `SyncBadge` update chip `⬆` → `<Icon arrow-up>`.
  - `SearchPalette` results: `📝`/`☑` markers → `<Icon note>` / `<Icon list>` (color-coded).
  - `AgendaView` + `KanbanBoard` reminder `🔔` → `<Icon bell>`.
  - `EditorToolbar` task-list `☑` glyph → `<Icon check>` inside toolbar text buttons (labels stay).
- Emoji INSIDE note content (user content) and the callout icons (portal parity, P3) do NOT change.
- Accessible names unchanged (aria-labels/titles already present keep working with icons inside).

### L2 — Type hierarchy (no font bundling)

Single change point: `:root` + a few rules in `styles.css`. Scale (system-ui retained):

- `--font-ui` = existing stack; body 14px → 13.5px, line-height 1.45 → 1.5; `h2/h3` small-caps
  labels get 10.5px/11px + looser tracking (h3 loses the opacity:0.8 crutch).
- Headings inside views: `#checklist-head .cl-title` 17px → 20px, `#note-title` 17px → 20px
  (`-0.01em` letter-spacing, both).
- Meta text class `.meta-line`: NEW shared rule (11.5px, `--muted`, `font-variant-numeric: tabular-nums`).
- Buttons: base stays 13px; `.new-btn` drops to 12px but stops wrapping (L6).
- The editor's reading typography (`.tiptap`, markdown editor line-height 1.6) does NOT change.
- NO font-family change, NO @font-face (offline discipline, Option B holds the bundling question).

### L3 — Layered surfaces + shadow tokens

Two new elevation tokens + softened borders:

```css
:root {
  --surface: #1b2233;        /* popover/modal/overlay surface, one step above --panel */
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);                  /* cards, rows */
  --shadow-2: 0 12px 32px rgba(0, 0, 0, 0.5);                /* popovers + modals */
}
```
(Exact values ported per theme: dark + rwmarkable-dark + light each define `--surface`; shadow
tokens stay theme-independent.)

- Popover/menu/modal surfaces upgrade: `.jotty-dropdown-menu`, `.kanban-menu`, `.edt-slash-menu`,
  `.edt-bubble`, `.edt-tablebar`, `.image-resize-overlay`, `.modal`, `.modal-card` →
  `background: var(--surface)`, `box-shadow: var(--shadow-2)`, radius 8px kept, borders softened
  to `--border-soft`.
- List sections (`#app > main > section`, `#note-editor`) get `box-shadow: var(--shadow-1)`.
- Kanban cards pick up `--surface` (one step above the column panel — the "cards vs background
  barely differentiate" finding).
- `button:hover` STOPS re-bordering with the accent (`border-color: var(--accent)` removed from
  the base hover; hover = background shift + `--border-soft`). Accent discipline: accent fills
  survive ONLY on `.primary`, `.new-btn`, `.sec-toggle.selected`, checkbox fill, focus rings,
  li.selected (which becomes the softer L5 selection look).
- Scrollbar thumb 10px → 8px, color from `--border-soft`.

### L4 — Hover-reveal uniformity

- `ChecklistView` row delete buttons (both top-level and `.child`) get the `.row-del` treatment:
  always in the DOM (RTL tests keep passing), `opacity: 0.4` base, `1` on row hover, red on own
  hover — the existing `NoteList/ChecklistList` pattern, now uniform.
- Item rename inputs already overlay-reveal on hover/focus (unchanged).
- NO new hide-on-hover for anything else (checkboxes stay visible: touch users).

### L5 — Category instant-apply (checklist view) + selection styling

- `ChecklistView`: `.cl-category` input + `Save` button are REPLACED by the existing site-style
  `Dropdown` (src/components/Dropdown.tsx), `ariaLabel="Category"`, options = the current
  category list (`categories` from the store, both `notes`+`checklists` trees merged by path,
  plus the list's own current value if absent — a list's category may exist on the server but
  hold no notes/checklists locally; never render empty options in that case).
- `onChange` fires `saveMeta` (existing blur semantics die): the Dropdown commit IS the save.
  While offline/disconnected there are no options → falls back to the old text input (the
  Dropdown's current-value line renders fine, but the fallback keeps edit-ability; implementation
  renders the text input when `categories` is null or the merged list is empty).
- `cl-title` blur-commit stays (existing tests keep passing unchanged).
- `li.selected` (sidebar categories + list rows) softens: `--accent-soft` background +
  `--accent-strong-text` text + 2px inset accent bar via `::before` on list rows; the border
  re-color from `li.selected` dies (accent discipline L3).
- The checklist header gains a progress meta line (rides L7's counts): `<progress-like>` bar
  (pure CSS div, 4px) + `n/m done` in `.meta-line` typography. Renders ONLY for plain lists
  (boards have per-column counts already).

### L6 — Checklist list header + new buttons

- `ChecklistList` header becomes: `h2` + right-aligned icon buttons: `+ New board` (icon
  `columns`) and `+ New checklist` (icon `plus`) as `--accent-soft` `.new-btn` chips with
  `white-space: nowrap` (the wrapping die-cut; verified in the 412px phone media query too
  — `.section-head` wrap stays the narrow-viewport fallback).
- Same treatment for `NoteList`'s voice + new buttons (icons, nowrap).

### L7 — Row metadata (the real feature work)

**Notes list** (`NoteList`):
- Second meta line: content snippet (stripped HTML → first ~70 chars; the full content already
  rides `NoteDto` in the list payload — zero Rust changes) + relative age (`updatedAt` → "2h ago" /
  "yesterday" / "Sep 12" / "never synced" when null). Snippet lives in a `.meta-line` div.
- RTL text-matcher discipline (skill rule: `getByText` matches text nodes only): title gets its
  existing `.item-title` span; snippet + age live in a SEPARATE span each — test fences target
  elements, never interpolated text joins.

**Checklists list** (`ChecklistList`) — needs ONE read-only Rust field addition:
- `list_checklists_inner` (commands/mod.rs:127) already computes per-list item_counts + open_counts
  (for the `completed` flag). Those counts are promoted to the wire:
  `ChecklistDto` gains `#[serde(default)] itemCount: i64` + `#[serde(default)] doneCount: i64`
  (serde camelCase matches existing dto.rs). `db` layer unchanged — the two HashMaps are already
  in scope; the map fills them.
- `ItemDto`/sync paths untouched; creation-response field-freeze class does NOT apply (counts are
  read-only local derivations, never parsed back).
- Frontend: list rows render `n of m done · <age>` meta line (items:[] payload keeps working —
  `#[serde(default)]` = 0 for older shapes like the App.test fixtures).
- Relative age helper: `src/util/relativeTime.ts` (pure fn `relativeAge(iso: string | null): string`),
  unit-tested directly (jsdom Date fine). Used by both lists. Null → 'never synced'.

**Board rows** keep the existing `board` chip (L1 styling only).

### L8 — Completed grouping (checklist detail, plain lists)

- In `ChecklistView`, top-level completed items render as a collapsed-look group under a divider
  AFTER all open items: `[divider: "Completed · n"]` + rows. NOT shown when n=0.
- Order semantics are display-ONLY: the `top` position array, DnD ordering (`reorderItems`) inputs,
  and children attachment are untouched — grouping = a render-time partition
  (`top.filter(!completed)` + `top.filter(completed)`), children always render attached to their
  parent wherever the parent sits.
- Children of a completed parent keep rendering inside that parent (unchanged).
- DnD: the completed group's rows keep their drag affordances; drop targets on open rows unchanged.
- Toggle-back re-renders the item back into the open section (existing reload path; no test
  needs reordering semantics written).
- The "New item / Add" pair: the input gains an inline icon+label placeholder pattern
  ("Add an item ⏎"), the explicit Add button REMAINS (jsdom-fenced behavior + hover-typing users),
  but moves ABOVE the open list (top-of-list add input, Things/Todoist pattern) — enter still adds.

### L9 — Misc awkwardness fixes (same sweep)

- Settings modal: keeps its 440px width but gains `max-height: min(76vh, 640px)` + internal scroll
  (`overflow: auto` body) + consistent section gaps — dead-void fix without a redesign.
- Onboarding/connect copy area padding tightened (12px → 16px grid).
- `#notes li`, `#checklists li` rows: 9px→10px vertical padding, meta line adds height; `gap: 6px`
  kept.
- Agenda: entries get the same hover-reveal + meta-line typography; the 🔔 chip becomes Icon+time.
  No layout redesign (right-void is Option B territory).
- Dark-theme `--row-hover` contrast bumped +4% lightness (readability check only, same hue).

### L10 — Test strategy (fences are binding; byte-exact where pinned)

- NEW fences (drive the work):
  - `icons.test.tsx`: renders each name → `svg` with `fill="none"`, `stroke-width=1.8`-class attrs,
    viewBox 24, no emoji chars anywhere in icon module source.
  - `relativeTime.test.ts`: pure-fn table (null → 'never synced', 90s → 'just now', 3h → '3h ago',
    10d → 'Sep 21' style date, future → absolute date).
  - `ChecklistList.test.tsx` addition: meta line with counts (Rust dto default 0/0 vs populated),
    age rendering.
  - `NoteList.test.tsx` addition: snippet (HTML stripped), age.
  - `ChecklistView.test.tsx` additions: category Dropdown → select calls `update_checklist`;
    completed grouping order; completed divider hidden at 0; add-input at top still calls add_item.
  - styles.css static token checks (voiceTheme.test.ts pattern): elevation + selection rules exist —
    `--surface`, `--shadow-2`, `.row-del` opacity pattern, `button:hover` no longer borders accent.
- RESHAPED fences (existing tests updated where behavior changed):
  - `ChecklistView.test.tsx` save-button + blur tests → Dropdown-select equivalents (blur-based
    category mutation contract is what dies).
  - Emoji-text clicks (`+ New note`, `🎙 New voice note`, `+ New checklist`, `+ New board`,
    `📝`/`☑` markers, `⬆` update chip, `☰`) across App.test / NoteList.test / ChecklistList.test /
    SearchPalette.test → accessible-name or icon-title equivalents.
  - `NoteList.test.tsx` 'renders provided notes' etc. stay green (title unchanged).
- Rust: `dto.rs` struct fields + `list_checklists_inner` fill + commands/mod.rs test additions
  (counts: 0/0 for empty list, n/done for mixed). Existing `list_checklists_inner_reports_completion`
  must stay green with the new fields present.
- Gates baseline (run 2026-10-01 at d5860a7d): vitest 450/450 across 43 files, tsc clean,
  warnings census 18 (Δ0 gate), cargo lib 258+1i (v0.22.3 census; expected stable — no new Rust
  tests beyond the counts additions). Baselines re-census at ship.

## Version / release

- Minor bump → v0.24.0 (feature). Standard 3-file bump + locks + `git push` + `npx tauri build`
  (desktop) + Android build + tag + release per the ship procedure. Build/release happens at the
  user's confirm gate ("starting now - confirm?"), after all gates re-run green.