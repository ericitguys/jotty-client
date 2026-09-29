import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import KanbanBoard from './KanbanBoard';
import { ymd, dateLabel } from './calendarGrid';

// v0.22.2 reshape (WebKitGTK date-popup eradication): the native
// <input type="date"> is replaced by the pure-DOM DateDropdown everywhere.
// The native popup commits a day-pick but NEVER closes + keeps grabbing
// pointer/keyboard (probed 2026-09-29 — references/webkitgtk-datetime-probe.md);
// helpers drive the new picker flow: open the grid, navigate to the target
// day's month (empty/other-month values open on "today"), click the cell.
const pickDate = (ariaLabel: string, day: string) => {
  fireEvent.click(screen.getByRole('button', { name: ariaLabel }));
  let cell = screen.queryByRole('button', { name: day });
  let guard = 0;
  while (!cell && guard++ < 24) {
    // first IN-month cell anchors which month the grid currently shows
    const first = document.querySelector('.jotty-date-day:not(.dim)') as HTMLElement | null;
    if (!first) throw new Error('date grid did not open');
    const shown = first.getAttribute('aria-label')!.slice(0, 7); // 'YYYY-MM'
    fireEvent.click(screen.getByRole('button', { name: day.slice(0, 7) > shown ? 'Next month' : 'Previous month' }));
    cell = screen.queryByRole('button', { name: day });
  }
  if (!cell) throw new Error(`grid could not reach ${day}`);
  fireEvent.click(cell);
};
// value of the picker trigger = the picker's committed value (label mirrors it)
const dateTriggerText = (ariaLabel: string) => {
  const btn = screen.getByRole('button', { name: ariaLabel });
  return (btn.querySelector('.jotty-dropdown-label') as HTMLElement).textContent ?? '';
};

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
    // RESHAPED v0.22.2 (DateDropdown): the picker trigger mirrors the committed
    // value as a LOCALIZED label (dateLabel mirror — no native input remains)
    expect(dateTriggerText('Date (clearable)')).toBe(dateLabel('2026-10-01'));
    pickDate('Date (clearable)', '2026-10-05');
    expect(dateTriggerText('Date (clearable)')).toBe(dateLabel('2026-10-05'));
    fireEvent.click(screen.getByText('Save date'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_target_date', { checklistId: 'b1', itemLocalId: 'i1', targetDate: '2026-10-05' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('Set date via the Clear row saves null (clears the date)', async () => {
    const reload = vi.fn(async () => {});
    render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Set date'));
    expect(dateTriggerText('Date (clearable)')).toBe(dateLabel('2026-10-01'));
    // RESHAPED v0.22.2: clearing = the picker's Clear row (a native input had
    // no clear affordance at all on the broken webview); '' saves null
    fireEvent.click(screen.getByRole('button', { name: 'Date (clearable)' }));
    fireEvent.click(screen.getByText('Clear'));
    expect(dateTriggerText('Date (clearable)')).toBe('Pick a date');
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
    // RESHAPED v0.22.2: the date ask = the DateDropdown (label 'Date (optional)')
    pickDate('Date (optional)', '2026-10-05');
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
  // RESHAPED (2026-09-29, WebKitGTK probe): the single input[type=datetime-local]
  // is unusable on the Tauri Linux webview — every field click opens a days-only
  // calendar popup that GRABS keyboard+pointer, so segments can never be typed,
  // and picking a day auto-fills "now" as the time. Split editor: date input +
  // custom Time Dropdown (pure-DOM, engine-proof). Save stays DISABLED until
  // both parts are picked; the only clear path is the Back row (never a
  // partial-save null). The webview facts are frozen by the probe harness in
  // references/webkitgtk-datetime-probe.md (skill jotty-client).

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
    // split editor (v0.22.2): pure-DOM DateDropdown + the engine-proof Time dropdown
    const editor = container.querySelector('.kanban-reminder-edit') as HTMLElement;
    const dateTrigger = screen.getByRole('button', { name: 'Reminder date' });
    expect(editor).toContainElement(dateTrigger);
    expect(dateTrigger.querySelector('.jotty-dropdown-label')!.textContent).toBe('Pick a date'); // no existing reminder -> empty prefill
    // Save is DISABLED until date AND time are picked (no half-saves, ever)
    const editorSave = screen.getByRole('button', { name: 'Save reminder' }) as HTMLButtonElement;
    expect(editorSave.disabled).toBe(true);
    // pick the time via the Dropdown (role=option rows, same as board pickers)
    fireEvent.click(screen.getByRole('button', { name: 'Reminder time' }));
    fireEvent.click(screen.getByRole('option', { name: '09:30 AM' }));
    // date picked via the calendar grid (RESHAPE v0.22.2 — the native input's
    // popup never closes on the webview; the pure-DOM picker commits + closes)
    const typedDate = '2026-10-05';
    pickDate('Reminder date', typedDate);
    expect(editorSave.disabled).toBe(false);
    fireEvent.click(editorSave);
    // composed LOCAL wall time -> ISO carries the offset (TZ-robust assert)
    const expected = new Date(`${typedDate}T09:30:00`);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_reminder', { checklistId: 'b1', itemLocalId: 'i1', datetime: expected.toISOString() }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('date_without_time_save_blocked_never_clears', async () => {
    // THE WEBKITGTK REGRESSION FENCE: the single-field editor silently sent
    // null (a DELETE) when only a date was filled — its .value read '' while
    // incomplete. The split editor must hard-block: incomplete -> Save
    // disabled, no invoke, no clear, editor stays open.
    // No existing reminder (fresh appointment card = the user's exact case).
    // The old engine behavior: typed a date, time never entered -> whole
    // datetime-local read '' -> Save silently sent null. The split editor's
    // fence: date-only pick -> Save disabled + editor stays open + NO invoke
    // (nothing can be cleared that does not exist, and nothing saves half).
    reminderMock();
    const reload = vi.fn(async () => {});
    const { container } = render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Set reminder'));
    const editor = container.querySelector('.kanban-reminder-edit') as HTMLElement;
    // pick ONLY the date (the user's exact broken flow — RESHAPED v0.22.2:
    // the date arrives via the calendar grid now; the popup closes on pick,
    // so the user actually REACHES Save/Back this time)
    pickDate('Reminder date', '2026-10-05');
    expect(editor.querySelector('.kanban-reminder-hint')!.textContent).toMatch(/time/i); // names the missing TIME
    // incomplete (no time picked) -> Save stays disabled; clicking changes nothing
    const editorSave = screen.getByRole('button', { name: 'Save reminder' }) as HTMLButtonElement;
    expect(editorSave.disabled).toBe(true);
    fireEvent.click(editorSave); // no-op on a disabled button
    // NO invoke, editor stays open
    expect(invoke.mock.calls.some((c) => c[0] === 'set_item_reminder')).toBe(false);
    expect(container.querySelector('.kanban-reminder-edit')).not.toBeNull();
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

  it('editor_prefills_both_parts_of_existing_reminder', async () => {
    reminderMock();
    const reload = vi.fn(async () => {});
    // production fixture: Z-form ISO (upstream writes toISOString(); T7.1 reshape from the offset-less fixture)
    const fixture = '2026-10-01T07:00:00.000Z';
    const withReminder = [{ ...items[0], priority: null, targetDate: null, children: [], reminderDatetime: fixture, reminderNotified: null }];
    const { container } = render(<KanbanBoard checklistId="b1" items={withReminder} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Set reminder'));
    const editor = container.querySelector('.kanban-reminder-edit') as HTMLElement;
    // RESHAPED v0.22.2: date part prefill lands on the DateDropdown trigger
    // (label mirrors the committed value; TZ-robust computed in-test)
    const fd = new Date(fixture);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedDate = `${fd.getFullYear()}-${pad(fd.getMonth() + 1)}-${pad(fd.getDate())}`;
    const dateTrigger = screen.getByRole('button', { name: 'Reminder date' });
    expect(dateTriggerText('Reminder date')).toBe(dateLabel(expectedDate));
    // the calendar grid opens ON the stored reminder's month (never 'now')
    fireEvent.click(dateTrigger);
    expect((editor.querySelector('.jotty-date-header > span') as HTMLElement).textContent).toContain(
      new Date(fd.getFullYear(), fd.getMonth(), 15).toLocaleString([], { month: 'long', year: 'numeric' }),
    );
    fireEvent.keyDown(document, { key: 'Escape' }); // close the grid; the prefill stays
    // time part prefilled rounded UP to the next quarter-hour on the 12h dropdown label
    expect(screen.getByText('Back')).toBeTruthy();
    const editorSave = screen.getByRole('button', { name: 'Save reminder' }) as HTMLButtonElement;
    expect(editorSave.disabled).toBe(false); // parts complete after prefill
    // minute hand: whatever the exact prefill minute, the ROUND to quarter grid
    // maps every wall time to a valid option (no silent value drift)
    fireEvent.click(editorSave);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_reminder', { checklistId: 'b1', itemLocalId: 'i1', datetime: expect.any(String) }));
    const call = invoke.mock.calls.find((c) => c[0] === 'set_item_reminder');
    const sent = (call![1] as { datetime: string }).datetime;
    // instant may shift <=15min up by the round — assert the DATE survives exactly
    expect(sent.slice(0, 10)).toBe(`${fd.getFullYear()}-${pad(fd.getMonth() + 1)}-${pad(fd.getDate())}`);
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('back_without_save_does_not_invoke', async () => {
    reminderMock();
    const reload = vi.fn(async () => {});
    const { container } = render(<KanbanBoard checklistId="b1" items={items} reload={reload} />);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByText('alpha'));
    fireEvent.click(screen.getByText('Set reminder'));
    expect(container.querySelector('.kanban-reminder-edit')).not.toBeNull();
    fireEvent.click(screen.getByText('Back'));
    // Back never invokes: set_item_reminder NOT called
    expect(invoke.mock.calls.some((c) => c[0] === 'set_item_reminder')).toBe(false);
    // menu rows visible again
    expect(screen.getByText('Set reminder')).toBeInTheDocument();
    expect(screen.getByText('Rename')).toBeInTheDocument();
  });
});