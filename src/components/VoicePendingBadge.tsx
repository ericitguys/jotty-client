import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as api from '../api/client';

// Badge (2026-09-30 offline-voice run): how many recordings are waiting to be
// transcribed — failed drafts + already-saved notes still carrying an empty
// body (their transcript arrives via the retry pass). Refreshes on the events
// that change the underlying rows: the retry pass ("voice-updated", fired by
// sync completions and reconnect taps) and a slow poll for in-flight actions
// that never emit. Fetch failure = unknown = hidden, never a wrong count.
export default function VoicePendingBadge() {
  const [pending, setPending] = useState<number | null>(null);
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
  if (pending == null || pending === 0) return null;
  return (
    <span
      className="voice-pending-chip"
      data-testid="voice-pending-chip"
      title="Recordings waiting to be transcribed — they retry automatically when the AI server is reachable"
    >
      🎙 {pending} waiting to transcribe
    </span>
  );
}