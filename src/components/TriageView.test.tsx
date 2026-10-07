import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import TriageView from './TriageView';
import { relativeAge } from '../util/relativeTime';
import { useStore } from '../stores/store';
import type { ChecklistDto, NoteDto } from '../api/types';

const note = (
  id: string,
  title: string,
  content: string,
  createdAt: string | null,
  category = '!INBOX',
): NoteDto => ({
  id,
  title,
  content,
  category,
  createdAt,
  updatedAt: null,
  deletedAt: null,
  dirty: false,
  audioPath: null,
  audioDurationSecs: null,
});

const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ChecklistDto fixture for the promote picker (Task 4): listType carries the
// verified board values — 'kanban' + deprecated 'task' alias; 'simple' rows
// are plain checklists and must NOT appear in the picker.
const boardList = (id: string, title: string, listType: string): ChecklistDto => ({
  id,
  title,
  category: '',
  createdAt: null,
  updatedAt: null,
  deletedAt: null,
  dirty: false,
  completed: false,
  listType,
  items: [],
});

// Cards in DOM order: TriageView sorts internally (createdAt desc, id asc).
const cardIds = (): string[] =>
  [...document.querySelectorAll('li.triage-card')].map(
    (li) => li.querySelector('.triage-title')!.textContent!,
  );
const selectedCard = (): HTMLElement | null =>
  document.querySelector('li.triage-card.selected');
const pressKey = (key: string, target?: Element): void => {
  if (target) fireEvent.keyDown(target, { key });
  else fireEvent.keyDown(window, { key });
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(() => Promise.resolve(null));
  // Flow tests (Task 4) read the live store (defensive stale-guard, promote
  // picker, delete flow): pin a clean known baseline before every test so no
  // state leaks between cases.
  useStore.setState({
    notes: [],
    checklists: [],
    selectedNoteId: null,
    selectedChecklistId: null,
    selectedCategory: null,
    listMode: 'notes',
  } as never);
});

describe('TriageView list', () => {
  it('renders the triage header, live count, and cards sorted newest-first (createdAt desc, id tiebreak asc) from out-of-order fixtures', () => {
    // same createdAt pair pins the id tiebreak: n-a rides BEFORE n-z. One
    // shared ISO string (two isoAgo() calls would drift by milliseconds).
    const tieIso = isoAgo(2 * HOUR);
    const notes = [
      note('n-z', 'tie zeta', 'tie zeta body', tieIso),
      note('n-new', 'cap_newest_ab', 'newest capture body', isoAgo(HOUR)),
      note('n-old', 'cap_oldest_ab', 'oldest capture body', isoAgo(3 * DAY)),
      note('n-a', 'tie alpha', 'tie alpha body', tieIso),
      note('n-mid', 'cap_mid_ab', 'middle capture body', isoAgo(2 * DAY)),
    ];
    render(<TriageView notes={notes} />);

    expect(screen.getByText('Triage')).toBeInTheDocument();
    const section = document.querySelector('#triage')!;
    expect(section.querySelector('.triage-count')!.textContent).toBe('5');
    expect(cardIds()).toEqual(['cap_newest_ab', 'tie alpha', 'tie zeta', 'cap_mid_ab', 'cap_oldest_ab']);

    const first = document.querySelectorAll('li.triage-card')[0]!;
    // first card is selected by default; snippet + date ride the row
    expect(first).toHaveClass('selected');
    expect(first.querySelector('.triage-snippet')!.textContent).toBe('newest capture body');
    expect(first.querySelector('.triage-date')!.textContent).toBe(relativeAge(isoAgo(HOUR)));
  });

  it('squashes multi-line content to a snippet capped at 160 chars', () => {
    const content = `alpha\n beta\tgamma\n${'x'.repeat(200)}`;
    render(<TriageView notes={[note('n1', 'cap_squash_ab', content, isoAgo(HOUR))]} />);
    const snippet = document.querySelector('.triage-snippet')!.textContent!;
    // \n / \t / double-\n all collapse to single spaces, then hard cap at 160.
    expect(snippet).toBe(`alpha beta gamma ${'x'.repeat(200)}`.slice(0, 160));
    expect(snippet.length).toBe(160);
  });
});

describe('TriageView keyboard', () => {
  const notes = () => [
    note('n1', 'cap_first_ab', 'first body', isoAgo(3 * HOUR)),
    note('n2', 'cap_second_ab', 'second body', isoAgo(2 * HOUR)),
    note('n3', 'cap_third_ab', 'third body', isoAgo(HOUR)),
  ];

  it('j/k move the .selected card within the clamped bounds', () => {
    render(<TriageView notes={notes()} />);
    const cards = () => [...document.querySelectorAll('li.triage-card')];
    expect(cards()[0]!.classList.contains('selected')).toBe(true);

    pressKey('j');
    expect(cards()[1]!.classList.contains('selected')).toBe(true);
    expect(cards()[0]!.classList.contains('selected')).toBe(false);

    pressKey('j');
    pressKey('j'); // clamped at the last card
    expect(cards()[2]!.classList.contains('selected')).toBe(true);

    pressKey('k');
    expect(cards()[1]!.classList.contains('selected')).toBe(true);
    pressKey('k');
    pressKey('k'); // clamped at the first card
    expect(cards()[0]!.classList.contains('selected')).toBe(true);
  });

  it('ignores j/k/a/m/x while a text field (input/textarea) has the keydown target', () => {
    render(
      <>
        <TriageView notes={notes()} />
        <input aria-label="guard input" data-testid="guard-input" />
        <textarea aria-label="guard area" data-testid="guard-area" />
      </>,
    );
    const cards = () => [...document.querySelectorAll('li.triage-card')];

    pressKey('j'); // window-level keys still work
    expect(cards()[1]!.classList.contains('selected')).toBe(true);

    // Per-key stepwise asserts (T3 review F1 fix): every target key must
    // leave the selection UNCHANGED immediately after its own firing — a
    // single end-of-burst assert lets a j+k pair self-cancel (1→2→1) and
    // hide a deleted guard arm. a/m/x carry no per-key signal in T3: their
    // only effect is the no-op onAction placeholder (internal, no
    // prop/store/invoke seam) — they stay pinned in T4 per the plan split.
    for (const target of [
      screen.getByTestId('guard-input'),
      screen.getByTestId('guard-area'),
    ]) {
      for (const key of ['j', 'k', 'a', 'm', 'x'] as const) {
        pressKey(key, target);
        expect(cards()[1]!.classList.contains('selected')).toBe(true);
      }
    }
  });

  it('ignores j/k when the event was already defaultPrevented', () => {
    const stopper = (e: Event): void => e.preventDefault();
    window.addEventListener('keydown', stopper);
    try {
      render(<TriageView notes={notes()} />);
      pressKey('j');
      expect(cardIds().length).toBe(3);
      expect(selectedCard()).toBeTruthy();
      expect(cardIds().indexOf(selectedCard()!.querySelector('.triage-title')!.textContent!)).toBe(0);
    } finally {
      window.removeEventListener('keydown', stopper);
    }
  });
});

describe('TriageView empty state', () => {
  it('renders the friendly empty li and survives j/k/a/m/x with zero cards', () => {
    const notes: NoteDto[] = [];
    render(<TriageView notes={notes} />);

    const empty = document.querySelector('li.triage-empty')!;
    expect(empty.textContent).toBe('Inbox is empty 🎉');
    expect(document.querySelector('.triage-count')!.textContent).toBe('0');
    expect(document.querySelector('li.triage-card')).toBeNull();

    expect(() => {
      pressKey('j');
      pressKey('k');
      pressKey('a');
      pressKey('m');
      pressKey('x');
    }).not.toThrow();
    expect(document.querySelector('li.triage-empty')).not.toBeNull();
  });
});

describe('TriageView actions', () => {
  it('renders the exact action labels Promote / Move… / Discard per card; clicking Promote opens its modal with no invoke yet', () => {
    const seedA = note('n1', 'cap_first_ab', 'first body', isoAgo(2 * HOUR));
    const seedB = note('n2', 'cap_second_ab', 'second body', isoAgo(HOUR));
    // T4 amendment (disclosed): the defensive stale-guard now reads the LIVE
    // store catalog, so the store must mirror the props for a click to open
    // the modal instead of taking the missing-note clear path.
    useStore.setState({ notes: [seedA, seedB], checklists: [] } as never);
    render(<TriageView notes={[seedA, seedB]} />);
    const cards = [...document.querySelectorAll('li.triage-card')];
    for (const card of cards) {
      const labels = [...card.querySelectorAll('button')].map((b) => b.textContent);
      expect(labels).toEqual(['Promote', 'Move…', 'Discard']);
    }
    fireEvent.click(cards[0]!.querySelectorAll('button')[0]!);
    expect(screen.getByRole('dialog')).toBeInTheDocument(); // modal wiring is live
    expect(cards[0]!.classList.contains('selected')).toBe(true); // selection untouched
    expect(invoke).not.toHaveBeenCalled(); // OPENING a modal dispatches nothing
  });

  it('defensively renders only capture-zone notes (isCaptureZone safety-net inside the view)', () => {
    const notes = [
      note('n1', 'cap_inbox_ab', 'inbox body', isoAgo(2 * HOUR)),
      note('n2', 'not triage', 'library body', isoAgo(HOUR), 'LIBRARY/Notes'),
      note('n3', 'cap_nested_ab', 'nested body', isoAgo(3 * HOUR), '!INBOX/Sub'),
      note('n4', 'stray row', 'stray body', isoAgo(4 * HOUR), null as unknown as string),
    ];
    render(<TriageView notes={notes} />);
    expect(cardIds()).toEqual(['cap_inbox_ab', 'cap_nested_ab']);
    expect(screen.queryByText('library body')).not.toBeInTheDocument();
    expect(screen.queryByText('stray body')).not.toBeInTheDocument();
    expect(document.querySelector('.triage-count')!.textContent).toBe('2');
  });
});

describe('TriageView action flows (Task 4 wiring)', () => {
  it('promote: a opens the board picker (boards only, title asc); confirm invokes promote_note_to_board with exact args, refreshes, and closes + clamps', async () => {
    const seedA = note('n-a', 'cap_a_ab', 'Renew the vpn cert', isoAgo(HOUR)); // newest → first card
    const seedB = note('n-b', 'cap_b_ab', 'Old line', isoAgo(2 * HOUR));
    useStore.setState({
      notes: [seedA, seedB],
      checklists: [
        boardList('cl-plain', 'Groceries', 'simple'),
        boardList('b-zeta', 'Zeta board', 'kanban'),
        boardList('b-maint', 'Maintenance', 'task'),
      ],
    } as never);
    const { rerender } = render(<TriageView notes={[seedA, seedB]} />);
    pressKey('j'); // select the SECOND card (n-b)
    pressKey('a');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Board' })).toHaveTextContent('Maintenance');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Board' }));
    // Picker = checklists filtered to BOARD types and sorted by title asc:
    // plain 'Groceries' (simple) is excluded; the deprecated 'task' alias passes.
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent))
      .toEqual(['Maintenance', 'Zeta board']);
    fireEvent.click(within(dialog).getByRole('option', { name: 'Zeta board' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Card text' }), {
      target: { value: 'Fix the fuse box' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Card title' }), {
      target: { value: 'Fuse box' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('promote_note_to_board', {
        noteId: 'n-b',
        boardId: 'b-zeta',
        cardText: 'Fix the fuse box',
        newTitle: 'Fuse box',
      });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // success clears the modal
    expect(invoke.mock.calls.map((c) => c[0])).toContain('list_notes'); // refreshAll ran

    // The promoted note leaves the list → the selection clamps onto the new length.
    rerender(<TriageView notes={[seedA]} />);
    await waitFor(() => {
      const sel = document.querySelector('li.triage-card.selected')!;
      expect(sel.querySelector('.triage-title')!.textContent).toBe('cap_a_ab');
    });
  });

  it('move: m opens the move modal; the preset chip fills the category and a blank rename falls back to the note title', async () => {
    const seed = note('n-m', 'cap_move_ab', 'body text', isoAgo(HOUR));
    useStore.setState({ notes: [seed], checklists: [] } as never);
    render(<TriageView notes={[seed]} />);
    pressKey('m');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Category' })).toHaveValue('!INBOX'); // current category pre-filled
    fireEvent.click(within(dialog).getByRole('button', { name: 'LIBRARY/Docs' }));
    expect(within(dialog).getByRole('textbox', { name: 'Category' })).toHaveValue('LIBRARY/Docs');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title' }), { target: { value: '' } }); // blank rename
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('update_note', {
        id: 'n-m',
        title: 'cap_move_ab', // falls back to the note title when the rename input is blank
        content: 'body text',
        category: 'LIBRARY/Docs', // from the preset chip
      });
    });
    // ONE move invoke exactly — no pre-creation call for a new category (plan Review Focus 2).
    expect(invoke.mock.calls.filter((c) => c[0] === 'update_note')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // success clears the modal
  });

  it('discard: x opens the destructive confirm; confirming invokes delete_note once via the store with no extra refresh', async () => {
    const seed = note('n-d', 'cap_del_ab', 'body', isoAgo(HOUR));
    useStore.setState({ notes: [seed], checklists: [] } as never);
    render(<TriageView notes={[seed]} />);
    pressKey('x');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Discard capture')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Are you sure you want to discard "cap_del_ab"?');
    const confirmBtn = within(dialog).getByRole('button', { name: 'Discard' });
    expect(confirmBtn).toHaveClass('danger'); // destructive variant
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('delete_note', { id: 'n-d' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // ConfirmModal self-closes
    // deleteNote refreshes via its own refreshAll — the view adds NO extra refresh.
    expect(invoke.mock.calls.filter((c) => c[0] === 'list_notes')).toHaveLength(1);
  });

  it('a failed promote apply renders the error line inside the modal, keeps the modal open, and never refreshes', async () => {
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) =>
      cmd === 'promote_note_to_board'
        ? Promise.reject(new Error('stale: note no longer exists'))
        : Promise.resolve(null),
    );
    const seed = note('n-e', 'cap_err_ab', 'boom body', isoAgo(HOUR));
    useStore.setState({ notes: [seed], checklists: [boardList('b1', 'Maintenance', 'kanban')] } as never);
    render(<TriageView notes={[seed]} />);
    pressKey('a');
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' })); // first board preselected
    await waitFor(() => {
      expect(within(dialog).getByText('stale: note no longer exists')).toHaveClass('triage-error');
    });
    expect(screen.queryByRole('dialog')).not.toBeNull(); // failure KEEPS the modal open
    expect(invoke.mock.calls.filter((c) => c[0] === 'promote_note_to_board')).toHaveLength(1);
    expect(invoke.mock.calls.filter((c) => c[0] === 'list_notes')).toHaveLength(0); // no refreshAll on failure
  });

  it('a note missing from the live store opens no modal and clears the selection', () => {
    const stale = note('n-gone', 'cap_gone_ab', 'gone body', isoAgo(HOUR));
    useStore.setState({ notes: [], checklists: [] } as never); // store no longer carries it
    render(<TriageView notes={[stale]} />);
    pressKey('a');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('li.triage-card.selected')).toBeNull(); // selection cleared
    expect(invoke).not.toHaveBeenCalled();
  });
});