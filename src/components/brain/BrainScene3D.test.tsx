import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import BrainScene3D from './BrainScene3D';

const nodes = [
  { id: 'n0', kind: 'note', title: 'Note 0', links: 1 },
  { id: 'n1', kind: 'checklist', title: 'Check 1', links: 2 },
];
const edges = [{ source: 'n0', target: 'n1', kind: 'link', weight: 1 }];

const palette = {
  primary: [157, 95, 254] as [number, number, number],
  foreground: [249, 249, 249] as [number, number, number],
  muted: [163, 156, 175] as [number, number, number],
  background: [14, 24, 64] as [number, number, number],
  card: [27, 34, 51] as [number, number, number],
  border: [38, 47, 63] as [number, number, number],
};

const baseProps = {
  nodes,
  edges,
  focusId: null,
  selectedId: null,
  colourMode: 'type' as const,
  palette,
  flyTo: null,
  onSelect: vi.fn(),
  onOpen: vi.fn(),
};

describe('BrainScene3D jsdom fences', () => {
  beforeEach(() => {
    // jsdom has no webgl context by default.
    vi.restoreAllMocks();
  });

  it('renders structural stub when WebGL absent', () => {
    render(<BrainScene3D {...baseProps} />);
    const stub = document.querySelector('.brain-canvas-stub');
    expect(stub).not.toBeNull();
    expect(stub!.getAttribute('data-dimension')).toBe('3d');
    expect(stub!.getAttribute('data-node-count')).toBe(String(nodes.length));
  });

  it('disposal helper disposes mocked three parts', async () => {
    const disposeMap = new Map<string, boolean>();
    const fakeParts = {
      group: {},
      body: {
        material: {
          opacity: 1,
          dispose: () => { disposeMap.set('body.material', true); },
          map: { dispose: () => { disposeMap.set('body.map', true); } },
        },
      },
      hit: {
        geometry: { dispose: () => { disposeMap.set('hit.geometry', true); } },
        material: { dispose: () => { disposeMap.set('hit.material', true); } },
      },
      ring: {
        material: {
          opacity: 0,
          dispose: () => { disposeMap.set('ring.material', true); },
          map: { dispose: () => { disposeMap.set('ring.map', true); } },
        },
      },
      label: {
        material: {
          opacity: 0,
          dispose: () => { disposeMap.set('label.material', true); },
          map: { dispose: () => { disposeMap.set('label.map', true); } },
        },
      },
      labelAspect: 1,
      crowded: false,
      target: { body: 1, ring: 0, label: 0 },
    } as unknown as import('./brainThree').NodeParts;

    const { disposeParts } = await import('./brainThree');
    disposeParts(fakeParts);
    expect(disposeMap.get('body.material')).toBe(true);
    expect(disposeMap.get('hit.geometry')).toBe(true);
    expect(disposeMap.get('hit.material')).toBe(true);
    expect(disposeMap.get('ring.material')).toBe(true);
    expect(disposeMap.get('label.material')).toBe(true);
  });
});