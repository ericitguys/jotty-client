// Capture title helper (spec §3 entropy-title UX): first human sentence of a
// capture, truncated to fit list/card rows. Deliberate RE-IMPLEMENTATION of
// VoiceNoteReview.tsx titleFromTranscript (:9-15) — that file is byte-frozen
// by the P2 plan (Do-NOT-touch), so this standalone mirror lives in src/triage
// for P2/P3 reuse without importing the voice review component.
export function titleFromText(text: string): string {
  const trimmed = text.trim();
  const sentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  const t = sentence.trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}