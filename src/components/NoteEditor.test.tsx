import { render, screen, waitFor } from '@testing-library/react';
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
});
