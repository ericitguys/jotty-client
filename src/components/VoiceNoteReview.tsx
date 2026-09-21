import { useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import type { VoiceRecordingDto } from '../api/types';
import { useStore } from '../stores/store';

export const CAP_SECS = 480; // 8-minute cap, mirrors audio::MAX_SECS (spec §7)

export function titleFromTranscript(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'Voice note';
  const sentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  const t = sentence.trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

const fmt = (e: unknown) => String(e).replace(/^.*Error: /, '');

type Phase = 'recording' | 'transcribing' | 'review' | 'failed-start';

export default function VoiceNoteReview({ mode, recording, noteId, onClose, onSaved }: {
  mode: 'new' | 'resume' | 'retranscribe';
  recording?: VoiceRecordingDto | null;
  noteId?: string;
  onClose: () => void;
  onSaved?: (noteId: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>(mode === 'new' ? 'recording' : 'review');
  const [rec, setRec] = useState<VoiceRecordingDto | null>(recording ?? null);
  const [elapsed, setElapsed] = useState(0);
  const [rawText, setRawText] = useState('');
  const [tidiedText, setTidiedText] = useState<string | null>(null);
  const [view, setView] = useState<'raw' | 'tidied'>('raw');
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Uncategorized');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [atCap, setAtCap] = useState(false);
  const { connection, saveVoiceNoteWithBoard } = useStore();
  const [extracting, setExtracting] = useState(false);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [savedNoteId, setSavedNoteId] = useState<string | null>(null);
  const [boardNotice, setBoardNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const stoppedRef = useRef(false); // Stop pressed before the start-chain finished (permission prompt window)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const enterReview = (row: VoiceRecordingDto) => {
    const raw = row.rawTranscript ?? '';
    setRawText(raw);
    setTidiedText(row.tidiedTranscript);
    setView(row.tidiedTranscript ? 'tidied' : 'raw');
    setTitle(titleFromTranscript(raw));
    setCategory('Uncategorized');
    setAudioPath(row.path);
    setPhase('review');
  };

  useEffect(() => {
    if (mode === 'new') {
      let cancelled = false;
      (async () => {
        try {
          // Mic permission BEFORE the native recorder starts (Android runtime
          // prompt via the webview AUDIO_CAPTURE bridge; desktop is a no-op).
          await api.ensureMicPermission();
          const row = await api.voiceStartRecording();
          if (cancelled || stoppedRef.current) return; // user already stopped (or closed) mid-start
          setRec(row);
          setPhase('recording');
        } catch (e) {
          if (cancelled) return;
          setError(fmt(e));
          setPhase('failed-start');
        }
      })();
      return () => { cancelled = true; };
    }
    if (mode === 'resume' && recording) {
      enterReview(recording); // stale 'transcribing'/failed rows land in review w/ retry
    }
    if (mode === 'retranscribe' && noteId) {
      let cancelled = false;
      (async () => {
        try {
          const note = await api.getNote(noteId);
          const res = await api.voiceTranscribeNote(noteId);
          if (cancelled) return;
          setTitle(note.title);
          setCategory(note.category);
          setRawText(res.text);
          setTidiedText(null);
          setView('raw');
          setAudioPath(note.audioPath);
          setPhase('review');
        } catch (e) {
          if (cancelled) return;
          setError(fmt(e));
          setPhase('failed-start');
        }
      })();
      return () => { cancelled = true; };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // recording timer; auto-stop at the cap (spec §7)
  useEffect(() => {
    if (phase !== 'recording') return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);
  const stopRef = useRef<(atCap?: boolean) => Promise<void>>(async () => {});
  useEffect(() => {
    if (phase === 'recording' && elapsed >= CAP_SECS) void stopRef.current(true);
  }, [elapsed, phase]);

  const stopRecording = async (atCap = false) => {
    stoppedRef.current = true; // late start-chain arrivals must not clobber this session
    setPhase('transcribing');
    setAtCap(atCap);
    try {
      const row = await api.voiceStopRecording();
      setRec(row);
      const done = await api.voiceTranscribe(row.id);
      if (!mounted.current) return;
      setRec(done);
      enterReview(done);
    } catch (e) {
      if (!mounted.current) return;
      setError(fmt(e));
      setPhase('review');
    }
  };
  stopRef.current = stopRecording;

  const retryTranscribe = async () => {
    if (!rec) return;
    setPhase('transcribing');
    setError(null);
    try {
      const done = await api.voiceTranscribe(rec.id);
      if (!mounted.current) return;
      setRec(done);
      enterReview(done);
    } catch (e) {
      if (!mounted.current) return;
      setError(fmt(e));
      setPhase('review');
    }
  };

  const currentText = () => (view === 'tidied' && tidiedText != null ? tidiedText : rawText);

  const tidy = async () => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const src = currentText();
      const res = await api.voiceTidy(mode === 'retranscribe' ? null : rec?.id ?? null, src);
      if (!mounted.current) return;
      setTidiedText(res.tidied);
      setView('tidied');
      // A model that echoes the transcript back is indistinguishable from a
      // no-op tidy — surface it instead of silently "succeeding" (field report
      // 2026-09-21: user saved the raw text believing tidy had cleaned it).
      if (res.tidied.trim() === src.trim()) {
        setNotice('The AI returned the transcript unchanged — no cleanup was applied.');
      }
    } catch (e) {
      if (!mounted.current) return;
      // Failure goes to the ERROR slot (red, unmissable) — the old muted hint
      // line was missed in the field and the raw transcript got saved.
      setError(`Tidy failed — keeping the transcript as is. ${fmt(e)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const text = currentText();
      if (mode === 'retranscribe' && noteId) {
        await api.updateNote(noteId, title, text, category);
        if (!mounted.current) return;
        onSaved?.(noteId);
      } else if (rec) {
        const note = await api.voiceSaveNote(rec.id, title, category, view === 'tidied' && tidiedText != null, text);
        if (!mounted.current) return;
        onSaved?.(note.id);
      }
      onClose();
    } catch (e) {
      if (!mounted.current) return;
      setError(fmt(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const deleteRecording = async () => {
    if (rec) {
      try { await api.voiceDeleteRecording(rec.id); } catch { /* best-effort */ }
    }
    onClose();
  };

  // Voice note → kanban board: extract tasks from the transcript, let the user
  // edit the rows in a preview, then run the store's save→board→cards flow.
  const startBoardFlow = async () => {
    setExtracting(true); setNotice(null); setError(null); setBoardNotice(null);
    try {
      const tasks = await api.voiceExtractTasks(currentText());
      if (!mounted.current) return;
      if (tasks.length === 0) setNotice('No tasks found in this transcript.');
      else setPreview(tasks);
    } catch (e) {
      if (mounted.current) setError(fmt(e));
    } finally {
      if (mounted.current) setExtracting(false);
    }
  };

  const createBoardFromTasks = async () => {
    setBusy(true); setError(null);
    try {
      await saveVoiceNoteWithBoard({
        recordingId: mode === 'retranscribe' ? null : rec?.id ?? null,
        noteId: mode === 'retranscribe' ? noteId ?? null : null,
        title, category,
        useTidied: view === 'tidied' && tidiedText != null,
        text: currentText(),
        tasks: preview ?? [],
        noteSavedId: savedNoteId,
      });
      if (!mounted.current) return;
      onClose(); // board is selected by the store; NOT onSaved (board wins)
    } catch (e) {
      if (!mounted.current) return;
      const err = e as Error & { boardStage?: boolean; noteId?: string };
      if (err.boardStage) {
        setSavedNoteId(err.noteId ?? null);
        setBoardNotice(`Note saved — board creation failed: ${fmt(e)} Adjust the tasks and try again.`);
      } else {
        setError(fmt(e));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const failed = rec?.state === 'transcription_failed' || rec?.state === 'transcription_failed_auth';
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const boardEnabled = !!connection && !!currentText().trim() && !busy && !extracting && phase === 'review';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal voice-modal" onClick={(e) => e.stopPropagation()}>
        {phase === 'recording' && (
          <>
            <h2 className="voice-rec-label">🎙 Recording… {mmss}</h2>
            <p className="voice-hint">Auto-stops at 8 minutes.</p>
            <div className="voice-actions">
              <button className="primary" onClick={() => void stopRecording(false)}>Stop</button>
              <button onClick={deleteRecording}>Cancel</button>
            </div>
          </>
        )}
        {phase === 'transcribing' && <h2>Transcribing…</h2>}
        {phase === 'failed-start' && (
          <>
            <h2>Voice note</h2>
            <p className="error">{error}</p>
            <div className="voice-actions"><button onClick={onClose}>Close</button></div>
          </>
        )}
        {phase === 'review' && (
          <>
            <h2>Review voice note</h2>
            {atCap && <p className="voice-hint">Stopped at the 8-minute cap.</p>}
            {audioPath && <audio controls src={api.audioSrc(audioPath)} data-testid="voice-audio" />}
            <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <input placeholder="Category" value={category} onChange={(e) => setCategory(e.target.value)} />
            {failed && (
              <p className="error">
                {rec?.state === 'transcription_failed_auth'
                  ? `Transcription failed — check the AI server API key in Settings. ${rec?.lastError ?? ''}`
                  : `Transcription failed — will retry after the next sync. ${rec?.lastError ?? ''}`}
              </p>
            )}
            {notice && <p className="voice-hint">{notice}</p>}
            {error && <p className="error">{error}</p>}
            {preview ? (
              <div className="board-preview">
                <h3>Board tasks</h3>
                <p className="voice-hint">Board “{(title.trim() || 'Tasks from voice note')}” in “{category}” — every card starts in the first column.</p>
                {preview.map((t, i) => (
                  <div className="board-task-row" key={i}>
                    <input value={t} onChange={(e) => setPreview(preview.map((v, j) => (j === i ? e.target.value : v)))} />
                    <button aria-label={`Remove task ${i + 1}`} onClick={() => setPreview(preview.filter((_, j) => j !== i))}>×</button>
                  </div>
                ))}
                <button onClick={() => setPreview([...preview, ''])}>+ add task</button>
                <div className="voice-actions">
                  <button className="primary" disabled={busy || !preview.some((t) => t.trim())}
                          onClick={() => void createBoardFromTasks()}>Create</button>
                  <button onClick={() => { setPreview(null); }}>Cancel</button>
                </div>
                {boardNotice && <p className="voice-hint">{boardNotice}</p>}
              </div>
            ) : (
              <>
                <div className="voice-toggle">
                  <button className={view === 'raw' ? 'selected' : ''} onClick={() => setView('raw')}>Raw</button>
                  <button className={view === 'tidied' ? 'selected' : ''} onClick={() => setView('tidied')} disabled={tidiedText == null}>Tidied</button>
                  <button onClick={tidy} disabled={busy || !rawText.trim()}>Tidy transcript</button>
                </div>
                <textarea
                  placeholder="Transcript"
                  value={currentText()}
                  onChange={(e) => (view === 'tidied' ? setTidiedText(e.target.value) : setRawText(e.target.value))}
                  rows={10}
                />
                <div className="voice-actions">
                  <button className="primary" onClick={save} disabled={busy || !!savedNoteId}>{busy ? 'Saving…' : tidiedText != null ? (view === 'tidied' ? 'Save (tidied)' : 'Save (raw)') : 'Save'}</button>
                  <button className="primary" disabled={!boardEnabled || extracting}
                          title={connection ? 'Extract tasks with AI and create a board' : 'Connect to create boards'}
                          onClick={() => void startBoardFlow()}>
                    {extracting ? 'Extracting…' : 'Save + kanban board'}
                  </button>
                  {mode !== 'retranscribe' && <button onClick={deleteRecording}>Delete</button>}
                  {failed && <button onClick={retryTranscribe}>Retry transcription</button>}
                  <button onClick={onClose}>Close</button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}