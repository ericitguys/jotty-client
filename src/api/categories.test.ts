import { describe, expect, it } from 'vitest';

import { deriveCategories, UNCATEGORIZED } from './categories';
import type { ChecklistDto, NoteDto } from './types';

const note = (id: string, category: string, dirty = false): NoteDto => ({
  id,
  title: id,
  content: '',
  category,
  createdAt: null,
  updatedAt: null,
  deletedAt: null,
  dirty,
  audioPath: null,
  audioDurationSecs: null,
});

const list = (id: string, category: string, dirty = false): ChecklistDto => ({
  id,
  title: id,
  category,
  createdAt: null,
  updatedAt: null,
  deletedAt: null,
  dirty,
  completed: false,
  listType: 'task',
  items: [],
});

describe('deriveCategories — offline fallback mirroring the server /api/categories derivation', () => {
  it('derives parent nodes with their own counts, children at level+1, alphabetical DFS order', () => {
    const cats = deriveCategories(
      [note('n1', 'Work/Deep'), note('n2', 'Home'), note('n3', 'Work/Deep')],
      [list('l1', 'Home')],
    );
    expect(cats.notes).toEqual([
      { name: 'Home', path: 'Home', count: 1, level: 0 },
      { name: 'Work', path: 'Work', count: 0, level: 0 },
      { name: 'Deep', path: 'Work/Deep', count: 2, level: 1 },
    ]);
    // checklists derive their own tree from checklist category strings
    expect(cats.checklists).toEqual([{ name: 'Home', path: 'Home', count: 1, level: 0 }]);
  });

  it('counts only entities whose category exactly equals the node path (children never bump the parent)', () => {
    const cats = deriveCategories([note('n1', 'Work'), note('n2', 'Work/Sub')], []);
    expect(cats.notes).toEqual([
      { name: 'Work', path: 'Work', count: 1, level: 0 },
      { name: 'Sub', path: 'Work/Sub', count: 1, level: 1 },
    ]);
  });

  it('includes dirty (offline-created) entities; empty maps to Uncategorized like the server API', () => {
    const cats = deriveCategories(
      [note('n1', 'Offline Draft', true), note('n2', ''), note('n3', '   ')],
      [list('l1', '', true)],
    );
    // '' -> 'Uncategorized' (server REST normalizes `category || "Uncategorized"`);
    // '   ' stays verbatim because the server does not trim (it would be a
    // literal directory name server-side)
    const names = cats.notes.map((n) => n.name);
    expect(names).toContain('Offline Draft');
    expect(names).toContain(UNCATEGORIZED);
    expect(names).toContain('   ');
    const uncategorized = cats.notes.find((n) => n.name === UNCATEGORIZED)!;
    expect(uncategorized).toEqual({ name: 'Uncategorized', path: 'Uncategorized', count: 1, level: 0 });
    // checklists derive their own tree the same way
    expect(cats.checklists).toEqual([{ name: UNCATEGORIZED, path: 'Uncategorized', count: 1, level: 0 }]);
  });

  it('excludes .archive paths like the server category filter', () => {
    const cats = deriveCategories(
      [note('n1', '.archive/Old'), note('n2', 'Work/.archive/Deep'), note('n3', 'Home')],
      [],
    );
    expect(cats.notes).toEqual([{ name: 'Home', path: 'Home', count: 1, level: 0 }]);
  });

  it('collapses empty path segments and treats deep nesting level-by-level', () => {
    const cats = deriveCategories([note('n1', 'A//B/C')], []);
    expect(cats.notes).toEqual([
      { name: 'A', path: 'A', count: 0, level: 0 },
      { name: 'B', path: 'A/B', count: 0, level: 1 },
      { name: 'C', path: 'A/B/C', count: 1, level: 2 },
    ]);
  });
});