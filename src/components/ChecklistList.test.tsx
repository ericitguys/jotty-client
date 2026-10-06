import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import ChecklistList from './ChecklistList';
import { useStore } from '../stores/store';
import { relativeAge } from '../util/relativeTime'; // not mocked — real data rides the row

// tier A task 3: static css token fences (voiceTheme pattern — jsdom does no
// layout; RULE's helper there is NOT exported, so it is copied here).
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8');
const RULE = (sel: string) => {
  // match the first selector occurrence OUTSIDE a /* comment */ — the T1 helper's
  // first-substring intent (voiceTheme pattern); comments mention selectors too.
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const idx = noComments.indexOf(sel);
  expect(idx, `${sel} exists`).toBeGreaterThan(-1);
  const braces = noComments.indexOf('{', idx);
  const end = noComments.indexOf('}', braces);
  return noComments.slice(braces + 1, end);
};
const noCommentsCss = () => css.replace(/\/\*[\s\S]*?\*\//g, ''); // same strip as RULE

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
    fireEvent.click(screen.getByText('New checklist'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_checklist', { title: 'New checklist', category: 'Uncategorized' }));
  });

  it('+ New board calls create_task_board via the store and renders the button', async () => {
    render(<ChecklistList checklists={[]} />);
    fireEvent.click(screen.getByText('New board'));
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

describe('ChecklistList delete', () => {
  it('board and checklist rows both get a delete button; clicking opens the portal-worded confirm', () => {
    render(<ChecklistList checklists={[
      { id: 'b1', title: 'Sprint', category: 'Work', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, completed: false, listType: 'kanban', items: [] },
      { id: 'l1', title: 'Errands', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, completed: false, listType: 'simple', items: [] },
    ]} />);
    expect(screen.getByRole('button', { name: 'Delete Sprint' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Errands' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Sprint' }));
    expect(screen.getByText('Are you sure you want to delete "Sprint"?')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('delete_checklist', { id: 'b1' });
  });

  it('confirming invokes delete_checklist (works offline — outbox replays); Cancel does not', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'delete_checklist') return Promise.resolve();
      if (cmd === 'list_checklists') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<ChecklistList checklists={[
      { id: 'b1', title: 'Sprint', category: 'Work', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, completed: false, listType: 'kanban', items: [] },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Sprint' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(invoke).not.toHaveBeenCalledWith('delete_checklist', { id: 'b1' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Sprint' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('delete_checklist', { id: 'b1' }));
  });
});

// tier A task 3: checklist-list row metadata + header-button nowrap.
describe('ChecklistList row meta + header buttons (tier A task 3)', () => {
  it('rows carry the meta line: counts + age; boards render the board chip beside it', () => {
    // 1h ago derived in-test from relativeTime's OWN table (executor note:
    // never hard-code the age string from prose). Now() rides the real clock.
    const iso = new Date(Date.now() - 3_600_000).toISOString();
    const rows = [
      { id: 'l1', title: 'Groceries', category: 'Home', updatedAt: null, dirty: false, completed: false, listType: 'simple',
        itemCount: 5, doneCount: 2, createdAt: null, deletedAt: null, items: [] },
      { id: 'b1', title: 'Sprint', category: 'Work', updatedAt: iso,
        dirty: false, completed: false, listType: 'kanban', itemCount: 7, doneCount: 7, createdAt: null, deletedAt: null, items: [] },
    ];
    render(<ChecklistList checklists={rows as never[]} />);
    const g = screen.getByText('Groceries').closest('li')!;
    expect(g.querySelector('.row-meta')!.textContent).toBe('2 of 5 done · never synced');  // doneCount of itemCount — ORDER never flips
    const s = screen.getByText('Sprint').closest('li')!;
    expect(s.querySelector('.row-meta')!.textContent).toBe(`7 of 7 done · ${relativeAge(iso)}`);
    expect(within(s).getByText('board')).toBeInTheDocument(); // board chip survives beside the meta
  });

  it('old fixtures without counts skip the meta line (itemCount undefined → no .row-meta)', () => {
    // Same fixture shape the pre-task tests use: no itemCount → no meta span.
    render(<ChecklistList checklists={[
      { id: 'l1', title: 'Errands', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, completed: false, listType: 'simple', items: [] },
    ]} />);
    expect(document.querySelector('.row-meta')).not.toBeInTheDocument();
  });

  it('new-buttons never wrap (tier A finding: +New board/+New checklist wrapped to two lines)', () => {
    const block = RULE('.new-btn');
    expect(block).toContain('white-space: nowrap');
    // T3 review F2 (real-engine probe): the phone-media-only wrap fallback left the
    // narrow DESKTOP rail clipped. The group must wrap as a unit at any width.
    const head = RULE('.section-head');
    expect(head).toContain('flex-wrap: wrap');
    expect(RULE('.head-actions')).toContain('flex-wrap: wrap');
  });
});

describe('selected-chip contrast (tier B task 4, rider c)', () => {
  it('li.selected .chip text rides the per-theme --accent-contrast token (never literal white)', () => {
    const rule = RULE('li.selected .chip');
    expect(rule).toContain('var(--accent-contrast)');
    expect(rule).toContain('var(--accent-soft)'); // the tint background survives
    expect(rule).not.toContain('#fff');           // white-on-light-tint contrast class (m8)
    // one token, three theme blocks: dark ink on the light tint, white on the dark blocks
    expect(RULE(':root')).toContain('--accent-contrast: #fff');
    expect(RULE("#app[data-theme='light']")).toContain('--accent-contrast: #1b1b1f');
    expect(RULE("#app[data-theme='rwmarkable-dark']")).toContain('--accent-contrast: #fff');
  });
});

describe('ChecklistList card wall (v0.27.0)', () => {
  it('cards carry a completion progress bar: fill width + pct text from store counts', () => {
    const iso = new Date(Date.now() - 3_600_000).toISOString();
    render(<ChecklistList checklists={[
      { id: 'l1', title: 'Groceries', category: 'Home', updatedAt: iso, dirty: false, completed: false,
        listType: 'simple', itemCount: 4, doneCount: 1, createdAt: null, deletedAt: null, items: [] },
    ] as never[]} />);
    const li = screen.getByText('Groceries').closest('li')!;
    expect(li.querySelector('.card-progress')!.classList.contains('card-progress')).toBe(true);
    expect(li.querySelector('.progress-pct')!.textContent).toBe('25%');
    const fill = li.querySelector('.cl-progress-fill') as HTMLElement;
    expect(fill.style.width).toBe('25%');
    expect(li.querySelector('.cl-progress')).not.toBeNull(); // REUSES the checklist-view bar classes
  });

  it('zero-progress list shows 0% and an empty fill (never NaN/negative)', () => {
    render(<ChecklistList checklists={[
      { id: 'l2', title: 'Zero', category: '', updatedAt: null, dirty: false, completed: false,
        listType: 'simple', itemCount: 3, doneCount: 0, createdAt: null, deletedAt: null, items: [] },
    ] as never[]} />);
    const li = screen.getByText('Zero').closest('li')!;
    expect(li.querySelector('.progress-pct')!.textContent).toBe('0%');
    expect((li.querySelector('.cl-progress-fill') as HTMLElement).style.width).toBe('0%');
  });

  it('old fixtures without counts render neither progress row nor count footer', () => {
    render(<ChecklistList checklists={[
      { id: 'l3', title: 'Bare', category: '', createdAt: null, updatedAt: null, deletedAt: null,
        dirty: false, completed: false, listType: 'simple', items: [] },
    ] as never[]} />);
    const li = screen.getByText('Bare').closest('li')!;
    expect(li.querySelector('.card-progress')).toBeNull();
    expect(li.querySelector('.card-foot')).toBeNull();
  });

  it('card wall css: checklists = uniform grid (4 base, 3 @1440-, 2 @1024-, 1 @700-)', () => {
    expect(noCommentsCss()).toContain('#checklists ul {\n  display: grid;\n  gap: 14px;\n  grid-template-columns: repeat(4, minmax(0, 1fr));\n}');
    expect(noCommentsCss()).toContain('@media (max-width: 1440px) {\n  #checklists ul {\n    grid-template-columns: repeat(3, minmax(0, 1fr));\n  }\n}');
    expect(noCommentsCss()).toContain('@media (max-width: 1024px) {\n  #checklists ul {\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n  }\n}');
    expect(noCommentsCss()).toContain('#checklists ul {\n    grid-template-columns: 1fr;\n  }');
  });

  it('cards keep the pinned meta classes on the wall: row-meta meta-line count footer', () => {
    const iso = new Date(Date.now() - 7_200_000).toISOString();
    render(<ChecklistList checklists={[
      { id: 'b1', title: 'Sprint', category: 'Work', updatedAt: iso, dirty: false, completed: false,
        listType: 'kanban', itemCount: 7, doneCount: 7, createdAt: null, deletedAt: null, items: [] },
    ] as never[]} />);
    const li = screen.getByText('Sprint').closest('li')!;
    expect(li.querySelector('.card-foot .row-meta')!.classList.contains('meta-line')).toBe(true);
  });
});