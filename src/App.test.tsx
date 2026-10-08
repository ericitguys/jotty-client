import { fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => async () => {}) }));

import App from './App';
import { useStore } from './stores/store';
import { listen } from '@tauri-apps/api/event';

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const cssTextApp = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');

beforeEach(() => {
  invoke.mockReset();
  // the store is a module singleton — UI state leaks between tests without a reset
  useStore.setState({ categories: null, selectedCategory: null, selectedNoteId: null, selectedChecklistId: null, listMode: 'notes' });
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
    if (cmd === 'list_notes') return Promise.resolve([{ id: 'n1', title: 'Groceries', content: 'milk', category: 'Home', updatedAt: '2026-01-01T00:00:00.000Z', dirty: false }]);
    if (cmd === 'list_checklists') return Promise.resolve([{ id: 'l1', title: 'Errands', category: 'Home', dirty: false }]);
    if (cmd === 'list_categories') return Promise.resolve({ notes: [{ name: 'Home', path: 'Home', count: 1, level: 0 }], checklists: [] });
    if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: '2026-01-01T00:00:00.000Z', syncing: false });
    if (cmd === 'voice_list_unsaved') return Promise.resolve([]);
    if (cmd === 'list_agenda') return Promise.resolve([]);
    if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: 'https://ai.example.com', model: 'm', languageHint: '', apiPathSuffix: 'v1', hasKey: true });
    if (cmd === 'ai_get_models') return Promise.resolve([]);
    return Promise.resolve(null);
  });
});

// storm-guard tests (kimi audit 5.1) use fake timers — restore for every test
// so the fake clock never leaks into the next file-local suite member
afterEach(() => {
  vi.useRealTimers();
});

describe('App shell', () => {
  it('shows only the active section: notes by default, checklists via the section header', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    expect(screen.queryByText('Errands')).not.toBeInTheDocument(); // one list at a time
    expect(document.querySelector('main')).toHaveClass('list-only'); // nothing open -> the list spans the width
    // switching sections: only the checklists list shows
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Checklists' }));
    await waitFor(() => expect(screen.getByText('Errands')).toBeInTheDocument());
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument();
  });

  it('opening an item replaces the list with its editor (v0.27.0 full swap)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Groceries'));
    await waitFor(() => expect(screen.getByPlaceholderText('Note title')).toBeInTheDocument());
    expect(document.querySelector('main')).not.toHaveClass('list-only');
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument(); // the wall is GONE — not merely narrowed
    expect(document.querySelectorAll('main > section')).toHaveLength(0); // no list section rides along
  });

  it('opening a checklist view also swaps (wall unmounts), back restores the checklists wall', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Checklists' }));
    await waitFor(() => expect(screen.getByText('Errands')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Errands'));
    await waitFor(() => expect(document.getElementById('checklist-view')).toBeInTheDocument());
    expect(screen.queryByText('Errands')).not.toBeInTheDocument(); // list gone while open
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }));
    await waitFor(() => expect(document.getElementById('checklist-view')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Errands')).toBeInTheDocument()); // wall restored
  });

  it('back button is a real return path at every width: base css, fixed top-right', () => {
    // static css fences (jsdom applies no layout; RULE copied per the ChecklistList pattern)
    const noComments = cssTextApp().replace(/\/\*[\s\S]*?\*\//g, '');
    expect(noComments).toContain('.back-btn {\n  display: inline-flex;\n  position: fixed;\n  top: 10px; right: 10px;');
    expect(noComments).toContain('.menu-btn { display: none; }'); // menu-btn alone in the hide rule now
    expect(noComments).toContain('#app > main {\n  display: grid;\n  grid-template-columns: 1fr;');
    expect(noComments).toContain('#app > main:not(.list-only) {\n  padding-top: 54px;\n}');
  });

  it('not-connected screen auto-opens onboarding modal', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Connect to jotty')).toBeInTheDocument());
  });

  it('offline start: local data renders, categories derive from local rows even though the live fetch fails', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: null });
      if (cmd === 'list_notes') return Promise.resolve([
        { id: 'n1', title: 'Groceries', content: 'milk', category: 'Home', updatedAt: '2026-01-01T00:00:00.000Z', dirty: false },
        { id: 'n2', title: 'Worklog', content: 'x', category: 'Work/Deep', updatedAt: '2026-01-02T00:00:00.000Z', dirty: false },
      ]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.reject(new Error('network unreachable')); // live fetch, offline
      if (cmd === 'sync_status') return Promise.resolve({ pending: 2, last_sync_at: null, syncing: false, lastError: 'network unreachable' });
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument()); // the local copy renders
    expect(screen.queryByText('Connect to jotty')).not.toBeInTheDocument(); // no onboarding prompt
    // categories are derived from the local rows when the live fetch failed:
    const nav = within(screen.getByRole('navigation'));
    expect(nav.getByText('Home')).toBeInTheDocument();
    expect(nav.getByText('Work')).toBeInTheDocument(); // intermediate node of Work/Deep
    expect(nav.getByText('Deep')).toBeInTheDocument();
  });

  it('a failed categories refresh keeps the last categories and still refreshes the rest', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    // the instance becomes unreachable mid-session: the live categories fetch fails
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
      if (cmd === 'list_notes') return Promise.resolve([{ id: 'n2', title: 'Standup', content: 'x', category: 'Work', updatedAt: '2026-01-02T00:00:00.000Z', dirty: false }]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.reject(new Error('network unreachable'));
      if (cmd === 'sync_status') return Promise.resolve({ pending: 1, last_sync_at: null, syncing: false });
      return Promise.resolve(null);
    });
    const calls = vi.mocked(listen).mock.calls;
    const handler = calls[calls.length - 1][1] as () => Promise<void>;
    await act(async () => { await handler(); });
    await waitFor(() => expect(screen.getByText('Standup')).toBeInTheDocument()); // the rest still refreshes
    expect(within(screen.getByRole('navigation')).getByText('Home')).toBeInTheDocument(); // categories preserved
    expect(screen.queryByText('Connect to jotty')).not.toBeInTheDocument();
  });

  it('clicking a sidebar category filters notes; clicking again clears', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.25.0' });
      if (cmd === 'list_notes') return Promise.resolve([
        { id: 'n1', title: 'Groceries', content: 'milk', category: 'Home', updatedAt: '2026-01-01T00:00:00.000Z', dirty: false },
        { id: 'n2', title: 'Standup', content: 'x', category: 'Work', updatedAt: '2026-01-02T00:00:00.000Z', dirty: false },
      ]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.resolve({
        notes: [{ name: 'Home', path: 'Home', count: 1, level: 0 }, { name: 'Work', path: 'Work', count: 1, level: 0 }],
        checklists: [],
      });
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: '2026-01-01T00:00:00.000Z', syncing: false });
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    // filter to the Work category: Groceries disappears
    fireEvent.click(within(screen.getByRole('navigation')).getByText('Work'));
    await waitFor(() => expect(screen.queryByText('Groceries')).not.toBeInTheDocument());
    expect(screen.getByText('Standup')).toBeInTheDocument();
    // clicking the selected category again clears the filter
    fireEvent.click(within(screen.getByRole('navigation')).getByText('Work'));
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
  });

  it('clicking a checklist category filters the checklists list', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.25.0' });
      if (cmd === 'list_notes') return Promise.resolve([]);
      if (cmd === 'list_checklists') return Promise.resolve([
        { id: 'l1', title: 'Errands', category: 'Home', updatedAt: null, dirty: false },
        { id: 'l2', title: 'Deploy', content: '', category: 'Trips', updatedAt: null, dirty: false },
      ]);
      if (cmd === 'list_categories') return Promise.resolve({
        notes: [],
        checklists: [{ name: 'Trips', path: 'Trips', count: 1, level: 0 }],
      });
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false });
      return Promise.resolve(null);
    });
    render(<App />);
    // checklists are only visible in the checklists section
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Checklists' }));
    await waitFor(() => expect(screen.getByText('Errands')).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole('navigation')).getByText('Trips'));
    await waitFor(() => expect(screen.queryByText('Errands')).not.toBeInTheDocument());
    expect(screen.getByText('Deploy')).toBeInTheDocument(); // the Trips checklist remains visible
    expect(within(screen.getByRole('navigation')).getByText('Trips').closest('li')).toHaveClass('selected');
  });

  it('switching to the checklists tab closes an open note; its categories filter the list', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.25.0' });
      if (cmd === 'list_notes') return Promise.resolve([
        { id: 'n1', title: 'Groceries', content: 'milk', category: 'Home', updatedAt: null, dirty: false },
      ]);
      if (cmd === 'list_checklists') return Promise.resolve([
        { id: 'l1', title: 'Errands', category: 'Home', updatedAt: null, dirty: false },
        { id: 'l2', title: 'Packing list', category: 'Trips', updatedAt: null, dirty: false },
      ]);
      if (cmd === 'list_categories') return Promise.resolve({
        notes: [{ name: 'Home', path: 'Home', count: 1, level: 0 }],
        checklists: [{ name: 'Trips', path: 'Trips', count: 1, level: 0 }],
      });
      if (cmd === 'get_note') return Promise.resolve({ id: 'n1', title: 'Groceries', content: '<p>milk</p>', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false });
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false });
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    // open the note editor
    fireEvent.click(screen.getByText('Groceries'));
    await waitFor(() => expect(screen.getByPlaceholderText('Note title')).toBeInTheDocument());
    // switch to the checklists tab -> editor closes, checklists show
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Checklists' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('Note title')).not.toBeInTheDocument());
    expect(screen.getByText('Errands')).toBeInTheDocument();
    expect(screen.getByText('Packing list')).toBeInTheDocument();
    // a checklist category then filters the list
    fireEvent.click(within(screen.getByRole('navigation')).getByText('Trips'));
    await waitFor(() => expect(screen.queryByText('Errands')).not.toBeInTheDocument()); // filtered out
    expect(screen.getByText('Packing list')).toBeInTheDocument();
  });

  it('settings button opens settings mode', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Settings'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument());
  });

  it('kanban-type checklists render the board view; plain ones keep the checklist', async () => {
    let requested: string | null = null;
    const boardMeta = { id: 'kb', title: 'Sprint', category: 'Work', updatedAt: null, deletedAt: null, dirty: false, completed: false, listType: 'kanban', items: [] };
    const plainMeta = { id: 'pl', title: 'Plain', category: 'Work', updatedAt: null, deletedAt: null, dirty: false, completed: false, listType: 'simple',
        items: [{ localId: 'i1', checklistId: 'pl', parentLocalId: null, text: 't', completed: false, position: 0, dirty: false, status: null, priority: null, targetDate: null, children: [] }] };
    invoke.mockImplementation((cmd: string, args?: { id?: string }) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://x', version: '1.25.0' });
      if (cmd === 'list_notes') return Promise.resolve([]);
      if (cmd === 'list_checklists') return Promise.resolve([
        { id: 'kb', title: 'Sprint', category: 'Work', dirty: false, completed: false, listType: 'kanban' },
        { id: 'pl', title: 'Plain', category: 'Work', dirty: false, completed: false, listType: 'simple' },
      ]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'get_checklist') {
        requested = args?.id ?? null;
        return requested === 'kb' ? Promise.resolve(boardMeta) : Promise.resolve(plainMeta);
      }
      if (cmd === 'get_board_columns' || cmd === 'fetch_task_board') return Promise.resolve({ checklistId: 'kb', statuses: [
        { id: 'todo', label: 'To Do', color: null, order: 0, autoComplete: false },
        { id: 'completed', label: 'Completed', color: null, order: 1, autoComplete: true },
      ] });
      if (cmd === 'get_prefs') return Promise.resolve(null);
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false, lastError: null });
      return Promise.resolve(null);
    });
    render(<App />);
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Checklists' }));
    fireEvent.click(await screen.findByText('Sprint'));
    // board renders with its columns; the plain checkbox list does NOT
    await waitFor(() => expect(screen.getByText('To Do')).toBeInTheDocument());
    expect(requested).toBe('kb');
    // v0.27.0 full swap: the open board REPLACED the wall — back out of the
    // board first, the Plain card is gone while the board is open
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }));
    // open the plain list: checklist view with checkboxes
    fireEvent.click(await screen.findByText('Plain'));
    await waitFor(() => expect(screen.getByText('t')).toBeInTheDocument());
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
  });
});

describe('web preference mirroring', () => {
  const prefs = (p: Record<string, unknown>) => ({
    preferredTheme: null, defaultNoteFilter: null, defaultChecklistFilter: null,
    checklistItemClickAction: null, hideConnectionIndicator: null,
    pinnedNotes: [], pinnedLists: [], ...p,
  });

  it('app root follows preferredTheme: light, dark, and system', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    const root = document.getElementById('app');
    act(() => useStore.setState({ prefs: prefs({ preferredTheme: 'light' }) }));
    expect(root).toHaveAttribute('data-theme', 'light');
    act(() => useStore.setState({ prefs: prefs({ preferredTheme: 'dark' }) }));
    expect(root).toHaveAttribute('data-theme', 'dark');
    act(() => useStore.setState({ prefs: prefs({ preferredTheme: 'system' }) }));
    expect(root).toHaveAttribute('data-theme', 'dark'); // no matchMedia in jsdom -> guard yields dark
  });

  it('site themes with app palettes render their own data-theme (rwmarkable-dark = blue)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    const root = document.getElementById('app');
    act(() => useStore.setState({ prefs: prefs({ preferredTheme: 'rwmarkable-dark' }) }));
    expect(root).toHaveAttribute('data-theme', 'rwmarkable-dark');
    // unknown custom theme ids still fall back to dark
    act(() => useStore.setState({ prefs: prefs({ preferredTheme: 'some-future-theme' }) }));
    expect(root).toHaveAttribute('data-theme', 'dark');
  });

  it('site theme_color adopts the site scheme when the user has no personal theme', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    const root = document.getElementById('app');
    // no preferredTheme + site manifest says #111827 -> rwmarkable-dark
    act(() => useStore.setState({ branding: { name: 'T', iconDataUrl: null, themeColor: '#111827' } }));
    expect(root).toHaveAttribute('data-theme', 'rwmarkable-dark');
    // unknown site color still falls back to dark
    act(() => useStore.setState({ branding: { name: 'T', iconDataUrl: null, themeColor: '#ff88cc' } }));
    expect(root).toHaveAttribute('data-theme', 'dark');
    // personal theme always wins over the site color
    act(() => useStore.setState({ prefs: prefs({ preferredTheme: 'light' }) }));
    expect(root).toHaveAttribute('data-theme', 'light');
    act(() => useStore.setState({ prefs: prefs({ preferredTheme: null }), branding: null }));
    expect(root).toHaveAttribute('data-theme', 'dark');
  });

  it('in-app theme override wins over the site mirror', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    const root = document.getElementById('app');
    act(() => useStore.setState({ themeOverride: 'rwmarkable-dark' }));
    expect(root).toHaveAttribute('data-theme', 'rwmarkable-dark');
    // override survives a branding change (site color ignored)
    act(() => useStore.setState({ branding: { name: 'T', iconDataUrl: null, themeColor: '#ff88cc' } }));
    expect(root).toHaveAttribute('data-theme', 'rwmarkable-dark');
    // override light
    act(() => useStore.setState({ themeOverride: 'light' }));
    expect(root).toHaveAttribute('data-theme', 'light');
    // auto/none returns to the mirror chain
    act(() => useStore.setState({ themeOverride: null }));
    expect(root).toHaveAttribute('data-theme', 'dark');
  });

  it('mobile top bar shows the hamburger and the app name in flow', async () => {
    useStore.setState({ branding: { name: 'Acme Notes', iconDataUrl: null, themeColor: null } });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    const bar = document.querySelector('.topbar');
    expect(bar).not.toBeNull();
    expect(bar!.querySelector('.menu-btn')).not.toBeNull();
    expect(bar!.querySelector('.topbar-title')!.textContent).toBe('Acme Notes');
  });

  it('defaultNoteFilter=recent orders notes by updatedAt desc', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://x', version: '1.25.0' });
      if (cmd === 'list_notes') return Promise.resolve([
        { id: 'n1', title: 'Old', content: '', category: 'Home', updatedAt: '2026-01-01T00:00:00.000Z', dirty: false },
        { id: 'n2', title: 'New', content: '', category: 'Home', updatedAt: '2026-02-01T00:00:00.000Z', dirty: false },
      ]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'get_prefs') return Promise.resolve(prefs({ defaultNoteFilter: 'recent' }));
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false, lastError: null });
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('New')).toBeInTheDocument());
    const first = document.querySelector('#notes li .item-title')?.textContent;
    expect(first).toBe('New');
  });

  it('defaultNoteFilter=pinned shows only pinned notes', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://x', version: '1.25.0' });
      if (cmd === 'list_notes') return Promise.resolve([
        { id: 'n1', title: 'PinnedNote', content: '', category: 'Home', updatedAt: null, dirty: false },
        { id: 'n2', title: 'Unpinned', content: '', category: 'Home', updatedAt: null, dirty: false },
      ]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'get_prefs') return Promise.resolve(prefs({ defaultNoteFilter: 'pinned', pinnedNotes: ['n1'] }));
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false, lastError: null });
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('PinnedNote')).toBeInTheDocument());
    expect(screen.queryByText('Unpinned')).not.toBeInTheDocument();
  });

  it('defaultChecklistFilter=incomplete hides fully-completed lists', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://x', version: '1.25.0' });
      if (cmd === 'list_notes') return Promise.resolve([]);
      // the backend stamps per-list completion on the list payload
      if (cmd === 'list_checklists') return Promise.resolve([
        { id: 'l1', title: 'OpenList', category: 'Home', dirty: false, completed: false, listType: 'checklist' },
        { id: 'l2', title: 'DoneList', category: 'Home', dirty: false, completed: true, listType: 'checklist' },
      ]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'get_prefs') return Promise.resolve(prefs({ defaultChecklistFilter: 'incomplete' }));
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false, lastError: null });
      return Promise.resolve(null);
    });
    render(<App />);
    // switch to the checklists section
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Checklists' }));
    await waitFor(() => expect(screen.getByText('OpenList')).toBeInTheDocument());
    expect(screen.queryByText('DoneList')).not.toBeInTheDocument();
  });

  it('hideConnectionIndicator=enable removes the sync badge', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    expect(document.getElementById('sync-badge')).toBeInTheDocument();
    act(() => useStore.setState({ prefs: prefs({ hideConnectionIndicator: 'enable' }) }));
    expect(document.getElementById('sync-badge')).not.toBeInTheDocument();
  });

  it('window title mirrors the instance name (branding)', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://x', version: '1.25.0' });
      if (cmd === 'list_notes') return Promise.resolve([]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'get_branding') return Promise.resolve({ name: 'Acme Notes', iconDataUrl: null });
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false, lastError: null });
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(document.title).toBe('Acme Notes'));
    act(() => useStore.setState({ branding: null }));
    expect(document.title).toBe('jotty·desktop');
  });

  it('new voice note opens the review overlay when the AI server is configured', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('New voice note'));
    await waitFor(() => expect(screen.getByText(/Recording/)).toBeInTheDocument());
  });

  it('new voice note opens Settings when the AI server is unconfigured', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
      if (cmd === 'list_notes') return Promise.resolve([{ id: 'n1', title: 'Groceries', content: 'milk', category: 'Home', updatedAt: '2026-01-01T00:00:00.000Z', dirty: false }]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false });
      if (cmd === 'voice_list_unsaved') return Promise.resolve([]);
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: '', model: '', languageHint: '', apiPathSuffix: 'v1', hasKey: false });
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('New voice note'));
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
  });

  it('resume prompt offers resume/discard when unsaved voice drafts exist', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
      if (cmd === 'list_notes') return Promise.resolve([]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false });
      if (cmd === 'voice_list_unsaved') return Promise.resolve([
        { id: 'r1', path: '/data/voice/r1.wav', durationSecs: 3, rawTranscript: 'draft', tidiedTranscript: null, state: 'transcribed', lastError: null, createdAt: '2026-09-18T00:00:00Z' },
      ]);
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: 'https://ai', model: 'm', languageHint: '', apiPathSuffix: 'v1', hasKey: true });
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Unfinished voice note')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Resume review'));
    await waitFor(() => expect(screen.getByPlaceholderText('Transcript')).toHaveValue('draft'));
  });

  it('resume prompt discard deletes the recordings', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
      if (cmd === 'list_notes') return Promise.resolve([]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false });
      if (cmd === 'voice_list_unsaved') return Promise.resolve([
        { id: 'r1', path: '/data/voice/r1.wav', durationSecs: 3, rawTranscript: null, tidiedTranscript: null, state: 'transcription_failed', lastError: null, createdAt: '2026-09-18T00:00:00Z' },
      ]);
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: '', model: '', languageHint: '', apiPathSuffix: 'v1', hasKey: false });
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Unfinished voice note')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Discard'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_delete_recording', { recordingId: 'r1' }));
  });

  it('closing the voice note modal re-checks for unsaved drafts (field report 2026-09-25: a draft must surface without a restart)', async () => {
    // the draft list is empty on mount; the SAME query after closing the modal
    // must run again and surface the draft
    let listCalls = 0;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
      if (cmd === 'list_notes') return Promise.resolve([]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false });
      if (cmd === 'voice_list_unsaved') {
        listCalls++;
        return Promise.resolve(listCalls === 1 ? [] : [
          { id: 'r1', path: '/data/voice/r1.wav', durationSecs: 3, rawTranscript: 'draft', tidiedTranscript: null, state: 'transcribed', lastError: null, createdAt: '2026-09-18T00:00:00Z' },
        ]);
      }
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: 'https://ai', model: 'm', languageHint: '', apiPathSuffix: 'v1', hasKey: true });
      if (cmd === 'voice_start_recording') return Promise.resolve({ id: 'r2', path: '/data/voice/r2.wav', durationSecs: 0, rawTranscript: null, tidiedTranscript: null, state: 'recording', lastError: null, createdAt: new Date().toISOString() });
      if (cmd === 'voice_delete_recording') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('New voice note')).toBeInTheDocument());
    expect(screen.queryByText('Unfinished voice note')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('New voice note'));
    await waitFor(() => expect(screen.getByText(/Recording/)).toBeInTheDocument());
    // close the modal (recording-phase Cancel): the draft list must re-run and prompt
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.getByText('Unfinished voice note')).toBeInTheDocument());
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  });

  it('menu button toggles the navigation drawer (mobile)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    const app = document.getElementById('app')!;
    expect(app).not.toHaveClass('drawer-open');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));
    expect(app).toHaveClass('drawer-open');
    expect(screen.getByRole('navigation')).toBeInTheDocument(); // sidebar reachable
    fireEvent.click(document.querySelector('.drawer-backdrop')!);
    expect(app).not.toHaveClass('drawer-open');
 expect(screen.queryByRole('button', { name: 'Toggle navigation' })).toBeInTheDocument(); // toggle remains
  });

  it('opening Settings from the drawer closes the drawer (modal must not sit under the sidebar)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    const app = document.getElementById('app')!;
    fireEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));
    expect(app).toHaveClass('drawer-open');
    fireEvent.click(screen.getByText('Settings'));
    expect(app).not.toHaveClass('drawer-open');
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('back button clears the open editor (now the only return path — rename only)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Groceries')); // open the editor
    await waitFor(() => expect(document.getElementById('note-editor')).toBeInTheDocument());
    expect(document.querySelector('main')).not.toHaveClass('list-only');
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }));
    await waitFor(() => expect(document.getElementById('note-editor')).not.toBeInTheDocument());
    expect(document.querySelector('main')).toHaveClass('list-only');
    // back returns to the section of the entity that was open: a note -> the notes list
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    expect(screen.queryByText('Errands')).not.toBeInTheDocument();
  });

  it('back button from a checklist returns to the checklists list', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Checklists' }));
    await waitFor(() => expect(screen.getByText('Errands')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Errands')); // open the checklist
    await waitFor(() => expect(document.getElementById('checklist-view')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }));
    await waitFor(() => expect(document.getElementById('checklist-view')).not.toBeInTheDocument());
    // back from a checklist lands on the checklists list, not the notes list
    await waitFor(() => expect(screen.getByText('Errands')).toBeInTheDocument());
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument();
  });

  it('listMode agenda renders the AgendaView list pane and neither entity list', async () => {
    useStore.setState({ listMode: 'agenda' });
    render(<App />);
    await waitFor(() => expect(screen.getByText('No dated items.')).toBeInTheDocument());
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument(); // notes list stays closed
    expect(screen.queryByText('Errands')).not.toBeInTheDocument(); // checklists list stays closed
    // the right pane stays empty until a click-through selects a checklist
    expect(document.getElementById('note-editor')).toBeNull();
    expect(document.getElementById('checklist-view')).toBeNull();
  });

  it('reconnect tap + waiting-to-transcribe chip (2026-09-30 offline-voice run)', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
      if (cmd === 'list_notes') return Promise.resolve([]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false });
      if (cmd === 'voice_list_unsaved') return Promise.resolve([]);
      if (cmd === 'voice_get_pending_transcriptions') return Promise.resolve(2);
      if (cmd === 'voice_retry_pending') return Promise.resolve({ stagingRetried: 2, stagingSucceeded: 2, notesFilled: 0 });
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: 'https://ai', model: 'm', languageHint: '', apiPathSuffix: 'v1', hasKey: true });
      return Promise.resolve(null);
    });
    render(<App />);
    // chip: the count surfaces inside the sync footer
    await waitFor(() => expect(screen.getByTestId('voice-pending-chip')).toHaveTextContent('2 waiting to transcribe'));
    // the webview sees the network return -> ONE retry pass fires after the 1s
    // debounce window (kimi audit 5.1 storm guard). Fake timers are safe here:
    // the only waits left in this test are act() drains (no RTL async wrappers).
    vi.useFakeTimers();
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      vi.advanceTimersByTime(1000);
    });
    expect(invoke).toHaveBeenCalledWith('voice_retry_pending');
  });
});

describe('Quick capture (capture-foundation P1)', () => {
  it('Ctrl+Shift+J focuses the capture input from anywhere in the app', async () => {
    // seed + render App per the file's existing helper (beforeEach) — the notes
    // wall is mounted with listMode 'notes' and no selection
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'J', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByPlaceholderText(/capture/i)).toBeInTheDocument());
    expect(document.activeElement?.getAttribute('placeholder')).toMatch(/capture/i);
  });

  it('submitting a capture posts quick_capture with the text and stays on the wall', async () => {
    // the quick_capture response rides the shared fallthrough resolve(null):
    // neither QuickCapture nor the store action reads the resolved NoteDto here
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    const input = screen.getByPlaceholderText(/capture/i);
    fireEvent.change(input, { target: { value: 'renew vpn cert' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('quick_capture', { text: 'renew vpn cert' }));
    // the wall still renders — no editor opened
    expect(document.querySelector('main')).toHaveClass('list-only');
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Note title')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/capture/i)).toBeInTheDocument();
  });
});

describe('!INBOX isolation (capture-foundation P1 T3)', () => {
  it('capture-zone notes are hidden from the notes wall until the inbox category is selected', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
      if (cmd === 'list_notes') return Promise.resolve([
        { id: 'a1', title: 'work note', content: '', category: 'Work', updatedAt: '2026-01-01T00:00:00.000Z', dirty: false },
        { id: 'b1', title: 'cap_1_aaaa', content: '', category: '!INBOX', updatedAt: '2026-01-02T00:00:00.000Z', dirty: false },
      ]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      // live categories fetch fails offline-style → tree derives from the local rows
      if (cmd === 'list_categories') return Promise.reject(new Error('network unreachable'));
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false });
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('work note')).toBeInTheDocument());
    expect(screen.queryByText('cap_1_aaaa')).toBeNull(); // capture-zone note hidden from the default wall
    // select the inbox category: the capture surface becomes the ONLY wall
    act(() => { useStore.getState().selectCategory({ type: 'notes', path: '!INBOX' }); });
    await waitFor(() => expect(screen.getByText('cap_1_aaaa')).toBeInTheDocument());
    expect(screen.queryByText('work note')).toBeNull();
  });

  it('inbox surface shows the capture count next to the category node', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: null });
      if (cmd === 'list_notes') return Promise.resolve([
        { id: 'c1', title: 'cap_2_xxxx', content: '', category: '!INBOX', updatedAt: '2026-01-02T00:00:00.000Z', dirty: false },
        { id: 'c2', title: 'cap_2_yyyy', content: '', category: '!INBOX', updatedAt: '2026-01-03T00:00:00.000Z', dirty: false },
        { id: 'a2', title: 'work note', content: '', category: 'Work', updatedAt: '2026-01-01T00:00:00.000Z', dirty: false },
      ]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      // live categories fetch fails → Sidebar derives the tree from the rows:
      // 2 inbox notes + 1 other → the !INBOX node carries count 2
      if (cmd === 'list_categories') return Promise.reject(new Error('network unreachable'));
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false });
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('work note')).toBeInTheDocument()); // wall mounted with the seeded rows
    const nav = within(screen.getByRole('navigation'));
    const li = nav.getByText('!INBOX').closest('li');
    expect(li).not.toBeNull();
    expect(li?.querySelector('.count')?.textContent).toBe('2'); // capture count chip next to the node
  });
});

describe('voice retry storm guard (kimi audit 5.1: 1s debounce + in-flight ref)', () => {
  const retryCalls = () => invoke.mock.calls.filter((c) => c[0] === 'voice_retry_pending').length;
  const onlineBurst = (n: number) => {
    for (let i = 0; i < n; i++) window.dispatchEvent(new Event('online'));
  };

  it('debounces a rapid online burst: 3 events within the window fire exactly ONE retry pass (after the window)', async () => {
    vi.useFakeTimers();
    render(<App />);
    await act(async () => {}); // settle the mount promise chain inside act
    onlineBurst(3);
    expect(retryCalls()).toBe(0); // inside the debounce window: nothing has fired yet
    act(() => { vi.advanceTimersByTime(1000); });
    expect(retryCalls()).toBe(1); // the whole burst coalesces into exactly ONE pass
  });

  it('in-flight guard: a second burst while a pass is still pending stays at ONE invoke; the guard unblocks after it resolves', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    // re-mock EVERY command the App mount touches (test-local overrides REPLACE
    // the whole beforeEach impl — mock fall-through class) + hold the retry pass
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_retry_pending') return gate;
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
      if (cmd === 'list_notes') return Promise.resolve([]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false });
      if (cmd === 'voice_list_unsaved') return Promise.resolve([]);
      if (cmd === 'list_agenda') return Promise.resolve([]);
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: 'https://ai.example.com', model: 'm', languageHint: '', apiPathSuffix: 'v1', hasKey: true });
      if (cmd === 'ai_get_models') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    vi.useFakeTimers();
    render(<App />);
    await act(async () => {});
    onlineBurst(3);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(retryCalls()).toBe(1); // the first pass started and hangs on the gate
    onlineBurst(2);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(retryCalls()).toBe(1); // guard holds: no SECOND pass while the first is in flight
    release();
    await act(async () => {}); // drain the .catch/.finally chain so the guard releases
    onlineBurst(1);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(retryCalls()).toBe(2); // a NEW burst after the pass resolved may run the next pass
  });

  // Whole-branch-review MX1 catch: the in-flight guard absorbs stacked timers,
  // so the burst-coalescing test alone cannot distinguish a working debounce
  // from guard-only compensation. The RESET law pins the debounce itself: an
  // event INSIDE the window re-arms it — no pass may start mid-burst.
  it('an online event inside the debounce window resets it — no fire before the settled window closes', async () => {
    vi.useFakeTimers();
    render(<App />);
    await act(async () => {});
    onlineBurst(1);
    act(() => { vi.advanceTimersByTime(900); });
    expect(retryCalls()).toBe(0); // 100ms inside the window: nothing yet
    onlineBurst(1);               // second event RESETS the timer to now+1000
    act(() => { vi.advanceTimersByTime(900); });
    expect(retryCalls()).toBe(0); // t=1800: the reset window (closes t=1900) is still open — no mid-burst fire
    act(() => { vi.advanceTimersByTime(100); });
    expect(retryCalls()).toBe(1); // t=1900: the SETTLED window closes — exactly one pass for the whole storm
  });
});

describe('triage integration (capture P2 T5)', () => {
  // !INBOX note fixtures carry createdAt: TriageView sorts + ages cards
  const zoneNote = (id: string, title: string, content: string, category: string, createdAt: string) =>
    ({ id, title, content, category, createdAt, updatedAt: createdAt, deletedAt: null, dirty: false, audioPath: null, audioDurationSecs: null });

  it('selecting the !INBOX category renders TriageView instead of NoteList', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
      if (cmd === 'list_notes') return Promise.resolve([
        zoneNote('cap1', 'cap_9_aaaa', 'renew the vpn cert this week', '!INBOX', '2026-10-07T10:00:00.000Z'),
        zoneNote('cap2', 'cap_9_zzzz', 'book the dentist', '!INBOX/kitchen', '2026-10-07T09:00:00.000Z'),
        { id: 'home1', title: 'Groceries', content: 'milk', category: 'Home', updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null, dirty: false, audioPath: null, audioDurationSecs: null },
      ]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [{ name: '!INBOX', path: '!INBOX', count: 2, level: 0 }], checklists: [] });
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false });
      if (cmd === 'voice_list_unsaved') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument()); // wall settled first
    act(() => { useStore.getState().selectCategory({ type: 'notes', path: '!INBOX' }); });
    // the wall swaps to the triage surface
    await waitFor(() => expect(screen.getByText('Triage')).toBeInTheDocument());
    expect(screen.getByText('cap_9_aaaa')).toBeInTheDocument(); // zone rows surface as triage cards
    expect(screen.getByText('cap_9_zzzz')).toBeInTheDocument(); // nested zone rows too (startsWith zone law)
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument(); // the notes wall (NoteList) unmounted
    expect(document.querySelector('#triage')).not.toBeNull();
  });

  it('the plain notes wall is untouched — no triage swap without an inbox selection', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    expect(screen.queryByText('Triage')).not.toBeInTheDocument(); // default wall keeps the card view
    expect(document.querySelector('#triage')).toBeNull();
  });

  it('Ctrl+Shift+I opens the triage surface from anywhere', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'I', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByText('Triage')).toBeInTheDocument());
    // the base mock carries no !INBOX rows — the triage wall renders its empty state
    expect(screen.getByText('Inbox is empty 🎉')).toBeInTheDocument();
  });
});
