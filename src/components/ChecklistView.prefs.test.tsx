import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import ChecklistView from './ChecklistView';
import { useStore } from '../stores/store';

const items = [
  { localId: 'i1', checklistId: 'l1', parentLocalId: null, text: 'a', completed: false, position: 0, dirty: false, children: [] },
  { localId: 'i2', checklistId: 'l1', parentLocalId: null, text: 'b', completed: true, position: 1, dirty: false, children: [] },
];

beforeEach(() => {
  invoke.mockReset();
  useStore.setState({ prefs: null });
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'get_checklist') return Promise.resolve({ id: 'l1', title: 'L', category: 'Home', updatedAt: null, dirty: false, items });
    if (cmd === 'set_item_checked' || cmd === 'reorder_items' || cmd === 'add_item' || cmd === 'delete_item') return Promise.resolve({});
    return Promise.resolve(null);
  });
});

describe('ChecklistView click action preference', () => {
  it('clicking item text toggles by default (no prefs)', async () => {
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    fireEvent.click(screen.getByText('a'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_checked', { checklistId: 'l1', itemLocalId: 'i1', checked: true }));
  });

  it('clicking item text toggles when the web prefers toggle', async () => {
    useStore.setState({ prefs: { preferredTheme: null, defaultNoteFilter: null, defaultChecklistFilter: null, checklistItemClickAction: 'toggle', hideConnectionIndicator: null, pinnedNotes: [], pinnedLists: [] } });
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    fireEvent.click(screen.getByText('a'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_checked', { checklistId: 'l1', itemLocalId: 'i1', checked: true }));
  });

  it('clicking item text starts rename when the web prefers edit', async () => {
    useStore.setState({ prefs: { preferredTheme: null, defaultNoteFilter: null, defaultChecklistFilter: null, checklistItemClickAction: 'edit', hideConnectionIndicator: null, pinnedNotes: [], pinnedLists: [] } });
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    fireEvent.click(screen.getByText('a'));
    // no toggle happened
    expect(invoke).not.toHaveBeenCalledWith('set_item_checked', expect.anything());
    // the row's rename input got focus (click-to-edit)
    const renameInput = screen.getByDisplayValue('a');
    expect(document.activeElement).toBe(renameInput);
  });
});