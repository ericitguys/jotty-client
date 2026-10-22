import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useStore, DEFAULT_BRAIN_PREFS } from '../stores/store';
import type { BrainPrefs } from '../stores/store';
import BrainView from './BrainView';
import BrainInspector from './brain/BrainInspector';

const mockBrainFetch = vi.fn();
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, brainFetch: (...args: unknown[]) => mockBrainFetch(...args) };
});

vi.mock('./brain/BrainCanvas2D', () => ({
  default: ({
    onOpen,
    onSelect,
    nodes,
  }: {
    onOpen: (n: { id: string; kind: string }) => void;
    onSelect: (id: string | null) => void;
    nodes: { id: string; kind: string; title: string }[];
  }) => (
    <div data-testid="brain-canvas-stub" className="brain-canvas" data-dimension="2d">
      <button onClick={() => onSelect(nodes[0]?.id ?? 'n0')} data-testid="mock-node">Select first</button>
      <button
        onDoubleClick={() => onOpen({ id: nodes[0]?.id ?? 'n0', kind: nodes[0]?.kind ?? 'note' })}
        data-testid="mock-open-node"
      >
        Open first
      </button>
    </div>
  ),
}));

vi.mock('./brain/BrainScene3D', () => ({
  default: () => (
    <div data-testid="brain-canvas-stub" className="brain-canvas" data-dimension="3d">
      <canvas data-testid="brain-3d-canvas" />
    </div>
  ),
}));

const makeResult = (overrides: Partial<{ fromCache: boolean; stale: boolean; status: string; nodeCount: number; edges: { source: string; target: string; kind: string; weight?: number }[] }> = {}) => {
  const { fromCache = false, stale = false, status = 'ready', nodeCount = 3, edges: edgeOverride } = overrides;
  const defaultEdges = edgeOverride ?? [];
  return {
    graph: {
      status,
      focus: null,
      nodes: Array.from({ length: nodeCount }, (_, i) => ({
        id: `n${i}`,
        kind: 'note',
        title: `Note ${i}`,
        links: i,
      })),
      edges: defaultEdges,
      total: nodeCount,
      truncated: false,
    },
    fetchedAt: '2026-10-20T00:00:00Z',
    fromCache,
    stale,
  };
};

beforeEach(() => {
  mockBrainFetch.mockReset();
  localStorage.clear();
  cleanup();
  useStore.setState({
    brainFocusId: null,
    brainPrefs: {
      dimension: '2d',
      colourMode: 'type',
      depth: 2,
      filters: { notes: true, checklists: true, tags: false, ghosts: true, suggestions: false, orphans: true },
    },
    notes: [],
    checklists: [],
  } as Partial<ReturnType<typeof useStore.getState>>);
});

describe('BrainView shell', () => {
  it('renders container + toolbar + 2D stub on ready graph', async () => {
    mockBrainFetch.mockResolvedValue(makeResult());
    render(<BrainView />);
    await waitFor(() => expect(screen.getByTestId('brain-canvas-stub')).toBeInTheDocument());
    expect(document.querySelector('#brain')).not.toBeNull();
    expect(document.querySelector('.brain-toolbar')).not.toBeNull();
  });

  it('renders stale chip exactly "· stale data" when fromCache', async () => {
    mockBrainFetch.mockResolvedValue(makeResult({ fromCache: true }));
    render(<BrainView />);
    await waitFor(() => expect(document.querySelector('.sync-stale')).toBeInTheDocument());
  });

  it('renders stale chip when stale flag is true', async () => {
    mockBrainFetch.mockResolvedValue(makeResult({ stale: true }));
    render(<BrainView />);
    await waitFor(() => expect(document.querySelector('.sync-stale')).toBeInTheDocument());
  });

  it('keeps prior ready graph and shows server-indexing chip when a building response arrives', async () => {
    const { resolve, promise } = (() => {
      let resolve: (v: ReturnType<typeof makeResult>) => void = () => {};
      const promise = new Promise<ReturnType<typeof makeResult>>((r) => {
        resolve = r;
      });
      return { resolve, promise };
    })();
    mockBrainFetch
      .mockResolvedValueOnce(makeResult({ status: 'ready', nodeCount: 3 }))
      .mockReturnValueOnce(promise);
    render(<BrainView />);
    await waitFor(() => expect(screen.getByTestId('brain-canvas-stub')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/3 items · 0 links · showing 3/)).toBeInTheDocument());

    // trigger a re-fetch by changing depth -> building response
    act(() => useStore.getState().setBrainPrefs({ depth: 3 }));
    resolve(makeResult({ status: 'building', nodeCount: 0 }));

    await waitFor(() => expect(screen.getByText('· stale data · server indexing')).toBeInTheDocument());
    // prior graph still rendered (legend keeps the 3 ready nodes, not the empty building graph)
    expect(screen.getByText(/3 items · 0 links · showing 3/)).toBeInTheDocument();
  });

  it('shows indexing notice + refresh button when building with no nodes', async () => {
    mockBrainFetch.mockResolvedValue(makeResult({ status: 'building', nodeCount: 0 }));
    render(<BrainView />);
    await waitFor(() => {
      expect(screen.getByText(/Still indexing links/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Refresh/ })).toBeInTheDocument();
    });
  });

  it('shows empty state when ready with no nodes', async () => {
    mockBrainFetch.mockResolvedValue(makeResult({ status: 'ready', nodeCount: 0 }));
    render(<BrainView />);
    await waitFor(() => expect(screen.getByText('No links yet.')).toBeInTheDocument());
  });

  it('shows error state when invoke throws', async () => {
    mockBrainFetch.mockRejectedValue(new Error('boom'));
    render(<BrainView />);
    await waitFor(() => expect(screen.getByText('Brain unavailable')).toBeInTheDocument());
  });
});

describe('BrainView toolbar', () => {
  it('depth slider and scope toggle are absent when unfocused', async () => {
    mockBrainFetch.mockResolvedValue(makeResult());
    render(<BrainView />);
    await waitFor(() => expect(document.querySelector('.brain-toolbar')).toBeInTheDocument());
    expect(document.querySelector('[data-testid="depth-slider"]')).toBeNull();
    expect(screen.queryByLabelText(/Local/)).toBeNull();
  });

  it('depth slider and scope toggle are present when focused', async () => {
    mockBrainFetch.mockResolvedValue(makeResult());
    useStore.setState({ brainFocusId: 'n0' });
    render(<BrainView />);
    await waitFor(() => expect(document.querySelector('.brain-toolbar')).toBeInTheDocument());
    expect(document.querySelector('[data-testid="depth-slider"]')).not.toBeNull();
    expect(screen.queryByLabelText(/Local/)).not.toBeNull();
  });

  it('filter chips toggle via aria-pressed', async () => {
    mockBrainFetch.mockResolvedValue(makeResult());
    render(<BrainView />);
    await waitFor(() => expect(document.querySelector('.brain-filters')).toBeInTheDocument());
    const notesChip = screen.getByRole('button', { name: 'notes' });
    expect(notesChip.getAttribute('aria-pressed')).toBe('true');
    notesChip.click();
    expect(useStore.getState().brainPrefs.filters.notes).toBe(false);
  });

  it('suggestions chip starts unpressed (default OFF)', async () => {
    mockBrainFetch.mockResolvedValue(makeResult());
    render(<BrainView />);
    await waitFor(() => expect(document.querySelector('.brain-filters')).toBeInTheDocument());
    const chip = screen.getByRole('button', { name: 'suggestions' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
  });

  it('3D button is disabled when WebGL probe is false', async () => {
    mockBrainFetch.mockResolvedValue(makeResult());
    render(<BrainView />);
    await waitFor(() => expect(document.querySelector('.brain-toolbar')).toBeInTheDocument());
    const dimButtons = screen.getAllByRole('button', { name: /3D|2D/ });
    const button3D = dimButtons.find((b) => b.textContent?.includes('3D'));
    expect(button3D).not.toBeUndefined();
    expect((button3D as HTMLButtonElement).disabled).toBe(true);
  });

  it('3D button is enabled when WebGL probe is true', async () => {
    mockBrainFetch.mockResolvedValue(makeResult());
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn((type: string) => (type === 'webgl2' ? {} : null)) as unknown as typeof orig;
    render(<BrainView />);
    await waitFor(() => expect(document.querySelector('.brain-toolbar')).toBeInTheDocument());
    const dimButtons = screen.getAllByRole('button', { name: /3D|2D/ });
    const button3D = dimButtons.find((b) => b.textContent?.includes('3D'));
    expect(button3D).not.toBeUndefined();
    expect((button3D as HTMLButtonElement).disabled).toBe(false);
    HTMLCanvasElement.prototype.getContext = orig;
  });
});

describe('BrainView dimension', () => {
  it('swaps from 2d to 3d via store and renders 3D stub', async () => {
    mockBrainFetch.mockResolvedValue(makeResult());
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn((type: string) => (type === 'webgl2' ? {} : null)) as unknown as typeof orig;
    render(<BrainView />);
    await waitFor(() => expect(document.querySelector('.brain-canvas[data-dimension="2d"]')).toBeInTheDocument());
    useStore.getState().setBrainDimension('3d');
    await waitFor(() => expect(document.querySelector('.brain-canvas[data-dimension="3d"]')).toBeInTheDocument());
    HTMLCanvasElement.prototype.getContext = orig;
  });

  it('auto-2D guard keeps stored pref 3d but renders 2d when coarse pointer', async () => {
    mockBrainFetch.mockResolvedValue(makeResult());
    useStore.getState().setBrainPrefs({ dimension: '3d' });
    const saved = window.matchMedia;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(pointer: coarse)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: query,
      onchange: null,
    }));
    render(<BrainView />);
    await waitFor(() => expect(document.querySelector('.brain-canvas[data-dimension="2d"]')).toBeInTheDocument());
    expect(useStore.getState().brainPrefs.dimension).toBe('3d');
    const raw = localStorage.getItem('jotty.brain-prefs');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).dimension).toBe('3d');
    vi.stubGlobal('matchMedia', saved);
  });

  it('webglcontextlost on 3D canvas downgrades dimension to 2d and persists', async () => {
    mockBrainFetch.mockResolvedValue(makeResult());
    useStore.setState({ brainPrefs: { ...useStore.getState().brainPrefs, dimension: '3d' } });
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn((type: string) => (type === 'webgl2' ? {} : null)) as unknown as typeof orig;
    render(<BrainView />);
    await waitFor(() => expect(document.querySelector('.brain-canvas[data-dimension="3d"]')).toBeInTheDocument());
    const canvas = document.querySelector('[data-testid="brain-3d-canvas"]') as HTMLCanvasElement | null;
    await new Promise((r) => setTimeout(r, 0));
    if (canvas) {
      act(() => canvas.dispatchEvent(new Event('webglcontextlost', { bubbles: true })));
    }
    await waitFor(() => expect(useStore.getState().brainPrefs.dimension).toBe('2d'));
    expect(JSON.parse(localStorage.getItem('jotty.brain-prefs')!).dimension).toBe('2d');
    HTMLCanvasElement.prototype.getContext = orig;
  });
});

describe('store matrix', () => {
  it('setBrainFocus sets focus and switches mode to brain', () => {
    useStore.getState().setBrainFocus('abc');
    expect(useStore.getState().brainFocusId).toBe('abc');
    expect(useStore.getState().listMode).toBe('brain');
    expect(useStore.getState().selectedNoteId).toBeNull();
    expect(useStore.getState().selectedChecklistId).toBeNull();
  });

  it('setListMode(brain) clears focus', () => {
    useStore.getState().setBrainFocus('abc');
    useStore.getState().setListMode('brain');
    expect(useStore.getState().brainFocusId).toBeNull();
    expect(useStore.getState().listMode).toBe('brain');
  });

  it('selectNote clears focus', () => {
    useStore.getState().setBrainFocus('abc');
    useStore.getState().selectNote('n1');
    expect(useStore.getState().brainFocusId).toBeNull();
    expect(useStore.getState().selectedNoteId).toBe('n1');
  });

  it('selectChecklist clears focus', () => {
    useStore.getState().setBrainFocus('abc');
    useStore.getState().selectChecklist('c1');
    expect(useStore.getState().brainFocusId).toBeNull();
    expect(useStore.getState().selectedChecklistId).toBe('c1');
  });

  it('selectCategory clears focus', () => {
    useStore.getState().setBrainFocus('abc');
    useStore.getState().selectCategory({ type: 'notes', path: 'Work' });
    expect(useStore.getState().brainFocusId).toBeNull();
  });

  it('selectCategory(null) clears focus', () => {
    useStore.getState().setBrainFocus('abc');
    useStore.getState().selectCategory(null);
    expect(useStore.getState().brainFocusId).toBeNull();
  });
});

describe('prefs persistence', () => {
  it('loads defaults when no stored prefs', () => {
    expect(useStore.getState().brainPrefs.filters.suggestions).toBe(false);
  });

  it('merges stored prefs over defaults', () => {
    localStorage.setItem('jotty.brain-prefs', JSON.stringify({ depth: 3, filters: { suggestions: true } }));
    useStore.getState().setBrainPrefs({ depth: 3, filters: { ...useStore.getState().brainPrefs.filters, suggestions: true } });
    expect(useStore.getState().brainPrefs.depth).toBe(3);
    expect(useStore.getState().brainPrefs.filters.suggestions).toBe(true);
    expect(JSON.parse(localStorage.getItem('jotty.brain-prefs')!).depth).toBe(3);
  });

  it('corrupt JSON falls back to defaults on init', () => {
    localStorage.setItem('jotty.brain-prefs', 'not-json');
    expect(useStore.getState().brainPrefs).toEqual(DEFAULT_BRAIN_PREFS);
  });
});

describe('node open', () => {
  it('double-click opens a note via selectNote when local row exists', async () => {
    mockBrainFetch.mockResolvedValue(makeResult());
    useStore.setState({ notes: [{ id: 'n0', title: 'Note 0', content: '', category: 'Work', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, dirty: false, audioPath: null, audioDurationSecs: null }] });
    render(<BrainView />);
    await waitFor(() => expect(screen.getByTestId('brain-canvas-stub')).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByTestId('mock-open-node'));
    expect(useStore.getState().selectedNoteId).toBe('n0');
  });
});

describe('BrainView inspector + legend', () => {
  it('renders inspector on node select with title and kind', async () => {
    mockBrainFetch.mockResolvedValue(makeResult({ edges: [{ source: 'n0', target: 'n1', kind: 'link' }] }));
    render(<BrainView />);
    await waitFor(() => expect(screen.getByTestId('brain-canvas-stub')).toBeInTheDocument());
    screen.getByTestId('mock-node').click();
    await waitFor(() => expect(screen.getByRole('complementary', { name: /Brain inspector/i })).toBeInTheDocument());
    expect(screen.getByText('Note 0')).toBeInTheDocument();
    expect(document.querySelector('.brain-inspector-kind')?.textContent).toBe('note');
  });

  it('renders legend with total items, total links, and shown nodes', async () => {
    mockBrainFetch.mockResolvedValue(makeResult({ nodeCount: 3, edges: [{ source: 'n0', target: 'n1', kind: 'link', weight: 1 }, { source: 'n1', target: 'n2', kind: 'link', weight: 1 }] }));
    render(<BrainView />);
    await waitFor(() => expect(screen.getByText(/3 items · 2 links · showing 3/)).toBeInTheDocument());
  });

  it('shows (unknown) fallback for edge target missing from graph nodes', () => {
    render(
      <BrainInspector
        node={{ id: 'n0', kind: 'note', title: 'Note 0', links: 0 }}
        edges={[{ source: 'n0', target: 'missing', kind: 'link', weight: 1 }]}
        onClose={vi.fn()}
        onPick={vi.fn()}
        onOpen={vi.fn()}
        canOpen={() => false}
        resolveTitle={() => null}
      />,
    );
    expect(screen.getByText(/Links to/)).toBeInTheDocument();
    expect(screen.getByText('(unknown)')).toBeInTheDocument();
  });

  it('opens a checklist from the inspector', async () => {
    mockBrainFetch.mockResolvedValue({
      graph: {
        status: 'ready',
        focus: null,
        nodes: [{ id: 'c0', kind: 'checklist', title: 'Chk 0', links: 0 }],
        edges: [],
        total: 1,
        truncated: false,
      },
      fetchedAt: '2026-10-20T00:00:00Z',
      fromCache: false,
      stale: false,
    });
    useStore.setState({ checklists: [{ id: 'c0', title: 'Chk 0', items: [], category: 'Work', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, dirty: false, completed: false, listType: 'simple' }] });
    render(<BrainView />);
    await waitFor(() => expect(screen.getByTestId('brain-canvas-stub')).toBeInTheDocument());
    screen.getByTestId('mock-node').click();
    await waitFor(() => expect(document.querySelector('.brain-inspector-open')).not.toBeNull());
    fireEvent.click(document.querySelector('.brain-inspector-open')!);
    expect(useStore.getState().selectedChecklistId).toBe('c0');
  });
});

// REAL-ENGINE LAYOUT CATCH (WebKitGTK probe 2026-10-22): .brain-view is a grid
// item inside #app > main; main's grid row sizes to CONTENT (align-content:start),
// so .brain-view height:100% resolved to auto and the whole view collapsed to
// ~112px — the 2D/3D graph canvas measured a 1168x53 sliver (body 53px, host 0px).
// The rule pins the same viewport height budget the list sections use
// (100vh minus main's 16px+16px padding). jsdom + static fences cannot see the
// collapse; this rule-block fence is the regression tripwire.
describe('BrainView shell height', () => {
  it('the route host pins the real viewport height (#app > main > .brain-view)', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const sel = '#app > main > .brain-view';
    const i = css.indexOf(sel);
    expect(i, `${sel} rule exists`).toBeGreaterThan(-1);
    const block = css.slice(i, css.indexOf('}', i));
    expect(block).toContain('height: calc(100vh - 32px)');
  });
});