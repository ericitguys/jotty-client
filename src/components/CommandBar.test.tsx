import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import CommandBar from './CommandBar';
import { useStore } from '../stores/store';

const LABELS = ['New note', 'New checklist', 'New board', 'New voice note', 'Sync now', 'Toggle theme', 'Open settings'];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'search')
      return Promise.resolve({
        notes: [{ id: 'n1', title: 'Groceries', snippet: 'milk and eggs' }],
        checklists: [{ id: 'b9', title: 'Home Reno', itemText: 'kitchen' }],
      });
    if (cmd === 'create_note') return Promise.resolve({ id: 'n9', title: 'Untitled note', category: 'Uncategorized' });
    if (cmd === 'create_checklist') return Promise.resolve({ id: 'c9', title: 'New checklist', category: 'Uncategorized' });
    if (cmd === 'create_task_board') return Promise.resolve({ id: 'k9', title: 'New board', category: 'Uncategorized' });
    return Promise.resolve(null);
  });
  // store is a module singleton — reset the fields THIS component reads
  useStore.setState({
    connection: { instance_url: 'http://127.0.0.1:1', has_api_key: true } as never,
    checklists: [{ id: 'b9', title: 'Home Reno', listType: 'kanban' } as never],
    themeOverride: null as never,
    setThemeOverride: vi.fn(),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    createNote: vi.fn().mockResolvedValue({ id: 'n9' }),
    createChecklist: vi.fn().mockResolvedValue({ id: 'c9' }),
    createBoard: vi.fn().mockResolvedValue({ id: 'k9' }),
  } as never);
});

describe('CommandBar — commands', () => {
  it('empty query renders exactly the 7 pinned commands and no results', () => {
    render(<CommandBar onClose={() => {}} onSelectNote={() => {}} onSelectChecklist={() => {}} />);
    for (const label of LABELS) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText('Groceries')).toBeNull();
  });

  it('Enter on an active command row runs it (New note) and closes', async () => {
    const onClose = vi.fn();
    useStore.setState({ createNote: vi.fn().mockResolvedValue({ id: 'n9' }) } as never);
    render(<CommandBar onClose={onClose} onSelectNote={() => {}} onSelectChecklist={() => {}} />);
    const input = screen.getByPlaceholderText('Search commands and notes…');
    fireEvent.keyDown(input, { key: 'Enter' }); // active=0 on empty query = first command
    await waitFor(() => expect(useStore.getState().createNote).toHaveBeenCalledWith('Untitled note', 'Uncategorized'));
    expect(onClose).toHaveBeenCalled();
  });

  it('typing filters commands AND debounces search results below them', async () => {
    render(<CommandBar onClose={() => {}} onSelectNote={() => {}} onSelectChecklist={() => {}} />);
    const input = screen.getByPlaceholderText('Search commands and notes…');
    fireEvent.change(input, { target: { value: 'note' } });
    // 'note' still matches 'New note' (label containment)…
    await waitFor(() => expect(screen.getByText('New note')).toBeInTheDocument());
    // …and 200ms later the search results render below the commands
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    expect(screen.queryByText('Open settings')).toBeNull(); // filtered out
  });

  it('result rows navigate via the App callbacks (select note + close)', async () => {
    const onSelectNote = vi.fn();
    const onClose = vi.fn();
    render(<CommandBar onClose={onClose} onSelectNote={onSelectNote} onSelectChecklist={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Search commands and notes…'), { target: { value: 'groc' } });
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Groceries'));
    expect(onSelectNote).toHaveBeenCalledWith('n1');
    expect(onClose).toHaveBeenCalled();
  });

  it('board chip renders for a kanban-type checklist result (store-catalog derived) and opens the board', async () => {
    const onSelectChecklist = vi.fn();
    render(<CommandBar onClose={() => {}} onSelectNote={() => {}} onSelectChecklist={onSelectChecklist} />);
    fireEvent.change(screen.getByPlaceholderText('Search commands and notes…'), { target: { value: 'reno' } });
    await waitFor(() => expect(screen.getByText('Home Reno')).toBeInTheDocument());
    expect(screen.getByText('board')).toHaveClass('board-chip');
    fireEvent.click(screen.getByText('Home Reno'));
    expect(onSelectChecklist).toHaveBeenCalledWith('b9');
  });

  it('Sync now runs refreshAll through the store and closes', async () => {
    const onClose = vi.fn();
    useStore.setState({ refreshAll: vi.fn().mockResolvedValue(undefined) } as never);
    render(<CommandBar onClose={onClose} onSelectNote={() => {}} onSelectChecklist={() => {}} />);
    fireEvent.click(screen.getByText('Sync now'));
    await waitFor(() => expect(useStore.getState().refreshAll).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('Toggle theme cycles the override: null → dark', () => {
    useStore.setState({ themeOverride: null as never, setThemeOverride: vi.fn() } as never);
    render(<CommandBar onClose={() => {}} onSelectNote={() => {}} onSelectChecklist={() => {}} />);
    fireEvent.click(screen.getByText('Toggle theme'));
    expect(useStore.getState().setThemeOverride).toHaveBeenCalledWith('dark');
  });

  it('Open settings + New voice note route through the App-provided handlers and close', () => {
    const onOpenSettings = vi.fn();
    const onStartVoiceNote = vi.fn();
    const onClose = vi.fn();
    render(<CommandBar onClose={onClose} onSelectNote={() => {}} onSelectChecklist={() => {}}
                       onOpenSettings={onOpenSettings} onStartVoiceNote={onStartVoiceNote} />);
    fireEvent.click(screen.getByText('Open settings'));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    onClose.mockClear();
    fireEvent.click(screen.getByText('New voice note'));
    expect(onStartVoiceNote).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape closes the bar', () => {
    const onClose = vi.fn();
    render(<CommandBar onClose={onClose} onSelectNote={() => {}} onSelectChecklist={() => {}} />);
    fireEvent.keyDown(screen.getByPlaceholderText('Search commands and notes…'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('New checklist + New board run through the store actions', async () => {
    render(<CommandBar onClose={() => {}} onSelectNote={() => {}} onSelectChecklist={() => {}} />);
    fireEvent.click(screen.getByText('New checklist'));
    await waitFor(() => expect(useStore.getState().createChecklist).toHaveBeenCalledWith('New checklist', 'Uncategorized'));
    fireEvent.click(screen.getByText('New board'));
    await waitFor(() => expect(useStore.getState().createBoard).toHaveBeenCalledWith('New board', 'Uncategorized'));
  });
});