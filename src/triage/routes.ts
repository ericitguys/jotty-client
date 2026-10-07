// Triage route enum (spec §5 / plan Global Constraints): the CLOSED set of
// dispositions a capture can be triaged to. P2 validates client-side at every
// triage entry point; P3's AI layer reuses the same gate. Case-SENSITIVE by
// law — the app's shared literals (`!INBOX`, `PROCESSED`) are case-sensitive
// and lowercase spellings must never route.
export const TRIAGE_ROUTES = ['TODO', 'COMMANDS', 'DOCS', 'NOISE'] as const;

export type TriageRoute = (typeof TRIAGE_ROUTES)[number];

export const isTriageRoute = (v: unknown): v is TriageRoute =>
  typeof v === 'string' && (TRIAGE_ROUTES as readonly string[]).includes(v);

// Move presets (spec §5): the `m`/Move… flow pre-fills these destinations.
// TODO needs no preset — selecting the TODO route IS the destination.
export const TRIAGE_MOVE_PRESET = {
  COMMANDS: 'LIBRARY/Commands',
  DOCS: 'LIBRARY/Docs',
} as const;