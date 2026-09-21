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

describe('store.saveVoiceNoteWithBoard', () => {
  const boardRow = { id: 'b1', title: 'Errands', category: 'Home', dirty: false, completed: false, listType: 'kanban', items: [] };
  const noteRow = { id: 'n1', title: 'Memo', content: 'x', category: 'Home', audioPath: '/v/r1.wav', audioDurationSecs: 4, createdAt: null, updatedAt: null, deletedAt: null, dirty: true };
  const input = {
    recordingId: 'r1', noteId: null, title: 'Errands', category: 'Home',
    useTidied: false, text: 'buy milk, call dentist', tasks: ['Buy milk', 'Call dentist'],
  };
  // The flow's own commands, in order. refreshAll's catalog fetches
  // (get_connection/list_notes/... — fired once after the save, once inside
  // createBoard) ride the same invoke mock, so order/count asserts filter to
  // the flow commands the action is responsible for.
  const isFlowCmd = (c: string) => c === 'voice_save_note' || c === 'create_task_board' || c === 'add_item';

  it('saves the note first, then creates the board, then adds one card per task', async () => {
    const calls: string[] = [];
    invoke.mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd === 'voice_save_note') return Promise.resolve(noteRow);
      if (cmd === 'create_task_board') return Promise.resolve(boardRow);
      if (cmd === 'add_item') return Promise.resolve({});
      return Promise.resolve(null);
    });
    const res = await useStore.getState().saveVoiceNoteWithBoard(input);
    expect(res).toEqual({ noteId: 'n1', boardId: 'b1' });
    expect(calls.filter(isFlowCmd)).toEqual(['voice_save_note', 'create_task_board', 'add_item', 'add_item']);
    expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'b1', text: 'Buy milk', parentLocalId: null, status: null });
    expect(useStore.getState().selectedChecklistId).toBe('b1');
  });

  it('retranscribe mode saves via update_note', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'update_note') return Promise.resolve({ ...noteRow, id: 'n2' });
      if (cmd === 'create_task_board') return Promise.resolve(boardRow);
      if (cmd === 'add_item') return Promise.resolve({});
      return Promise.resolve(null);
    });
    await useStore.getState().saveVoiceNoteWithBoard({ ...input, recordingId: null, noteId: 'n2' });
    expect(invoke).toHaveBeenCalledWith('update_note', { id: 'n2', title: 'Errands', content: 'buy milk, call dentist', category: 'Home' });
  });

  it('board-stage failure rethrows with boardStage + noteId (note stays saved)', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_save_note') return Promise.resolve(noteRow);
      if (cmd === 'create_task_board') return Promise.reject('api error 400: nope');
      return Promise.resolve(null);
    });
    await expect(useStore.getState().saveVoiceNoteWithBoard(input)).rejects.toMatchObject({ boardStage: true, noteId: 'n1' });
  });

  it('retry with noteSavedId skips the save step entirely', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'create_task_board') return Promise.resolve(boardRow);
      if (cmd === 'add_item') return Promise.resolve({});
      return Promise.resolve(null);
    });
    await useStore.getState().saveVoiceNoteWithBoard({ ...input, noteSavedId: 'n1' });
    expect(invoke).not.toHaveBeenCalledWith('voice_save_note', expect.anything());
    expect(invoke).toHaveBeenCalledWith('create_task_board', { title: 'Errands', category: 'Home' });
  });

  it('empty title falls back to "Tasks from voice note" and empty task rows are filtered', async () => {
    const calls: string[] = [];
    invoke.mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd === 'voice_save_note') return Promise.resolve(noteRow);
      if (cmd === 'create_task_board') return Promise.resolve({ ...boardRow, id: 'b2' });
      if (cmd === 'add_item') return Promise.resolve({});
      return Promise.resolve(null);
    });
    await useStore.getState().saveVoiceNoteWithBoard({ ...input, title: '   ', tasks: ['  ', 'Real task', ''] });
    expect(invoke).toHaveBeenCalledWith('create_task_board', { title: 'Tasks from voice note', category: 'Home' });
    expect(calls.filter(isFlowCmd).length).toBe(3); // save + board + ONE add_item
  });
});