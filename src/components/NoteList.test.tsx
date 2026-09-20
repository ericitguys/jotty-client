import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

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
    fireEvent.click(screen.getByText('+ New note'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_note', { title: 'Untitled note', category: 'Uncategorized' }));
  });

  it('renders provided notes', async () => {
    render(<NoteList notes={[{ id: 'n1', title: 'Groceries', content: 'milk', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, audioPath: null, audioDurationSecs: null }]} onStartVoiceNote={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });

  it('voice note button calls onStartVoiceNote', () => {
    const onStart = vi.fn();
    render(<NoteList notes={[]} onStartVoiceNote={onStart} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByText('🎙 New voice note'));
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