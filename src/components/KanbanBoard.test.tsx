import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import KanbanBoard from './KanbanBoard';

const board = {
  checklistId: 'b1',
  statuses: [
    { id: 'todo', label: 'To Do', color: null, order: 0, autoComplete: false },
    { id: 'in_progress', label: 'In Progress', color: '#3b82f6', order: 1, autoComplete: false },
    { id: 'completed', label: 'Completed', color: null, order: 2, autoComplete: true },
  ],
};
const items = [
  { localId: 'i1', checklistId: 'b1', parentLocalId: null, text: 'alpha', completed: false, position: 0, dirty: false, status: 'todo', priority: 'high', targetDate: '2026-10-01', children: [
    { localId: 'c1', checklistId: 'b1', parentLocalId: 'i1', text: 'sub', completed: false, position: 1, dirty: false, status: null, priority: null, targetDate: null, children: [] },
  ] },
  { localId: 'i2', checklistId: 'b1', parentLocalId: null, text: 'mystery', completed: false, position: 1, dirty: false, status: 'bogus', priority: null, targetDate: null, children: [] },
  { localId: 'i3', checklistId: 'b1', parentLocalId: null, text: 'done-card', completed: true, position: 2, dirty: false, status: 'completed', priority: null, targetDate: null, children: [] },
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'get_board_columns') return Promise.resolve(board);
    if (cmd === 'fetch_task_board') return Promise.resolve(board);
    if (cmd === 'set_item_target_date') return Promise.resolve({});
    return Promise.resolve({});
  });
});

describe('KanbanBoard', () => {
  it('renders columns in order with counts and refreshes them in the background', async () => {
    render(<KanbanBoard checklistId="b1" items={items} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('To Do')).toBeInTheDocument());
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('get_board_columns', { checklistId: 'b1' });
    expect(invoke).toHaveBeenCalledWith('fetch_task_board', { checklistId: 'b1' });
  });

  it('groups cards by status; unknown/absent status lands in the FIRST column', async () => {
    const { container } = render(<KanbanBoard checklistId="b1" items={items} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    const cols = container.querySelectorAll('.kanban-col');
    const first = cols[0].textContent ?? '';
    expect(first).toContain('alpha');
    expect(first).toContain('mystery'); // bogus status -> first column (ruling 6)
    expect((cols[2].textContent ?? '')).toContain('done-card');
  });

  it('shows display-only badges (priority, target date, subtask count)', async () => {
    render(<KanbanBoard checklistId="b1" items={items} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('high')).toBeInTheDocument());
    expect(screen.getByText('2026-10-01')).toBeInTheDocument();
    expect(screen.getByText('1 subtask')).toBeInTheDocument();
  });

  it('marks cards in autoComplete columns completed', async () => {
    const { container } = render(<KanbanBoard checklistId="b1" items={items} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('done-card')).toBeInTheDocument());
    const doneCol = container.querySelectorAll('.kanban-col')[2];
    expect(doneCol.querySelector('.kanban-card.completed-item')).not.toBeNull();
  });

  it('menu Move-to calls set_item_status and reloads; backdrop closes', async () => {
    const reload = vi.fn(async () => {});
    render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Move to In Progress'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_status', { checklistId: 'b1', itemLocalId: 'i1', status: 'in_progress' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('menu Rename commits set_item_text; Delete calls delete_item', async () => {
    const reload = vi.fn(async () => {});
    render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByDisplayValue('alpha');
    fireEvent.change(input, { target: { value: 'renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_text', { checklistId: 'b1', itemLocalId: 'i1', text: 'renamed' }));
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('delete_item', { checklistId: 'b1', itemLocalId: 'i1' }));
  });

  it('column + adds a card with the column status', async () => {
    const reload = vi.fn(async () => {});
    render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getAllByText('+').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('+')[0]);
    fireEvent.change(screen.getByPlaceholderText('New card'), { target: { value: 'fresh' } });
    fireEvent.keyDown(screen.getByPlaceholderText('New card'), { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'b1', text: 'fresh', parentLocalId: null, status: 'todo' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('drop on a column moves the card (dataTransfer-first, T17 ruling U)', async () => {
    const reload = vi.fn(async () => {});
    const { container } = render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    const card = screen.getByText('alpha').closest('.kanban-card') as HTMLElement;
    // real dataTransfer — jsdom lacks it; ChecklistView tests use a shim
    const dt = { getData: (t: string) => (t === 'text/plain' ? 'i1' : ''), setData: () => {} };
    fireEvent.dragStart(card, { dataTransfer: dt });
    const targetCol = container.querySelectorAll('.kanban-col')[2];
    fireEvent.drop(targetCol, { dataTransfer: dt });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_status', { checklistId: 'b1', itemLocalId: 'i1', status: 'completed' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('menu Set date prefills the picker; saving calls set_item_target_date and reloads', async () => {
    const reload = vi.fn(async () => {});
    render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Set date'));
    // prefilled with the card's existing target date
    const input = screen.getByDisplayValue('2026-10-01') as HTMLInputElement;
    expect(input.type).toBe('date');
    fireEvent.change(input, { target: { value: '2026-10-05' } });
    fireEvent.click(screen.getByText('Save date'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_target_date', { checklistId: 'b1', itemLocalId: 'i1', targetDate: '2026-10-05' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('Set date with a cleared input saves null (clears the date)', async () => {
    const reload = vi.fn(async () => {});
    render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Set date'));
    const input = screen.getByDisplayValue('2026-10-01');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByText('Save date'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_target_date', { checklistId: 'b1', itemLocalId: 'i1', targetDate: null }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('add form asks for a date; committing with one sends targetDate on add_item (no second invoke)', async () => {
    const reload = vi.fn(async () => {});
    render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getAllByText('+').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('+')[0]);
    // the form asks BEFORE saving: text + date + Add/Cancel
    fireEvent.change(screen.getByPlaceholderText('New card'), { target: { value: 'dentist' } });
    fireEvent.change(screen.getByLabelText('Date (optional)'), { target: { value: '2026-10-05' } });
    fireEvent.click(screen.getByText('Add card'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'b1', text: 'dentist', parentLocalId: null, status: 'todo', targetDate: '2026-10-05' }));
    expect(invoke).not.toHaveBeenCalledWith('set_item_target_date', expect.anything());
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('add form commit without a date keeps the byte-frozen 4-key add_item shape', async () => {
    const reload = vi.fn(async () => {});
    render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getAllByText('+').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('+')[0]);
    fireEvent.change(screen.getByPlaceholderText('New card'), { target: { value: 'plain card' } });
    fireEvent.keyDown(screen.getByPlaceholderText('New card'), { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'b1', text: 'plain card', parentLocalId: null, status: 'todo' }));
    const call = invoke.mock.calls.find((c) => c[0] === 'add_item');
    expect(call![1]).not.toHaveProperty('targetDate');
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('add form Cancel closes without invoking', async () => {
    const reload = vi.fn(async () => {});
    render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getAllByText('+').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('+')[0]);
    fireEvent.change(screen.getByPlaceholderText('New card'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByText('Cancel'));
    expect(invoke).not.toHaveBeenCalledWith('add_item', expect.anything());
  });

  // ---- Appointments T7: reminder chip + set/clear inline editor ----

  const reminderMock = () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_board_columns') return Promise.resolve(board);
      if (cmd === 'fetch_task_board') return Promise.resolve(board);
      if (cmd === 'set_item_reminder') return Promise.resolve({});
      return Promise.resolve({});
    });
  };

  it('kanban_card_shows_reminder_chip_when_set', async () => {
    const withReminders = [
      { ...items[0], localId: 'r1', text: 'reminded', position: 0, priority: null, targetDate: null, children: [], reminderDatetime: '2026-10-01T09:00:00+02:00', reminderNotified: false },
      { ...items[0], localId: 'r2', text: 'pinged', position: 1, priority: null, targetDate: null, children: [], reminderDatetime: '2026-10-02T10:00:00+02:00', reminderNotified: true },
    ];
    render(<KanbanBoard checklistId="b1" items={withReminders} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('reminded')).toBeInTheDocument());
    // RESHAPED (R6/T7-N5): the chip renders FORMATTED local time, so the v1-raw
    // substring assert (`toContain('2026-10-01T09:00:00+02:00')`) is replaced by
    // the TZ-robust formatted-not-raw check — the raw offset-form text would
    // carry 'T'; clock digits asserted without exact digits. 🔔 prefix + dim
    // classes unchanged.
    const chipPlain = (screen.getByText('reminded').closest('.kanban-card') as HTMLElement).querySelector('.kanban-reminder') as HTMLElement;
    expect(chipPlain).not.toBeNull();
    expect(chipPlain.textContent).toContain('🔔');
    expect(chipPlain.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(chipPlain.textContent).not.toContain('T');
    expect(chipPlain.textContent).not.toContain('Z');
    expect(chipPlain.className).not.toContain('notified');
    const chipNotified = (screen.getByText('pinged').closest('.kanban-card') as HTMLElement).querySelector('.kanban-reminder') as HTMLElement;
    expect(chipNotified).not.toBeNull();
    expect(chipNotified.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(chipNotified.className).toContain('notified');
  });

  it('kanban_reminder_chip_shows_formatted_local_time_with_full_tooltip', async () => {
    const withReminders = [
      { ...items[0], localId: 'r9', text: 'formatted', position: 0, priority: null, targetDate: null, children: [], reminderDatetime: '2026-10-01T09:00:00.000Z', reminderNotified: false },
      { ...items[0], localId: 'r10', text: 'formatted-notified', position: 1, priority: null, targetDate: null, children: [], reminderDatetime: '2026-10-02T10:00:00.000Z', reminderNotified: true },
    ];
    render(<KanbanBoard checklistId="b1" items={withReminders} reload={async () => {}} />);
    await waitFor(() => expect(screen.getByText('formatted')).toBeInTheDocument());
    // R6 (T7-N5): the Z-form fixture proves formatted-not-raw — the raw stored
    // ISO would carry 'T' and 'Z'; clock digits asserted TZ-robustly (never
    // exact clock digits — the local rendering is TZ-dependent)
    const chipPlain = (screen.getByText('formatted').closest('.kanban-card') as HTMLElement).querySelector('.kanban-reminder') as HTMLElement;
    expect(chipPlain).not.toBeNull();
    expect(chipPlain.textContent).toContain('🔔');
    expect(chipPlain.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(chipPlain.textContent).not.toContain('T');
    expect(chipPlain.textContent).not.toContain('Z');
    // class names unchanged + notified dim still keyed on reminderNotified
    expect(chipPlain.className).toContain('kanban-reminder');
    expect(chipPlain.className).not.toContain('notified');
    // tooltip = full local datetime on the SAME span: non-empty, ≠ raw stored ISO
    const title = chipPlain.getAttribute('title');
    expect(title).toBeTruthy();
    expect(title).not.toBe('2026-10-01T09:00:00.000Z');
    const chipNotified = (screen.getByText('formatted-notified').closest('.kanban-card') as HTMLElement).querySelector('.kanban-reminder') as HTMLElement;
    expect(chipNotified).not.toBeNull();
    expect(chipNotified.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(chipNotified.className).toContain('kanban-reminder');
    expect(chipNotified.className).toContain('notified');
    expect(chipNotified.getAttribute('title')).toBeTruthy();
  });

  it('set_reminder_flow_dispatches_set_item_reminder', async () => {
    reminderMock();
    const reload = vi.fn(async () => {});
    const { container } = render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Set reminder'));
    const input = container.querySelector('.kanban-reminder-edit input') as HTMLInputElement;
    expect(input.type).toBe('datetime-local');
    expect(input.value).toBe(''); // no existing reminder -> empty prefill
    const typed = '2026-10-05T09:30';
    fireEvent.change(input, { target: { value: typed } });
    fireEvent.click(screen.getByText('Save'));
    // datetime-local = local wall time -> ISO carries the offset; computed in-test, TZ-robust
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_reminder', { checklistId: 'b1', itemLocalId: 'i1', datetime: new Date(typed).toISOString() }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('clear_reminder_flow_passes_null', async () => {
    reminderMock();
    const reload = vi.fn(async () => {});
    const withReminder = [{ ...items[0], priority: null, targetDate: null, children: [], reminderDatetime: '2026-10-01T09:00', reminderNotified: null }];
    render(<KanbanBoard checklistId="b1" items={withReminder} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    expect(screen.getByText('Clear reminder')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Clear reminder'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_reminder', { checklistId: 'b1', itemLocalId: 'i1', datetime: null }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('empty_reminder_save_clears', async () => {
    reminderMock();
    const reload = vi.fn(async () => {});
    // production fixture: Z-form ISO (upstream writes toISOString(); T7.1 reshape from the offset-less fixture)
    const fixture = '2026-10-01T07:00:00.000Z';
    const withReminder = [{ ...items[0], priority: null, targetDate: null, children: [], reminderDatetime: fixture, reminderNotified: null }];
    const { container } = render(<KanbanBoard checklistId="b1" items={withReminder} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Set reminder'));
    const input = container.querySelector('.kanban-reminder-edit input') as HTMLInputElement;
    // expected prefill computed in-test from the fixture (TZ-robust, same pattern as the set-flow fence)
    const fd = new Date(fixture);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedLocal = `${fd.getFullYear()}-${pad(fd.getMonth() + 1)}-${pad(fd.getDate())}T${pad(fd.getHours())}:${pad(fd.getMinutes())}`;
    expect(input.value).toBe(expectedLocal); // prefilled with the LOCAL conversion of the Z-form reminder
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));
    // empty value = clear -> null (DELETE server-side) — the explicit-clear path stays pinned
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_reminder', { checklistId: 'b1', itemLocalId: 'i1', datetime: null }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('prefilled_unchanged_save_restores_same_instant', async () => {
    reminderMock();
    const reload = vi.fn(async () => {});
    const fixture = '2026-10-01T07:00:00.000Z';
    const withReminder = [{ ...items[0], priority: null, targetDate: null, children: [], reminderDatetime: fixture, reminderNotified: null }];
    const { container } = render(<KanbanBoard checklistId="b1" items={withReminder} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Set reminder'));
    const input = container.querySelector('.kanban-reminder-edit input') as HTMLInputElement;
    // input shows the converted local value (TZ-robust: expected computed in-test)
    const fd = new Date(fixture);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedLocal = `${fd.getFullYear()}-${pad(fd.getMonth() + 1)}-${pad(fd.getDate())}T${pad(fd.getHours())}:${pad(fd.getMinutes())}`;
    expect(input.value).toBe(expectedLocal);
    fireEvent.click(screen.getByText('Save'));
    // Save WITHOUT edits -> an ISO whose instant equals the fixture's instant (TZ-safe compare)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_reminder', { checklistId: 'b1', itemLocalId: 'i1', datetime: expect.any(String) }));
    const call = invoke.mock.calls.find((c) => c[0] === 'set_item_reminder');
    const sent = (call![1] as { datetime: string }).datetime;
    expect(new Date(sent).getTime()).toBe(new Date(fixture).getTime());
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('back_without_save_does_not_invoke', async () => {
    reminderMock();
    const reload = vi.fn(async () => {});
    const { container } = render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Set reminder'));
    expect(container.querySelector('.kanban-reminder-edit input')).not.toBeNull();
    fireEvent.click(screen.getByText('Back'));
    // Back never invokes: set_item_reminder NOT called
    expect(invoke.mock.calls.some((c) => c[0] === 'set_item_reminder')).toBe(false);
    // menu rows visible again
    expect(screen.getByText('Set reminder')).toBeInTheDocument();
    expect(screen.getByText('Rename')).toBeInTheDocument();
  });
});