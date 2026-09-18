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
  // the store is a module singleton — reset ALL ui state between tests
  useStore.setState({ categories: cats, selectedCategory: null, selectedNoteId: null, selectedChecklistId: null, listMode: 'notes' });
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

  it('selecting a checklist category filters and clears open selections', () => {
    // checklist categories are only reachable in the checklists tab
    useStore.setState({ selectedCategory: null, selectedNoteId: 'n1', selectedChecklistId: null, listMode: 'checklists' });
    render(<Sidebar />);
    fireEvent.click(screen.getByText('Errands'));
    const s = useStore.getState();
    expect(s.selectedCategory).toEqual({ type: 'checklists', path: 'Errands' });
    expect(s.listMode).toBe('checklists');
    expect(s.selectedNoteId).toBeNull();
  });

  it('show all button clears an active filter', () => {
    useStore.setState({ selectedCategory: { type: 'checklists', path: 'Errands' } });
    render(<Sidebar />);
    fireEvent.click(screen.getByText('Show all'));
    expect(useStore.getState().selectedCategory).toBeNull();
  });
});

describe('Sidebar section switching', () => {
  it('clicking the Checklists header switches to checklists mode and closes open items', () => {
    useStore.setState({ listMode: 'notes', selectedNoteId: 'n1', selectedCategory: { type: 'notes', path: 'Home' } });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Checklists' }));
    const s = useStore.getState();
    expect(s.listMode).toBe('checklists');
    expect(s.selectedNoteId).toBeNull();
    expect(s.selectedCategory).toBeNull();
  });

  it('clicking the Notes header switches back to notes mode and closes open checklists', () => {
    useStore.setState({ listMode: 'checklists', selectedChecklistId: 'l1' });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    const s = useStore.getState();
    expect(s.listMode).toBe('notes');
    expect(s.selectedChecklistId).toBeNull();
  });

  it('the active section header is highlighted', () => {
    useStore.setState({ listMode: 'checklists' });
    render(<Sidebar />);
    expect(screen.getByRole('button', { name: 'Checklists' })).toHaveClass('selected');
    expect(screen.getByRole('button', { name: 'Notes' })).not.toHaveClass('selected');
  });

  it('only the active section shows its categories', () => {
    render(<Sidebar />);
    expect(screen.queryByText('Errands')).not.toBeInTheDocument(); // checklist cats hidden in notes mode
    fireEvent.click(screen.getByRole('button', { name: 'Checklists' }));
    expect(screen.getByText('Errands')).toBeInTheDocument();
    expect(screen.queryByText('Work')).not.toBeInTheDocument(); // notes cats hidden in checklists mode
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
  });
});