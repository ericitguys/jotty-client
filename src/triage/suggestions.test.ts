// AI suggestion validation (P3 Task 2): pure-layer fences for the RE-validation
// law — the Rust side validates, but the client NEVER trusts the wire either
// (defense in depth, spec §5). Chunking keeps the Rust cap tripwire honest.
import { describe, expect, it } from 'vitest';
import type * as T from '../api/types';
import { chunkIds, validateSuggestions } from './suggestions';

const dto = (over: Partial<T.TriageSuggestionDto> & { noteId: string }): T.TriageSuggestionDto => ({
  route: 'TODO',
  suggestedBoard: null,
  suggestedTitle: null,
  suggestedTags: [],
  confidence: 0.9,
  ...over,
});

const ctx = (over: Partial<{ noteIds: string[]; boardTitles: Set<string>; threshold: number; vocab: Set<string> }> = {}) => ({
  noteIds: ['a', 'b', 'c'],
  boardTitles: new Set(['Maintenance', 'Zeta board']),
  threshold: 0.7,
  vocab: new Set(['todo', 'cmd', 'incident', 'research']),
  ...over,
});

describe('validateSuggestions (Task 2 RED fences)', () => {
  it('keeps confident suggestions and resolves the board only against the CURRENT board titles', () => {
    const out = validateSuggestions(
      [dto({ noteId: 'a', route: 'DOCS', suggestedBoard: 'Maintenance', confidence: 0.9 })],
      ctx(),
    );
    expect([...out.keys()]).toEqual(['a']);
    const s = out.get('a')!;
    expect(s.route).toBe('DOCS');
    expect(s.boardTitle).toBe('Maintenance'); // ∈ boardTitles → kept (resolves title→id downstream)
    expect(s.low).toBe(false); // 0.9 >= 0.7 threshold
    expect(s.newTitle).toBeNull();
    expect(s.tags).toEqual([]);
    expect(s.newTags).toEqual([]);
  });

  it('drops bad routes (case-sensitive), foreign note ids, and tolerates unusable shapes by dropping the item', () => {
    const out = validateSuggestions(
      [
        dto({ noteId: 'a', route: 'todo' }), // lowercase literal — case-SENSITIVE gate drops it
        dto({ noteId: 'foreign', route: 'TODO' }), // ∉ request set — dropped
        dto({ noteId: 'b', suggestedTags: 'not-an-array' as unknown as string[] }), // shape tolerated as empty
        dto({ noteId: null as unknown as string, route: 'TODO' }), // unusable id — dropped
      ],
      ctx(),
    );
    // lowercase route + foreign id + null id all dropped
    expect([...out.keys()]).toEqual(['b']);
    expect(out.get('b')!.tags).toEqual([]); // non-array tags tolerated as empty
    expect(out.get('b')!.newTags).toEqual([]);
    expect(out.get('b')!.low).toBe(false);
  });

  it('splits existing tags from NEW proposals after normalization (#strip + case)', () => {
    const out = validateSuggestions(
      [dto({
        noteId: 'a',
        route: 'TODO',
        suggestedTags: ['#Todo', '#Fresh', 'CMD', '', '  '],
      })],
      ctx(),
    );
    const s = out.get('a')!;
    // "#Todo" normalizes onto the vocab NOT into proposals; empty tags skipped
    expect(s.tags).toEqual(['todo', 'cmd']);
    expect(s.newTags).toEqual(['fresh']); // vocab-missing tags are proposals
  });

  it('marks below-threshold suggestions low (missing confidence arrives as 0.0 → low)', () => {
    const out = validateSuggestions(
      [
        dto({ noteId: 'a', confidence: 0.4 }),
        // confidence field ABSENT on the wire (fixture kills the default)
        dto({ noteId: 'b', confidence: undefined as unknown as number }),
      ],
      ctx({ threshold: 0.7 }),
    );
    expect(out.get('a')!.low).toBe(true);
    expect(out.get('b')!.confidence).toBe(0.0);
    expect(out.get('b')!.low).toBe(true);
  });
});

describe('chunkIds (Task 2 RED fences)', () => {
  it('slices in order with a ceil remainder chunk (45 → 20/20/5)', () => {
    const ids = Array.from({ length: 45 }, (_, i) => `n${i}`);
    const chunks = chunkIds(ids);
    expect(chunks.map((c: string[]) => c.length)).toEqual([20, 20, 5]);
    expect(chunks.flat()).toEqual(ids); // order-stable, no reshuffling
  });

  it('returns [] for zero ids and an exact single chunk at the cap', () => {
    expect(chunkIds([])).toEqual([]);
    expect(chunkIds(Array.from({ length: 20 }, (_, i) => `n${i}`)).map((c: string[]) => c.length)).toEqual([20]);
  });
});