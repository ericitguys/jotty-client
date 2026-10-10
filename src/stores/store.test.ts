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

describe('store.stalePieces', () => {
  it('marks categories stale when server is reachable but listCategories fails', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instanceUrl: 'http://srv', version: '1' });
      if (cmd === 'list_categories') return Promise.reject(new Error('boom'));
      if (cmd === 'get_prefs') return Promise.resolve({
        preferredTheme: null, defaultNoteFilter: null, defaultChecklistFilter: null,
        checklistItemClickAction: null, hideConnectionIndicator: null, pinnedNotes: [], pinnedLists: [],
      });
      if (cmd === 'get_branding') return Promise.resolve({ name: null, iconDataUrl: null, themeColor: null });
      return Promise.resolve([]);
    });
    await useStore.getState().refreshAll();
    expect(useStore.getState().stalePieces).toEqual({ categories: true, prefs: false, branding: false });
  });

  it('clears stale flags after a fully successful refresh', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instanceUrl: 'http://srv', version: '1' });
      if (cmd === 'list_categories') return Promise.reject(new Error('boom'));
      return Promise.resolve([]);
    });
    await useStore.getState().refreshAll();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instanceUrl: 'http://srv', version: '1' });
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'get_prefs') return Promise.resolve({
        preferredTheme: null, defaultNoteFilter: null, defaultChecklistFilter: null,
        checklistItemClickAction: null, hideConnectionIndicator: null, pinnedNotes: [], pinnedLists: [],
      });
      if (cmd === 'get_branding') return Promise.resolve({ name: null, iconDataUrl: null, themeColor: null });
      return Promise.resolve([]);
    });
    await useStore.getState().refreshAll();
    expect(useStore.getState().stalePieces).toEqual({ categories: false, prefs: false, branding: false });
  });

  it('does not mark stale on an offline start (connection is null)', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve(null);
      if (cmd === 'list_categories') return Promise.reject(new Error('offline'));
      return Promise.resolve([]);
    });
    await useStore.getState().refreshAll();
    expect(useStore.getState().stalePieces).toEqual({ categories: false, prefs: false, branding: false });
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

  it('targetBoardId: no create_task_board — cards go to the existing board, which gets selected', async () => {
    const calls: string[] = [];
    invoke.mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd === 'voice_save_note') return Promise.resolve(noteRow);
      if (cmd === 'add_item') return Promise.resolve({});
      return Promise.resolve(null);
    });
    const res = await useStore.getState().saveVoiceNoteWithBoard({ ...input, targetBoardId: 'b9' });
    expect(res).toEqual({ noteId: 'n1', boardId: 'b9' });
    expect(calls.filter(isFlowCmd)).toEqual(['voice_save_note', 'add_item', 'add_item']);
    expect(calls).not.toContain('create_task_board');
    expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'b9', text: 'Buy milk', parentLocalId: null, status: null });
    expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'b9', text: 'Call dentist', parentLocalId: null, status: null });
    // the target board is opened AFTER the adds land (fresh view fetches them) and the sidebar refreshes
    expect(useStore.getState().selectedChecklistId).toBe('b9');
    expect(useStore.getState().listMode).toBe('checklists');
  });

  it('targetBoardId + noteSavedId retry: adds to the existing board without re-saving the note', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'add_item') return Promise.resolve({});
      return Promise.resolve(null);
    });
    await useStore.getState().saveVoiceNoteWithBoard({ ...input, targetBoardId: 'b9', noteSavedId: 'n1' });
    expect(invoke).not.toHaveBeenCalledWith('voice_save_note', expect.anything());
    expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'b9', text: 'Buy milk', parentLocalId: null, status: null });
    expect(useStore.getState().selectedChecklistId).toBe('b9');
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

  it('appointment branch: one card + target date + reminder on the chosen board, no board create (appointments Task 8)', async () => {
    const calls: string[] = [];
    invoke.mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd === 'voice_save_note') return Promise.resolve(noteRow);
      // add_item returns ItemDto (commands add_item -> Result<ItemDto, String>):
      // the branch chains the returned localId directly — no store read-back.
      if (cmd === 'add_item') return Promise.resolve({ localId: 'i1', checklistId: 'b9', text: 'Dentist', completed: false, position: 0, dirty: true, children: [] });
      return Promise.resolve(null);
    });
    // WITH a time: create → set_item_target_date → set_item_reminder, all on i1.
    await useStore.getState().saveVoiceNoteWithBoard({
      ...input, tasks: [], targetBoardId: null,
      // panel shape: targetDate date-only, reminder = the composed local
      // datetime as an absolute instant (toISOString) — passed verbatim
      appointment: { title: 'Dentist', targetDate: '2026-10-01', reminderDatetime: new Date('2026-10-01T09:00:00').toISOString(), boardId: 'b9' },
    });
    expect(calls).not.toContain('create_task_board');
    expect(useStore.getState().selectedChecklistId).toBe('b9');
    expect(useStore.getState().listMode).toBe('checklists');
    // addItem passes the title verbatim (the panel validates non-empty) with no
    // targetDate — the date rides the separate set_item_target_date op.
    expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'b9', text: 'Dentist', parentLocalId: null, status: null });
    expect(invoke).toHaveBeenCalledWith('set_item_target_date', { checklistId: 'b9', itemLocalId: 'i1', targetDate: '2026-10-01' });
    expect(invoke).toHaveBeenCalledWith('set_item_reminder', { checklistId: 'b9', itemLocalId: 'i1', datetime: new Date('2026-10-01T09:00:00').toISOString() });
    const flow = calls.filter((c) => c !== 'get_connection' && c !== 'list_notes' && c !== 'list_checklists'
      && c !== 'list_categories' && c !== 'sync_status' && c !== 'get_prefs' && c !== 'get_branding');
    expect(flow).toEqual(['voice_save_note', 'add_item', 'set_item_target_date', 'set_item_reminder']);
    // date-only (no time): reminderDatetime null → NO set_item_reminder call.
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) => {
      calls.push(`2:${cmd}`);
      if (cmd === 'voice_save_note') return Promise.resolve(noteRow);
      if (cmd === 'add_item') return Promise.resolve({ localId: 'i2', checklistId: 'b9', text: 'Checkup', completed: false, position: 0, dirty: true, children: [] });
      return Promise.resolve(null);
    });
    await useStore.getState().saveVoiceNoteWithBoard({
      ...input, tasks: [], targetBoardId: null,
      appointment: { title: 'Checkup', targetDate: '2026-10-02', reminderDatetime: null, boardId: 'b9' },
    });
    expect(invoke).toHaveBeenCalledWith('set_item_target_date', { checklistId: 'b9', itemLocalId: 'i2', targetDate: '2026-10-02' });
    expect(calls.filter((c) => c.startsWith('2:')).filter((c) => c === '2:set_item_reminder')).toHaveLength(0);
  });
});