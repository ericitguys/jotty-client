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
- **Snapshot cache — db/migrations.rs v7 (cumulative MIGRATIONS vec pattern, v1..v6 today):** `brain_snapshots(cache_key TEXT PRIMARY KEY, response_json TEXT NOT NULL, fetched_at TEXT NOT NULL)`. **Cache-key canonicalization (audit B1):** `brain_cache_key(&BrainQuery) -> String` — params in fixed order `depth=<decimal>&focus=<lowercased uuid or ''>&limit=<decimal>&suggestions=<true|false>`; uuids lowercased (server lowercases focus); NO url-encoding (path-free values only). **Growth bound:** keep at most 30 rows — on insert, `DELETE FROM brain_snapshots WHERE cache_key NOT IN (SELECT cache_key FROM brain_snapshots ORDER BY fetched_at DESC LIMIT 30)` in the SAME transaction. **Crash-atomicity:** the cache write (INSERT OR REPLACE + trim) is ONE transaction; a truncated/garbage `response_json` is caught at READ time by the serde parse → discard + treat as no-cache.
- **Cache invalidation (audit B10):** a local mutation or pull upsert makes every snapshot stale — `brain_fetch` compares the row's `fetched_at` with the outbox's newest op timestamp (present locally, no new column): any pending outbox op enqueued AFTER `fetched_at` → the snapshot is stale for FIRST RENDER too (chip shows until a live fetch succeeds). Pull-side: a snapshot whose `fetched_at` predates the last successful pull's `sync_state.last_pull_at` (column exists today) is stale the same way. No row deletion needed — staleness is computed, not destructive.
- `commands/`: `brain_fetch(query) -> BrainFetchResult {graph, fetched_at, from_cache}` — borrows `state.client` (field declared at state.rs:13 as `tokio::sync::RwLock<Option<JottyClient>>`, populated at connect, commands/mod.rs:1085-1101). **Fetch result matrix (audit B2):** (1) no client (never connected) → `AppError` → frontend renders the offline empty state; (2) live fetch OK → cache write (transaction above) → `from_cache: false`; (3) connection-layer error (reqwest send/connect, the AppError::Http class — NOT an HTTP status) → read cache row → `from_cache: true` if present, else the same error; (4) HTTP 401/403 (any non-transient status) → **NEVER fall back to cache** (auth-loss must not serve stale server data) → surface the error; (5) network timeout → treated as connection-layer (arm 3). Frontend guards `Number.isSafeInteger` + domain on depth/limit before invoke (jotty-client SKILL.md i64-boundary law).
- **No new capability grants**: three/rfg are plain npm deps; app-owned custom commands need no ACL entries (capabilities/default.json adds nothing).

**Frontend (src/):**
- Store: `ListMode` gains `'brain'` (store.ts:64); `brainFocusId: string | null` + `setBrainFocus(id)` (sets focus AND `listMode:'brain'` in one set()); wall-swap branch at the agenda arm (App.tsx:292). **Focus reset matrix (audit B3):** `setListMode('brain')` from the drawer/Sidebar → `brainFocusId = null` (global graph); `selectNote`/`selectChecklist`/`selectCategory`/back-button → clear `brainFocusId`; only `setBrainFocus` (header buttons) carries a focus in.
- `BrainView.tsx` (wall branch): fetch (cache-first render → live refresh on success), toolbar, renderer host, inspector, legend. **Render-state matrix (audit B2):** cached `ready` graph shown first (chip ON if computed stale per the invalidation rule); live success with `ready` → overwrites render + cache write, chip off; live `status='building'` → KEEP the cached graph rendered with chip text `· stale data · server indexing` (never overwrite the cache with an empty building graph); no cache + live `building` → "still indexing" notice + manual refresh (upstream renders the same class of state with no polling).
- Toolbar: search (upstream `searchNodes`: substring title, degree sort, cap 8, Enter = select+fly), dimension 2D/3D toggle (3D disabled when the WebGL probe fails; probe + `prefers-reduced-motion`/coarse-pointer auto-2D per upstream useBrainPrefs:40-51), local-scope toggle + depth slider **only when focused** (upstream pattern), per-kind filter chips (notes/checklists/tags/ghosts/suggestions/orphans), colour mode TYPE/CATEGORY, `suggestions` chip **default OFF** (out-of-band from upstream DEFAULT_FILTERS).
- Renderers: `BrainCanvas2D.tsx` (`react-force-graph-2d`: charge -110/dist 500, link distance 42, collide personal-space 5, region+gravity forces — ported constants from BrainCanvas2D.tsx:35-38,95-97 + brain-forces.ts) and `BrainScene3D.tsx` (`react-force-graph-3d`: OrbitControls, sprite-based node objects with raycast-only hit meshes, suggested-edge anchor-visibility, declutter loop, dispose discipline — brain-three.ts). Both `React.lazy` chunks; renderer swap = dimension state. **3D lifecycle on WebKitGTK (audit B5):** the WebGL probe re-runs on EVERY 3D mount (not once per session) and the scene listens for `webglcontextlost` → auto-downgrade to 2D; renderer disposal follows upstream's disposeParts/forgetStamps discipline (textures + rAF loop torn down on unmount/dimension swap). Upstream pointer-slop constants (CLICK_SLOP_PX=6, CLICK_MAX_MS=450) are ported as-is but marked Chromium-derived — the WebKitGTK screenshot pass verifies actual click behavior before release.
- View-model port: `brainView()` filtering (suggestion-inclusive BFS for local reachability even when suggestions render OFF — the upstream subtlety, brain-graph.ts:97-119), colour palettes read CSS vars + theme mutation (useBrainPalette pattern) with token-sweep law (no raw hex).
- Inspector: selected node → linksTo / linkedFrom / suggested (weight%) sections, neighbour quick-pick, Open button (per §5). Ghost/tag nodes: no navigation (Open disabled with a "not written yet"-class label). Nodes NOT present in the local DB (foreign-owner/shared items the client never synced, or tombstoned/deleted rows): rendered but Open disabled with a "not synced" hint (audit B8). No edit/connect actions exist to hide (out-list §6).
- Stale chip: BrainView-local `from_cache`/computed-stale flag renders the `· stale data` span INSIDE BrainView (does NOT touch the global `stalePieces` sync state). **CSS (audit A-F2):** `.sync-stale` is scoped `#sync-badge .sync-stale` today (styles.css:869) — P4 adds an unscoped base rule `.sync-stale { … }` with the `#sync-badge` rule kept for its overrides, so both chips share the visual without BrainView depending on the badge subtree. Encrypted notes: out of scope (v1 non-goal stands) — a graph node whose local row carries encrypted content renders as a normal node; decrypting/serving content is not BrainView's job (audit B8, accepted scope cut).
- `status === 'building'` → honest "still indexing" notice + manual refresh button (upstream renders the same class of state with no polling).
- Prefs persistence (audit B9 moved it INTO P2; resolved Q1): direct `localStorage` via store-init IIFEs — the `themeOverride`/`reduceMotion` precedent (store.ts:96-115, keys `jotty.theme-override`, `jotty.reduce-motion`). New key `jotty.brain-prefs` = upstream's blob shape `{dimension, filters, colourMode, depth}` merged over defaults on init; setter mirrors setThemeOverride's try/catch pattern (storage-unavailable = session-only). jsdom tests ride the existing `src/test/setup.ts` in-memory localStorage shim.
- Entries: drawer Sidebar `sec-toggle`-style Brain row (Sidebar.tsx:20-32 pattern); brain buttons in `NoteEditor` + `ChecklistView`/`KanbanBoard` headers calling `setBrainFocus(uuid)`; new hand-drawn `graph` glyph in the icons.tsx JSX map (hub-and-spoke SVG paths — no runtime icon dep, upstream HugeIcons NOT ported).
- Desktop-only: audit A-F6 correction — there is NO CSS-only desktop-gating precedent; the existing pattern is the reverse (styles.css:1218+ phone block HIDES things at narrow widths, "Desktop is untouched"). BrainView ships inside that convention: the drawer entry + header buttons get narrow-width hides in the phone block (exact selector set pinned in the plan; 412px layout untouched). No userAgent sniffing (audit B-Q2).

## 5. Open-item flow (node → editor)

`node.kind === 'note'` → `selectNote(id)`; `'checklist'` → `selectChecklist(id)` (store.ts:160-166; audit B4's "boards land in the wrong view" was REJECTED on evidence: `ChecklistView` itself branches `listType` kanban/task → `<KanbanBoard>` at ChecklistView.tsx:71+266, so the same id opens the board correctly). `'ghost'`/`'tag'` → Open disabled. Nodes absent from the local DB (tombstoned, foreign-owner, never-synced) → Open disabled with a "not synced" hint.

## 6. Out-list (explicit — nothing here ships in v1)

1. Link editing (`connectItems`-class server actions) — server-authoring, REST surface out of scope.
2. Ghost-create from the inspector (upstream `createNote` server action) — ghosts render; their Open is disabled.
3. Orphans/relations explorer views (`/api/relations/*`, upstream orphans/links pages).
4. Suggestions ON by default — the toolbar chip EXISTS but defaults OFF (deliberate deviation from upstream).
5. Android/mobile support (412px layouts render the exclusion, no tuning).
6. MCP/graph-side anything; server-side changes of any kind.
7. 3D: no custom three effects beyond the upstream-parity feature list above (no new shaders/effects).

## 7. Testing fences (jotty-client skill laws applied — audit A-F3 correction: these live in the jotty-client SKILL.md, NOT in AGENTS.md/docs/superpowers; cite `~/.hermes/skills/software-development/jotty-client/SKILL.md` lines 78/145/162/177)

1. **Envelope law, inverted**: wiremock test pins BrainResponse as TOP-LEVEL (a `{"data": {...}}`-shaped mock must FAIL the parser — fence the absence-of-envelope explicitly, mirroring the client.rs:113-116 counter-example).
2. **DTO key-set law**: wire-key fences compare a sorted key SET of the parsed DTO (serde_json maps iterate sorted).
3. **Cache fences**: snapshot write-on-success only + bounded trim (30 rows) inside the single write transaction; corrupted/truncated JSON row → treated as absent; same canonical cache_key across param ORDER permutations AND uuid case variants (cache-key canonicalization test); auth-error (401/403) does NOT fall back to cache (new arm-4 test); offline (connection-layer) fallback returns `from_cache: true` + stale payload byte-identical; staleness computation flags snapshots older than the newest outbox op / last pull at the DTO level.
4. **jsdom blindness**: both renderers = structural fences ONLY (component mount w/ stubbed canvas, callback wiring, 3D-disabled-when-no-WebGL path, the dimension-toggle lazy swap pinned as: toggling `dimension` unmounts one lazy branch and mounts the other, both wrapped in Suspense fallbacks — audit B6). The REAL layout fence = the headless WebKitGTK dist probe screenshot pass at 1280 + 412 (vision-verify stills) BEFORE the gate question — covers: 2D graph render, stale chip, desktop exclusion, dark-theme palette, inspector open, and the 3D path (3D-fallback message and/or rendered scene; audit B5-F6).
5. **i64/u32 boundary law**: every numeric command arg passes the `Number.isSafeInteger` + domain guard (depth 1..3, limit 1..200) on a Math.trunc'd const.
6. **brainView port**: unit tests seeded-deterministic (no rAF — the port is pure), each filter flag + the suggestion-inclusive BFS subtlety + orphan-except-focus + focused/global scope math vs upstream fixtures.
7. **Timer/loop hygiene**: renderer tests carry the rAF/interval cleanup discipline (upstream's per-frame declutter loops are the leak class the repo has hit before); disposal on unmount/dimension swap is itself fenced (parts map emptied, texture cache dropped).
8. **Palette fence**: no inline `style="color:#…"` raw-hex strings anywhere in BrainView render output (token sweep); colors come from computed CSS vars only (audit B6 — WebKitGTK dark-theme screenshot is the real verify).
9. **Lazy-chunk prod smoke (audit B7)**: after `npx tauri build`, needle-check the dist manifest references the lazy chunk files and they exist (the stale-dist lesson generalizes: a green build proves nothing about what the webview loads if the chunk 404s).
10. Standing gates: full vitest + tsc + cargo test --lib + census 18 Δ0 (re-run; counts re-measured at implementation time).

## 8. Roadmap (SDD-ready — single feature, 4 task slices; audit B9/B6-amended order)

- [ ] **P1 — Data layer:** wiremock-pinned DTO + fetch_brain + v7 snapshot table (canonicalization/trim/tx) + brain_fetch command + fetch result matrix + offline/cache fallback + staleness computation (Rust + fences 1-3,5).
- [ ] **P2 — Frontend core (incl. prefs, audit B9):** store 'brain' mode + brainFocusId + reset matrix + wall branch + BrainView shell + toolbar + **prefs persistence (jotty.brain-prefs)** + 2D renderer + brainView port + render-state matrix (+ fences 4-structural,6,8).
- [ ] **P3 — 3D + fallback:** lazy BrainScene3D + WebGL re-probe on 3D mount + webglcontextlost downgrade + auto-2D guard + renderer swap + disposal fences (fence 7).
- [ ] **P4 — Chrome + entries:** inspector + legend + stale chip (generic .sync-stale base rule) + drawer/header entries + phone-block exclusion + api.ts wrapper polish + WebKitGTK screenshot pass (all stills) + lazy-chunk prod smoke (fences 4,9).

Each phase ships per the standing staged platform release order (APK → Linux → Windows) **when it rides a release**; Android exclusion here means the phone keeps its current build until the follow-up ride-along.

## 9. KPIs

1. The graph opens for any item ≤2 taps from the editor (header button → focused graph).
2. Offline never lies: cached graph always carries the stale chip; no-cache offline = honest empty state.
3. Zero raw-colour leaks (token sweep) and zero new capability grants.

## Appendix — Provenance + audit trail

- **Live probes (2026-10-20, dev 1.28.0 container):** GET /api/brain with x-api-key → 200, `{status:"ready", nodes:[], edges:[], total:0, truncated:false}` (fresh fixture); route source `/app/app/api/brain/route.ts` (getBrain, neighbourhoodFor); schema bounds depth 2/3, limit 60/200 (consts-relations.ts:61-64). Audit A re-probed independently: 200 top-level shape + depth=5 → 400 + invalid focus → 404.
- **Upstream dissection** (kimi-k2.7-code:cloud leaf → `/tmp/brain-kimi/upstream-parity.md`, 398 lines): react-force-graph-2d ^1.29.1 / -3d 1.29.1 / three 0.186.1 (package.json:81-82,99); force constants; WebGL probe gating; brainView BFS subtlety; inspector sections; connect/createNote = server actions (verify-before-accept: every load-bearing claim re-checked by the controller against the extracted sources — package.json, imports, brain-view math, searchNodes cap, edge schema weight/total/truncated).
- **Client integration** (controller probes after the kimi client-map leaf looped at 2h and was killed — its partial log was discarded, ALL §4 facts re-derived directly): store.ts:64/96-115/160-205, App.tsx:281-292, Sidebar.tsx:20-32, SyncBadge.tsx:15-33 + styles.css:869, commands/mod.rs:1085-1101, state.rs:13, keys.rs:81-88, migrations.rs v1-v6 pattern, capabilities/default.json, icons.tsx JSX map, ChecklistView.tsx:71+266 (kanban branch).
- **Cold audits (2026-10-20, kimi-k2.7-code:cloud, controller-verified before adoption):**
  - Audit A — fact/citation (`/tmp/brain-kimi/audit-facts.md`): 6 findings (0C/3I/3M), ALL ACCEPTED: F1 state.rs field is :13 not :70; F2 .sync-stale is #sync-badge-scoped (generic base rule required); F3 laws live in jotty-client SKILL.md not repo docs; F4 Sidebar range 20-32; F5 store range 160-166; F6 no desktop-gating precedent (phone-hide convention). 3 questions resolved inline (prefs home = localStorage IIFE pattern; icon = hand-drawn graph glyph; stale chip = shared base rule).
  - Audit B — design-risk (`/tmp/brain-kimi/audit-design.md`): 10 leads, findings F1-F10. ACCEPTED: F1 cache underspecification (canonicalization helper + 30-row trim + single-tx write + read-time JSON guard); F2 building/status + auth-loss matrix (401/403 NEVER serve cache); F3 brainFocusId reset matrix; F5 WebGL re-probe on 3D mount + webglcontextlost downgrade + pointer-slop caveat; F6-expanded fence list (dark-theme palette, lazy-Suspense swap assertion, 3D screenshot path); F9 prefs persistence moved into P2; F10 cache staleness computed from outbox/last-pull timestamps (no destructive invalidation). REJECTED with evidence: **F4** ("selectChecklist opens simple-list, kanban degrades") — FALSE: ChecklistView.tsx:71+266 branches listType kanban/task to `<KanbanBoard>`, the board opens correctly via the same selector (the finding's own premise misread the wall). ACCEPTED as scoped cuts (B8): foreign-owner/never-synced nodes render with Open disabled + "not synced" hint; encrypted notes stay a v1 non-goal. Q3 (suggestions-OFF vs BFS coherence): the upstream semantic is kept verbatim — local-scope reachability may include suggestion-connected nodes whose edges only DRAW when the chip is ON; accepted as-is (parity).