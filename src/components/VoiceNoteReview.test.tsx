import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import VoiceNoteReview, { titleFromTranscript } from './VoiceNoteReview';

const recordedRow = {
  id: 'r1', path: '/data/voice/r1.wav', durationSecs: 4.2,
  rawTranscript: null, tidiedTranscript: null, state: 'recorded', lastError: null, createdAt: '2026-09-18T00:00:00Z',
};

beforeEach(() => {
  invoke.mockReset();
  // jsdom has no mediaDevices: stub getUserMedia for the mic-permission gate.
  // Default: granted — individual tests override for the denial path.
  const gm = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: gm } });
  (globalThis as unknown as { __lastGum: unknown }).__lastGum = gm;
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'voice_start_recording') return Promise.resolve(recordedRow);
    if (cmd === 'voice_stop_recording') return Promise.resolve(recordedRow);
    if (cmd === 'voice_transcribe') return Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'Hello world. Second sentence.', lastError: null });
    if (cmd === 'voice_tidy') return Promise.resolve({ tidied: 'Hello, world.' });
    if (cmd === 'voice_save_note') return Promise.resolve({ id: 'n9', title: 'Hello world. Second sentence.', content: 'x', category: 'Uncategorized', audioPath: '/data/voice/r1.wav', audioDurationSecs: 4.2, createdAt: null, updatedAt: null, deletedAt: null, dirty: true });
    if (cmd === 'get_note') return Promise.resolve({ id: 'n1', title: 'T', content: '<p>old</p>', category: 'Home', audioPath: '/data/voice/n1.wav', audioDurationSecs: 3, createdAt: null, updatedAt: null, deletedAt: null, dirty: false });
    if (cmd === 'voice_transcribe_note') return Promise.resolve({ text: 'New transcript.' });
    if (cmd === 'update_note') return Promise.resolve({});
    if (cmd === 'voice_delete_recording') return Promise.resolve(null);
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

  it('titleFromTranscript: first sentence, truncation, empty fallback', () => {
    expect(titleFromTranscript('One two three. Four.')).toBe('One two three.');
    expect(titleFromTranscript('x'.repeat(100) + '. rest')).toBe('x'.repeat(57) + '…');
    expect(titleFromTranscript('   ')).toBe('Voice note');
    expect(titleFromTranscript('no punctuation here')).toBe('no punctuation here');
  });
});