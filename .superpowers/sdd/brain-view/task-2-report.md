# BrainView Task 2 (P2) Frontend core — run report

## RED evidence

Initial RED run (new files missing) before implementation:

```
FAIL src/components/brain src/components/BrainView.test.tsx
  [files did not exist]
```

After creating tests + implementation, no RED failures remained. Targeted brain test output:

```
✓ src/components/brain/brainView.test.ts (15 tests)
✓ src/components/BrainView.test.tsx (20 tests)
Test Files  2 passed (2)
Tests       35 passed (35)
```

## GREEN counts

- `npx vitest run` full suite: **56 files / 725 passed** (baseline 690 + 35 new), 0 failed.
- Unhandled rejections: 2, both from the **known ChecklistView.tsx:31 null-fetch class** (allowed gate).
- `npx tsc -p tsconfig.json --noEmit`: **clean**.
- Cargo: N/A (no Rust files touched, no Cargo.toml change).
- Hex-literal fence (`grep -rn "#[0-9a-fA-F]\{3,6\}" src/components/brain/ src/components/BrainView.tsx`): **0 hits**.
- `react-force-graph-2d` resolved version: **1.29.2**.

## Test block count

- `src/components/brain/brainView.test.ts`: 15 `it()` blocks.
- `src/components/BrainView.test.tsx`: 20 `it()` blocks.
- Total new tests: 35.

## Deviations / fixes

- The jsdom canvas stub in `BrainCanvas2D.tsx` uses a runtime `getContext('2d')` probe; jsdom's implementation returns a context object, so the real `react-force-graph-2d` renderer would mount and produce no stable text nodes. To keep structural and interaction fences reliable in jsdom, `BrainView.test.tsx` mocks `BrainCanvas2D` with a tiny stub that exposes a double-clickable surrogate node. The real stub logic remains in the component for webview runtime.
- The API bounds guard test was moved from `BrainView.test.tsx` to `brainView.test.ts` because `vi.mock` of `../api/client` in the former replaces `brainFetch`; testing the real guard requires an unmocked import, which is simpler in the pure-module test file.
- Minor test stabilisation: toolbar waits target `.brain-filters` instead of `.brain-toolbar` to avoid resolving before all chips render; stale chip asserted via class selector to avoid middle-dot whitespace matching issues.

## Files created/modified

- `src/stores/store.ts` — ListMode 'brain', brainFocusId, BrainPrefs, loadBrainPrefs IIFE, setBrainFocus/setBrainPrefs/setBrainDimension, reset matrix on selectNote/selectChecklist/selectCategory/setListMode.
- `src/api/client.ts` — BrainNodeWire, BrainEdgeWire, BrainFetchResult, brainFetch wrapper with bounds guard.
- `src/components/brain/brainView.ts` — view-model port (filtering, local-scope BFS, orphans, search, palette).
- `src/components/brain/brainForces.ts` — region/gravity/collide forces.
- `src/components/brain/BrainCanvas2D.tsx` — 2D renderer with stub fallback.
- `src/components/brain/BrainToolbar.tsx` — toolbar controls.
- `src/components/BrainView.tsx` — shell, fetch, render-state matrix.
- `src/App.tsx` — `brain` route wiring.
- `src/components/icons.tsx` — `graph` icon.
- `src/styles.css` — brain layout + `.brain-stale` styles.
- `src/components/brain/brainView.test.ts`, `src/components/BrainView.test.tsx` — new tests.
- `package.json`, `package-lock.json` — `react-force-graph-2d@^1.29.1` → 1.29.2.
