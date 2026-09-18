import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => async () => {}) }));

import App from './App';
import { useStore } from './stores/store';

beforeEach(() => {
  invoke.mockReset();
  // the store is a module singleton — UI state leaks between tests without a reset
  useStore.setState({ selectedCategory: null, selectedNoteId: null, selectedChecklistId: null, listMode: 'notes' });
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
    if (cmd === 'list_notes') return Promise.resolve([{ id: 'n1', title: 'Groceries', content: 'milk', category: 'Home', updatedAt: '2026-01-01T00:00:00.000Z', dirty: false }]);
    if (cmd === 'list_checklists') return Promise.resolve([{ id: 'l1', title: 'Errands', category: 'Home', dirty: false }]);
    if (cmd === 'list_categories') return Promise.resolve({ notes: [{ name: 'Home', path: 'Home', count: 1, level: 0 }], checklists: [] });
    if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: '2026-01-01T00:00:00.000Z', syncing: false });
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

  it('clicking a checklist category shows the checklists list, not the open note', async () => {
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
    // browse the Trips checklist category -> editor closes, filtered checklists show
    fireEvent.click(within(screen.getByRole('navigation')).getByText('Trips'));
    await waitFor(() => expect(screen.queryByPlaceholderText('Note title')).not.toBeInTheDocument());
    expect(screen.queryByText('Errands')).not.toBeInTheDocument(); // filtered out
    expect(screen.getByText('Packing list')).toBeInTheDocument();
  });

  it('settings button opens settings mode', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Settings'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument());
  });
});
