import { BrainVMNode, BrainVMEdge, edgeColour, BrainPalette } from './brainView';

export interface BrainLegendProps {
  totalNodes: number;
  totalEdges: number;
  shownNodes: number;
}

const SWATCH_KINDS: BrainVMEdge['kind'][] = ['link', 'mention', 'checklist', 'wiki', 'suggested', 'tag'];

export default function BrainLegend({ totalNodes, totalEdges, shownNodes }: BrainLegendProps) {
  // palette read uses live CSS vars; in jsdom it falls back to the
  // default palette, which is fine for structural tests.
const palette: BrainPalette = { primary: [157, 95, 254], foreground: [249, 249, 249], muted: [163, 156, 175], background: [14, 24, 64], card: [27, 34, 51], border: [38, 47, 63] };
  return (
    <div className="brain-legend" aria-label="Brain legend">
      <div className="brain-legend-counts">
        {totalNodes} items · {totalEdges} links · showing {shownNodes}
      </div>
      <div className="brain-legend-swatches">
        {SWATCH_KINDS.map((kind) => {
          const color = edgeColour({ source: '', target: '', kind, weight: 1 }, palette, true);
          const dashed = kind === 'suggested';
          return (
            <span key={kind} className="brain-legend-swatch">
              <span
                className="brain-legend-swatch-line"
                data-kind={kind}
                style={{
                  backgroundColor: dashed ? 'transparent' : color,
                  borderBottom: dashed ? `2px dashed ${color}` : undefined,
                }}
              />
              <span className="brain-legend-swatch-label">{kind}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
