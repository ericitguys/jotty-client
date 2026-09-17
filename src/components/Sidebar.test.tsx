import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import Sidebar from './Sidebar';
import { useStore } from '../stores/store';

const cats = {
  notes: [
    { name: 'Home', path: 'Home', count: 2, level: 0 },
    { name: 'Work', path: 'Work', count: 1, level: 0 },
  ],
  checklists: [{ name: 'Errands', path: 'Errands', count: 3, level: 0 }],
};

beforeEach(() => {
  useStore.setState({ categories: cats, selectedCategory: null });
});

describe('Sidebar category filtering', () => {
  it('clicking a category selects it in the store and marks it selected', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText('Home'));
    expect(useStore.getState().selectedCategory).toEqual({ type: 'notes', path: 'Home' });
    expect(screen.getByText('Home').closest('li')).toHaveClass('selected');
  });

  it('clicking the selected category again clears the filter', () => {
    useStore.setState({ selectedCategory: { type: 'notes', path: 'Home' } });
    render(<Sidebar />);
    fireEvent.click(screen.getByText('Home'));
    expect(useStore.getState().selectedCategory).toBeNull();
  });

  it('selecting a checklist category clears open selections so the list is visible', () => {
    useStore.setState({ selectedCategory: null, selectedNoteId: 'n1', selectedChecklistId: null });
    render(<Sidebar />);
    fireEvent.click(screen.getByText('Errands'));
    expect(useStore.getState().selectedCategory).toEqual({ type: 'checklists', path: 'Errands' });
    expect(useStore.getState().selectedNoteId).toBeNull();
  });

  it('show all button clears an active filter', () => {
    useStore.setState({ selectedCategory: { type: 'checklists', path: 'Errands' } });
    render(<Sidebar />);
    fireEvent.click(screen.getByText('Show all'));
    expect(useStore.getState().selectedCategory).toBeNull();
  });
});