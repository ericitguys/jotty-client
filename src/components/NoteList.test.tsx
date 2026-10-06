import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const cssText = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { relativeAge } from '../util/relativeTime'; // not mocked — real data rides the row

import NoteList from './NoteList';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'list_notes') {
      return Promise.resolve([
        { id: 'n1', title: 'Groceries', content: 'milk', category: 'Home', updatedAt: null, dirty: false },
      ]);
    }
    if (cmd === 'create_note') {
      return Promise.resolve({ id: 'n9', title: 'Untitled note', content: '', category: 'Uncategorized', createdAt: null, updatedAt: null, deletedAt: null, dirty: true });
    }
    return Promise.resolve(null);
  });
});

describe('NoteList creation', () => {
  it('new note button calls create_note with default title and category', async () => {
    render(<NoteList notes={[]} onStartVoiceNote={vi.fn()} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByText('New note'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_note', { title: 'Untitled note', category: 'Uncategorized' }));
  });

  it('renders provided notes', async () => {
    render(<NoteList notes={[{ id: 'n1', title: 'Groceries', content: 'milk', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, audioPath: null, audioDurationSecs: null }]} onStartVoiceNote={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });

  it('voice note button calls onStartVoiceNote', () => {
    const onStart = vi.fn();
    render(<NoteList notes={[]} onStartVoiceNote={onStart} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByText('New voice note'));
    expect(onStart).toHaveBeenCalled();
  });

  it('mic badge shows only for notes with audio and empty content', () => {
    const notes = [
      { id: 'n1', title: 'Pending', content: '', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, audioPath: '/data/voice/a.wav', audioDurationSecs: 3 },
      { id: 'n2', title: 'Done', content: 'text', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, audioPath: '/data/voice/b.wav', audioDurationSecs: 3 },
      { id: 'n3', title: 'Plain', content: 'text', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, audioPath: null, audioDurationSecs: null },
    ];
    render(<NoteList notes={notes as never[]} onStartVoiceNote={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByTitle('Pending transcription — retries after sync')).toBeInTheDocument();
    expect(screen.getAllByTitle('Pending transcription — retries after sync')).toHaveLength(1);
  });
});

describe('NoteList delete', () => {
  it('every row has a delete button; clicking it opens the confirm modal without selecting the row', () => {
    const notes = [
      { id: 'n1', title: 'Groceries', content: 'milk', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, audioPath: null, audioDurationSecs: null },
      { id: 'n2', title: 'Ideas', content: 'x', category: 'Work', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, audioPath: null, audioDurationSecs: null },
    ];
    render(<NoteList notes={notes as never[]} onStartVoiceNote={vi.fn()} onOpenSettings={vi.fn()} />);
    const buttons = screen.getAllByRole('button', { name: 'Delete Groceries' });
    expect(buttons).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Delete Ideas' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Groceries' }));
    expect(screen.getByText('Are you sure you want to delete "Groceries"?')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('delete_note', { id: 'n1' }); // confirm not yet
  });

  it('confirming the modal invokes delete_note and closes it; Cancel does not', async () => {
    const notes = [
      { id: 'n1', title: 'Groceries', content: 'milk', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, audioPath: null, audioDurationSecs: null },
    ];
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'delete_note') return Promise.resolve();
      if (cmd === 'list_notes') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<NoteList notes={notes as never[]} onStartVoiceNote={vi.fn()} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Groceries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Are you sure you want to delete "Groceries"?')).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('delete_note', { id: 'n1' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Groceries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('delete_note', { id: 'n1' }));
  });
});

describe('NoteList row metadata', () => {
  it('rows carry the meta line: stripped snippet + relative age', () => {
    const iso = new Date(Date.now() - 7_200_000).toISOString();
    const notes = [{ id: 'n1', title: 'Groceries', content: '<p>&nbsp;oat milk &amp; bread</p>',
      category: 'Home', createdAt: null, updatedAt: iso, deletedAt: null, dirty: false,
      audioPath: null, audioDurationSecs: null }];
    render(<NoteList notes={notes as never[]} onStartVoiceNote={vi.fn()} onOpenSettings={vi.fn()} />);
    const row = screen.getByText('Groceries').closest('li')!;
    expect(row.querySelector('.row-snippet')!.textContent).toBe('oat milk & bread');
    // '2h ago' derived from relativeAge (same arithmetic) per the brief note —
    // wall-clock-safe at any local hour.
    expect(row.querySelector('.row-age')!.textContent).toBe(relativeAge(iso));
  });

  it('snippet collapses markup blocks to spaces; empty content renders no snippet', () => {
    const notes = [
      { id: 'n1', title: 'A', content: '<h1>t1</h1><p>t2</p>', category: '', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, audioPath: null, audioDurationSecs: null },
      { id: 'n2', title: 'B', content: '', category: '', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, audioPath: null, audioDurationSecs: null },
    ];
    render(<NoteList notes={notes as never[]} onStartVoiceNote={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByText('A').closest('li')!.querySelector('.row-snippet')!.textContent).toBe('t1 t2');
    expect(screen.getByText('B').closest('li')!.querySelector('.row-snippet')).toBeNull();
  });

  it('empty content renders no snippet; never-synced note renders never-synced age', () => {
    const notes = [{ id: 'n3', title: 'C', content: '', category: '', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, audioPath: null, audioDurationSecs: null }];
    render(<NoteList notes={notes as never[]} onStartVoiceNote={vi.fn()} onOpenSettings={vi.fn()} />);
    const row = screen.getByText('C').closest('li')!;
    expect(row.querySelector('.row-snippet')).toBeNull();
    expect(row.querySelector('.row-age')!.textContent).toBe('never synced');
  });
});

describe('NoteList card wall (v0.27.0)', () => {
  const base = { createdAt: null, deletedAt: null, dirty: false, audioPath: null, audioDurationSecs: null };

  it('renders as a card wall: ul.card-wall with head/body/foot card regions', () => {
    const iso = new Date(Date.now() - 7_200_000).toISOString();
    const notes = [{ id: 'n1', title: 'Groceries', content: '<p>oat milk</p>', category: 'Home', updatedAt: iso, ...base }];
    render(<NoteList notes={notes as never[]} onStartVoiceNote={vi.fn()} onOpenSettings={vi.fn()} />);
    const ul = document.querySelector('#notes ul')!;
    expect(ul.classList.contains('card-wall')).toBe(true);
    const li = screen.getByText('Groceries').closest('li')!;
    expect(li.querySelector('.card-head .item-title')!.textContent).toBe('Groceries');
    expect(li.querySelector('.card-head .chip')!.textContent).toBe('Home');
    expect(li.querySelector('.card-body .row-snippet')!.textContent).toBe('oat milk');
    expect(li.querySelector('.card-foot .row-age')).not.toBeNull();
  });

  it('empty-content note card: no card-body, footer still rides', () => {
    const notes = [{ id: 'n2', title: 'C', content: '', category: '', updatedAt: null, ...base }];
    render(<NoteList notes={notes as never[]} onStartVoiceNote={vi.fn()} onOpenSettings={vi.fn()} />);
    const li = screen.getByText('C').closest('li')!;
    expect(li.querySelector('.card-body')).toBeNull();
    expect(li.querySelector('.card-foot .row-age')!.textContent).toBe('never synced');
  });

  it('card wall css: notes = masonry columns (3 base, 4 @1600+, 2 @1024-, 1 @700-)', () => {
    const noComments = cssText().replace(/\/\*[\s\S]*?\*\//g, '');
    expect(noComments).toContain('#notes ul {\n  column-gap: 14px;\n  column-count: 3;\n}');
    expect(noComments).toContain('@media (min-width: 1600px) {\n  #notes ul {\n    column-count: 4;\n  }\n}');
    expect(noComments).toContain('@media (max-width: 1024px) {\n  #notes ul {\n    column-count: 2;\n  }\n}');
    expect(noComments).toContain('#notes ul {\n    column-count: 1;\n  }');
  });
});