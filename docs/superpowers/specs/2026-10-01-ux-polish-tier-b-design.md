# UX Polish Pass (Tier B) — Design

**Date:** 2026-10-01
**Status:** Approved direction (user picked "full B" 2026-10-01; the four shape questions answered in-thread — unified command bar / subtle+fast motion / board cards polish+inline edit / NO font swap)
**Repo convention:** no Tailwind, no new runtime deps; tokens in `src/styles.css`; TDD everywhere. Frontend-only run expected (no Rust changes anticipated; cargo gates still re-run at ship).

## Goal

Ship the visible tier of the 2026-10-01 UX pass — everything Tier A (v0.24.0) explicitly deferred.
Tier A was the quiet polish (icons, tokens, row metadata, surfaces); Tier B changes how the app
FEELS day-to-day: one command bar that runs the app, motion that makes surfaces feel alive,
board cards that read and edit cleanly. Identity unchanged: 3-pane architecture, theme colors,
sync semantics, no data-model or upstream-API changes.

## Scope decisions locked 2026-10-01 (user, in-thread)

1. **Command bar: UNIFIED** — one bar; commands + search results together; arrow keys reach everything.
2. **Motion: SUBTLE & FAST** — 120–180ms CSS fades/slides; reduced-motion toggle; NO skeleton
   shimmer, NO spring physics; pure CSS, zero new deps.
3. **Board cards: POLISH + INLINE EDIT** — surfaces/pills/drag ghost + click-to-edit title in
   place; context menus keep date/reminder/move/delete.
4. **Font: NO SWAP** — system-ui stays everywhere (user declined Inter explicitly).

## S1 — Command bar (SearchPalette → CommandBar)

Current state (verified): ⌘K opens `SearchPalette` (39 lines) — search-only, notes + checklists,
two callbacks (`onSelectNote`/`onSelectChecklist`). Board card editing today is menu-driven
(Rename → inline input; Set date / Set reminder / Move / Delete in `kanban-menu`); no card-detail
modal.

- New `src/components/CommandBar.tsx` REPLACES `SearchPalette`. `App.tsx` ⌘K/⌘-K wiring, the
  `showSearch` state slot, and the open/close contract stay; the two select callbacks keep
  working (command execution adds its own dispatch wiring).
- **Empty query → COMMANDS section pinned first** (7 commands, in order):
  1. New note — same create flow the `+ New note` button calls, then opens it
  2. New checklist — same flow as `+ New checklist`, then opens it
  3. New board — same flow as `+ New board`, then opens it
  4. New voice note — same flow as the 🎙/mic NoteList button
  5. Sync now — same handler as the Refresh button
  6. Toggle theme — same code path the Settings → Appearance picker uses (cycles through the
     picker's theme list, in its listed order)
  7. Open settings — opens the existing SettingsModal
  No new mutation semantics beyond these seven; no per-item commands, no delete commands (YAGNI).
- **Search below, unchanged behavior:** same search results as today (notes + checklists
  sections; boards render with the existing `board` chip). Typing filters BOTH layers: commands
  whose label contains the query (case-insensitive) stay listed; entity results below.
- **Keyboard:** ↑/↓ moves seamlessly across sections (commands are first-class rows); Enter runs
  the selected row (command executes / entity opens); Esc closes; opening focus starts on the
  first command. Mouse rows clickable as today.
- Icons: command rows carry Tier A icon-module icons (`note`, `list`, `columns`, `mic`,
  `refresh`, `settings`, `plus`). Toggle theme needs ONE new icon name (`sun`) — added to
  `icons.tsx` the established way (lucide path data, inline svg, zero deps).
- Mobile: bar renders as a full-width sheet under the 412px media query; reachability = the
  entry points ⌘K has today (no new mobile-only launcher in this pass).
- Tests: RTL — empty-query command section renders (7 rows); typing filters commands + results;
  keyboard nav crosses sections; Enter executes a command (api mocks assert the exact command);
  entity select opens; Esc closes. The `SearchPalette` suite RETIRES (reshaped into
  `CommandBar.test.tsx`). `App.test.tsx` ⌘K fences reshaped to the new component.

## S2 — Motion tokens + reduced motion

- Tokens in `:root`: `--motion-fast: 120ms`, `--motion-med: 180ms`, `--ease-out:
  cubic-bezier(0.2, 0, 0, 1)`.
- Animated surfaces (opacity/transform/box-shadow/background-color ONLY — compositor-friendly,
  safe in WebKitGTK):
  - Menus/popovers (`.jotty-dropdown-menu`, `.kanban-menu`, `.edt-slash-menu`, `.edt-bubble`,
    `.edt-tablebar`): fade + 4px slide, `--motion-fast`.
  - Modals (`.modal`, `.modal-card`) + backdrop: fade + 6px rise, `--motion-med`.
  - Drawer: translateX, `--motion-med` (412px media query).
  - Kanban cards, list rows, buttons, `li.selected`: color/shadow transitions only — no movement.
- **FORBIDDEN (fence-enforced):** transition/animation on layout properties (`width`, `height`,
  `top`, `left`, `margin`); `@keyframes` beyond none; any JS-driven animation or animation library.
- Reduced motion, two layers:
  1. `prefers-reduced-motion` media query → durations zeroed.
  2. In-app toggle: Settings → Appearance → "Reduce motion" checkbox → persisted with the theme
     setting (same local-setting pattern as the theme picker) → sets `data-reduce-motion` on the
     app root → `[data-reduce-motion]` zeroes durations regardless of the OS setting.
- Tests: static token fences (RULE/comment-stripped pattern): tokens exist; zero
  layout-property transitions in the sheet; reduced-motion block + `[data-reduce-motion]` rule
  exist. `SettingsModal` fence: checkbox writes the setting and the root attr reflects it.

## S3 — Board cards: surfaces, pills, ghost, inline edit

- Card surface: `background: var(--surface)` + `--shadow-1` (Tier A tokens), radius kept —
  cards pop one step above the column panel like Tier A popovers do above the page.
- **Pills** (right-aligned meta row on the card, `.meta-line` typography + icon): the card's
  EXISTING metadata rendered as uniform icon pills — target-date pill (calendar icon + date
  label; today/overdue get the attention/danger token) and reminder pill (bell icon; existing
  reminder-chip semantics carried over, now pill-styled). Pills REPLACE any raw text rendering
  of that metadata today; pill clicks do NOT start editing (S3 inline edit click-through).
- **Drag ghost: CSS-only** — `.kanban-card.dragging { opacity: 0.45; box-shadow: var(--shadow-2);
  transform: rotate(1.5deg) scale(1.02); }`. The existing dragStart handler adds the class (and
  removes it on dragEnd); the DnD contract stays byte-identical (T17 rulings U/W stand:
  dataTransfer-first drop, children from `item.children`). NO `setDragImage` calls.
- **Inline edit:** clicking the card's TITLE area swaps the title for the existing
  menu-rename input pattern in place (`autoFocus`, Enter/blur commit → same
  `api.setItemText` path, Esc cancels without invoking). Pills, menu button, and any action
  areas are click-through (their clicks do NOT start editing). Menu → Rename STAYS (existing
  fences keep passing).
- Tests: RTL — click title → input focused; Enter commits `setItemText`; Esc cancels (zero
  invoke); pill renders for date/reminder metadata; pill click does not start editing;
  dragStart adds `.dragging`; menu-rename path stays green.

## S4 — Agenda right-void + onboarding refresh (layout-only passes)

- `AgendaView`: entries fill the dead right side with a right-aligned relative-day chip
  (TODAY / weekday name / overdue in the danger token) using `.meta-line` tokens; entries adopt
  Tier A hover-reveal + meta typography. No new data, no new columns, no calendar.
- Onboarding/connect: visual hierarchy pass only — centered card, clearer label hierarchy,
  existing connect-validation text styled inline. The wire logic (URL/key validation, connect
  flow, probes) is byte-identical.
- Tests: light fences — agenda chip renders the relative label from the entry date; onboarding
  existing tests stay green (logic untouched).

## S5 — Riders (the v0.24.1 queue folds in here)

The seven deferred v0.24.1 riders ride the relevant tasks (detailed per task in the plan):
(a) ChecklistView row-del hover-opacity uniformity; (b) `--row-hover` +4% dark-theme bump;
(c) `li.selected .chip` contrast rider; (d) icons provenance header reword; (e)
VoiceNoteReview join-wrap + 2-fence reshape; (f) dedupe DOM-count fence hygiene; (g) catOptions
`listMeta` pre-load race (~120ms local wire).

## Non-goals (unchanged + user-ruled)

- NO font bundling — system-ui stays (user declined 2026-10-01).
- NO skeleton shimmer, NO spring physics (locked with the motion answer).
- NO full inline card creation / quick actions on cards (add-card stays in the column header).
- NO data-model, sync, or upstream-API changes; zero Rust expected.
- Onboarding FLOW unchanged (visual pass only). Command bar = exactly the 7 commands.

## Version / release

- Minor bump → **v0.25.0** (features). Standard ship per the standing staged order: gates →
  3-file bump + locks → push → **(A) Android APK** → **(B) Linux bundles** → **(C) Windows exe
  (tag-push CI)** → verify + re-hash every asset → ledger. Ship stages are user-confirm gates.

## Test strategy / gates

- Baselines re-census at dispatch (post-v0.24.0 snapshots: vitest 502/502 across 46 files with
  1 known cosmetic unhandled rejection; tsc clean; cargo lib 266+1i; warnings 18 Δ0).
- New/reshaped suites: `CommandBar.test.tsx` (~10 fences; SearchPalette suite retires), motion
  token fences, `KanbanBoard` inline-edit + pill + ghost fences, `SettingsModal` reduce-motion
  fence, agenda chip fence. Net-positive test delta, arithmetic verified in reports.
- **Real-engine probe standing rule applies:** any task adding pill rows/meta lines/flex
  containers that could change flex axis behavior runs the headless-ux-probe screenshot pass at
  1280px + 412px BEFORE the gate question (Tier A lesson — row-meta flex-axis class).
- `grep` gates at ship: no emoji buttons (`icons` discipline holds), `prompt()` still 0.