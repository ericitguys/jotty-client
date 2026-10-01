import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import AgendaView, { agendaDueLabel } from './AgendaView';
import { dateLabel } from './calendarGrid';
import { useStore } from '../stores/store';
import type { AgendaEntry } from '../api/types';

// Fixture dates are SEMANTIC (voice-run lesson): the component buckets by the
// local-time date key of new Date(iso), so every fixture is built from a live
// new Date() offset — hardcoded calendar dates would drift out of their bucket
// as the calendar moves. Full ISO strings (with a time part) parse to the
// exact instant, so local-date bucketing is exact in any timezone.
const entry = (over: Partial<AgendaEntry>): AgendaEntry => ({
  checklistId: 'l1', checklistTitle: 'Errands', itemLocalId: 'i1',
  text: 'task', completed: false, position: 0, ...over,
});
const dated = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString();
};

// Next-7 boundary fixtures (C1): live-offset like `dated` above (semantic
// dates — hardcoded calendar days drift out of their bucket), then anchored
// at LOCAL NOON via setHours so the local date key is immune to midnight-edge
// /DST drift, and emitted as a full ISO string (standing TZ rule).
const datedAtNoon = (offsetDays: number): string => {
  const d = new Date(Date.now());
  d.setDate(d.getDate() + offsetDays);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
};

beforeEach(() => {
  invoke.mockReset();
  // the store is a module singleton — reset ALL ui state between tests
  useStore.setState({ selectedCategory: null, selectedNoteId: null, selectedChecklistId: null, listMode: 'agenda', pendingHighlightId: null });
});

describe('AgendaView', () => {
  it('groups entries in order: Overdue, Today, Tomorrow, Next 7 days, Later, Completed', async () => {
    // wire order (T4): pre-sorted by targetDate ASC — completed rides its date
    const rows = [
      entry({ itemLocalId: 'i-over', text: 'overdue thing', targetDate: dated(-3) }),
      entry({ itemLocalId: 'i-today', text: 'today thing', targetDate: dated(0) }),
      entry({ itemLocalId: 'i-done', text: 'done thing', targetDate: dated(0), completed: true }),
      entry({ itemLocalId: 'i-tom', text: 'tomorrow thing', targetDate: dated(1) }),
      entry({ itemLocalId: 'i-week', text: 'midweek thing', targetDate: dated(2) }),
      entry({ itemLocalId: 'i-late', text: 'far future thing', targetDate: dated(30) }),
    ];
    invoke.mockImplementation((cmd: string) => (cmd === 'list_agenda' ? Promise.resolve(rows) : Promise.resolve(null)));
    render(<AgendaView />);
    await waitFor(() => expect(screen.getByText('overdue thing')).toBeInTheDocument());
    // groups render in the fixed order, completed entries land in the last group
    const headings = Array.from(document.querySelectorAll('.agenda-group h3')).map((h) => h.textContent);
    expect(headings).toEqual(['Overdue', 'Today', 'Tomorrow', 'Next 7 days', 'Later', 'Completed']);
    // each entry text renders (wrapped in .agenda-text) inside the RIGHT group
    const groupOf = (t: string) =>
      screen.getByText(t).closest('.agenda-group')?.querySelector('h3')?.textContent;
    expect(groupOf('overdue thing')).toBe('Overdue');
    expect(groupOf('today thing')).toBe('Today');
    expect(groupOf('tomorrow thing')).toBe('Tomorrow');
    expect(groupOf('midweek thing')).toBe('Next 7 days');
    expect(groupOf('far future thing')).toBe('Later');
    expect(groupOf('done thing')).toBe('Completed'); // completed, not its date bucket
  });

  it('renders the reminder bell and dims it when notified', async () => {
    const rows = [
      entry({ itemLocalId: 'i1', text: 'with reminder', targetDate: dated(0), reminderDatetime: dated(0), reminderNotified: false }),
      entry({ itemLocalId: 'i2', text: 'notified reminder', targetDate: dated(0), reminderDatetime: dated(-1), reminderNotified: true }),
      entry({ itemLocalId: 'i3', text: 'no reminder', targetDate: dated(0) }),
    ];
    invoke.mockImplementation((cmd: string) => (cmd === 'list_agenda' ? Promise.resolve(rows) : Promise.resolve(null)));
    render(<AgendaView />);
    await waitFor(() => expect(screen.getByText('with reminder')).toBeInTheDocument());
    const bells = document.querySelectorAll('.agenda-bell');
    expect(bells).toHaveLength(2); // the row without reminderDatetime renders no bell
    expect(bells[0]).not.toHaveClass('notified');
    expect(bells[1]).toHaveClass('notified');
  });

  it('reminder chip shows 🔔 + formatted local time, never the raw ISO, with a full-datetime tooltip', async () => {
    const rows = [
      entry({ itemLocalId: 'i1', text: 'chip time', targetDate: dated(0), reminderDatetime: '2026-10-01T09:00:00.000Z', reminderNotified: false }),
    ];
    invoke.mockImplementation((cmd: string) => (cmd === 'list_agenda' ? Promise.resolve(rows) : Promise.resolve(null)));
    render(<AgendaView />);
    await waitFor(() => expect(screen.getByText('chip time')).toBeInTheDocument());
    // R6 (T6-N4): the Z-form fixture proves formatted-not-raw — the raw stored
    // ISO would carry 'T' and 'Z'; clock digits asserted TZ-robustly (never
    // exact clock digits — the local rendering is TZ-dependent)
    const chip = document.querySelector('.agenda-bell') as HTMLElement;
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(chip.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(chip.textContent).not.toContain('T');
    expect(chip.textContent).not.toContain('Z');
    // tooltip = full local datetime on the SAME span: non-empty, ≠ raw stored ISO
    const title = chip.getAttribute('title');
    expect(title).toBeTruthy();
    expect(title).not.toBe('2026-10-01T09:00:00.000Z');
  });

  it('Next-7 boundary: now+7d lands in "Next 7 days" (inclusive upper bound)', async () => {
    const rows = [entry({ itemLocalId: 'i-p7', text: 'plus seven', targetDate: datedAtNoon(7) })];
    invoke.mockImplementation((cmd: string) => (cmd === 'list_agenda' ? Promise.resolve(rows) : Promise.resolve(null)));
    render(<AgendaView />);
    await waitFor(() => expect(screen.getByText('plus seven')).toBeInTheDocument());
    const groupOf = (t: string) =>
      screen.getByText(t).closest('.agenda-group')?.querySelector('h3')?.textContent;
    // weekKey = today+7 is INCLUSIVE: the +7d boundary belongs to Next 7 days
    expect(groupOf('plus seven')).toBe('Next 7 days');
  });

  it('Next-7 boundary: now+8d lands in "Later"', async () => {
    const rows = [entry({ itemLocalId: 'i-p8', text: 'plus eight', targetDate: datedAtNoon(8) })];
    invoke.mockImplementation((cmd: string) => (cmd === 'list_agenda' ? Promise.resolve(rows) : Promise.resolve(null)));
    render(<AgendaView />);
    await waitFor(() => expect(screen.getByText('plus eight')).toBeInTheDocument());
    const groupOf = (t: string) =>
      screen.getByText(t).closest('.agenda-group')?.querySelector('h3')?.textContent;
    // one day past the inclusive bound tips into Later
    expect(groupOf('plus eight')).toBe('Later');
  });

  it('click-through selects the owning checklist and best-effort scrolls to the row', async () => {
    const rows = [entry({ checklistId: 'l9', itemLocalId: 'i9', text: 'clickable', targetDate: dated(0) })];
    invoke.mockImplementation((cmd: string) => (cmd === 'list_agenda' ? Promise.resolve(rows) : Promise.resolve(null)));
    // jsdom has no scrollIntoView: stand in a recording stub, restore after
    const proto = Element.prototype as Element & { scrollIntoView?: (arg?: unknown) => void };
    const original = proto.scrollIntoView;
    const calls: unknown[] = [];
    proto.scrollIntoView = (arg) => { calls.push(arg); };
    try {
      render(<AgendaView />);
      await waitFor(() => expect(screen.getByText('clickable')).toBeInTheDocument());
      // the ChecklistView row the agenda wants to highlight (top-level rows
      // carry id=item-<localId>) is already mounted: the scroll fires
      document.body.insertAdjacentHTML('beforeend', '<div id="item-i9"></div>');
      fireEvent.click(screen.getByText('clickable'));
      const s = useStore.getState();
      expect(s.selectedChecklistId).toBe('l9');
      expect(s.selectedNoteId).toBeNull();
      expect(s.listMode).toBe('checklists'); // selectChecklist flips the mode: list + view open
      expect(calls).toEqual([{ block: 'center' }]);
    } finally {
      proto.scrollIntoView = original;
      document.getElementById('item-i9')?.remove();
    }
  });

  it('click-through stores the pending highlight id before selecting the checklist (deferred scroll)', async () => {
    const rows = [entry({ checklistId: 'l9', itemLocalId: 'i9', text: 'clickable', targetDate: dated(0) })];
    invoke.mockImplementation((cmd: string) => (cmd === 'list_agenda' ? Promise.resolve(rows) : Promise.resolve(null)));
    render(<AgendaView />);
    await waitFor(() => expect(screen.getByText('clickable')).toBeInTheDocument());
    expect(useStore.getState().pendingHighlightId).toBeNull(); // nothing pending before the click
    fireEvent.click(screen.getByText('clickable'));
    // the click REQUESTS a one-shot highlight: set BEFORE selectChecklist so a
    // fresh open (rows not mounted yet) still scrolls after ChecklistView's
    // items resolve. No row is mounted here — the immediate lookup is a no-op.
    expect(useStore.getState().pendingHighlightId).toBe('i9');
  });

  it('empty, null or failed fetch renders the inline state line, never a crash', async () => {
    // empty result → the empty-state line
    invoke.mockImplementation((cmd: string) => (cmd === 'list_agenda' ? Promise.resolve([]) : Promise.resolve(null)));
    const first = render(<AgendaView />);
    await waitFor(() => expect(screen.getByText('No dated items.')).toBeInTheDocument());
    expect(document.querySelector('.agenda-entry')).toBeNull();
    first.unmount();

    // null payload (unknown-command mock fallthrough) → same empty state, null-safe
    invoke.mockImplementation((cmd: string) => (cmd === 'list_agenda' ? Promise.resolve(null) : Promise.resolve(null)));
    const second = render(<AgendaView />);
    await waitFor(() => expect(screen.getByText('No dated items.')).toBeInTheDocument());
    second.unmount();

    // failed fetch (offline) → inline error line, entries stay []
    invoke.mockImplementation((cmd: string) => (cmd === 'list_agenda' ? Promise.reject(new Error('offline')) : Promise.resolve(null)));
    render(<AgendaView />);
    await waitFor(() => expect(screen.getByText('Agenda unavailable.')).toBeInTheDocument());
    expect(document.querySelector('.agenda-entry')).toBeNull();
  });

  it('agenda entry meta rides the meta-line typography; the bell stays a span wrapper (title + icon)', async () => {
    const rows = [
      entry({ itemLocalId: 'i1', text: 'meta typ', targetDate: dated(0), reminderDatetime: '2026-10-01T09:00:00.000Z', reminderNotified: false }),
    ];
    invoke.mockImplementation((cmd: string) => (cmd === 'list_agenda' ? Promise.resolve(rows) : Promise.resolve(null)));
    render(<AgendaView />);
    await waitFor(() => expect(screen.getByText('meta typ')).toBeInTheDocument());
    // meta-line typography (spec L9): the shared muted/tabular rule rides the spans
    expect(document.querySelector('.agenda-list')).toHaveClass('meta-line');
    expect(document.querySelector('.agenda-time')).toHaveClass('meta-line');
    // bell chip (task 5): a SPAN wrapper carries the title + the Icon's svg — never a raw glyph
    const bell = document.querySelector('.agenda-bell') as HTMLElement;
    expect(bell.tagName).toBe('SPAN');
    expect(bell.getAttribute('title')).toBeTruthy();
    expect(bell.querySelector('svg')).not.toBeNull();
  });

  // tier B S4 — right-side due chip (datedAtNoon anchors both fixtures at LOCAL
  // noon, so the local date key is drift-immune exactly like the bucket tests)
  it('entries render a right-side due chip; overdue + today rows get the group classes', async () => {
    const rows = [
      entry({ itemLocalId: 'i-over', text: 'overdue thing', targetDate: datedAtNoon(-3) }),
      entry({ itemLocalId: 'i-today', text: 'today thing', targetDate: datedAtNoon(0) }),
    ];
    invoke.mockImplementation((cmd: string) => (cmd === 'list_agenda' ? Promise.resolve(rows) : Promise.resolve(null)));
    render(<AgendaView />);
    await waitFor(() => expect(screen.getByText('overdue thing')).toBeInTheDocument());
    expect(document.querySelector('.agenda-entry .agenda-due.overdue')).not.toBeNull();
    expect(document.querySelector('.agenda-entry .agenda-due.today')).not.toBeNull();
  });
});

describe('agendaDueLabel (tier B task 4)', () => {
  it('today → Today', () => expect(agendaDueLabel('2026-10-01', '2026-10-01', '2026-10-02', '2026-10-08')).toBe('Today'));
  it('tomorrow → Tomorrow', () => expect(agendaDueLabel('2026-10-02', '2026-10-01', '2026-10-02', '2026-10-08')).toBe('Tomorrow'));
  it('past → localized date label (dateLabel contract)', () => {
    expect(agendaDueLabel('2020-05-05', '2026-10-01', '2026-10-02', '2026-10-08')).toBe(dateLabel('2020-05-05'));
  });
  it('unparseable → raw value', () => expect(agendaDueLabel('weird', '2026-10-01', '2026-10-02', '2026-10-08')).toBe('weird'));
  it('within-7-days → weekday label (locale-rendered, type-asserted)', () => {
    expect(typeof agendaDueLabel('2026-10-03', '2026-10-01', '2026-10-02', '2026-10-08')).toBe('string');
  });
});