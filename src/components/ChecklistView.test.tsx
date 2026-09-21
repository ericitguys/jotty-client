import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import ChecklistView from './ChecklistView';

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
});

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
});