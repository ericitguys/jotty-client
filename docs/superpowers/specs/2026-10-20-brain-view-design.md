# Technical Specification: BrainView — the link map in jotty-desktop

**Version:** 1.0
**Date:** 2026-10-20
**Status:** Design locked — awaiting implementation go
**Target:** jotty-desktop client (Tauri 2) + stock jotty API 1.28.0+ (pure REST — the 2026-09-15 no-fork lock holds)
**Sources:** live probes on the 1.28.0 dev container (2026-10-20) + verified upstream dissection (kimi leaf, controller-verified against extracted sources) + controller probes of the client repo

---

## 1. Problem statement

jotty's Brain (the link map between notes/checklists/wikilinks/tags) exists only in the upstream web UI. The desktop client holds a full local copy but cannot see how items connect. BrainView brings the graph into the client: focused or global, 2D or 3D, online or (stale) offline — with zero server-side changes.

## 2. Locked decisions (user-confirmed 2026-10-20, short-label reconfirm after the button-truncation catch)

1. **Rendering: 2D + 3D**, upstream-parity stack — `react-force-graph-2d` ^1.29.1 (canvas) + `react-force-graph-3d` 1.29.1 + `three` 0.186.1 (verified upstream versions), both renderer bundles lazy-loaded; **2D auto-fallback when the WebGL probe fails** (upstream gates the 3D toggle on `webglReady`).
2. **Offline: SQLite snapshot cache** — last successful response per query renders offline under a `· stale data` chip (reuses the `.sync-stale` visual, styles.css:869).
3. **Entry + flow**: drawer entry (`setListMode('brain')`, store.ts:173 — cleanly resets category/selections) + brain buttons in the note and checklist/board headers opening the graph **focused on that item's uuid** (mirrors upstream brainHref/BrainButton); node click → inspector with an **Open item** action.
4. **Out-list** (§8): link editing, ghost-create, orphans/relations explorer, suggestions default-ON→**OFF** (our default differs from upstream's DEFAULT_FILTERS.suggestions=true — deviates deliberately), Android rides a later release (desktop-only this ship).

NOT locked as assumed earlier: the 2D renderer is NOT hand-rolled — "match upstream" means the react-force-graph libraries (clarify pick = parity; disclosed here).

## 3. Server contract (verified live + against _schemas/api/relations.ts in the 1.28.0 container)

- `GET /api/brain`, auth `x-api-key`. Query (zod, schemas-relations.ts:70-93): `focus` (uuid, optional — omit = most-linked items), `depth` (1..3, default 2), `limit` (1..200, default 60), `suggestions` (bool, default false).
- Response is **TOP-LEVEL** `{status('building'|'ready'), focus?, nodes[], edges[], total, truncated}` — NOT an envelope (live probe: 200 `{"status":"ready","nodes":[],"edges":[],"total":0,"truncated":false}`). This is the inverse of the categories GET trap (client.rs:113-116 unwraps `v["categories"]`) — `fetch_brain` must parse the WHOLE object as the DTO.
- `nodes[]`: `{id (uuid | 'ghost:<title>' for unwritten wikilink targets), kind ('note'|'checklist'|'ghost'|'tag'), title, category?, owner?, links (to+from count), distance? (from focus), tags?}`.
- `edges[]`: `{source, target, kind ('link'|'mention'|'checklist'|'wiki'|'tag'|'suggested'), weight ("how many times source links to target, or the suggestion score")}`.
- `total` = nodes matched before limit; `truncated` = limit left some out (both surface in the legend/inspector).
- Sibling routes `/api/relations/*` exist but are OUT for v1 (§8).

## 4. Client architecture

**Backend (Rust, src-tauri/):**
- `jotty/client.rs`: `fetch_brain(&self, query: &BrainQuery) -> AppResult<BrainResponse>` — one string query string; `api_get::<BrainResponse>` direct-TOP-LEVEL parse; serde camelCase DTOs mirroring §3 exactly; `BrainQuery {focus: Option<String>, depth: u32, limit: u32, suggestions: bool}`.
- **Snapshot cache — db/migrations.rs v7 (cumulative MIGRATIONS vec pattern, v1..v6 today):** `brain_snapshots(cache_key TEXT PRIMARY KEY, response_json TEXT NOT NULL, fetched_at TEXT NOT NULL)`. `cache_key` = canonicalized query string (sorted params). Rules: written ONLY on a successful fetch; malformed cached JSON is discarded (reparse failure → treat as no-cache); serving a cached snapshot because the live fetch failed = the offline path.
- `commands/`: `brain_fetch(query) -> BrainResponse + fetched_at + from_cache` — borrows `state.client` (RwLock<Option<JottyClient>>, populated at connect, commands/mod.rs:1085-1101); on connection error → read cache row → return `{graph, from_cache: true}`; no client (never connected) → error surfaced as the offline empty state. Numeric args `depth/limit` are u32: frontend guards `Number.isSafeInteger` + domain check before invoke (repo i64-boundary law).
- **No new capability grants**: three/rfg are plain npm deps; app-owned custom commands need no ACL entries (capabilities/default.json adds nothing).

**Frontend (src/):**
- Store: `ListMode` gains `'brain'` (store.ts:64); `setListMode('brain')` + `brainFocusId: string | null` (set by the header buttons alongside the mode so App.tsx mounts `<BrainView focus={brainFocusId}/>`); wall-swap branch at the agenda arm (App.tsx:292).
- `BrainView.tsx` (wall branch): fetch (cache-first render → live refresh on success), toolbar, renderer host, inspector, legend.
- Toolbar: search (upstream `searchNodes`: substring title, degree sort, cap 8, Enter = select+fly), dimension 2D/3D toggle (3D disabled when the WebGL probe fails; probe + `prefers-reduced-motion`/coarse-pointer auto-2D per upstream useBrainPrefs:40-51), local-scope toggle + depth slider **only when focused** (upstream pattern), per-kind filter chips (notes/checklists/tags/ghosts/suggestions/orphans), colour mode TYPE/CATEGORY, `suggestions` chip **default OFF** (out-of-band from upstream DEFAULT_FILTERS).
- Renderers: `BrainCanvas2D.tsx` (`react-force-graph-2d`: charge -110/dist 500, link distance 42, collide personal-space 5, region+gravity forces — ported constants from BrainCanvas2D.tsx:35-38,95-97 + brain-forces.ts) and `BrainScene3D.tsx` (`react-force-graph-3d`: OrbitControls, sprite-based node objects with raycast-only hit meshes, suggested-edge anchor-visibility, declutter loop, dispose discipline — brain-three.ts). Both `React.lazy` chunks; renderer swap = dimension state.
- View-model port: `brainView()` filtering (suggestion-inclusive BFS for local reachability even when suggestions render OFF — the upstream subtlety, brain-graph.ts:97-119), colour palettes read CSS vars + theme mutation (useBrainPalette pattern) with token-sweep law (no raw hex).
- Inspector: selected node → linksTo / linkedFrom / suggested (weight%) sections, neighbour quick-pick, Open button (per §5). Ghost/tag nodes: no navigation (Open disabled with a "not written yet"-class label).
- Stale chip: BrainView-local `from_cache` flag renders the `· stale data` span INSIDE BrainView (does NOT touch the global `stalePieces` sync state).
- `status === 'building'` → honest "still indexing" notice + manual refresh button (upstream renders the same class of state with no polling).
- Prefs persistence: upstream localStorage blob `jotty-brain-prefs` {dimension, filters, colourMode, depth} — port to the client's existing pref store mechanism (§ plan task verifies the exact home; localStorage fallback precedent exists in src/test/setup.ts).
- Entries: drawer Sidebar `sec-toggle`-style Brain row (Sidebar.tsx:21-31 pattern); brain buttons in `NoteEditor` + `ChecklistView`/`KanbanBoard` headers calling `setBrainFocus(uuid) + setListMode('brain')`; new graph glyph in the icons.tsx JSX map.
- Desktop-only: the drawer entry + header buttons hide below the small-viewport breakpoint (412px phone layout untouched; approach matches existing CSS-only desktop gating — plan task pins the exact selector set).

## 5. Open-item flow (node → editor)

`node.kind === 'note'` → `selectNote(id)`; `'checklist'` → `selectChecklist(id)` (boards ride the same id — store.ts:160-171; both reset the complementary selection, exactly what the wall needs). `'ghost'`/`'tag'` → Open disabled. If the uuid no longer exists locally (server-newer item), Open is disabled with an honest hint; refresh catalog via existing sync if online.

## 6. Out-list (explicit — nothing here ships in v1)

1. Link editing (`connectItems`-class server actions) — server-authoring, REST surface out of scope.
2. Ghost-create from the inspector (upstream `createNote` server action) — ghosts render; their Open is disabled.
3. Orphans/relations explorer views (`/api/relations/*`, upstream orphans/links pages).
4. Suggestions ON by default — the toolbar chip EXISTS but defaults OFF (deliberate deviation from upstream).
5. Android/mobile support (412px layouts render the exclusion, no tuning).
6. MCP/graph-side anything; server-side changes of any kind.
7. 3D: no custom three effects beyond the upstream-parity feature list above (no new shaders/effects).

## 7. Testing fences (repo laws applied to this feature)

1. **Envelope law, inverted**: wiremock test pins BrainResponse as TOP-LEVEL (a `{"data": {...}}`-shaped mock must FAIL the parser — fence the absence-of-envelope explicitly, mirroring the client.rs:113-116 counter-example).
2. **DTO key-set law**: wire-key fences compare a sorted key SET of the parsed DTO (serde_json maps iterate sorted).
3. **Cache fences**: snapshot write-on-success only; corrupted JSON row → treated as absent; same canonical cache_key across param ORDER permutations (query canonicalization test); offline fallback returns `from_cache: true` + stale payload byte-identical.
4. **jsdom blindness**: both renderers = structural fences ONLY (component mount w/ stubbed canvas, callback wiring, lazy-chunk swap on dimension state, 3D-disabled-when-no-WebGL path). The REAL layout fence = the headless WebKitGTK dist probe screenshot pass at 1280 + 412 (vision-verify stills) BEFORE the gate question — covers the 2D graph, stale chip, and the desktop-only exclusion.
5. **i64/u32 boundary law**: every numeric command arg passes the `Number.isSafeInteger` + domain guard (depth 1..3, limit 1..200) on a Math.trunc'd const.
6. **brainView port**: unit tests seeded-deterministic (no rAF), each filter flag + the suggestion-inclusive BFS subtlety + orphan-except-focus + focused/global scope math vs upstream fixtures.
7. **Timer/loop hygiene**: renderer tests carry the rAF/interval cleanup discipline (upstream's per-frame loops are the leak class the repo has hit before).
8. Standing gates: full vitest + tsc + cargo test --lib + census 18 Δ0 (re-run; counts re-measured at implementation time).

## 8. Roadmap (SDD-ready — single feature, 4 task slices)

- [ ] **P1 — Data layer:** wiremock-pinned DTO + fetch_brain + v7 snapshot table + brain_fetch command + offline/cache fallback (Rust + fences 1-3,5).
- [ ] **P2 — 2D view:** store 'brain' mode + wall branch + BrainView shell + toolbar + 2D renderer + brainView port (+ fences 4-structural,6,7).
- [ ] **P3 — 3D + fallback:** lazy BrainScene3D + WebGL probe + auto-2D guard + renderer swap.
- [ ] **P4 — Chrome + entries:** inspector + legend + stale chip + drawer/header entries + desktop-only exclusion + prefs persistence + WebKitGTK screenshot pass.

Each phase ships per the standing staged platform release order (APK → Linux → Windows) **when it rides a release**; Android exclusion here means the phone keeps its current build until the follow-up ride-along.

## 9. KPIs

1. The graph opens for any item ≤2 taps from the editor (header button → focused graph).
2. Offline never lies: cached graph always carries the stale chip; no-cache offline = honest empty state.
3. Zero raw-colour leaks (token sweep) and zero new capability grants.

## Appendix — Provenance

- **Live probes (2026-10-20, dev 1.28.0 container):** GET /api/brain with x-api-key → 200, `{status:"ready", nodes:[], edges:[], total:0, truncated:false}` (fresh fixture); route source `/app/app/api/brain/route.ts` (getBrain, neighbourhoodFor); schema bounds depth 2/3, limit 60/200 (consts-relations.ts:61-64).
- **Upstream dissection** (kimi-k2.7-code:cloud leaf → `/tmp/brain-kimi/upstream-parity.md`, 398 lines): react-force-graph-2d ^1.29.1 / -3d 1.29.1 / three 0.186.1 (package.json:81-82,99); force constants; WebGL probe gating; brainView BFS subtlety; inspector sections; connect/createNote = server actions (verify-before-accept: every load-bearing claim re-checked by the controller against the extracted sources — package.json, imports, brain-view math, searchNodes cap, edge schema weight/total/truncated).
- **Client integration** (controller probes after the kimi client-map leaf looped at 2h and was killed — its partial log was discarded, ALL §4 facts above re-derived directly): store.ts:64/160-205, App.tsx:281-292, Sidebar.tsx:21-31, SyncBadge.tsx:15-33 + styles.css:869, commands/mod.rs:1085-1101, state.rs:70, keys.rs:81-88, migrations.rs v1-v6 pattern, capabilities/default.json, icons.tsx JSX map.