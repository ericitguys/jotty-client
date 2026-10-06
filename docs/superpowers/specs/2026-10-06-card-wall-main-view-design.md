# Card-Wall Main View — Design

Status: approved design, 2026-10-06. User request (Discord): "can we redo the
main view of notes and tasks. instead of being long rectangle can it be like
the jotty app and be square and be side by side?"

Scope questions answered via clarify the same day — the user picked all three
recommended defaults: the card-wall look (jotty web default), the editor
replaces the wall full-width when an item is open (web-like), and checklist
cards mirror the web card (progress bar + footer meta, no inline item
preview). Design approved via those picks.

## 1. Problem

The client's Notes and Checklists tabs render each item as a full-width row —
a long rectangle stacked in a single column (`#app > main.list-only`, `#notes
ul`/`#checklists ul` = `flex-direction: column`). The jotty web app renders
the same content as a wall of side-by-side cards (its default `viewMode:
'card'`), which is the look the user wants in the client.

## 2. Upstream reference (fccview/jotty, probed 2026-10-06 from `main`)

- **Notes card mode** (`NotesHome.tsx`): masonry wall via `react-masonry-css`,
  `breakpointColumnsObj = { default: 3, 1600: 4, 1599: 3, 1280: 2, 1024: 2,
  768: 1, 640: 1 }` — net effect: 4 columns on very wide screens, 3 default,
  2 on tablet, 1 on phone. `NoteCard` = title (hover→primary), category chip,
  content preview (`line-clamp-4`), footer with category + relative age.
- **Checklists card mode** (`ChecklistHome.tsx`): NOT masonry — a uniform
  responsive grid, `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3
  xl:grid-cols-4 gap-4`. `ChecklistCard` = title + category chip, progress
  bar with completion %, footer "N of M done" + relative time; kanban-type
  lists additionally render `TaskSpecificDetails`. The client mirrors the
  plain-checklist card body; `TaskSpecificDetails` is NOT ported (see §4).
- Upstream default `viewMode` is `'card'` (`app/_utils/settings-store.ts`).
  The user sees the card wall on the web daily.

## 3. Decisions (locked 2026-10-06, clarify all-recommended)

1. **Card wall for both lists.** `NoteList` and `ChecklistList` re-render
   their items as cards side by side. The `ul > li` DOM stays (list
   semantics + existing test queries click/`selected` on `li` survive); the
   `ul` gains class `card-wall` and each `li` becomes a card.
2. **Notes cards = masonry** (CSS multi-column, no new dependency):
   `column-count` pinned by media query — ≥1600px: 4, default: 3,
   ≤1024px: 2, ≤700px: 1 (rides the existing phone breakpoint). Cards get
   `break-inside: avoid`.
3. **Checklist cards = uniform grid** matching upstream: 1 / 2 / 3 / 4
   columns at ≤700 / ≤1024 / ≤1440 / >1440 px, same visual card chrome as
   notes.
4. **Note card body** (top → bottom): title (＋ dirty • + mic badge when
   pending transcription), category chip, snippet preview (existing
   `snippetFromHtml(n.content)`, clamped ~4 lines), footer = relative age
   (`relativeAge(n.updatedAt)`). Delete ✕ stays (hover-reveal top-right,
   `stopPropagation`, ConfirmModal guarded).
5. **Checklist card body**: title (＋ dirty •), board chip for
   kanban/task types (existing `board-chip`), category chip, progress bar
   (accent fill on muted track) with % when countable, footer
   "N of M done · age". Counts come ONLY from the store's list rows
   (`itemCount`/`doneCount` — wire-counts fact: `From<ChecklistRow>` DTO
   hardcodes 0/0; only `list_checklists_inner` fills real totals). Rows
   without counts (old fixtures) skip bar AND footer count; age still shows.
   % = `Math.round(done/item*100)`, item==0 → 0%.
6. **Editor open = wall replaced, full-width** (web-like). When
   `selectedNoteId`/`selectedChecklistId` is set, the list section
   unmounts; the editor/ChecklistView occupies `main` alone
   (`grid-template-columns: 1fr`). The old list-rail split
   (`minmax(260px, 340px) 1fr`) is removed. Back returns to the wall —
   the existing `back-btn` (already hidden on desktop!) must therefore be
   visible on desktop whenever an item is open: un-hide it at ALL widths,
   same treatment as phone (fixed, top: 10px right: 10px, 38px square) —
   the single consistent placement; the real-engine probe confirms it does
   not cover editor/ChecklistView controls (§5).
7. **Full-swap applies at every width.** The phone media query's editor
   behavior stops being a special case; `main.list-only`'s full-width rule
   generalizes to `main > *` being the only child. The `.list-only` class
   stays only if its CSS carries other load (verified during
   implementation; delete if dead).
8. **Version target: v0.27.0** (minor feature) across the usual three
   files + lock refresh. Staged ship order (A Android → B Linux → C
   Windows/CI verification) per standing rule, once built.

## 4. Out of scope (explicitly NOT in this change)

- Agenda view: unchanged (the user said notes and tasks; agenda keeps its
  calendar layout and still opens a full-width swap when it spawns a view).
- KanbanBoard and ChecklistView interiors: unchanged — only the LISTS get
  the wall.
- No Cards/Tiles settings toggle, no viewMode persistence (client has no
  viewMode setting upstream parity demanded — cards ARE the view).
- No pin/unpin toggles on cards (client's pinned filters mirror web prefs;
  editing pins is a web-side feature).
- No drag-to-reorder of cards, no TaskSpecificDetails (top-tasks panel)
  port, no card context menus. Existing actions (open, delete) only.
- No upstream filing; pure client-side UI change, no API/DB/sync changes
  whatsoever — Rust source untouched. The v0.27.0 bump still re-runs the
  cargo gates per the ship-procedure standing rule (Cargo.toml version
  field changes).

## 5. Verification requirements (standing rules that bite here)

- **REAL-ENGINE LAYOUT CATCH class**: any task adding meta/layout rows must
  run the headless-ux-probe screenshot pass at 1280 AND 412 widths against
  vite :5199 + the invoke-shim BEFORE the gate question (both strikes in the
  2026-10-01 run were caught only by real-engine probes). The wall layout at
  4 widths (1600/1280/1024/412) plus an editor-open shot gets screenshotted.
- Existing NoteList/ChecklistList test fences reshape (li classes, card
  chrome); disclose reshapes. New fences: card-wall class present, note card
  carries snippet+age, checklist card carries progress bar + footer count,
  board chip preserved, editor-open renders NO list section, back-btn visible
  with an item open, phone media column count (via the probe, not jsdom).
- Gates: full `npx vitest run`, `npx tsc --noEmit`, `cargo test --lib`
  (baseline re-census by running immediately before citing).