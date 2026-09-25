import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import VoiceNoteReview, { titleFromTranscript } from './VoiceNoteReview';
import { useStore } from '../stores/store';

const recordedRow = {
  id: 'r1', path: '/data/voice/r1.wav', durationSecs: 4.2,
  rawTranscript: null, tidiedTranscript: null, state: 'recorded', lastError: null, createdAt: '2026-09-18T00:00:00Z',
};

beforeEach(() => {
  invoke.mockReset();
  // zustand is a module singleton: reset the state the component consumes so a
  // leaked connection/selection can't bleed between tests (store.test shape).
  useStore.setState({
    connection: null,
    notes: [],
    checklists: [],
    categories: null,
    syncStatus: null,
    selectedNoteId: null,
    selectedChecklistId: null,
    selectedCategory: null,
    listMode: 'notes',
  });
  // jsdom has no mediaDevices: stub getUserMedia for the mic-permission gate.
  // Default: granted — individual tests override for the denial path.
  const gm = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: gm } });
  (globalThis as unknown as { __lastGum: unknown }).__lastGum = gm;
  invoke.mockImplementation((cmd: string) => {
    // fresh createdAt: the component derives the re-attach timer from it — a
    // stale fixture date would read as "recording for days" (cap auto-stop)
    if (cmd === 'voice_start_recording') return Promise.resolve({ ...recordedRow, createdAt: new Date().toISOString() });
    if (cmd === 'voice_stop_recording') return Promise.resolve(recordedRow);
    if (cmd === 'voice_transcribe') return Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'Hello world. Second sentence.', lastError: null });
    if (cmd === 'voice_tidy') return Promise.resolve({ tidied: 'Hello, world.' });
    if (cmd === 'voice_save_note') return Promise.resolve({ id: 'n9', title: 'Hello world. Second sentence.', content: 'x', category: 'Uncategorized', audioPath: '/data/voice/r1.wav', audioDurationSecs: 4.2, createdAt: null, updatedAt: null, deletedAt: null, dirty: true });
    if (cmd === 'get_note') return Promise.resolve({ id: 'n1', title: 'T', content: '<p>old</p>', category: 'Home', audioPath: '/data/voice/n1.wav', audioDurationSecs: 3, createdAt: null, updatedAt: null, deletedAt: null, dirty: false });
    if (cmd === 'voice_transcribe_note') return Promise.resolve({ text: 'New transcript.' });
    if (cmd === 'update_note') return Promise.resolve({});
    if (cmd === 'voice_delete_recording') return Promise.resolve(null);
    // board flow: the component consumes the REAL store action, whose api calls
    // ride this same invoke mock (the store module's own mock is not active here).
    if (cmd === 'voice_extract_tasks') return Promise.resolve(['Buy milk', 'Call dentist']);
    if (cmd === 'create_task_board') return Promise.resolve({ id: 'b1', title: 'Hello world.', category: 'Uncategorized', dirty: false, completed: false, listType: 'kanban', items: [] });
    if (cmd === 'add_item') return Promise.resolve({});
    return Promise.resolve(null);
  });
});

describe('VoiceNoteReview', () => {
  it('new mode: renders recording phase with a live timer, stop transcribes and prefills the title', async () => {
    vi.useFakeTimers();
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText(/Recording/)).toBeInTheDocument();
    // act() flushes the interval's setElapsed updates (React 18 defers
    // out-of-act updates; bare advanceTimersByTime left the DOM at 0:00).
    act(() => { vi.advanceTimersByTime(2100); });
    expect(screen.getByText(/Recording/)).toHaveTextContent('0:02');
    vi.useRealTimers();
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByPlaceholderText('Title')).toHaveValue('Hello world.'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_transcribe', { recordingId: 'r1' }));
  });

  it('failed transcription shows the retry button and error text, retry re-calls', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_start_recording') return Promise.resolve(recordedRow);
      if (cmd === 'voice_stop_recording') return Promise.resolve(recordedRow);
      if (cmd === 'voice_transcribe') return Promise.resolve({ ...recordedRow, state: 'transcription_failed', rawTranscript: null, lastError: '500 boom' });
      return Promise.resolve(null);
    });
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByText(/500 boom/)).toBeInTheDocument());
    expect(screen.getByText('Retry transcription')).toBeInTheDocument();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_transcribe') return Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'now it works' });
      if (cmd === 'voice_start_recording') return Promise.resolve(recordedRow);
      if (cmd === 'voice_stop_recording') return Promise.resolve(recordedRow);
      return Promise.resolve(null);
    });
    fireEvent.click(screen.getByText('Retry transcription'));
    // getByDisplayValue would be ambiguous here: the title input mirrors the
    // transcript (titleFromTranscript), so both elements carry the same value —
    // assert the transcript textarea itself.
    await waitFor(() => expect(screen.getByPlaceholderText('Transcript')).toHaveValue('now it works'));
  });

  it('requests mic permission (getUserMedia) before starting the recorder', async () => {
    const gm = (globalThis as unknown as { __lastGum: ReturnType<typeof vi.fn> }).__lastGum;
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(gm).toHaveBeenCalledWith({ audio: true }));
    // the recorder must NOT start before the prompt resolves
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_start_recording'));
    await waitFor(() => expect(screen.getByText(/Recording/)).toBeInTheDocument());
  });

  it('mic denial shows an error and never starts the recorder', async () => {
    const gm = (globalThis as unknown as { __lastGum: ReturnType<typeof vi.fn> }).__lastGum;
    // real webviews reject with a DOMException whose .name is NotAllowedError
    gm.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Microphone access denied/)).toBeInTheDocument());
    expect(invoke).not.toHaveBeenCalledWith('voice_start_recording');
  });

  it('tidy stores both texts, switches to the tidied view, raw toggle returns', async () => {
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByText('Tidy transcript')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Tidy transcript'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_tidy', { recordingId: 'r1', raw: 'Hello world. Second sentence.' }));
    expect(screen.getByPlaceholderText('Transcript')).toHaveValue('Hello, world.');
    fireEvent.click(screen.getByText('Raw'));
    expect(screen.getByPlaceholderText('Transcript')).toHaveValue('Hello world. Second sentence.');
    fireEvent.click(screen.getByText('Tidied'));
    expect(screen.getByPlaceholderText('Transcript')).toHaveValue('Hello, world.');
  });

  it('tidy failure keeps the raw transcript and shows a notice', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_tidy') return Promise.reject(new Error('server down'));
      if (cmd === 'voice_transcribe') return Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'raw text' });
      if (cmd === 'voice_start_recording') return Promise.resolve(recordedRow);
      if (cmd === 'voice_stop_recording') return Promise.resolve(recordedRow);
      return Promise.resolve(null);
    });
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByText('Tidy transcript')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Tidy transcript'));
    await waitFor(() => expect(screen.getByText(/Tidy failed/)).toBeInTheDocument());
    expect(screen.getByPlaceholderText('Transcript')).toHaveValue('raw text');
  });

  it('tidy failure renders as an unmissable error line, not a muted hint', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_tidy') return Promise.reject(new Error('server down'));
      if (cmd === 'voice_transcribe') return Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'raw text' });
      if (cmd === 'voice_start_recording') return Promise.resolve(recordedRow);
      if (cmd === 'voice_stop_recording') return Promise.resolve(recordedRow);
      return Promise.resolve(null);
    });
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByText('Tidy transcript')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Tidy transcript'));
    const line = await screen.findByText(/Tidy failed/);
    // The failure must carry the .error class (red, unmissable), NOT .voice-hint
    expect(line).toHaveClass('error');
    expect(line).not.toHaveClass('voice-hint');
  });

  it('tidy that returns the text unchanged shows a no-op notice', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_tidy') return Promise.resolve({ tidied: 'Hello world. Second sentence.' });
      if (cmd === 'voice_transcribe') return Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'Hello world. Second sentence.', lastError: null });
      if (cmd === 'voice_start_recording') return Promise.resolve(recordedRow);
      if (cmd === 'voice_stop_recording') return Promise.resolve(recordedRow);
      return Promise.resolve(null);
    });
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByText('Tidy transcript')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Tidy transcript'));
    expect(await screen.findByText(/returned the transcript unchanged/i)).toBeInTheDocument();
    // the editor still shows the (unchanged) text
    expect(screen.getByPlaceholderText('Transcript')).toHaveValue('Hello world. Second sentence.');
  });

  it('Save button labels which transcript version will be saved once a tidied text exists', async () => {
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByPlaceholderText('Title')).toBeInTheDocument());
    // no tidied text yet: plain Save
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('Tidy transcript'));
    // after tidy: view flips to tidied — the button names it
    await waitFor(() => expect(screen.getByRole('button', { name: /Save \(tidied\)/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByRole('button', { name: /Save \(raw\)/ })).toBeInTheDocument();
  });

  it('save calls voice_save_note with the edited text and reports the saved note', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<VoiceNoteReview mode="new" onClose={onClose} onSaved={onSaved} />);
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByPlaceholderText('Title')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('Title'), { target: { value: 'My memo' } });
    fireEvent.change(screen.getByPlaceholderText('Transcript'), { target: { value: 'edited by me' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('n9'));
    expect(onClose).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('voice_save_note', {
      recordingId: 'r1', title: 'My memo', category: 'Uncategorized', useTidied: false, contentOverride: 'edited by me',
    });
  });

  it('retranscribe mode transcribes the note and saves via update_note', async () => {
    const onSaved = vi.fn();
    render(<VoiceNoteReview mode="retranscribe" noteId="n1" onClose={() => {}} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByPlaceholderText('Transcript')).toHaveValue('New transcript.'));
    expect(screen.getByDisplayValue('T')).toBeInTheDocument(); // title prefilled from the note
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_note', { id: 'n1', title: 'T', content: 'New transcript.', category: 'Home' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('n1'));
  });

  it('resume mode enters review from the stored row and cancel deletes the recording', async () => {
    const onClose = vi.fn();
    render(<VoiceNoteReview mode="resume" recording={{ ...recordedRow, state: 'transcribed', rawTranscript: 'resumed text' }} onClose={onClose} onSaved={() => {}} />);
    // title mirrors the transcript here too (no punctuation) — assert the
    // transcript textarea, not a shared display value.
    await waitFor(() => expect(screen.getByPlaceholderText('Transcript')).toHaveValue('resumed text'));
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_delete_recording', { recordingId: 'r1' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('cancel during recording deletes the recording and closes', async () => {
    const onClose = vi.fn();
    render(<VoiceNoteReview mode="new" onClose={onClose} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Recording/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_delete_recording', { recordingId: 'r1' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // field report 2026-09-25: the overlay was dismissed mid-recording; pressing
  // the voice button again must RE-ATTACH to the live recording, not dead-end.
  it('re-attach: the recording timer continues from the row createdAt, not zero', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_start_recording') {
        return Promise.resolve({ ...recordedRow, createdAt: new Date(Date.now() - 90_000).toISOString() });
      }
      return Promise.resolve(null);
    });
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    // 90s of audio already captured when the overlay reopens
    await waitFor(() => expect(screen.getByText(/Recording/)).toHaveTextContent('1:30'));
  });

  it('cap-attach probe: the recording self-stopped, so stop + transcribe run immediately', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_start_recording') {
        return Promise.resolve({ ...recordedRow, createdAt: new Date(Date.now() - 490_000).toISOString() });
      }
      if (cmd === 'voice_stop_recording') return Promise.resolve({ ...recordedRow, durationSecs: 480 });
      if (cmd === 'voice_transcribe') return Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'Hello world. Second sentence.', lastError: null });
      return Promise.resolve(null);
    });
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_stop_recording'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_transcribe', { recordingId: 'r1' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Transcript')).toHaveValue('Hello world. Second sentence.'));
    expect(screen.getByText('Stopped at the 8-minute cap.')).toBeInTheDocument();
  });

  it('tapping the backdrop during a live recording does NOT dismiss it (Stop/Cancel are the exits)', async () => {
    const onClose = vi.fn();
    render(<VoiceNoteReview mode="new" onClose={onClose} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Recording/)).toBeInTheDocument());
    fireEvent.click(document.querySelector('.modal-backdrop')!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/Recording/)).toBeInTheDocument();
    // the guard is phase-scoped: once reviewing, tapping outside still closes
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByText('Review voice note')).toBeInTheDocument());
    fireEvent.click(document.querySelector('.modal-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('resume of a never-transcribed (recorded) draft transcribes it instead of an empty dead end', async () => {
    render(<VoiceNoteReview mode="resume" recording={{ ...recordedRow, state: 'recorded', rawTranscript: null }} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_transcribe', { recordingId: 'r1' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Transcript')).toHaveValue('Hello world. Second sentence.'));
  });

  it('titleFromTranscript: first sentence, truncation, empty fallback', () => {
    expect(titleFromTranscript('One two three. Four.')).toBe('One two three.');
    expect(titleFromTranscript('x'.repeat(100) + '. rest')).toBe('x'.repeat(57) + '…');
    expect(titleFromTranscript('   ')).toBe('Voice note');
    expect(titleFromTranscript('no punctuation here')).toBe('no punctuation here');
  });
});

describe('VoiceNoteReview board flow', () => {
  // reach review phase: render mode="new", click Stop (transcribe auto-fires,
  // enterReview lands in phase=review) — reuses the harness defaults above.

  it('board button: enabled when connected with a transcript, disabled offline and when empty', async () => {
    useStore.setState({ connection: { url: 'x' } as never });
    const connected = render(<VoiceNoteReview mode="new" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    const btn = await screen.findByRole('button', { name: /kanban board/i });
    expect(btn).toBeEnabled();
    expect(btn).toHaveAttribute('title', 'Extract tasks with AI and create a board');
    // empty transcript: nothing to extract from -> disabled again
    fireEvent.change(screen.getByPlaceholderText('Transcript'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: /kanban board/i })).toBeDisabled();
    connected.unmount();
    useStore.setState({ connection: null });
    render(<VoiceNoteReview mode="new" onClose={() => {}} />);
    // offline instance: disabled with a connect hint
    fireEvent.click(screen.getByText('Stop'));
    const offline = await screen.findByRole('button', { name: /kanban board/i });
    expect(offline).toBeDisabled();
    expect(offline).toHaveAttribute('title', 'Connect to create boards');
  });

  it('tap extracts from the EDITOR text and shows the editable preview', async () => {
    useStore.setState({ connection: { url: 'x' } as never });
    render(<VoiceNoteReview mode="new" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    await screen.findByRole('button', { name: /kanban board/i });
    // edit the transcript first: extraction must read the EDITOR text
    fireEvent.change(screen.getByPlaceholderText('Transcript'), { target: { value: 'Edited transcript' } });
    fireEvent.click(screen.getByRole('button', { name: /kanban board/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_extract_tasks', { text: 'Edited transcript' }));
    // preview replaces the transcript editor + review actions
    expect(await screen.findByText('Board tasks')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Transcript')).not.toBeInTheDocument();
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
    // board title/category inputs mirror the overlay fields (title prefilled from transcript)
    expect(screen.getByDisplayValue(/Hello world/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Uncategorized')).toBeInTheDocument();
    // rows exist, edit + remove + add work
    fireEvent.change(await screen.findByDisplayValue('Buy milk'), { target: { value: 'Buy oat milk' } });
    expect(screen.getByDisplayValue('Buy oat milk')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Buy milk')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]);
    expect(screen.queryByDisplayValue('Buy oat milk')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Call dentist')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /\+ add task/i }));
    expect(screen.getByDisplayValue('')).toBeInTheDocument();
    // Create enabled while any row has text; Cancel sits beside it
    expect(screen.getByRole('button', { name: /^Create/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('empty extraction shows the no-tasks notice and stays in review', async () => {
    useStore.setState({ connection: { url: 'x' } as never });
    invoke.mockImplementation((cmd: string) => cmd === 'voice_transcribe'
      ? Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'Hello world.', lastError: null })
      : cmd === 'voice_extract_tasks' ? Promise.resolve([])
      : cmd === 'voice_start_recording' ? Promise.resolve(recordedRow)
      : cmd === 'voice_stop_recording' ? Promise.resolve(recordedRow) : Promise.resolve(null));
    render(<VoiceNoteReview mode="new" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    fireEvent.click(await screen.findByRole('button', { name: /kanban board/i }));
    expect(await screen.findByText('No tasks found in this transcript.')).toBeInTheDocument();
    // stays in review: editor + actions remain, no preview rows appeared
    expect(screen.getByPlaceholderText('Transcript')).toBeInTheDocument();
    expect(screen.queryByText('Board tasks')).not.toBeInTheDocument();
    // a notice, not an error: the error line never renders
    expect(document.querySelector('.voice-modal .error')).toBeNull();
  });

  it('extraction failure keeps the review view with a retryable error', async () => {
    useStore.setState({ connection: { url: 'x' } as never });
    invoke.mockImplementation((cmd: string) => cmd === 'voice_transcribe'
      ? Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'Hello world.', lastError: null })
      : cmd === 'voice_extract_tasks' ? Promise.reject(new Error('api error 500'))
      : cmd === 'voice_start_recording' ? Promise.resolve(recordedRow)
      : cmd === 'voice_stop_recording' ? Promise.resolve(recordedRow) : Promise.resolve(null));
    render(<VoiceNoteReview mode="new" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    fireEvent.click(await screen.findByRole('button', { name: /kanban board/i }));
    expect(await screen.findByText('api error 500')).toBeInTheDocument();
    // review view kept, no preview; the button re-enables for a retry
    expect(screen.getByPlaceholderText('Transcript')).toBeInTheDocument();
    expect(screen.queryByText('Board tasks')).not.toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /kanban board/i });
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent('Save + kanban board');
  });

  it('confirm runs save → board → adds, then closes; board selection wins (no onSaved call)', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    useStore.setState({ connection: { url: 'x' } as never });
    render(<VoiceNoteReview mode="new" onClose={onClose} onSaved={onSaved} />);
    fireEvent.click(screen.getByText('Stop'));
    fireEvent.click(await screen.findByRole('button', { name: /kanban board/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Create/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSaved).not.toHaveBeenCalled();
    const order = invoke.mock.calls.map((c) => c[0]);
    expect(order.indexOf('voice_save_note')).toBeLessThan(order.indexOf('create_task_board'));
    expect(order.indexOf('create_task_board')).toBeLessThan(order.indexOf('add_item'));
    expect(useStore.getState().selectedChecklistId).toBe('b1');
    expect(invoke).toHaveBeenCalledWith('create_task_board', { title: 'Hello world.', category: 'Uncategorized' });
    expect(invoke).toHaveBeenCalledWith('voice_save_note', { recordingId: 'r1', title: 'Hello world.', category: 'Uncategorized', useTidied: false, contentOverride: 'Hello world. Second sentence.' });
    expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'b1', text: 'Buy milk', parentLocalId: null, status: null });
    expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'b1', text: 'Call dentist', parentLocalId: null, status: null });
  });

  it('board-stage failure: notice names it, note marked saved, Create retries WITHOUT re-saving', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    let boardCalls = 0;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_save_note') return Promise.resolve({ id: 'n1', title: 'T', content: 'x', category: 'Uncategorized', audioPath: '/v/r1.wav', audioDurationSecs: 4, createdAt: null, updatedAt: null, deletedAt: null, dirty: true });
      if (cmd === 'create_task_board') {
        boardCalls += 1;
        return boardCalls === 1 ? Promise.reject('api error 400: nope') : Promise.resolve({ id: 'b1', title: 'T', category: 'Uncategorized', dirty: false, completed: false, listType: 'kanban', items: [] });
      }
      if (cmd === 'add_item') return Promise.resolve({});
      if (cmd === 'voice_extract_tasks') return Promise.resolve(['Buy milk', 'Call dentist']);
      if (cmd === 'voice_transcribe') return Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'Hello world.', lastError: null });
      if (cmd === 'voice_start_recording' || cmd === 'voice_stop_recording') return Promise.resolve(recordedRow);
      // refreshAll runs inside the store action: keep the connection alive so
      // the cancel-and-re-extract interlude below can re-open the preview.
      if (cmd === 'get_connection') return Promise.resolve({ instanceUrl: 'http://x', version: null });
      return Promise.resolve(null);
    });
    useStore.setState({ connection: { url: 'x' } as never });
    render(<VoiceNoteReview mode="new" onClose={onClose} onSaved={onSaved} />);
    fireEvent.click(screen.getByText('Stop'));
    fireEvent.click(await screen.findByRole('button', { name: /kanban board/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Create/i }));
    expect(await screen.findByText(/Note saved — board creation failed/)).toBeInTheDocument();
    // preview stays open; the note save happened exactly once
    expect(screen.getByText('Board tasks')).toBeInTheDocument();
    const savesAfterFirst = invoke.mock.calls.filter((c) => c[0] === 'voice_save_note').length;
    expect(savesAfterFirst).toBe(1);
    // cancel back to review: the Save button is disabled while the note is
    // saved-but-boardless (ruling 2: disabled={busy || !!savedNoteId})
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Save')).toBeDisabled();
    // re-enter the preview and retry Create: board retried, save NOT re-run
    fireEvent.click(screen.getByRole('button', { name: /kanban board/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Create/i }));
    await waitFor(() => expect(boardCalls).toBe(2));
    expect(invoke.mock.calls.filter((c) => c[0] === 'voice_save_note').length).toBe(1); // STILL 1
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('board target picker: lists existing boards, chosen board receives the cards without a create', async () => {
    useStore.setState({
      connection: { url: 'x' } as never,
      checklists: [
        { id: 'b-ex', title: 'Chores', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, completed: false, listType: 'kanban', items: [] },
        { id: 'plain-x', title: 'Plain list', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, completed: false, listType: 'checklist', items: [] },
      ],
    });
    const onClose = vi.fn();
    render(<VoiceNoteReview mode="new" onClose={onClose} />);
    fireEvent.click(screen.getByText('Stop'));
    fireEvent.click(await screen.findByRole('button', { name: /kanban board/i }));
    await screen.findByText('Board tasks');
    // picker hidden BEFORE any kanban board exists... (this fixture HAS one, so:) — picker shown, plain lists excluded
    const picker = screen.getByRole('button', { name: 'Board target' });
    expect(picker).toHaveTextContent(/New board/i);
    fireEvent.click(picker);
    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Plain list' })).toBeNull();
    // choose the existing board; hint switches to the add-to wording
    fireEvent.click(screen.getByRole('option', { name: 'Chores' }));
    expect(screen.getByText(/Adding to “Chores”/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const cmds = invoke.mock.calls.map((c) => c[0]);
    expect(cmds).not.toContain('create_task_board');
    expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'b-ex', text: 'Buy milk', parentLocalId: null, status: null });
    expect(useStore.getState().selectedChecklistId).toBe('b-ex');
  });

  it('board target picker: hidden when no kanban boards exist yet', async () => {
    useStore.setState({ connection: { url: 'x' } as never, checklists: [
      { id: 'plain-x', title: 'Plain list', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, completed: false, listType: 'checklist', items: [] },
    ] });
    render(<VoiceNoteReview mode="new" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    fireEvent.click(await screen.findByRole('button', { name: /kanban board/i }));
    await screen.findByText('Board tasks');
    expect(screen.queryByRole('button', { name: 'Board target' })).toBeNull();
  });

  it('cancel at preview persists nothing and returns to review with edits intact', async () => {
    const onClose = vi.fn();
    useStore.setState({ connection: { url: 'x' } as never });
    render(<VoiceNoteReview mode="new" onClose={onClose} />);
    fireEvent.click(screen.getByText('Stop'));
    await screen.findByRole('button', { name: /kanban board/i });
    fireEvent.change(screen.getByPlaceholderText('Transcript'), { target: { value: 'Edited transcript' } });
    fireEvent.click(screen.getByRole('button', { name: /kanban board/i }));
    await screen.findByText('Board tasks');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // back in review with the shared edits intact
    await waitFor(() => expect(screen.getByPlaceholderText('Transcript')).toHaveValue('Edited transcript'));
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /kanban board/i })).toBeInTheDocument();
    expect(screen.queryByText('Board tasks')).not.toBeInTheDocument();
    // nothing persisted: extraction only — no save/board/add invokes, no close
    const cmds = invoke.mock.calls.map((c) => c[0]);
    expect(cmds).toContain('voice_extract_tasks');
    expect(cmds.filter((c) => c === 'voice_save_note')).toHaveLength(0);
    expect(cmds.filter((c) => c === 'create_task_board')).toHaveLength(0);
    expect(cmds.filter((c) => c === 'add_item')).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });
});