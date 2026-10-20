# BrainView Implementation Plan

> **For Hermes:** Use subagent-driven-development to implement this plan task-by-task. Each task dispatches a leaf in its own git worktree; the controller merges on green. Specs live in `docs/superpowers/specs/2026-10-20-brain-view-design.md` (v1.1, commit ead57d2) — binding.

**Goal:** Surface jotty's Brain (link map) in the desktop client: 2D+3D graph, focused or global, online or cached-offline, zero server changes.

**Architecture:** REST `GET /api/brain` → Rust `fetch_brain` (DTO, TOP-LEVEL envelope) → v7 snapshot cache (canonicalized key, 30-row trim, one-transaction write, computed staleness) → `brain_fetch` command with a 5-arm result matrix → frontend `BrainView` (store 'brain' mode, lazy 2D/3D renderers, toolbar/inspector/legend, stale chip) reached from drawer + note/checklist headers.

**Tech Stack:** Tauri 2 (Rust), React+TS+Vite, zustand, wiremock (Rust tests), jsdom/vitest, NEW deps: `react-force-graph-2d` ^1.29.1 + `react-force-graph-3d` 1.29.1 + `three` 0.186.1 (lazy chunks).

**Baselines at plan authoring (2026-10-20, re-measure at dispatch):** vitest 690/690 (+2 known unhandled rejections of the ONE ChecklistView null-fetch class — class-identity gate, not count), tsc clean, cargo test --lib 304-ish + 1i (re-measure), census 18 Δ0.

**Standing laws:** ship order applies only at release time; every gate routes full output to a file (grep, never head/tail); `--manifest-path src-tauri/Cargo.toml` on every cargo call; NO `cargo fmt`; repo-local identity `git -c user.name=zeus -c user.email=zeus@local` on EVERY commit/amend (PLACEMENT: before the subcommand); new test imports function-local; census Δ0; JS asserts carry NO message args; Rust asserts DO.

---

### Task 1 (P1) — Rust data layer: DTOs, fetch_brain, v7 cache, brain_fetch

**Files:**
- Modify: `src-tauri/src/jotty/client.rs` (fetch_brain + DTOs + cache_key helper live here or a sibling `brain.rs` module under `src-tauri/src/jotty/`)
- Modify: `src-tauri/src/db/migrations.rs` (append v7)
- Modify: `src-tauri/src/commands/mod.rs` (brain_fetch command + register in `lib.rs:158` generate_handler)
- Test: `src-tauri/src/jotty/brain.rs` #[cfg(test)] mod + wiremock tests (repo pattern: wiremock at client.rs:514+)

**Interfaces (binding):**
- `BrainQuery { focus: Option<String>, depth: u32, limit: u32, suggestions: bool }` + `Default` (depth 2, limit 60, suggestions false).
- `BrainNode { id, kind, title, category: Option<String>, owner: Option<String>, links: u64, distance: Option<u64>, tags: Option<Vec<String>> }`, `BrainEdge { source, target, kind, weight: f64 }`, `BrainResponse { status: String, focus: Option<String>, nodes: Vec<BrainNode>, edges: Vec<BrainEdge>, total: u64, truncated: bool }` — all `#[serde(rename_all = "camelCase")]`, kind fields plain String (wire enums validated by value: "note"|"checklist"|"ghost"|"tag"; edges additionally "suggested"|"tag" kinds).
- `pub fn brain_cache_key(q: &BrainQuery) -> String` → `format!("depth={}&focus={}&limit={}&suggestions={}", depth, focus.unwrap_or_default().to_lowercase(), limit, suggestions)` (fixed order, NO url-encoding).
- `pub async fn fetch_brain(&self, q: &BrainQuery) -> AppResult<BrainResponse>` — `self.api_get::<BrainResponse>(path_with_query)`; TOP-LEVEL parse (NO envelope index — the get_notes `v["notes"]` shape is the COUNTER-example).
- Cache: `brain_snapshot_write(conn, cache_key, &BrainResponse) -> AppResult<()>` = ONE transaction: INSERT OR REPLACE + trim `DELETE FROM brain_snapshots WHERE cache_key NOT IN (SELECT cache_key FROM brain_snapshots ORDER BY fetched_at DESC LIMIT 30)`; `fetched_at` = RFC3339 UTC now.
- `brain_snapshot_read(conn, cache_key) -> AppResult<Option<BrainResponse>>` — serde parse failure or row absent → `Ok(None)` (read-time guard; truncated JSON class).
- Command `brain_fetch(query: BrainQuery, app: AppHandle, state: State<'_, AppState>) -> AppResult<BrainFetchResult>`; `BrainFetchResult { graph: BrainResponse, fetched_at: String, from_cache: bool, stale: bool }` (camelCase serialize). Arms (spec §4 matrix):
  1. `state.client.read().await` is None → `Err(AppError::InvalidConfig("not connected"))`.
  2. live fetch OK → cache write txn → `from_cache:false`, `stale:false`.
  3. reqwest connection-layer error (`AppError::Http`) → read cache: Some → `from_cache:true` + `stale` computed; None → propagate error.
  4. HTTP status 401/403 (any non-transient status error) → propagate error, NO cache read.
  5. `stale` = cache `fetched_at` < (a) newest `created_at` in `outbox` table, OR (b) `sync_state.last_pull_at` (read both; use max) — `stale:true` when either outranks the snapshot. Verify the actual column names against the v1/v2 schema before writing (outbox: `created_at` exists since v1; sync_state read via the existing helper pattern in `sync/`).
- Classification: inspect the error type from `fetch_brain` — reqwest URL/connection failures surface as `AppError::Http` (error.rs), status errors as `AppError::Api { status, body }`. Use `matches!` on the AppError variant, never string matching.
- Command registration: add `brain_fetch` (snake_case) to the generate_handler list at lib.rs:158.

**Steps (TDD):**
1. RED: wiremock tests (a) TOP-LEVEL envelope parse green-shape — mock GET `/api/brain?depth=2&focus=&limit=60&suggestions=false` returning the live-probe JSON; assert full DTO key-set (sorted) + values; (b) inverted-envelope fence — mock `{"data": {status...}}` MUST fail parse (fetch_brain returns Err, kind parse/missing-field); (c) query string sent = the canonical cache_key order + lowercase focus (case-variant input SAME key); (d) cache write→read round-trip incl. trim over 31 rows (oldest evicted); (e) cache read of corrupt JSON → None; (f) command arms: 2 (live OK), 3 (wiremock down → cache served `from_cache:true`), 4 (status 401 → Err, cache NOT consulted — assert cache row unchanged), 5 (stale flag when an outbox op's created_at > fetched_at + when last_pull_at > fetched_at + false when neither).
2. GREEN minimally. 3. Full `cargo test --lib` → expected = baseline + new tests (count: grep `#[test]`/`#[tokio::test]` in the new mod; measure, never estimate — dispatch re-measures). 4. Census `cargo check --all-targets 2>&1 | grep -c '^warning'` = 18 Δ0. 5. Commit `feat(brain): fetch_brain + v7 snapshot cache + brain_fetch command`.

**Migration v7 (exact):**
```sql
CREATE TABLE brain_snapshots (
    cache_key TEXT PRIMARY KEY,
    response_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
);
```
Appended as `// v7 — BrainView link-map snapshots (2026-10-20).` batch entry; ADDITIVE.

**JS invocation shape (for Task 2's api.ts):** `invoke('brain_fetch', { query: { focus: 'uuid'|null, depth: 2, limit: 60, suggestions: false } })` → `{ graph, fetchedAt, fromCache, stale }` (camelCase on the wire).

---

### Task 2 (P2) — Frontend core: store, wall branch, BrainView shell + toolbar + prefs, 2D renderer, brainView port

**Files:**
- Modify: `src/stores/store.ts` (ListMode + brainFocusId + setBrainFocus + reset matrix + brain-prefs IIFEs + setters)
- Modify: `src/App.tsx` (brain branch insertion after the agenda arm)
- Create: `src/components/BrainView.tsx`, `src/components/brain/BrainToolbar.tsx`, `src/components/brain/brainView.ts` (port of upstream brain-graph filtering — plain functions), `src/components/brain/BrainCanvas2D.tsx`
- Modify: `src/api.ts` (brainFetch wrapper per Task 1's invocation shape; `Number.isSafeInteger` + domain guard on depth/limit — trunc'd consts, depth 1..3, limit 1..200)
- Modify: `package.json`/`npm install react-force-graph-2d@^1.29.1` (ONLY the 2D dep this task)
- Create: `src/components/brain/BrainView.test.tsx` (+ brainView.test.ts)
- Icons: `graph` glyph entry in `src/components/icons.tsx` (hand-drawn hub-and-spoke paths)

**Binding details:**
- Store: `ListMode = 'notes' | 'checklists' | 'agenda' | 'brain'`; `brainFocusId: string | null`; `setBrainFocus(id)` sets `{ brainFocusId: id, listMode: 'brain', selectedNoteId: null, selectedChecklistId: null }` in ONE set; `setListMode('brain')` → `brainFocusId: null`; `selectNote`/`selectChecklist`/`selectCategory`/back → clear `brainFocusId` (add `brainFocusId: null` into their existing set calls).
- Prefs: key `jotty.brain-prefs`, JSON `{dimension:'2d'|'3d', filters:{notes,checklists,tags,ghosts,suggestions,orphans}, colourMode:'type'|'category', depth:number}` stored UNDERSCORE-free (camelCase blob, upstream shape); init-IIFE reads + merges over defaults `{dimension:'2d', filters:{notes:true,checklists:true,tags:false,ghosts:true,suggestions:false,orphans:true}, colourMode:'type', depth:2}` (suggestions default FALSE — deliberate deviation); `setBrainPrefs(patch)` setter mirrors setThemeOverride try/catch. Note: upstream's ` BrainDimensions.TWO_D = "2d"`, `THREE_D = "3d"`.
- brainView port (pure, from /tmp/brain-src/ui/utils/brain-graph.ts:89-121): edge filter by suggestions/tags flags; adjacency neighbour map (suggestion-inclusive variant for BFS); local-scope `_within(focus, neighbourMap(edges,true), scope.depth)`; kind filter (KIND_FILTER note→notes, checklist→checklists, tag→tags, ghost→ghosts); orphans-drop-except-focus; kept-set edge projection. Types: `BrainVMNode {id, kind, title, category?, links, distance?}` — map from BrainNode wire DTO; `degree` upstream == wire `links`.
- Toolbar: scope toggle + depth slider ONLY when focusId (upstream); dimension select (2D enabled always; 3D disabled this task — Task 3 wires it); filter chips; colour mode select; suggestions chip default OFF; search box with `searchNodes` (substring title, sort by links desc, cap 8, Enter → select+fly-2D).
- Render-state matrix (spec §4): invoke via api.brainFetch on mount and when `focusId`/scope/depth/suggestions/limit change (query re-fetch on parameter change); cache-first render = render `graph` state immediately from invoke result (the Rust command already implements the cache-vs-live matrix — the frontend ONLY renders what arrives: `{graph, fromCache, stale}`); chip ON when `fromCache || stale`; `status==='building'` + zero nodes → indexing notice + refresh button; `status==='ready'` + zero nodes → honest empty state; fetch error → error notice (no silent empty).
- 2D renderer: container div + `useElementSize`-style ResizeObserver hook (port exists upstream; write ~15-line hook); `ForceGraph2D` with the upstream constants (charge force strength -110 distanceMax 500, link distance 42, collide radius nodeRadius+5, regionForce 0.05, gravityForce 0.012, cooldownTicks 120, FOCUS_ZOOM 3, FLY_MS 1100, FIT_PADDING 120, DIM_ALPHA 0.15, HUB_LABELS 10, CLICK_SLOP_PX 6, CLICK_MAX_MS 450, DOUBLE_CLICK_MS 350); `nodeCanvasObject` = paintStamp port (circle + glyph letter by kind) with lit/dim via neighbour set; labels pass = top-N hubs + anchor (collision-skipped pill labels); suggested edges shown only touching anchor, dashed [3,3]; node click → select (single) / open (dblclick + right-click); pan/zoom from the lib.
- jsdom fences (structural): mount renders container + toolbar; brainView unit tests (each filter flag, BFS subtlety, orphan-except-focus, scope math, searchNodes cap 8 + sort); api.ts guards (truncate/out-of-domain rejects); store reset matrix (each action clears/keeps brainFocusId per matrix); prefs IIFE round-trip + merge-over-defaults + corrupt-JSON → defaults; toolbar renders depth slider only when focused (RTL conditional).
- NO raw hex colors: node/edge colors from CSS vars via `getComputedStyle`-read helper (theme-reactive), inline-style fence (fence 8).

**Steps:** RED (new test files, run filtered vitest) → GREEN → `npx vitest run` FULL (expected = 690 + new; grep the added `it(`/`test(` count and re-derive — STOP on unexplained delta beyond the 2 known rejection class) → `npx tsc -p tsconfig.json --noEmit` → cargo test --lib untouched (no Rust change; if you touched none, census N/A) → commit `feat(brain): BrainView shell + toolbar + prefs + 2D renderer + brainView port`.

---

### Task 3 (P3) — 3D renderer + fallback (lazy chunk, re-probe, contextlost)

**Files:**
- Create: `src/components/brain/BrainScene3D.tsx`, `src/components/brain/brainThree.ts` (sprite/glyph/dispose port)
- Modify: `src/components/BrainView.tsx` (dimension swap via React.lazy + Suspense fallback; WebGL re-probe hook)
- Modify: `package.json` (`npm install react-force-graph-3d@1.29.1 three@0.186.1` + `@types/three`)
- Test: extend BrainView.test.tsx + new BrainScene3D structural tests

**Binding details:**
- Renderer swap: `React.lazy(() => import('./brain/BrainScene3D'))` and 2D likewise lazy; `<Suspense fallback={<div className="brain-loading"/>}>` around the active branch; toggling `dimension` swaps the branch (STRUCTURAL FENCE: assert the swap unmounts one and mounts the other, both have a fallback).
- WebGL probe hook: probe runs on EVERY 3D branch mount (`_webgl()` port: canvas.getContext('webgl2') || 'webgl' in try/catch); `webglcontextlost` listener on the 3D canvas → clear dimension to '2d' + persist pref. 3D toolbar button disabled when probe fails (upstream parity); `prefers-reduced-motion`/coarse-pointer → auto-2D unless stored pref says 3d (upstream useBrainPrefs:49-51).
- Scene port: ForceGraph3D background transparent, controlType "orbit", warmupTicks 60, cooldownTicks 160, linkOpacity 0.85, suggested-curvature 0.25, particles 2 on lit non-tag edges, anchor-only suggested visibility; node Three object = Group{Sprite(CanvasTexture stamp), hit Mesh(SphereGeometry, raycast-only), halo sprite, label sprite}; declutter every 6 frames (hub cap min(8, ceil(n/8))); frameGraph clamp 140..1600 FRAME_MS 900; auto-rotate after 25s idle, speed 0.35, pause on pointer; dispose: cancel rAF, disposeParts, forgetStamps.
- Structural tests only (jsdom): probe-failure → 3D button disabled + 2D enforced; contextlost simulation (fire the listener) → dimension state flips 2d + pref persisted; lazy import mocked (`vi.mock('./brain/BrainScene3D')` or dynamic-import mock) — swap assertion; disposal fences (parts map emptied fn called on unmount).
- Steps: RED → GREEN → FULL vitest (count arithmetic) → tsc → census UNCHANGED (npm dep bump: re-run cargo check census anyway) → commit `feat(brain): lazy 3D scene + WebGL re-probe + contextlost fallback`.

---

### Task 4 (P4) — Chrome + entries + exclusion + prod smoke

**Files:**
- Create: `src/components/brain/BrainInspector.tsx`, `src/components/brain/BrainLegend.tsx`
- Modify: `src/components/NoteEditor.tsx`, `src/components/ChecklistView.tsx` (header brain buttons — ChecklistView covers boards via its existing header; do NOT also add to KanbanBoard header if ChecklistView's header hosts it — verify at implementation, one button per surface)
- Modify: `src/components/Sidebar.tsx` (Brain row)
- Modify: `src/styles.css` (generic `.sync-stale` base rule — keep `#sync-badge .sync-stale` overrides; brain view layout classes; phone-block hides: drawer Brain row + header brain buttons `display:none` at the 412px breakpoint)
- Create/extend tests: BrainInspector.test.tsx + entry-button tests (existing header test files extended)

**Binding details:**
- Inspector: linksTo (non-suggested out-edges), linkedFrom (in-edges), suggested (weight%, desc) sections; neighbour quick-pick (click → select that node); Open button per spec §5 (disabled states: ghost/tag "not written yet", not-in-local-DB "not synced"); "lonely" empty variant.
- Open: `selectNote(id)` / `selectChecklist(id)` — ChecklistView already branches kanban/task to KanbanBoard (ChecklistView.tsx:71+266) — no board-specific path. Open only fires when the local row EXISTS (check via store's loaded state; else disabled hint).
- Legend: totals (nodes, link-kind edges via LINK_EDGE_KINDS set, shown count) + 6 edge-kind swatches from edgeColour (palette-derived).
- Entries: drawer Brain row → `setListMode('brain')` (auto global graph via reset matrix); NoteEditor header + ChecklistView header brain button → `setBrainFocus(id)` (note.id / checklist.id); icons.tsx `graph` glyph from Task 2 (if Task 2 didn't add it, this task does — one owner, decided at dispatch).
- CSS: unscoped `.sync-stale { color: var(--amber); opacity: 0.85; }` (base) with existing `#sync-badge .sync-stale` kept (it adds max-width/ellipsis — keep those scoped there OR move to base if harmless for brain chip: DECIDE at implementation, disclose); phone-block hides added INSIDE the `@media (max-width: 700px)` section.
- Prod smoke (gate, controller-runnable): after `npx tauri build` (or at release build time), `dist/assets` needle-check: lazy chunk files exist and are referenced. This task RUNS vitest/tsc/gates only; the build smoke rides the ship procedure.
- Steps: RED → GREEN → FULL vitest + tsc → census Δ0 (CSS/test-only Rust untouched; still re-run) → commit `feat(brain): inspector, legend, entries, mobile exclusion, shared stale chip`.

---

### Task 5 — Whole-feature close-out (controller + one reviewer)

- Controller: merge all task branches (serialize Task1→2→3→4; rebase worktrees as needed), run FULL gates (vitest, tsc, cargo test --lib, census), WebKitGTK screenshot pass at 1280 + 412: 2D graph, stale chip, excluded entries, dark theme palette, inspector open, 3D-or-fallback (headless-ux-probe recipe, references/headless-ux-probe.md) — vision-verify stills.
- Reviewer dispatch (delegate_task or kimi): whole-branch review-package diff, charged with: cross-task seams (store reset matrix vs header buttons vs back button; chip CSS scoping; lazy chunks in dist), spec §-coverage spot checks, fence-claim verification, deferred-minor triage. Ship verdict.
- Ledger updates: jotty-client skill status + memory; release only on user ask (staged order when asked).

---

## Dispatch notes

- Worktrees: `git worktree add /tmp/wt-brain-pN main` per task; `npm ci` once per fresh worktree (esbuild policy warning harmless); shared `CARGO_TARGET_DIR=/tmp/brain-target` for Rust tasks (first gate pays compile).
- Leaf model: kimi-k2.7-code:cloud via `hermes chat --query-file <brief> --oneshot -m kimi-k2.7-code:cloud` (worktree cwd), report file in the worktree's `.superpowers/sdd/brain-view/` (gitignored area), final line `DONE <sha> <gates>` / `STOP <delta>`; gates = STOP-on-mismatch contract.
- Every brief carries: binding Interfaces verbatim, test fences, gate arithmetic (ledger baseline + counted fences), known-noise exclusions (2-rejection ChecklistView class; census baseline), the byte-census boundary convention (incl. trailing NL), and the AGENTS.md write-guard (never touch it).
- Task 2's BrainCanvas2D constants are PORTED from upstream (audit-verified) — briefs quote them verbatim; upstream sources readable at /tmp/brain-src/ during dispatch (read-only).