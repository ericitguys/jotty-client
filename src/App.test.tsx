import { fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => async () => {}) }));

import App from './App';
import { useStore } from './stores/store';
import { listen } from '@tauri-apps/api/event';

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
    if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: 'https://ai.example.com', model: 'm', languageHint: '', apiPathSuffix: 'v1', hasKey: true });
    if (cmd === 'ai_get_models') return Promise.resolve([]);
    return Promise.resolve(null);
  });
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

  it('opening an item narrows the list beside its editor', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Groceries'));
    await waitFor(() => expect(screen.getByPlaceholderText('Note title')).toBeInTheDocument());
    expect(document.querySelector('main')).not.toHaveClass('list-only');
    expect(screen.getByText('Groceries')).toBeInTheDocument(); // the list stays visible beside the editor
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
    fireEvent.click(screen.getByText('🎙 New voice note'));
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
    fireEvent.click(screen.getByText('🎙 New voice note'));
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

  it('back button clears the open editor (mobile)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Groceries')); // open the editor
    await waitFor(() => expect(document.getElementById('note-editor')).toBeInTheDocument());
    expect(document.querySelector('main')).not.toHaveClass('list-only');
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }));
    await waitFor(() => expect(document.getElementById('note-editor')).not.toBeInTheDocument());
    expect(document.querySelector('main')).toHaveClass('list-only');
  });
});
