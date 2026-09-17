import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import SearchPalette from './SearchPalette';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'search') return Promise.resolve({ notes: [{ id: 'n1', title: 'Groceries', snippet: '…milk…' }], checklists: [] });
    return Promise.resolve(null);
  });
});

describe('SearchPalette', () => {
  it('queries search and navigates on result click', async () => {
    const selectNote = vi.fn();
    render(<SearchPalette onClose={() => {}} onSelectNote={selectNote} onSelectChecklist={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'milk' } });
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Groceries'));
    expect(selectNote).toHaveBeenCalledWith('n1');
  });
});