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
const cardByTitle = (title: string): Element | null =>
  [...document.querySelectorAll('li.triage-card')].find(
    (li) => li.querySelector('.triage-title')!.textContent === title,
  ) ?? null;
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

  // T5 real-engine probe catch (WebkitGTK still showed literal `<p>…</p>` in
  // the snippet): content is TipTap HTML — tags must never reach the UI.
  it('strips HTML tags from the snippet', () => {
    render(
      <TriageView
        notes={[note('n-html', 'cap_html_ab', '<p>Renew the vpn <strong>cert</strong> this week</p>', isoAgo(HOUR))]}
      />,
    );
    expect(document.querySelector('.triage-snippet')!.textContent).toBe('Renew the vpn cert this week');
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
    // P3 Task 2 amendment (disclosed in task-2-report): mounting TriageView now
    // reads threshold + vocab once (passive, no side effects) — OPENING a modal
    // still dispatches nothing beyond those two mount reads.
    expect(invoke.mock.calls.every((c) => c[0] === 'get_triage_settings' || c[0] === 'triage_tag_vocab')).toBe(true);
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
    // P3 Task 2 amendment (disclosed): only the two passive mount reads fire.
    expect(invoke.mock.calls.every((c) => c[0] === 'get_triage_settings' || c[0] === 'triage_tag_vocab')).toBe(true);
  });

  // Task-4 review F2 rider: the TriageMoveModal carries no in-dialog error
  // affordance, so a failed move apply CLOSES the dialog and lets the
  // section-level .triage-error line surface (same asymmetry as the accepted
  // discard flow) instead of hiding the error behind the fixed backdrop.
  it('a failed move apply closes the dialog and surfaces the error line section-level', async () => {
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) =>
      cmd === 'update_note'
        ? Promise.reject(new Error('stale: note no longer exists'))
        : Promise.resolve(null),
    );
    const seed = note('n-move-err', 'cap_mv_ab', 'boom body', isoAgo(HOUR));
    useStore.setState({ notes: [seed], checklists: [] } as never);
    render(<TriageView notes={[seed]} />);
    pressKey('m');
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' })); // default category prefilled
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // failure CLOSES the dialog
    await waitFor(() => {
      expect(screen.getByText('stale: note no longer exists')).toHaveClass('triage-error');
    });
    expect(invoke.mock.calls.filter((c) => c[0] === 'update_note')).toHaveLength(1);
  });
});
describe('TriageView AI suggestions (P3 Task 2)', () => {
  // ---- fixtures ----
  const seedMany = (n: number): NoteDto[] =>
    Array.from({ length: n }, (_, i) =>
      note(`note-${String(i).padStart(2, '0')}`, `card ${String(i).padStart(2, '0')}`, `body ${i}`, isoAgo((i + 1) * HOUR)),
    ); // createdAt: i=0 newest → card order (sorted desc) == seeded order

  const sugg = (noteId: string, over: Record<string, unknown> = {}) => ({
    noteId,
    route: 'TODO',
    suggestedBoard: null,
    suggestedTitle: null,
    suggestedTags: [],
    confidence: 0.9,
    ...over,
  });

  const suggestCalls = (): string[][] =>
    invoke.mock.calls.filter((c) => c[0] === 'triage_suggest').map((c) => c[1].noteIds);

  const deferred = <T,>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  // standard passive mounts: settings + vocab resolve to known values
  const passiveMounts = (): void => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_triage_settings') return Promise.resolve({ confidenceThreshold: 0.7 });
      if (cmd === 'triage_tag_vocab') return Promise.resolve(['todo', 'cmd', 'incident', 'research']);
      return Promise.resolve(null);
    });
  };

  it('suggest button sweeps in chunked SEQUENTIAL order (45 notes → 20/20/5 slices in card order)', async () => {
    passiveMounts();
    const notes = seedMany(45);
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_triage_settings') return Promise.resolve({ confidenceThreshold: 0.7 });
      if (cmd === 'triage_tag_vocab') return Promise.resolve(['todo']);
      if (cmd === 'triage_suggest') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<TriageView notes={notes} />);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest (AI)' }));
    await waitFor(() => expect(suggestCalls()).toHaveLength(3));
    const allIds = notes.map((n) => n.id); // card order == seeded order (newest first)
    expect(suggestCalls()).toEqual([
      allIds.slice(0, 20),
      allIds.slice(20, 40),
      allIds.slice(40, 45),
    ]);
  });

  it('badges render for confident suggestions: ONE .triage-ai row BETWEEN snippet and actions with pinned chips', async () => {
    passiveMounts();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_triage_settings') return Promise.resolve({ confidenceThreshold: 0.7 });
      if (cmd === 'triage_tag_vocab') return Promise.resolve(['todo', 'cmd']);
      if (cmd === 'triage_suggest')
        return Promise.resolve([
          sugg('n1', { route: 'TODO', suggestedBoard: 'Maintenance', suggestedTags: ['todo', 'fresh'], confidence: 0.9 }),
        ]);
      return Promise.resolve(null);
    });
    const seedA = note('n1', 'cap_badge_ab', 'badge body', isoAgo(2 * HOUR));
    const seedB = note('n2', 'cap_badge_cd', 'plain body', isoAgo(HOUR));
    useStore.setState({ notes: [seedA, seedB], checklists: [boardList('b1', 'Maintenance', 'kanban')] } as never);
    render(<TriageView notes={[seedA, seedB]} />);
    // let the passive mount reads land BEFORE the sweep (the tag split reads
    // the live vocab — the ordering the real app always has)
    await waitFor(() => expect(invoke.mock.calls.some((c) => c[0] === 'triage_tag_vocab')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Suggest (AI)' }));
    await waitFor(() => expect(cardByTitle('cap_badge_ab')!.querySelector('.triage-ai')).not.toBeNull());

    const card = cardByTitle('cap_badge_ab')!;
    const row = card.querySelector('.triage-ai')!;
    expect(card.querySelectorAll('.triage-ai')).toHaveLength(1); // ONE row per card
    // DOM position law: BETWEEN .triage-snippet and .triage-actions
    expect(row.previousElementSibling!.className).toBe('triage-snippet');
    expect(row.nextElementSibling!.className).toBe('triage-actions');
    // chips: route badge, resolved board, existing tags plain, proposed tag as a button ending '?'
    expect(row.querySelector('.triage-badge')!.textContent).toBe('TODO');
    expect(row.querySelector('.triage-board')!.textContent).toBe('Board: Maintenance');
    expect([...row.querySelectorAll('.triage-tag:not(.new)')].map((t) => t.textContent)).toEqual(['#todo']);
    const newChip = row.querySelector('button.triage-tag.new')!;
    expect(newChip.textContent).toBe('#fresh?');
    expect(row.querySelector('.triage-conf')!.textContent).toBe('90%');
    // the OTHER card carries no badge row at all
    expect(cardByTitle('cap_badge_cd')!.querySelector('.triage-ai')).toBeNull();
  });

  it('low-confidence suggestions render the manual-review state with no chips', async () => {
    passiveMounts();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_triage_settings') return Promise.resolve({ confidenceThreshold: 0.7 });
      if (cmd === 'triage_tag_vocab') return Promise.resolve(['todo']);
      if (cmd === 'triage_suggest')
        return Promise.resolve([sugg('n1', { route: 'NOISE', suggestedBoard: 'Maintenance', suggestedTags: ['todo'], confidence: 0.4 })]);
      return Promise.resolve(null);
    });
    const seed = note('n1', 'cap_low_ab', 'low body', isoAgo(HOUR));
    useStore.setState({ notes: [seed], checklists: [boardList('b1', 'Maintenance', 'kanban')] } as never);
    render(<TriageView notes={[seed]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest (AI)' }));
    await waitFor(() => expect(document.querySelector('.triage-ai.low')).not.toBeNull());
    const row = document.querySelector('.triage-ai.low')!;
    expect(row.textContent).toBe('Below confidence threshold — review manually');
    expect(row.querySelector('.triage-badge')).toBeNull(); // no chips at all
    expect(row.querySelector('.triage-tag')).toBeNull();
    expect(row.querySelector('.triage-conf')).toBeNull();
  });

  it('a failed chunk degrades to manual and the sweep CONTINUES (chunk 2 rejects → chunk 3 still invoked)', async () => {
    passiveMounts();
    const notes = seedMany(45);
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_triage_settings') return Promise.resolve({ confidenceThreshold: 0.7 });
      if (cmd === 'triage_tag_vocab') return Promise.resolve(['todo']);
      if (cmd === 'triage_suggest') {
        const n = invoke.mock.calls.filter((c) => c[0] === 'triage_suggest').length;
        if (n === 1) return Promise.resolve(notes.slice(0, 20).map((x) => sugg(x.id, { suggestedBoard: 'Maintenance' })));
        if (n === 2) return Promise.reject(new Error('backend exploded'));
        if (n === 3) return Promise.resolve(notes.slice(40, 45).map((x) => sugg(x.id, { suggestedBoard: 'Zeta board' })));
      }
      return Promise.resolve(null);
    });
    useStore.setState({ notes, checklists: [boardList('b-zeta', 'Zeta board', 'kanban')] } as never);
    render(<TriageView notes={notes} />);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest (AI)' }));
    await waitFor(() => expect(suggestCalls()).toHaveLength(3));
    const errored = document.querySelector('.triage-error');
    expect(errored).not.toBeNull();
    expect(errored!.textContent).toContain('chunk failed — triaged manually'); // fmtError stripped, plan text rides
    // badges from chunks 1 + 3 present; chunk 2 (degraded) has none
    expect(cardByTitle('card 00')!.querySelector('.triage-badge')).not.toBeNull();
    expect(cardByTitle('card 19')!.querySelector('.triage-badge')).not.toBeNull();
    expect(cardByTitle('card 44')!.querySelector('.triage-badge')).not.toBeNull();
    for (let i = 20; i < 40; i++) {
      expect(cardByTitle(`card ${String(i).padStart(2, '0')}`)!.querySelector('.triage-ai')).toBeNull();
    }
  });

  it('suggestions for notes no longer in cards are dropped (stale reply ids never render)', async () => {
    passiveMounts();
    const notes = [note('n-a', 'cap_stay_ab', 'stays', isoAgo(2 * HOUR)), note('n-b', 'cap_gone_cd', 'leaves', isoAgo(HOUR))];
    useStore.setState({ notes } as never);
    const gate = deferred<unknown[]>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_triage_settings') return Promise.resolve({ confidenceThreshold: 0.7 });
      if (cmd === 'triage_tag_vocab') return Promise.resolve(['todo']);
      if (cmd === 'triage_suggest') return gate.promise;
      return Promise.resolve(null);
    });
    const { rerender } = render(<TriageView notes={notes} />);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest (AI)' }));
    // while the sweep is in flight the card for n-b LEAVES the live set
    const after = [notes[0]!];
    useStore.setState({ notes: after } as never);
    rerender(<TriageView notes={after} />);
    // the reply arrives carrying BOTH ids (+ a hallucinated one)
    gate.resolve([sugg('n-a'), sugg('n-b', { route: 'DOCS' }), sugg('n-hallucinated', { route: 'TODO' })]);
    await waitFor(() => expect(cardByTitle('cap_stay_ab')!.querySelector('.triage-badge')).not.toBeNull());
    expect(cardByTitle('cap_gone_cd')).toBeNull(); // card is gone entirely
    expect(document.body.textContent).not.toContain('leaves');
    // sanity: the sweep validated against the SNAPSHOT (n-b was requested)
    expect(suggestCalls()).toHaveLength(1);
  });

  it('approving a new-tag chip joins the vocab and re-renders the chip plain', async () => {
    passiveMounts();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_triage_settings') return Promise.resolve({ confidenceThreshold: 0.7 });
      if (cmd === 'triage_tag_vocab') return Promise.resolve(['todo']);
      if (cmd === 'triage_suggest') return Promise.resolve([sugg('n1', { suggestedTags: ['#Fresh'] })]);
      if (cmd === 'triage_tag_vocab_add') return Promise.resolve(['todo', 'fresh']);
      return Promise.resolve(null);
    });
    const seed = note('n1', 'cap_tag_ab', 'tag body', isoAgo(HOUR));
    useStore.setState({ notes: [seed], checklists: [] } as never);
    render(<TriageView notes={[seed]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest (AI)' }));
    const chip = await waitFor(() => {
      const c = document.querySelector('button.triage-tag.new');
      expect(c).not.toBeNull();
      return c!;
    });
    expect(chip.textContent).toBe('#fresh?'); // NORMALIZED display (wire carried "#Fresh")
    fireEvent.click(chip);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('triage_tag_vocab_add', { tag: 'fresh' })); // NORMALIZED tag
    await waitFor(() => {
      const plain = [...document.querySelectorAll('.triage-tag')].filter((t) => t.textContent === '#fresh');
      const newBtn = document.querySelector('button.triage-tag.new');
      expect(plain.length).toBeGreaterThan(0); // chip re-rendered PLAIN after vocab join
      expect(newBtn).toBeNull();
    });
  });

  it('s key triggers a sweep and rides all guard arms (input focus / open modal)', async () => {
    passiveMounts();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_triage_settings') return Promise.resolve({ confidenceThreshold: 0.7 });
      if (cmd === 'triage_tag_vocab') return Promise.resolve(['todo']);
      if (cmd === 'triage_suggest') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    const notes = [note('n1', 'cap_key_ab', 'k body', isoAgo(2 * HOUR)), note('n2', 'cap_key_cd', 'k body 2', isoAgo(HOUR))];
    useStore.setState({ notes } as never); // promote-modal stale-guard reads the LIVE store
    render(
      <>
        <TriageView notes={notes} />
        <input aria-label="guard input" data-testid="guard-input" />
      </>,
    );
    const sweepCount = (): number => invoke.mock.calls.filter((c) => c[0] === 'triage_suggest').length;

    pressKey('s'); // fires the sweep
    await waitFor(() => expect(sweepCount()).toBe(1));

    pressKey('s', screen.getByTestId('guard-input')); // input-focused: guarded
    expect(sweepCount()).toBe(1);

    pressKey('a'); // opens the promote modal
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    pressKey('s'); // modal open: guarded
    expect(sweepCount()).toBe(1);
  });

  it('a second sweep click while a sweep is in flight is ignored (single-sweep guard)', async () => {
    passiveMounts();
    const notes = seedMany(45);
    const gate = deferred<unknown[]>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_triage_settings') return Promise.resolve({ confidenceThreshold: 0.7 });
      if (cmd === 'triage_tag_vocab') return Promise.resolve(['todo']);
      if (cmd === 'triage_suggest') return gate.promise;
      return Promise.resolve(null);
    });
    useStore.setState({ notes } as never);
    render(<TriageView notes={notes} />);
    const btn = screen.getByRole('button', { name: 'Suggest (AI)' });
    fireEvent.click(btn);
    expect(btn.textContent).toBe('Analyzing… (0/3)'); // progress template rides the in-flight state
    fireEvent.click(btn); // re-entrant click IGNORED
    expect(suggestCalls()).toHaveLength(1);
    gate.resolve(notes.slice(0, 20).map((x) => sugg(x.id)));
    await waitFor(() => expect(btn.textContent).toBe('Analyzing… (1/3)'));
    // release the remaining chunks
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_triage_settings') return Promise.resolve({ confidenceThreshold: 0.7 });
      if (cmd === 'triage_tag_vocab') return Promise.resolve(['todo']);
      if (cmd === 'triage_suggest') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    await waitFor(() => expect(btn.textContent).toBe('Suggest (AI)')); // back to idle
    // the guard released; the REMAINING chunks complete the ORIGINAL sweep
    expect(suggestCalls()).toHaveLength(3);
  });
});

describe('TriageView suggestion prefill (P3 Task 3)', () => {
  const seedPair = (): NoteDto[] => {
    const notes = [
      note('n1', 'cap_pref_ab', 'Renew the vpn cert this week', isoAgo(HOUR)),
      note('n2', 'cap_pref_cd', 'plain body', isoAgo(2 * HOUR)),
    ]; // n1 newest → cards[0] (the card the a/m keys act on)
    useStore.setState({ notes, checklists: [boardList('b1', 'Maintenance', 'kanban'), boardList('b2', 'Zeta board', 'kanban')] } as never);
    return notes;
  };

  // sweep harness: confident suggestion for n1; per-test override re-mocks the
  // WHOLE chain (mock-fallthrough law)
  const sweepOnce = (suggestion: unknown): void => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_triage_settings') return Promise.resolve({ confidenceThreshold: 0.7 });
      if (cmd === 'triage_tag_vocab') return Promise.resolve(['todo']);
      if (cmd === 'triage_suggest') return Promise.resolve(suggestion);
      return Promise.resolve(null);
    });
  };
  const sugg = (over: Record<string, unknown>) => ({
    noteId: 'n1', route: 'TODO', suggestedBoard: null, suggestedTitle: null,
    suggestedTags: [], confidence: 0.9, ...over,
  });
  const clickSuggest = async (): Promise<void> => {
    fireEvent.click(screen.getByRole('button', { name: 'Suggest (AI)' }));
    await waitFor(() => expect(invoke.mock.calls.some((c) => c[0] === 'triage_suggest')).toBe(true));
  };

  it('confident todo suggestion opens promote prefilled: suggested board + suggested title (card text NOT AI)', async () => {
    seedPair();
    sweepOnce([sugg({ suggestedBoard: 'Zeta board', suggestedTitle: 'Renew the vpn cert' })]);
    render(<TriageView notes={useStore.getState().notes as NoteDto[]} />);
    await clickSuggest();
    pressKey('a'); // promote on the FIRST card (n1 — newest)
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Board' })).toHaveTextContent('Zeta board');
    expect(within(dialog).getByRole('textbox', { name: 'Card title' })).toHaveValue('Renew the vpn cert');
    expect(within(dialog).getByRole('textbox', { name: 'Card text' })).toHaveValue('Renew the vpn cert this week'); // first line, NOT AI
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('promote_note_to_board', {
      noteId: 'n1', boardId: 'b2', cardText: 'Renew the vpn cert this week', newTitle: 'Renew the vpn cert',
    }));
  });

  it('confident COMMANDS route opens move prefilled: LIBRARY/Commands + suggested title', async () => {
    seedPair();
    sweepOnce([sugg({ route: 'COMMANDS', suggestedTitle: 'vpn renewal steps' })]);
    render(<TriageView notes={useStore.getState().notes as NoteDto[]} />);
    await clickSuggest();
    pressKey('m');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Category' })).toHaveValue('LIBRARY/Commands');
    expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveValue('vpn renewal steps');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_note', {
      id: 'n1', title: 'vpn renewal steps', content: 'Renew the vpn cert this week', category: 'LIBRARY/Commands',
    }));
  });

  it('below-threshold suggestion opens the modals EXACTLY as P2 (entropy title, first board, first-line text)', async () => {
    seedPair();
    sweepOnce([sugg({ confidence: 0.4, suggestedBoard: 'Zeta board', suggestedTitle: 'AI title that must NOT appear' })]);
    render(<TriageView notes={useStore.getState().notes as NoteDto[]} />);
    await clickSuggest();
    pressKey('a');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Board' })).toHaveTextContent('Maintenance'); // boards[0] fallback
    expect(within(dialog).getByRole('textbox', { name: 'Card title' })).toHaveValue('Renew the vpn cert this week'); // titleFromText(content)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('promote_note_to_board', {
      noteId: 'n1', boardId: 'b1', cardText: 'Renew the vpn cert this week', newTitle: 'Renew the vpn cert this week',
    }));
  });

  it('NOISE route suggestion touches no prefill: promote uses P2 defaults, move uses the note category, discard untouched', async () => {
    seedPair();
    sweepOnce([sugg({ route: 'NOISE', suggestedBoard: 'Zeta board', suggestedTitle: 'AI title must not appear' })]);
    render(<TriageView notes={useStore.getState().notes as NoteDto[]} />);
    await clickSuggest();
    // the badge IS the cue (route badge renders)
    expect(cardByTitle('cap_pref_ab')!.querySelector('.triage-badge')!.textContent).toBe('NOISE');
    pressKey('m');
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Category' })).toHaveValue('!INBOX'); // the note's own category
    expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveValue('cap_pref_ab'); // the note's own title
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    pressKey('a');
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Board' })).toHaveTextContent('Maintenance'); // first board
    expect(within(dialog).getByRole('textbox', { name: 'Card title' })).toHaveValue('Renew the vpn cert this week'); // entropy fallback
  });

  it('user edits override the prefill (HITL law: values, never the contract)', async () => {
    seedPair();
    sweepOnce([sugg({ suggestedBoard: 'Zeta board', suggestedTitle: 'AI title' })]);
    render(<TriageView notes={useStore.getState().notes as NoteDto[]} />);
    await clickSuggest();
    pressKey('a');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Card title' })).toHaveValue('AI title');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Card text' }), { target: { value: 'User typed text' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Card title' }), { target: { value: 'User title' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('promote_note_to_board', {
      noteId: 'n1', boardId: 'b2', cardText: 'User typed text', newTitle: 'User title',
    }));
  });
});
