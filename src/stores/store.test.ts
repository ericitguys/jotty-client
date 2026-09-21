import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useStore } from './store';

beforeEach(() => {
  invoke.mockReset();
  // reset UI selections so a leaked selection from a prior test can't mask a
  // cold-start behavior (zustand is a module singleton)
  useStore.setState({
    connection: null,
    notes: [],
    checklists: [],
    categories: null,
    syncStatus: null,
    selectedNoteId: null,
    selectedChecklistId: null,
    selectedCategory: null,
    listMode: 'notes',
  });
});

describe('store.createBoard', () => {
  it('createBoard calls create_task_board, refreshes, and selects the new board', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'create_task_board') return Promise.resolve({ id: 'b1', title: 'New board', category: 'Work', dirty: false, completed: false, listType: 'kanban', items: [] });
      if (cmd === 'list_checklists') return Promise.resolve([]); // keep existing list mocks shape
      return Promise.resolve(null);
    });
    await useStore.getState().createBoard('New board', 'Work');
    expect(invoke).toHaveBeenCalledWith('create_task_board', { title: 'New board', category: 'Work' });
    expect(useStore.getState().selectedChecklistId).toBe('b1');
    expect(useStore.getState().listMode).toBe('checklists');
  });
});