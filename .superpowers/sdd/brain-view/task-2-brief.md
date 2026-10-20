# MISSION — Leaf implementer: BrainView Task 2 (P2) — Frontend core

You are the LEAF implementer. Full tool rights INSIDE `/tmp/wt-brain-p2` ONLY
(branch `brain/p2`, base `9850731` — Task 1's Rust data layer is IN: command
`brain_fetch(query: {focus, depth, limit, suggestions})` exists, returns
`{graph: BrainResponse, fetchedAt, fromCache, stale}`). NEVER touch
`/coding/jotty` (live checkout), any other repo, or $HOME config. Commit
locally with `git -c user.name=zeus -c user.email=zeus@local commit` (overrides
BEFORE the subcommand). NO push, NO `cargo fmt`, NO reformatting, NEVER touch
AGENTS.md. Rust is DONE for this task: do NOT modify src-tauri/** (cargo gates
not yours to run; census N/A unless you touch Cargo.toml — you must not).

## Environment

- vitest + RTL + jsdom; `src/test/setup.ts` has in-memory localStorage shim.
- Baselines at 9850731 (measured): full `npx vitest run` = **54 files / 690
  tests passed** + UP TO 2 unhandled rejections of the ONE known
  ChecklistView null-fetch class (ChecklistView.tsx:31; not a gate break —
  class-identity is the gate). `npx tsc -p tsconfig.json --noEmit` CLEAN.
- React 18; zustand store singleton (import `useStore` from '../stores/store').

## Objective (spec v1.1 §4 Frontend + plan Task 2 — read both first)

Build the BrainView frontend CORE: store 'brain' mode + brainFocusId +
reset matrix + prefs persistence, wall branch, BrainView shell with toolbar +
render-state matrix, the brainView view-model port, and the 2D renderer.
NO 3D this task (the dimension toggle renders 3D as a disabled button; Task 3
wires the lazy chunk). NO inspector/legend this task (Task 4) — BrainView
renders graph + toolbar + (selection feedback = node highlight only this task;
Task 4 adds the inspector panel). The stale CHIP ships here (it's the
render-state matrix's own signal), but the CSS base-rule relaxation is Task 4
— use a BrainView-local class `brain-stale` styled like the badge chip (copy
the amber visual) so you don't touch styles.css? NO — touch styles.css freely
EXCEPT: do not remove/alter the `#sync-badge .sync-stale` rule.

## Binding store shape (exact)

```ts
export type ListMode = 'notes' | 'checklists' | 'agenda' | 'brain';
// new fields:
brainFocusId: string | null,
brainPrefs: BrainPrefs,            // type below
// new actions:
setBrainFocus: (id: string) => void,   // ids are uuid strings
setBrainPrefs: (patch: Partial<BrainPrefs>) => void,
setBrainDimension: (d: '2d' | '3d') => void,
```

```ts
export interface BrainPrefs {
  dimension: '2d' | '3d';
  colourMode: 'type' | 'category';
  depth: number;                 // 1..3 slider value
  filters: BrainFilterFlags;     // {notes: bool, checklists: bool, tags: bool, ghosts: bool, suggestions: bool, orphans: bool}
}
export const BRAIN_PREFS defaults: { dimension: '2d', colourMode: 'type', depth: 2,
  filters: { notes: true, checklists: true, tags: false, ghosts: true, suggestions: false, orphans: true } }
  // DEFAULT_FILTERS parity with upstream EXCEPT suggestions=false (deliberate, spec §2.4)
```

- `setBrainFocus(id)`: ONE set() → `{ brainFocusId: id, listMode: 'brain', selectedNoteId: null, selectedChecklistId: null }`.
- Reset matrix (spec §4 audit B3 — bind EXACTLY): `setListMode('brain')` →
  `brainFocusId: null`; `selectNote`, `selectChecklist` (BOTH arms — including
  null-id variants if they exist), `selectCategory` (both arms), and the
  App.tsx back-button arms → clear `brainFocusId: null`. The back button is in
  App.tsx (selectNote(null)/selectChecklist(null) paths) — extend those two
  store actions rather than App (store edits land either way, back-button
  behavior follows the actions it calls).
- Prefs persistence (IIFE pattern EXACTLY like store.ts:96-115 themeOverride):
  init reads `localStorage.getItem('jotty.brain-prefs')` → JSON.parse in
  try/catch → merge over defaults (`{...DEFAULTS, ...stored, filters: {...DEFAULTS.filters, ...stored?.filters}}`)
  → catch/null → defaults. `setBrainPreferences`-style setter writes the whole
  blob via try/catch (storage-unavailable = session-only, comment mirrors the
  existing pattern).

## api.ts (exact)

```ts
export interface BrainFetchResult {
  graph: { status: string; focus: string | null; nodes: BrainNodeWire[]; edges: BrainEdgeWire[]; total: number; truncated: boolean };
  fetchedAt: string;
  fromCache: boolean;
  stale: boolean;
}
```
- wrapper `export async function brainFetch(q: { focus: string | null; depth: number; limit: number; suggestions: boolean }): Promise<BrainFetchResult>`:
  - `const d = Math.trunc(q.depth); const l = Math.trunc(q.limit);`
  - guard: `!Number.isSafeInteger(d) || d < 1 || d > 3` or `!Number.isSafeInteger(l) || l < 1 || l > 200` → `throw new Error('brain query bounds: depth 1..3, limit 1..200')` (JS throws BEFORE invoke — fence with the exact message).
  - call `invoke('brain_fetch', { query: { focus: q.focus, depth: d, limit: l, suggestions: q.suggestions } })`.
- types `BrainNodeWire`/`BrainEdgeWire` exactly the Rust shapes (id/kind/title/category?/owner?/links/distance?/tags?; source/target/kind/weight) — cross-check field names against the shipped Rust struct in the worktree (grep `pub struct BrainNode` src-tauri/src/jotty/brain.rs) and mirror (this is the CROSS-TASK CONTRACT law: derive from src, not prose).

## brainView port (pure module `src/components/brain/brainView.ts`)

Port upstream brain-graph.ts filtering (upstream source mounted read-only at
/tmp/brain-src/ui/utils/brain-graph.ts — read for parity; port to our DTO):
- `brainView(nodes, edges, filters, scope: {local: boolean, depth: number}, focusId: string | null) -> {nodes, edges}`.
- Edge filter: drop kind 'suggested' when !filters.suggestions; drop kind 'tag' when !filters.tags.
- Adjacency `neighbourMap(edges, includeSuggestions)`: map id→Set of neighbour ids; the `includeSuggestions=true` variant (BFS reachability) KEeps suggested edges; the render-map (orphans check) uses the FILTERED map.
- Local scope: when scope.local && focusId → BFS `_within(focusId, neighbourMap(edges, true), Math.min(scope.depth, 3))` keep only reached nodes (+ focus).
- Kind filter via KIND_FILTER: note→filters.notes, checklist→filters.checklists, tag→filters.tags, ghost→filters.ghosts.
- Orphans: when !filters.orphans → drop nodes with no edge in the FILTERED edge set except the focus node.
- Edges out: only where both endpoints survived.
- `searchNodes(nodes, query, limit=8)`: substring match on title (lowercase), sort by links desc (upstream sort key degree == wire links), slice 8; empty/blank query → [].

## BrainView shell (`src/components/BrainView.tsx`)

- Props: none (reads store: brainFocusId, brainPrefs).
- Data: `useState<BrainFetchResult | null>`; effect fetches on mount + on ANY query-param change (focusId, scope.local, depth, suggestions on/off, limit) — deps-exact. While a newer fetch is in flight an older SUCCESS stays rendered (no flash-to-empty; abort-guard by a seq counter or latest-ref).
- Render tree (structural contract, these classes are binding):
  - `#brain` wrapper; header row holds `#brain-title` (text: "Brain") + stale chip when `fromCache || stale` → `<span className="brain-stale">· stale data</span>` (exact text incl. middle dot + spaces).
  - `status === 'building' && graph.nodes.length === 0` → `<div className="brain-indexing">Still indexing links…</div>` + refresh button (calls the same fetch).
  - `status === 'ready' && nodes.length === 0` → `<div className="brain-empty">No links yet.</div>` (checklist/notes content decides the wording — keep "No links yet.").
  - error state (invoke threw) → `<div className="brain-error">Brain unavailable</div>` (offline no-cache case lands here via Rust Err — honest).
  - graph present → `<div className="brain-body"><BrainToolbar … /><BrainCanvas2D … /></div>`.
- Node click = select (highlight); double-click + right-click = open via §5
  rule: note→selectNote(id); checklist→selectChecklist(id) (ChecklistView
  branches kanban/task to the board — verified spec §5); ghost/tag or
  not-in-local-DB → no-op. The not-in-DB check: `useStore.getState().notes.some(n=>n.id===id)` / `checklists.some(c=>c.id===id)` — note/checklist only.
- Toolbar (`src/components/brain/BrainToolbar.tsx`): search input (searchNodes → suggestion list, Enter picks first = select + 2D-FLY later; this task: select only), dimension segmented control (2D | 3D, 3D button `disabled` this task), scope Local/Global toggle (rendered ONLY when focusId — store brainFocusId non-null), depth slider 1..3 (only when focusId && scopeLocal), six filter chips (aria-pressed), colour select type|category, suggestions chip starts OFF from prefs. All toolbar writes go through setBrainPrefs (chip text: kind names lowercase).
- 2D renderer (`src/components/brain/BrainCanvas2D.tsx`): `react-force-graph-2d` (`npm install react-force-graph-2d@^1.29.1` — EXACT dep, record the resolved version).
  - Container + 15-line ResizeObserver hook (own `useElementSize` copy).
  - Constants EXACT (port of upstream BrainCanvas2D.tsx:29-49 + 95-99 + brain-forces.ts): chargeForce strength -110, distanceMax 500; link distance 42; collide radius nodeRadius(node,false)+5 (PERSONAL_SPACE 5); regionForce 0.05 (category centroid); gravityForce 0.012; cooldownTicks 120; FOCUS_ZOOM 3; FLY_MS 1100; FIT_PADDING 120; DIM_ALPHA 0.15; HUB_LABELS 10; CLICK_SLOP_PX 6; CLICK_MAX_MS 450; DOUBLE_CLICK_MS 350.
  - Node paint: canvas circle by kind colour + 1-char glyph (n/c/t/ghost '?'); colours from a palette helper reading computed CSS vars (var names: --primary, --foreground, --background, --muted, --amber IF exists — check styles.css var names first and reuse; write a small `getBrainPalette()` + MutationObserver on `document.documentElement` class/style/data-theme — port useBrainPalette). NO literal hex in BrainView files at all (the raw-hex fence is greppable: `grep -n "#[0-9a-fA-F]\{3,6\}" src/components/brain/ src/components/BrainView.tsx` must be 0).
  - Labels: pill labels for anchor + top HUB_LABELS hubs, collision-skipped (upstream drawLabels simplification allowed: 2-3 label lanes max, but keep the cap + collision skip).
  - Edges: suggested kind dashed [3,3] + visible only when touching the anchor (hover/selected/focus); lit set = anchor + neighbours (suggestion-inclusive); dim alpha 0.15.
  - Focus behavior: on first engine stop → focused: centerAt+zoom(FOCUS_ZOOM fly); unfocused: zoomToFit(FIT_PADDING).
  - jsdom: canvas getContext returns null in test env — the component MUST early-return a structural fallback (`<div className="brain-canvas-stub" data-node-count={nodes.length}/>` renders when `!canvas.getContext` in an effect probe ONCE per mount) — no crash in jsdom, real render in webview. (This keeps the structural fences mountable without a canvas mock.)
- Icons: add `graph` entry to the icons.tsx JSX map (hub-and-spoke: center circle + 3 outer circles + 3 lines; hand-drawn 24×24 paths).

## TDD — RED FIRST (fences bind verbatim; TS asserts carry NO message args)

New test files: `src/components/brain/brainView.test.ts` (pure unit:
each filter flag flips the expected node set; BFS-includes-suggestions
subtlety = node reached ONLY via a suggested edge stays in LOCAL scope when
chip off; orphan-except-focus; searchNodes cap/sort/blank query) and
`src/components/BrainView.test.tsx` (RTL: mock `../../api`'s brainFetch —
`vi.mock` with the RESULT SHAPE above; (1) renders container+toolbar+2D stub
on ready graph; (2) stale chip renders when fromCache||stale (text exactly
'· stale data'); (3) building+no-nodes → indexing notice + refresh btn; (4)
ready+no-nodes → empty state; (5) invoke throw → error state; (6) toolbar:
depth slider + scope toggle ABSENT unfocused, PRESENT focused; filter chips
toggle via aria-pressed; suggestions chip initially unpressed (default-OFF);
(7) store matrix: setBrainFocus sets fields; setListMode('brain') clears
focus; selectNote/selectChecklist/selectCategory clear focus; (8) prefs: IIFE
merge + setter persists (localStorage shim) + corrupt JSON → defaults; (9)
node double-click opens (selectNote called with the right id) — mock
useStore.getState() via the real store: use useStore.setState to seed
notes/checklists; (10) api guard throws the exact bounds Error message.
Count the it() blocks in your files at the end — the report states the total;
the FULL-SUITE expected below is ledger-baseline + your counted total.)

**Run RED first:** `npx vitest run src/components/brain src/components/BrainView.test.tsx` → expect FAIL (files missing) → implement → GREEN.

## Gates (order matters; FULL outputs routed to files, grep them)

1. `npx vitest run` FULL → expected: 690 + <your counted it() total> passed, 0
   failed; unhandled rejections allowed ONLY the known class (origins =
   ChecklistView.tsx:31 checklist-fetch; a NEW origin line = regression → STOP).
2. `npx tsc -p tsconfig.json --noEmit` → clean.
3. Census N/A (no Rust files touched, no Cargo.toml change — state it).
4. `grep -rn "#[0-9a-fA-F]\{3,6\}" src/components/brain/ src/components/BrainView.tsx` → 0 hits (palette fence).
5. `git add` explicit paths only.

## Commit (exact message shape)

```
git -c user.name=zeus -c user.email=zeus@local commit -m "feat(brain): BrainView shell + toolbar + prefs + 2D renderer + brainView port" -m "<behavior + test deltas + exact counts>"
```

## Report (create; the one writable path in-tree)

`/tmp/wt-brain-p2/.superpowers/sdd/brain-view/task-2-report.md` — RED evidence
(the failing lines), GREEN counts (exact), resolved rfg version
(`npm ls react-force-graph-2d`), deviations under §fixes. Gate mismatch →
STOP + report the delta.

## Final answer format (last message, nothing else)

`DONE <sha> vitest=<total> tsc=clean brain_tests=<k> rfg=<version>` — or
`STOP <one-line reason + delta>`.