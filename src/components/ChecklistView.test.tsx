import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import ChecklistView from './ChecklistView';
import { useStore } from '../stores/store';
import type { ChecklistDto } from '../api/types';

const items = [
  { localId: 'i1', checklistId: 'l1', parentLocalId: null, text: 'a', completed: false, position: 0, dirty: false, children: [] },
  { localId: 'i2', checklistId: 'l1', parentLocalId: null, text: 'b', completed: true, position: 1, dirty: false, children: [] },
];

// Minimal store-side checklist row (the T3-counted list_checklists wire, consumed
// by the view's header counts line). `items` stays [] — counts ride the wire.
const storeRow = (over: Partial<ChecklistDto> = {}): ChecklistDto => ({
  id: 'l1', title: 'L', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null,
  dirty: false, completed: false, listType: 'plain', items: [], ...over,
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'get_checklist') return Promise.resolve({ id: 'l1', title: 'L', category: 'Home', updatedAt: null, dirty: false, items });
    if (cmd === 'set_item_checked' || cmd === 'reorder_items' || cmd === 'add_item' || cmd === 'delete_item') return Promise.resolve({});
    return Promise.resolve(null);
  });
  // zustand module singleton: the one-shot pending highlight must not leak between tests
  useStore.setState({ pendingHighlightId: null });
  // tier A T4 hygiene: category tree + list rows persist across tests (module
  // singleton) — clear so every test seeds its own state (order-independent).
  useStore.setState({ categories: null, checklists: [] });
});

// jsdom has no Element.prototype.scrollIntoView: define it (so it can be
// spied), spy on it recording the scroll target + arg, and restore the
// original absent state afterwards.
const spyScrollIntoView = () => {
  const proto = Element.prototype as Element & { scrollIntoView?: (arg?: unknown) => void };
  const original = proto.scrollIntoView;
  if (!original) proto.scrollIntoView = () => {};
  const calls: { el: Element; arg: unknown }[] = [];
  const spy = vi.spyOn(proto, 'scrollIntoView').mockImplementation(function (this: Element, arg?: unknown) {
    calls.push({ el: this, arg });
  });
  return {
    calls,
    restore: () => {
      spy.mockRestore();
      if (!original) delete (proto as { scrollIntoView?: (arg?: unknown) => void }).scrollIntoView;
    },
  };
};

describe('ChecklistView', () => {
  it('renders items and toggling a checkbox calls set_item_checked', async () => {
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_checked', { checklistId: 'l1', itemLocalId: 'i1', checked: true }));
  });

  it('add item calls add_item and reloads', async () => {
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('Add an item ⏎'), { target: { value: 'c' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'l1', text: 'c', parentLocalId: null, status: null }));
  });

  it('category applies via dropdown — selecting an option commits update_checklist (Save button gone)', async () => {
    // pre-seed the store singleton's categories (beforeEach of this file does NOT):
    // 'Home' rides BOTH trees — the merged option set must carry it ONCE (dedupe by path).
    useStore.setState({ categories: {
      notes: [{ name: 'Home', path: 'Home', count: 1, level: 0 }, { name: 'Work', path: 'Work', count: 0, level: 0 }],
      checklists: [{ name: 'Home', path: 'Home', count: 1, level: 0 }, { name: 'Errands', path: 'Errands', count: 2, level: 0 }],
    } });
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument(); // Save button is GONE in dropdown mode
    fireEvent.click(screen.getByRole('button', { name: 'Category' }));
    fireEvent.click(screen.getByRole('option', { name: 'Work' }));  // merged tree: one 'Home' even tho both sides carry it
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_checklist', { id: 'l1', title: 'L', category: 'Work' }));
    // refresh evidence (T4 reshape of the old save-button fence, brief step 4):
    // the store re-pulls the lists after committing — assertion survives verbatim.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('list_notes'));
    expect(screen.queryAllByRole('option', { name: 'Home' })).toHaveLength(0); // menu closed again after the commit
  });

  it('category falls back to the text input when no categories exist (disconnected/empty tree)', async () => {
    useStore.setState({ categories: null });
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    const cat = screen.getByPlaceholderText('Category');  // the OLD text input still renders
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument(); // no Save in either mode (plan §Task 4)
    fireEvent.change(cat, { target: { value: 'Errands' } });
    fireEvent.blur(cat);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_checklist', { id: 'l1', title: 'L', category: 'Errands' }));
  });

  it('item ops do not clobber in-progress category edits', async () => {
    useStore.setState({ categories: null }); // typed in-progress edits survive only in the fallback input (dropdown applies instantly)
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    const cat = screen.getByPlaceholderText('Category');
    fireEvent.change(cat, { target: { value: 'Ho' } });
    fireEvent.change(screen.getByPlaceholderText('Add an item ⏎'), { target: { value: 'c' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'l1', text: 'c', parentLocalId: null, status: null }));
    // the reload after add_item must not snap the category field back to the DB value
    await waitFor(() => expect(screen.getByDisplayValue('Ho')).toBeInTheDocument());
  });

  it('reorder action sends full top-level order', async () => {
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    fireEvent.drop(screen.getAllByRole('listitem')[0], { dataTransfer: { getData: () => 'i2' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('reorder_items', { checklistId: 'l1', orderedTopLevelIds: ['i2', 'i1'] }));
  });

  it('completed items group at the bottom under a labeled divider; order data untouched', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_checklist') return Promise.resolve({ id: 'l1', title: 'L', category: 'Home', updatedAt: null, dirty: false,
        items: [
          { localId: 'i1', checklistId: 'l1', parentLocalId: null, text: 'a', completed: false, position: 0, dirty: false, children: [] },
          { localId: 'i2', checklistId: 'l1', parentLocalId: null, text: 'b', completed: true, position: 1, dirty: false, children: [] },
          { localId: 'i3', checklistId: 'l1', parentLocalId: null, text: 'c', completed: false, position: 2, dirty: false, children: [] },
        ] });
      return Promise.resolve({});
    });
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    const lis = document.querySelectorAll('#checklist-view > ul > li');
    // open rows first (positions preserved), THEN the divider, THEN the done row
    expect(document.querySelectorAll('#checklist-view > ul > li.completed-item')).toHaveLength(1);
    const texts = Array.from(lis).map((li) => li.querySelector('.item-text')?.textContent);
    expect(texts).toEqual(['a', 'c', 'b']); // i2 renders LAST despite position 1
    expect(screen.getByText(/Completed · 1/)).toBeInTheDocument();
    // order data untouched: a drop onto the FIRST row still sends the FULL top
    // order incl. i2 at its position. Insert-before-target is the pinned
    // contract (the retained 'reorder action sends full top-level order' fence
    // asserts the same drop semantics, spec L8: 'drop targets on open rows
    // unchanged') — the brief's literal array needed insert-AFTER, which would
    // break that retained fence, so the array here is the before-target shape.
    fireEvent.drop(screen.getAllByRole('listitem')[0], { dataTransfer: { getData: () => 'i3' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('reorder_items',
      { checklistId: 'l1', orderedTopLevelIds: ['i3', 'i1', 'i2'] }));
  });

  it('no completed group when nothing is done', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_checklist') return Promise.resolve({ id: 'l1', title: 'L', category: 'Home', updatedAt: null, dirty: false,
        items: [
          { localId: 'i1', checklistId: 'l1', parentLocalId: null, text: 'a', completed: false, position: 0, dirty: false, children: [] },
          { localId: 'i2', checklistId: 'l1', parentLocalId: null, text: 'b', completed: false, position: 1, dirty: false, children: [] },
        ] });
      return Promise.resolve({});
    });
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('b')).toBeInTheDocument());
    expect(screen.queryByText(/Completed/)).not.toBeInTheDocument();
  });

  it('add input sits above the list; Enter or Add button both call add_item', async () => {
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    const input = screen.getByPlaceholderText('Add an item ⏎');
    // input is ABOVE the rows in DOM order. Brief's bit test had the direction
    // flipped: compareDocumentPosition reports the ARGUMENT relative to the
    // caller, so rows following a top add-input = DOCUMENT_POSITION_FOLLOWING
    // (brief's PRECEDING would hold only if the rows PRECEDED it).
    expect(input.compareDocumentPosition(screen.getByText('a')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(input, { target: { value: 'c' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'l1', text: 'c', parentLocalId: null, status: null }));
    fireEvent.change(input, { target: { value: 'd' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'l1', text: 'd', parentLocalId: null, status: null }));
  });

  it('plain list: header renders the counts meta line + progress bar (T3 wire counts; display-only)', async () => {
    useStore.setState({ checklists: [storeRow({ itemCount: 5, doneCount: 2 })] });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_checklist') return Promise.resolve({ id: 'l1', title: 'L', category: 'Home', updatedAt: null, dirty: false,
        items: [
          { localId: 'i1', checklistId: 'l1', parentLocalId: null, text: 'a', completed: false, position: 0, dirty: false, children: [] },
          { localId: 'i2', checklistId: 'l1', parentLocalId: null, text: 'b', completed: true, position: 1, dirty: false, children: [] },
          { localId: 'i3', checklistId: 'l1', parentLocalId: null, text: 'c', completed: false, position: 2, dirty: false,
            children: [
              { localId: 'c1', checklistId: 'l1', parentLocalId: 'i3', text: 'c1', completed: false, position: 0, dirty: false, children: [] },
              { localId: 'c2', checklistId: 'l1', parentLocalId: 'i3', text: 'c2', completed: true, position: 1, dirty: false, children: [] },
            ] },
        ] });
      return Promise.resolve({});
    });
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    // counts ride the T3 wire (store row), never re-derived client-side —
    // nested children counted: 2 done (i2 + child c2) of 5 items, while the
    // view shows only 3 top-level rows (F6: wire counts ≠ visible top rows).
    const meta = document.querySelector('#checklist-head .row-meta.meta-line') as HTMLElement | null;
    expect(meta).not.toBeNull();
    expect(meta?.textContent).toContain('2 of 5 done');
    expect(meta?.textContent).toContain('never synced');
    expect(document.querySelectorAll('#checklist-view > ul > li')).toHaveLength(3); // display-only divergence is fine
    // 4px pure-CSS progress bar with a fill sized to the wire ratio
    const fill = document.querySelector('#checklist-head .cl-progress-fill') as HTMLElement | null;
    expect(fill).not.toBeNull();
    expect(fill?.style.width).toBe('40%');
    // header meta line is the LAST block in the header (T3-review F1 pattern)
    expect(document.getElementById('checklist-head')?.lastElementChild).toBe(meta);
  });

  it('boards render no header counts line or progress bar (plain lists only)', async () => {
    useStore.setState({ checklists: [storeRow({ itemCount: 5, doneCount: 2, listType: 'kanban' })] });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_checklist') return Promise.resolve({ id: 'l1', title: 'L', category: 'Home', updatedAt: null, dirty: false, listType: 'kanban',
        items: [
          { localId: 'i1', checklistId: 'l1', parentLocalId: null, text: 'card', completed: false, position: 0, dirty: false, status: null, priority: null, targetDate: null, children: [] },
        ] });
      if (cmd === 'get_board_columns' || cmd === 'fetch_task_board') return Promise.resolve({ checklistId: 'l1', statuses: [{ id: 'todo', label: 'To do', color: null, order: 0, autoComplete: false }] });
      return Promise.resolve({});
    });
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('card')).toBeInTheDocument()); // board branch mounted
    expect(document.querySelector('#checklist-head .row-meta.meta-line')).toBeNull(); // counts meta is plain-list only
    expect(document.querySelector('#checklist-head .cl-progress')).toBeNull();
  });

  it('header layout is column-idiomatic (T4-review F-1 real-engine catch, jsdom cannot see it)', () => {
    // .cl-progress must NOT carry the list-row flex-ROW idiom (flex-basis:100%) — in the
    // flex-COLUMN header it measured 18px instead of the spec 4px and shrunk the meta text
    // to a 3px sliver. Bind both halves so a regression cannot re-ship without breaking here.
    const css = readFileSync(join(here, '..', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (sel: string) => {
      const i = css.indexOf(sel);
      expect(i, sel).toBeGreaterThan(-1);
      const b = css.indexOf('{', i);
      return css.slice(b + 1, css.indexOf('}', b));
    };
    expect(rule('.cl-progress')).not.toContain('flex-basis');
    const headerMeta = rule('#checklist-head .row-meta');
    expect(headerMeta).toContain('flex-basis: auto');
    expect(headerMeta).toContain('flex-shrink: 0');
  });

  it('rows with a targetDate render a date chip after the item text (top-level and children)', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_checklist') return Promise.resolve({
        id: 'l1', title: 'L', category: 'Home', updatedAt: null, dirty: false,
        items: [
          { localId: 'i1', checklistId: 'l1', parentLocalId: null, text: 'dated top', completed: false, position: 0, dirty: false, targetDate: '2026-10-01',
            children: [
              { localId: 'c1', checklistId: 'l1', parentLocalId: 'i1', text: 'dated child', completed: false, position: 0, dirty: false, targetDate: '2026-10-02', children: [] },
            ] },
          { localId: 'i2', checklistId: 'l1', parentLocalId: null, text: 'undated', completed: false, position: 1, dirty: false, children: [] },
        ],
      });
      if (cmd === 'set_item_checked' || cmd === 'reorder_items' || cmd === 'add_item' || cmd === 'delete_item') return Promise.resolve({});
      return Promise.resolve(null);
    });
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('dated top')).toBeInTheDocument());
    const chips = document.querySelectorAll('.item-date-chip');
    expect(chips).toHaveLength(2); // the undated row renders no chip
    expect(chips[0]).toHaveTextContent('2026-10-01');
    expect(chips[1]).toHaveTextContent('2026-10-02');
    // the item text node is unchanged (the chip rides AFTER the text span)
    expect(screen.getByText('dated top')).toBeInTheDocument();
  });

  it('consumes the pending highlight after the load resolves: scrolls to the row and clears (one-shot)', async () => {
    const scroll = spyScrollIntoView();
    useStore.setState({ pendingHighlightId: 'i1' });
    try {
      render(<ChecklistView checklistId="l1" />);
      await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument()); // items resolved, rows mounted
      await waitFor(() => expect(useStore.getState().pendingHighlightId).toBeNull()); // one-shot: consumed
      expect(scroll.calls).toHaveLength(1);
      expect(scroll.calls[0].el).toBe(document.getElementById('item-i1')); // the pending row's element
      expect(scroll.calls[0].arg).toEqual({ block: 'center' });
    } finally {
      scroll.restore();
    }
  });

  it('pending id with no matching row after load: cleared silently, never scrolls (row-absent path)', async () => {
    const scroll = spyScrollIntoView();
    useStore.setState({ pendingHighlightId: 'i-missing' }); // belongs to no row of this (or any mounted) checklist
    try {
      render(<ChecklistView checklistId="l1" />);
      // the consume must not throw and must not abort the rest of the load:
      await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
      await waitFor(() => expect(screen.getByDisplayValue('L')).toBeInTheDocument()); // meta still loads after the consume
      await waitFor(() => expect(useStore.getState().pendingHighlightId).toBeNull()); // cleared regardless
      expect(scroll.calls).toEqual([]); // never scrolled
    } finally {
      scroll.restore();
    }
  });

  it('R6: add_item also fires the store catalog refresh (refreshAll), reload staying intact', async () => {
    let load = 0;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_checklist') {
        load++;
        return Promise.resolve({ id: 'l1', title: 'L', category: 'Home', updatedAt: null, dirty: false,
          items: load === 1 ? items : [...items,
            { localId: 'i3', checklistId: 'l1', parentLocalId: null, text: 'c', completed: false, position: 2, dirty: false, children: [] }] });
      }
      return Promise.resolve(null); // add_item + every refreshAll fetch resolve plainly
    });
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('Add an item ⏎'), { target: { value: 'c' } });
    fireEvent.click(screen.getByText('Add'));
    // existing reload() behavior intact: the row re-render rides the SECOND get_checklist payload
    await waitFor(() => expect(screen.getByText('c')).toBeInTheDocument());
    // refreshAll fingerprint — the same store catalog refetch the saveMeta path uses
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('list_checklists'));
    expect(invoke).toHaveBeenCalledWith('list_notes');
  });

  it('R6: toggle, rename and delete each fire the catalog refresh too', async () => {
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    invoke.mockClear();
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_checked', { checklistId: 'l1', itemLocalId: 'i1', checked: true }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('list_checklists')); // refreshAll rode the op
    invoke.mockClear();
    const input = screen.getByText('a').closest('.row-line')!
      .querySelector<HTMLInputElement>('input:not([type="checkbox"])')!; // the rename overlay input
    fireEvent.change(input, { target: { value: 'renamed' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_text', { checklistId: 'l1', itemLocalId: 'i1', text: 'renamed' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('list_checklists'));
    invoke.mockClear();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete item' })[0]);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('delete_item', { checklistId: 'l1', itemLocalId: 'i1' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('list_checklists'));
  });

  it('R7 companion pin: an open child of a done parent renders attached; the strike scope covers only the own line', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_checklist') return Promise.resolve({
        id: 'l1', title: 'L', category: 'Home', updatedAt: null, dirty: false,
        items: [
          { localId: 'i1', checklistId: 'l1', parentLocalId: null, text: 'done parent', completed: true, position: 0, dirty: false,
            children: [
              { localId: 'c1', checklistId: 'l1', parentLocalId: 'i1', text: 'open child attached', completed: false, position: 0, dirty: false, children: [] },
            ] },
          { localId: 'i2', checklistId: 'l1', parentLocalId: null, text: 'open top', completed: false, position: 1, dirty: false, children: [] },
        ],
      });
      return Promise.resolve({});
    });
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('open child attached')).toBeInTheDocument());
    const done = document.querySelector('#checklist-view > ul > li.completed-item') as HTMLElement | null;
    expect(done).not.toBeNull();
    // children render attached to their parent wherever it sits (grouped done
    // section): the old UNSCOPED strike matcher would own BOTH lines
    expect(Array.from(done!.querySelectorAll('.item-text')).map((e) => e.textContent))
      .toEqual(['done parent', 'open child attached']);
    // the SCOPED strike shape (the styles.css selector) owns ONLY the own line
    expect(Array.from(document.querySelectorAll('#checklist-view > ul > li.completed-item > .row-line > .item-text'))
      .map((e) => e.textContent)).toEqual(['done parent']);
  });

  it('rider a: checklist-view delete buttons carry the row-del class (top-level + child rows)', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_checklist') return Promise.resolve({
        id: 'l1', title: 'L', category: 'Home', updatedAt: null, dirty: false,
        items: [{
          localId: 'i1', checklistId: 'l1', parentLocalId: null, text: 'a', completed: false, position: 0, dirty: false,
          children: [{ localId: 'c1', checklistId: 'l1', parentLocalId: 'i1', text: 'kid', completed: false, position: 0, dirty: false, children: [] }],
        }],
      });
      return Promise.resolve({});
    });
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('kid')).toBeInTheDocument());
    const dels = document.querySelectorAll('#checklist-view .row-del');
    expect(dels.length).toBe(2); // top-level AND child rows join the uniform affordance (spec L4 half)
    expect(dels[0].getAttribute('aria-label')).toBe('Delete item');
    expect(dels[1].getAttribute('aria-label')).toBe('Delete subitem'); // a11y names never change
  });

  it('rider a: the .row-del hover-reveal rule covers the checklist view (selector-list extension)', () => {
    const css = readFileSync(join(here, '..', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const i = css.indexOf('#notes li:hover .row-del');
    expect(i).toBeGreaterThan(-1);
    // the extension joins the EXISTING hover-reveal rule's selector list (T5-review
    // precedent: extend lists, never duplicate rules the static fences read first)
    const selList = css.slice(i, css.indexOf('{', i));
    expect(selList).toContain('#checklist-view li:hover .row-del');
  });

  it('rider g (R-B5 evidence): warm mount renders the category dropdown from the STORE tree before listMeta loads', async () => {
    useStore.setState({
      categories: {
        notes: [{ name: 'Home', path: 'Home', count: 1, level: 0 }],
        checklists: [{ name: 'Work', path: 'Work', count: 2, level: 0 }],
      },
    });
    // listMeta still loading: the mount-resolve never fires during the asserts
    invoke.mockImplementation((cmd: string) =>
      cmd === 'get_checklist' ? new Promise(() => { /* pending — the mount window */ }) : Promise.resolve(null));
    render(<ChecklistView checklistId="l1" />);
    // pre-listMeta window: the Dropdown (store-derived options) is up, NOT the fallback input
    // — catOptions derives from store categories alone, so the ~120ms wire never downgrades
    expect(screen.getByRole('button', { name: 'Category' })).toBeInTheDocument();
    expect(document.querySelector('.cl-category')).toBeNull();
  });

  it('rider g (R-B5 re-rule): a mount-window blur with an EMPTY title never commits update_checklist', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_checklist') return new Promise((resolve) =>
        setTimeout(() => resolve({ id: 'l1', title: 'L', category: 'Home', updatedAt: null, dirty: false, items }), 50));
      return Promise.resolve(null);
    });
    render(<ChecklistView checklistId="l1" />);
    const titleInput = document.querySelector('.cl-title') as HTMLInputElement; // renders pre-load (controlled, value '')
    expect(titleInput.value).toBe('');   // the mount window: title state is still ''
    fireEvent.blur(titleInput);          // stray blur DURING the ~120ms window
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());  // the load resolved
    await waitFor(() => expect(screen.getByDisplayValue('L')).toBeInTheDocument());
    // the empty-title stray blur must NEVER commit — not now, not after the load
    expect(invoke).not.toHaveBeenCalledWith('update_checklist', expect.objectContaining({ id: 'l1' }));
    // the commit path stays live for a REAL title (non-empty blur commits as before)
    fireEvent.change(titleInput, { target: { value: 'Renamed' } });
    fireEvent.blur(titleInput);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_checklist', { id: 'l1', title: 'Renamed', category: 'Home' }));
  });

  it('F2: switching checklistId remounts the board and clears the column menu', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_checklist') {
        return Promise.resolve({
          id: 'l1', title: 'Board A', category: 'Home', updatedAt: null, dirty: false, listType: 'kanban',
          items: [
            { localId: 'i1', checklistId: 'l1', parentLocalId: null, text: 'a', completed: false, position: 0, dirty: false, status: 'todo', priority: null, targetDate: null, children: [] },
          ],
        });
      }
      if (cmd === 'get_board_columns' || cmd === 'fetch_task_board') {
        return Promise.resolve({ checklistId: 'l1', statuses: [{ id: 'todo', label: 'To do', color: null, order: 0, autoComplete: false }] });
      }
      return Promise.resolve({});
    });
    const { rerender } = render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Column actions' }));
    expect(document.querySelector('.kanban-col-head .kanban-menu')).not.toBeNull();
    rerender(<ChecklistView checklistId="l2" />);
    await waitFor(() => expect(document.querySelector('.kanban-col-head .kanban-menu')).toBeNull());
  });
});