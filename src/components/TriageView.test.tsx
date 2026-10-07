import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import TriageView from './TriageView';
import { relativeAge } from '../util/relativeTime';
import type { NoteDto } from '../api/types';

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

    for (const target of [
      screen.getByTestId('guard-input'),
      screen.getByTestId('guard-area'),
    ]) {
      pressKey('j', target);
      pressKey('k', target);
      pressKey('a', target);
      pressKey('m', target);
      pressKey('x', target);
      expect(cards()[1]!.classList.contains('selected')).toBe(true);
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
  it('renders the exact action labels Promote / Move… / Discard per card; clicking one is a placeholder no-op that keeps selection', () => {
    render(<TriageView notes={[
      note('n1', 'cap_first_ab', 'first body', isoAgo(2 * HOUR)),
      note('n2', 'cap_second_ab', 'second body', isoAgo(HOUR)),
    ]} />);
    const cards = [...document.querySelectorAll('li.triage-card')];
    for (const card of cards) {
      const labels = [...card.querySelectorAll('button')].map((b) => b.textContent);
      expect(labels).toEqual(['Promote', 'Move…', 'Discard']);
    }
    fireEvent.click(cards[0]!.querySelectorAll('button')[0]!);
    expect(cards[0]!.classList.contains('selected')).toBe(true); // selection untouched
    expect(invoke).not.toHaveBeenCalled(); // placeholder handlers wire no dispatch yet
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