import { useEffect, useRef, useState } from 'react';
import { useStore } from '../stores/store';
import type { BrainPrefs, BrainFilterFlags } from '../stores/store';
import { brainFetch } from '../api/client';
import type { BrainFetchResult, BrainNodeWire, BrainEdgeWire } from '../api/client';
import BrainToolbar from './brain/BrainToolbar';
import BrainCanvas2D from './brain/BrainCanvas2D';
import { brainView, useBrainPalette, searchNodes } from './brain/brainView';

interface Props {
  focusId?: string | null;
}

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
  const selectNote = useStore((s: { selectNote: (id: string | null) => void }) => s.selectNote);
  const selectChecklist = useStore((s: { selectChecklist: (id: string | null) => void }) => s.selectChecklist);
  const notes = useStore((s: { notes: { id: string }[] }) => s.notes);
  const checklists = useStore((s: { checklists: { id: string }[] }) => s.checklists);

  const activeFocusId = focusId ?? storeFocusId;
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
            onScopeLocalChange={setScopeLocal}
          />
          <BrainCanvas2D
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
        </div>
      )}
    </div>
  );
}
