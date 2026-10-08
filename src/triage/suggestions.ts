// AI triage suggestion re-validation + chunking (P3 Task 2). The Rust layer
// (triage_ai.rs) already validates strictly — this layer NEVER trusts the wire
// either (defense in depth, spec §5) and adapts the DTOs to UI concerns:
// board titles resolve against the CURRENT boards, tags split into
// already-known vs NEW proposals, below-threshold items flag manual review.
import type * as T from '../api/types';
import { isTriageRoute, type TriageRoute } from './routes';

// MUST stay equal to the Rust TRIAGE_CHUNK_CAP (src-tauri/src/triage_ai.rs) —
// the Rust oversize error is the drift tripwire ("chunk exceeds cap of 20 —
// slice client-side").
export const TRIAGE_CHUNK_CAP_TS = 20;

// Fallback when getTriageSettings fails/absent (mirrors Rust 0.70 default).
export const CONF_DEFAULT = 0.7;

// Order-stable slices: [0..cap), [cap..2cap), … ceil remainder (45 → 20/20/5).
export const chunkIds = (ids: string[], cap: number = TRIAGE_CHUNK_CAP_TS): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += cap) {
    out.push(ids.slice(i, i + cap));
  }
  return out;
};

// Normalization law (Rust triage_normalize_tag mirror): trim, strip leading
// '#'s, lowercase. Exported so the view + command layer share ONE definition.
export const normalizeTag = (t: string): string =>
  t.trim().replace(/^#+/, '').toLowerCase();

export interface ValidatedSuggestion {
  noteId: string;
  route: TriageRoute;
  boardTitle: string | null;
  newTitle: string | null;
  tags: string[];
  newTags: string[];
  confidence: number;
  low: boolean;
}

export interface ValidateCtx {
  // The request set this reply answers (snapshot ids): foreign noteIds drop.
  noteIds: string[];
  // CURRENT board titles (from boardsForPicker): anything else clears.
  boardTitles: Set<string>;
  // Confidence gate: confidence < threshold → low (0.0 → low → manual review).
  threshold: number;
  // Current tag vocabulary: tags ∩ vocab stay plain; the rest are proposals.
  vocab: Set<string>;
}

export const validateSuggestions = (
  dtos: T.TriageSuggestionDto[],
  ctx: ValidateCtx,
): Map<string, ValidatedSuggestion> => {
  const reqSet = new Set(ctx.noteIds);
  const out = new Map<string, ValidatedSuggestion>();
  for (const d of Array.isArray(dtos) ? dtos : []) {
    const noteId = (d as { noteId?: unknown } | null)?.noteId;
    if (typeof noteId !== 'string' || !reqSet.has(noteId)) continue;
    // duplicate model items for the same id: first wins (Rust law mirror)
    if (out.has(noteId)) continue;
    if (!isTriageRoute(d.route)) continue;
    const boardTitle =
      typeof d.suggestedBoard === 'string' && ctx.boardTitles.has(d.suggestedBoard)
        ? d.suggestedBoard
        : null;
    const newTitle =
      typeof d.suggestedTitle === 'string' && d.suggestedTitle.trim() !== ''
        ? d.suggestedTitle.trim()
        : null;
    // tags: normalize (trim, strip leading '#'s, lowercase); unusable shape →
    // empty per the tolerance law; empties skipped; dupes collapse.
    const norm: string[] = [];
    if (Array.isArray(d.suggestedTags)) {
      for (const t of d.suggestedTags) {
        if (typeof t !== 'string') continue;
        const n = normalizeTag(t);
        if (n !== '' && !norm.includes(n)) norm.push(n);
      }
    }
    const tags: string[] = [];
    const newTags: string[] = [];
    for (const t of norm) {
      if (ctx.vocab.has(t)) {
        if (!tags.includes(t)) tags.push(t);
      } else if (!newTags.includes(t)) {
        newTags.push(t);
      }
    }
    const confidence =
      typeof d.confidence === 'number' && Number.isFinite(d.confidence) ? d.confidence : 0.0;
    out.set(noteId, {
      noteId,
      route: d.route,
      boardTitle,
      newTitle,
      tags,
      newTags,
      confidence,
      low: confidence < ctx.threshold,
    });
  }
  return out;
};