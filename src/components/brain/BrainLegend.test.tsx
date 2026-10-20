import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import BrainLegend from './BrainLegend';

describe('BrainLegend', () => {
  it('renders the counts text in the exact shape', () => {
    render(<BrainLegend totalNodes={120} totalEdges={340} shownNodes={60} />);
    expect(screen.getByText('120 items · 340 links · showing 60')).toBeInTheDocument();
  });

  it('renders all six edge-kind swatches', () => {
    render(<BrainLegend totalNodes={0} totalEdges={0} shownNodes={0} />);
    const swatches = document.querySelectorAll('.brain-legend-swatch-line');
    const kinds = Array.from(swatches).map((s) => (s as HTMLElement).dataset.kind);
    expect(kinds).toEqual(['link', 'mention', 'checklist', 'wiki', 'suggested', 'tag']);
  });

  it('does not bake raw hex colours into inline styles', () => {
    render(<BrainLegend totalNodes={1} totalEdges={1} shownNodes={1} />);
    const lines = document.querySelectorAll('.brain-legend-swatch-line');
    for (const line of lines) {
      const style = (line as HTMLElement).style.backgroundColor || '';
      expect(style).not.toMatch(/^#[0-9a-f]{3,6}$/i);
    }
  });
});
