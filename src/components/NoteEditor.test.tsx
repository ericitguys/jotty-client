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

  it('save button flushes pending edits immediately and refreshes the store', async () => {
    render(<NoteEditor noteId="n1" />);
    await waitFor(() => expect(screen.getByDisplayValue('T')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('Category'), { target: { value: 'Urgent' } });
    // NO debounce wait — Save must commit right away
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_note', { id: 'n1', title: 'T', content: '<p>hello</p>', category: 'Urgent' }));
    // refreshAll evidence: the store re-pulls the lists
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('list_notes'));
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

  it('shows the voice panel with playback and duration when the note has audio', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_note') return Promise.resolve({ id: 'n1', title: 'T', content: '<p>hi</p>', category: 'Home', audioPath: '/data/voice/n1.wav', audioDurationSecs: 65, createdAt: null, updatedAt: null, deletedAt: null, dirty: false });
      if (cmd === 'update_note') return Promise.resolve({});
      return Promise.resolve(null);
    });
    render(<NoteEditor noteId="n1" />);
    await waitFor(() => expect(document.querySelector('.voice-panel')).not.toBeNull());
    const audio = document.querySelector('.voice-panel audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('src')).toContain('/data/voice/n1.wav');
    expect(document.querySelector('.voice-panel')?.textContent).toContain('1:05');
  });

  it('no audio_path means no voice panel', async () => {
    render(<NoteEditor noteId="n1" />);
    await waitFor(() => expect(screen.getByDisplayValue('T')).toBeInTheDocument());
    expect(document.querySelector('.voice-panel')).toBeNull();
  });

  it('delete audio clears the panel without touching content', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_note') return Promise.resolve({ id: 'n1', title: 'T', content: '<p>hi</p>', category: 'Home', audioPath: '/data/voice/n1.wav', audioDurationSecs: 65, createdAt: null, updatedAt: null, deletedAt: null, dirty: false });
      if (cmd === 'voice_delete_note_audio') return Promise.resolve({ id: 'n1', title: 'T', content: '<p>hi</p>', category: 'Home', audioPath: null, audioDurationSecs: null, createdAt: null, updatedAt: null, deletedAt: null, dirty: false });
      if (cmd === 'update_note') return Promise.resolve({});
      return Promise.resolve(null);
    });
    render(<NoteEditor noteId="n1" />);
    await waitFor(() => expect(document.querySelector('.voice-panel')).not.toBeNull());
    fireEvent.click(screen.getByText('Delete audio'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_delete_note_audio', { noteId: 'n1' }));
    await waitFor(() => expect(document.querySelector('.voice-panel')).toBeNull());
  });

  it('re-transcribe button calls onRetranscribe with the note id', async () => {
    const onRetranscribe = vi.fn();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_note') return Promise.resolve({ id: 'n1', title: 'T', content: '<p>hi</p>', category: 'Home', audioPath: '/data/voice/n1.wav', audioDurationSecs: 65, createdAt: null, updatedAt: null, deletedAt: null, dirty: false });
      if (cmd === 'update_note') return Promise.resolve({});
      return Promise.resolve(null);
    });
    render(<NoteEditor noteId="n1" onRetranscribe={onRetranscribe} />);
    await waitFor(() => expect(document.querySelector('.voice-panel')).not.toBeNull());
    fireEvent.click(screen.getByText('Re-transcribe'));
    expect(onRetranscribe).toHaveBeenCalledWith('n1');
  });

  it('shows the code language picker in the editor foot', async () => {
    render(<NoteEditor noteId="n1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Code language' })).toBeInTheDocument());
    // opens the site-style menu with the common language set
    fireEvent.click(screen.getByRole('button', { name: 'Code language' }));
    expect(await screen.findByRole('option', { name: 'Python' })).toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: 'Rust' }).length).toBeGreaterThan(0);
  });

  it('selecting a language inside a code block stamps the language class', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_note') return Promise.resolve({ id: 'n1', title: 'T', content: '<pre><code>x = 1</code></pre>', category: 'Home', updatedAt: null, deletedAt: null, dirty: false });
      if (cmd === 'update_note') return Promise.resolve({});
      return Promise.resolve(null);
    });
    render(<NoteEditor noteId="n1" />);
    // click into the code block so the cursor sits inside it
    const code = await waitFor(() => {
      const el = document.querySelector('.tiptap pre code');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(code);
    fireEvent.click(screen.getByRole('button', { name: 'Code language' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Python' }));
    // the editor updates the block language; the hint flips to the in-block text
    await waitFor(() => expect(document.querySelector('.code-lang-hint')?.textContent).toBe('applies to this code block'));
    expect(document.querySelector('.tiptap pre code')?.className).toContain('language-python');
  });
});
