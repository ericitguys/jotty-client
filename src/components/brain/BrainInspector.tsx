import type { BrainVMNode, BrainVMEdge } from './brainView';

export interface BrainInspectorProps {
  node: BrainVMNode;
  edges: BrainVMEdge[];
  onClose: () => void;
  onPick: (id: string) => void;
  onOpen: (node: BrainVMNode) => void;
  canOpen: (node: BrainVMNode) => boolean;
  stale?: string | null;
}

interface Neighbour {
  id: string;
  title: string;
  kind: string;
  weight: number;
  edge: BrainVMEdge;
  outgoing: boolean;
}

const isItemKind = (kind: string) => kind === 'note' || kind === 'checklist';

export default function BrainInspector({ node, edges, onClose, onPick, onOpen, canOpen, stale }: BrainInspectorProps) {
  const neighbours: Neighbour[] = edges
    .filter((edge) => edge.source === node.id || edge.target === node.id)
    .map((edge) => {
      const outgoing = edge.source === node.id;
      const id = outgoing ? edge.target : edge.source;
      // For a same-node loop (shouldn't happen), default to outgoing target.
      const other = { id, title: '(unknown)', kind: 'unknown' };
      return { ...other, weight: edge.weight, edge, outgoing };
    });

  const suggested = neighbours
    .filter((n) => n.edge.kind === 'suggested')
    .sort((a, b) => b.edge.weight - a.edge.weight);
  const outgoing = neighbours.filter((n) => n.outgoing && n.edge.kind !== 'suggested');
  const incoming = neighbours.filter((n) => !n.outgoing && n.edge.kind !== 'suggested');

  const openable = isItemKind(node.kind);
  const openDisabled = !canOpen(node);
  const openLabel =
    node.kind === 'ghost' ? 'Create ghost' : node.kind === 'tag' ? 'Open' : 'Open';
  const openTitle = openDisabled
    ? node.kind === 'ghost' || node.kind === 'tag'
      ? 'not written yet'
      : 'not synced'
    : undefined;

  return (
    <aside className="brain-inspector" aria-label="Brain inspector">
      {stale && <span className="sync-stale">{stale}</span>}
      <div className="brain-inspector-head">
        <div className="brain-inspector-title">
          <span className="brain-inspector-kind">{node.kind}</span>
          <h3>{node.title}</h3>
          {node.category && <span className="brain-inspector-category">{node.category}</span>}
        </div>
        <button type="button" className="brain-inspector-close" aria-label="Close inspector" title="Close inspector" onClick={onClose}>
          ×
        </button>
      </div>

      {neighbours.length === 0 && (
        <p className="brain-inspector-lonely">Not linked to anything yet.</p>
      )}

      {outgoing.length > 0 && (
        <section className="brain-inspector-section">
          <h4>Links to</h4>
          <ul>
            {outgoing.map((n) => (
              <li key={`out-${n.id}`}>
                <button type="button" onClick={() => onPick(n.id)}>
                  <span className="brain-inspector-neighbour-kind">{n.kind}</span>
                  <span className="brain-inspector-neighbour-title">{n.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {incoming.length > 0 && (
        <section className="brain-inspector-section">
          <h4>Linked from</h4>
          <ul>
            {incoming.map((n) => (
              <li key={`in-${n.id}`}>
                <button type="button" onClick={() => onPick(n.id)}>
                  <span className="brain-inspector-neighbour-kind">{n.kind}</span>
                  <span className="brain-inspector-neighbour-title">{n.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {suggested.length > 0 && (
        <section className="brain-inspector-section brain-inspector-suggested">
          <h4>Suggested links</h4>
          <ul>
            {suggested.map((n) => (
              <li key={`sug-${n.id}`}>
                <button type="button" onClick={() => onPick(n.id)}>
                  <span className="brain-inspector-neighbour-kind">{n.kind}</span>
                  <span className="brain-inspector-neighbour-title">{n.title}</span>
                  <span className="brain-inspector-suggested-score">{Math.round(n.edge.weight * 100)}%</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <button
        type="button"
        className="brain-inspector-open"
        disabled={openDisabled}
        title={openTitle}
        onClick={() => onOpen(node)}
      >
        {openLabel}
      </button>
    </aside>
  );
}
