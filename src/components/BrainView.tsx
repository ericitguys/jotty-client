import { useEffect, useMemo, useRef, useState, Suspense, lazy, useCallback } from 'react';
import { useStore } from '../stores/store';
import type { BrainPrefs, BrainFilterFlags } from '../stores/store';
import { brainFetch } from '../api/client';
import type { BrainFetchResult, BrainNodeWire, BrainEdgeWire } from '../api/client';
import BrainToolbar from './brain/BrainToolbar';
import BrainInspector from './brain/BrainInspector';
import BrainLegend from './brain/BrainLegend';
import { probeWebGL } from './brain/useWebGLProbe';
import { brainView, useBrainPalette, searchNodes } from './brain/brainView';

interface Props {
  focusId?: string | null;
}

const LazyBrainCanvas2D = lazy(() => import('./brain/BrainCanvas2D'));
const LazyBrainScene3D = lazy(() => import('./brain/BrainScene3D'));

function nodeToVM(n: BrainNodeWire): { id: string; kind: string; title: string; category?: string | null; links: number; distance?: number | null } {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    category: n.category ?? null,
    links: n.links,
    distance: n.distance ?? null,
  };
}

function edgeToVM(e: BrainEdgeWire): { source: string; target: string; kind: string; weight: number } {
  return {
    source: e.source,
    target: e.target,
    kind: e.kind,
    weight: e.weight ?? 0,
  };
}

export default function BrainView({ focusId }: Props) {
  const storeFocusId = useStore((s: { brainFocusId: string | null }) => s.brainFocusId);
  const prefs = useStore((s: { brainPrefs: BrainPrefs }) => s.brainPrefs);
  const setBrainPrefs = useStore((s: { setBrainPrefs: (patch: Partial<BrainPrefs>) => void }) => s.setBrainPrefs);
  const setBrainDimension = useStore((s: { setBrainDimension: (d: '2d' | '3d') => void }) => s.setBrainDimension);
  const selectNote = useStore((s: { selectNote: (id: string | null) => void }) => s.selectNote);
  const selectChecklist = useStore((s: { selectChecklist: (id: string | null) => void }) => s.selectChecklist);
  const notes = useStore((s: { notes: { id: string }[] }) => s.notes);
  const checklists = useStore((s: { checklists: { id: string }[] }) => s.checklists);

  const activeFocusId = focusId ?? storeFocusId;
  const prefersFlat =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    (window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const runtimeDimension: '2d' | '3d' =
    prefersFlat && prefs.dimension === '3d' ? '2d' : prefs.dimension;
  const webglOk = useMemo(() => probeWebGL(), [runtimeDimension]);
  const [data, setData] = useState<BrainFetchResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flyTo, setFlyTo] = useState<{ id: string; at: number } | null>(null);
  const seqRef = useRef(0);

  const [scopeLocal, setScopeLocal] = useState(!!activeFocusId);
  const scope = { local: scopeLocal, depth: prefs.depth };
  const query = {
    focus: activeFocusId,
    depth: Math.min(Math.max(prefs.depth, 1), 3),
    limit: 60,
    suggestions: prefs.filters.suggestions,
  };

  const palette = useBrainPalette();

  useEffect(() => {
    const seq = ++seqRef.current;
    setError(null);
    brainFetch(query)
      .then((result: BrainFetchResult) => {
        if (seq !== seqRef.current) return;
        setData(result);
      })
      .catch((err: Error) => {
        if (seq !== seqRef.current) return;
        setError(err);
      });
  }, [activeFocusId, prefs.filters.suggestions, prefs.depth]);

  const graph = data?.graph ?? { status: 'ready', focus: null, nodes: [], edges: [], total: 0, truncated: false };
  const vm = brainView(
    graph.nodes.map(nodeToVM),
    graph.edges.map(edgeToVM),
    prefs.filters,
    scope,
    activeFocusId,
  );

  const handleRefresh = () => {
    seqRef.current += 1;
    const seq = seqRef.current;
    setError(null);
    brainFetch(query)
      .then((result: BrainFetchResult) => {
        if (seq !== seqRef.current) return;
        setData(result);
      })
      .catch((err: Error) => {
        if (seq !== seqRef.current) return;
        setError(err);
      });
  };

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const attachedRef = useRef<HTMLCanvasElement | null>(null);
  const observerRef = useRef<MutationObserver | null>(null);
  const runtimeDimensionRef = useRef(runtimeDimension);
  const handleLostRef = useRef(() => setBrainDimension('2d'));
  runtimeDimensionRef.current = runtimeDimension;
  handleLostRef.current = () => setBrainDimension('2d');

  const attachContextLost = useCallback(() => {
    const el = canvasRef.current;
    if (!el || runtimeDimensionRef.current !== '3d') return;
    const canvas = el.querySelector('canvas');
    if (!canvas || canvas === attachedRef.current) return;
    if (attachedRef.current) {
      attachedRef.current.removeEventListener('webglcontextlost', handleLostRef.current);
    }
    attachedRef.current = canvas as HTMLCanvasElement;
    canvas.addEventListener('webglcontextlost', handleLostRef.current);
  }, []);

  useEffect(() => {
    attachContextLost();
  }, [runtimeDimension, attachContextLost]);

  const setCanvasContainer = useCallback((el: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (attachedRef.current) {
      attachedRef.current.removeEventListener('webglcontextlost', handleLostRef.current);
      attachedRef.current = null;
    }
    canvasRef.current = el;
    if (!el || typeof MutationObserver === 'undefined') return;
    attachContextLost();
    observerRef.current = new MutationObserver(attachContextLost);
    observerRef.current.observe(el, { childList: true, subtree: true });
  }, [attachContextLost]);

  const handleSelect = (id: string | null) => {
    setSelectedId(id);
  };

  const handleOpen = (node: { id: string; kind: string }) => {
    if (node.kind === 'note' && notes.some((n: { id: string }) => n.id === node.id)) {
      selectNote(node.id);
    } else if (node.kind === 'checklist' && checklists.some((c: { id: string }) => c.id === node.id)) {
      selectChecklist(node.id);
    }
  };

  const handleSearchPick = (id: string) => {
    setSelectedId(id);
    setFlyTo({ id, at: Date.now() });
  };

  const selectedNode = useMemo(() => vm.nodes.find((n) => n.id === selectedId) ?? null, [vm.nodes, selectedId]);

  const resolveTitle = useCallback(
    (id: string): { title: string; kind: string } | null => {
      const found = graph.nodes.find((n) => n.id === id);
      if (!found) return null;
      return { title: found.title, kind: found.kind };
    },
    [graph.nodes],
  );

  const canOpen = useCallback(
    (node: { id: string; kind: string }) => {
      if (node.kind !== 'note' && node.kind !== 'checklist') return false;
      if (node.kind === 'note') return notes.some((n) => n.id === node.id);
      return checklists.some((c) => c.id === node.id);
    },
    [notes, checklists],
  );

  const handleInspectorPick = (id: string) => {
    setSelectedId(id);
  };

  const handleInspectorClose = () => {
    setSelectedId(null);
  };

  const handleInspectorOpen = (node: { id: string; kind: string }) => {
    handleOpen(node);
  };

  const chipText = '· stale data';
  const showStale = !!data && (data.fromCache || data.stale);

  return (
    <div id="brain" className="brain-view">
      <div className="brain-head">
        <span id="brain-title">Brain</span>
        {showStale && <span className="brain-stale">{chipText}</span>}
      </div>

      {error && (
        <div className="brain-error">Brain unavailable</div>
      )}

      {!error && graph.status === 'building' && graph.nodes.length === 0 && (
        <div className="brain-indexing">
          Still indexing links…
          <button onClick={handleRefresh}>Refresh</button>
        </div>
      )}

      {!error && graph.status === 'ready' && vm.nodes.length === 0 && (
        <div className="brain-empty">No links yet.</div>
      )}

      {!error && vm.nodes.length > 0 && (
        <div className="brain-body">
          <BrainToolbar
            prefs={prefs}
            focusId={activeFocusId}
            scopeLocal={scopeLocal}
            nodes={graph.nodes.map(nodeToVM)}
            onChangePrefs={setBrainPrefs}
            onSearchPick={handleSearchPick}
            onDimensionChange={(d: '2d' | '3d') => setBrainPrefs({ dimension: d })}
            dimensionDisabled3D={!webglOk}
            onScopeLocalChange={setScopeLocal}
          />
          <BrainLegend totalNodes={graph.nodes.length} totalEdges={graph.edges.length} shownNodes={vm.nodes.length} />
          <div ref={setCanvasContainer}>
            {runtimeDimension === '2d' ? (
              <Suspense fallback={<div className="brain-loading" />}>
                <LazyBrainCanvas2D
                  nodes={vm.nodes}
                  edges={vm.edges}
                  focusId={activeFocusId}
                  selectedId={selectedId}
                  colourMode={prefs.colourMode}
                  palette={palette}
                  flyTo={flyTo}
                  onSelect={handleSelect}
                  onOpen={handleOpen}
                />
              </Suspense>
            ) : (
              <Suspense fallback={<div className="brain-loading" />}>
                <LazyBrainScene3D
                  nodes={vm.nodes}
                  edges={vm.edges}
                  focusId={activeFocusId}
                  selectedId={selectedId}
                  colourMode={prefs.colourMode}
                  palette={palette}
                  flyTo={flyTo}
                  onSelect={handleSelect}
                  onOpen={handleOpen}
                />
              </Suspense>
            )}
          </div>
          {selectedNode && (
            <BrainInspector
              node={selectedNode}
              edges={vm.edges}
              onClose={handleInspectorClose}
              onPick={handleInspectorPick}
              onOpen={handleInspectorOpen}
              canOpen={canOpen}
              resolveTitle={resolveTitle}
            />
          )}
        </div>
      )}
    </div>
  );
}
