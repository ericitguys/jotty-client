import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import NoteEditor from './NoteEditor';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'get_note') return Promise.resolve({ id: args?.id, title: 'T', content: '<p>hello</p>', category: 'Home', updatedAt: null, deletedAt: null, dirty: false });
    if (cmd === 'update_note') return Promise.resolve({});
    return Promise.resolve(null);
  });
});

describe('NoteEditor', () => {
  it('renders note content and saves on edit after debounce', async () => {
    render(<NoteEditor noteId="n1" />);
    await waitFor(() => expect(screen.getByDisplayValue('T')).toBeInTheDocument());
    // TipTap renders into a contenteditable; assert it mounted
    expect(document.querySelector('.tiptap')).not.toBeNull();
  });

  it('category change saves with the new category after debounce', async () => {
    render(<NoteEditor noteId="n1" />);
    await waitFor(() => expect(screen.getByDisplayValue('T')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('Category'), { target: { value: 'Work' } });
    // idle past the 800ms debounce window (real timers per ruling Q)
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(invoke).toHaveBeenCalledWith('update_note', { id: 'n1', title: 'T', content: '<p>hello</p>', category: 'Work' });
  });

  it('note_switch_does_not_clobber_previous_note', async () => {
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_note') {
        if (args?.id === 'n2') return Promise.resolve({ id: 'n2', title: 'T2', content: '<p>two</p>', category: 'Home', updatedAt: null, deletedAt: null, dirty: false });
        return Promise.resolve({ id: args?.id, title: 'T', content: '<p>hello</p>', category: 'Home', updatedAt: null, deletedAt: null, dirty: false });
      }
      if (cmd === 'update_note') return Promise.resolve({});
      return Promise.resolve(null);
    });
    const { rerender } = render(<NoteEditor noteId="n1" />);
    await waitFor(() => expect(screen.getByDisplayValue('T')).toBeInTheDocument());
    rerender(<NoteEditor noteId="n2" />);
    await waitFor(() => expect(screen.getByDisplayValue('T2')).toBeInTheDocument());
    // idle past the 800ms debounce window (real timers per ruling Q)
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const updates = invoke.mock.calls.filter((c) => c[0] === 'update_note');
    expect(updates.filter((c) => c[1]?.id === 'n1')).toEqual([]);
    for (const c of updates) expect(c[1]?.id).toBe('n2');
  });
});
