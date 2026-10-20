import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import { useStore, DEFAULT_BRAIN_PREFS } from '../stores/store';
import type { BrainPrefs } from '../stores/store';
import BrainView from './BrainView';

const mockBrainFetch = vi.fn();
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, brainFetch: (...args: unknown[]) => mockBrainFetch(...args) };
});

vi.mock('./brain/BrainCanvas2D', () => ({
  default: ({ onOpen }: { onOpen: (n: { id: string; kind: string }) => void }) => (
    <div data-testid="brain-canvas-stub" className="brain-canvas" data-dimension="2d">
      <button onDoubleClick={() => onOpen({ id: 'n0', kind: 'note' })} data-testid="mock-node">Open n0</button>
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

const makeResult = (overrides: Partial<{ fromCache: boolean; stale: boolean; status: string; nodeCount: number }> = {}) => {
  const { fromCache = false, stale = false, status = 'ready', nodeCount = 3 } = overrides;
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
      edges: [],
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
    await waitFor(() => expect(document.querySelector('.brain-stale')).toBeInTheDocument());
  });

  it('renders stale chip when stale flag is true', async () => {
    mockBrainFetch.mockResolvedValue(makeResult({ stale: true }));
    render(<BrainView />);
    await waitFor(() => expect(document.querySelector('.brain-stale')).toBeInTheDocument());
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
    fireEvent.doubleClick(screen.getByTestId('mock-node'));
    expect(useStore.getState().selectedNoteId).toBe('n0');
  });
});