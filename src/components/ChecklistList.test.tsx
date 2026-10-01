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
  const idx = css.indexOf(sel);
  expect(idx, `${sel} exists`).toBeGreaterThan(-1);
  const braces = css.indexOf('{', idx);
  const end = css.indexOf('}', braces);
  return css.slice(braces + 1, end);
};

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
  });
});