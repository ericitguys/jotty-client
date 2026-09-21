import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import ChecklistList from './ChecklistList';
import { useStore } from '../stores/store';

beforeEach(() => {
  invoke.mockReset();
  // + New board is disabled={!connection}: a disconnected store would swallow the click
  useStore.setState({ connection: { instanceUrl: 'http://localhost:1122', version: '1.25.0' }, selectedChecklistId: null });
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'create_checklist') {
      return Promise.resolve({ id: 'l9', title: 'New checklist', category: 'Uncategorized', createdAt: null, updatedAt: null, deletedAt: null, dirty: true, completed: false, listType: 'simple', items: [] });
    }
    if (cmd === 'create_task_board') {
      return Promise.resolve({ id: 'b9', title: 'New board', category: 'Uncategorized', createdAt: null, updatedAt: null, deletedAt: null, dirty: true, completed: false, listType: 'kanban', items: [] });
    }
    return Promise.resolve(null);
  });
});

describe('ChecklistList creation', () => {
  it('new checklist button calls create_checklist with default title and category', async () => {
    render(<ChecklistList checklists={[]} />);
    fireEvent.click(screen.getByText('+ New checklist'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_checklist', { title: 'New checklist', category: 'Uncategorized' }));
  });

  it('+ New board calls create_task_board via the store and renders the button', async () => {
    render(<ChecklistList checklists={[]} />);
    fireEvent.click(screen.getByText('+ New board'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_task_board', { title: 'New board', category: 'Uncategorized' }));
  });

  it('kanban-type lists show a board chip in the list', () => {
    render(<ChecklistList checklists={[
      { id: 'b1', title: 'Sprint', category: 'Work', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, completed: false, listType: 'kanban', items: [] },
      { id: 'l1', title: 'Errands', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, completed: false, listType: 'simple', items: [] },
    ]} />);
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]).getByText('board')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('board')).not.toBeInTheDocument();
  });
});