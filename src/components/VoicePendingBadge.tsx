import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as api from '../api/client';
import { useStore } from '../stores/store';
import { Icon } from './icons';

// Badge (2026-09-30 offline-voice run): how many recordings are waiting to be
// transcribed — failed drafts + already-saved notes still carrying an empty
// body (their transcript arrives via the retry pass). Refreshes on the events
// that change the underlying rows: the retry pass ("voice-updated", fired by
// sync completions and reconnect taps) and a slow poll for in-flight actions
// that never emit. Fetch failure = unknown = hidden, never a wrong count.
//
// Tappable (field report 2026-09-30: "should it open the note waiting to be
// transcribe?"): a tap opens the WAITING thing. A failing/unsaved draft →
// its review screen (oldest pending row — list_unsaved is newest-first, so
// flip it); otherwise the saved note whose transcript is still inbound opens
// in the editor. 'transcribing' rows are withheld (in flight, may complete
// any moment); 'recording' rows are live and never surfaced.
export default function VoicePendingBadge({ onOpenDraft }: {
  onOpenDraft?: (recording: import('../api/types').VoiceRecordingDto) => void;
}) {
  const [pending, setPending] = useState<number | null>(null);
  const notes = useStore((s) => s.notes);
  const selectNote = useStore((s) => s.selectNote);
  useEffect(() => {
    let on = true;
    const refresh = () => {
      api.voicePendingTranscriptions()
        .then((n) => { if (on) setPending(n); })
        .catch(() => {}); // command down (e.g. tests): hide rather than lie
    };
    refresh();
    const uv = listen('voice-updated', refresh);
    const us = listen('sync-updated', refresh);
    const t = setInterval(refresh, 30_000);
    return () => { on = false; uv.then((f) => f()); us.then((f) => f()); clearInterval(t); };
  }, []);
  const onActivate = () => {
    api.voiceListUnsaved().catch(() => [] as import('../api/types').VoiceRecordingDto[])
      .then((rows) => {
        if (!Array.isArray(rows)) return;
        const usable = rows
          .filter((r) => r.state !== 'recording' && r.state !== 'transcribing')
          .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
        if (usable.length > 0) {
          onOpenDraft?.(usable[0]);
          return;
        }
        // no unsaved drafts: the queue is a saved note still missing its transcript
        const pendingNote = notes.find((n) => !!n.audioPath && (!n.content || n.content === ''));
        if (pendingNote) selectNote(pendingNote.id);
      });
  };
  if (pending == null || pending === 0) return null;
  return (
    <span
      className="voice-pending-chip"
      data-testid="voice-pending-chip"
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); } }}
      title="Recordings waiting to be transcribed — they retry automatically when the AI server is reachable"
    >
      <Icon name="mic" size={12}/> {pending} waiting to transcribe
    </span>
  );
}