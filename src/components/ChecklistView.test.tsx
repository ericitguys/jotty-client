import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import ChecklistView from './ChecklistView';
import { useStore } from '../stores/store';

const items = [
  { localId: 'i1', checklistId: 'l1', parentLocalId: null, text: 'a', completed: false, position: 0, dirty: false, children: [] },
  { localId: 'i2', checklistId: 'l1', parentLocalId: null, text: 'b', completed: true, position: 1, dirty: false, children: [] },
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'get_checklist') return Promise.resolve({ id: 'l1', title: 'L', category: 'Home', updatedAt: null, dirty: false, items });
    if (cmd === 'set_item_checked' || cmd === 'reorder_items' || cmd === 'add_item' || cmd === 'delete_item') return Promise.resolve({});
    return Promise.resolve(null);
  });
  // zustand module singleton: the one-shot pending highlight must not leak between tests
  useStore.setState({ pendingHighlightId: null });
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
    fireEvent.change(screen.getByPlaceholderText('New item'), { target: { value: 'c' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'l1', text: 'c', parentLocalId: null, status: null }));
  });

  it('category change commits via update_checklist on blur', async () => {
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    const cat = screen.getByPlaceholderText('Category');
    fireEvent.change(cat, { target: { value: 'Errands' } });
    fireEvent.blur(cat);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_checklist', { id: 'l1', title: 'L', category: 'Errands' }));
  });

  it('save button commits meta and refreshes the store lists', async () => {
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('Category'), { target: { value: 'Trips' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_checklist', { id: 'l1', title: 'L', category: 'Trips' }));
    // refreshAll evidence: the store re-pulls the lists after committing
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('list_notes'));
  });

  it('item ops do not clobber in-progress category edits', async () => {
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    const cat = screen.getByPlaceholderText('Category');
    fireEvent.change(cat, { target: { value: 'Ho' } });
    fireEvent.change(screen.getByPlaceholderText('New item'), { target: { value: 'c' } });
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
});