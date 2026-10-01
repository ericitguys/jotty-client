import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relativeAge } from './relativeTime';

// Honest per-boundary table (plan Task 2 Step 1: the fence below is the SHAPE,
// the described table is the spec). Pinned NOW = 2026-10-01T12:00:00Z; the dev
// box runs UTC (verified pre-dispatch via `date +%z`), so pinned-string rows
// hold. Every date-string expectation for the absolute branches DERIVES from
// the same local Date arithmetic the helper uses (plan license), so the
// boundary rows carry branch-classification teeth, not double-typed bytes.
const NOW = new Date('2026-10-01T12:00:00Z').getTime();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const mdFormatter = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const yearInclusive = (ms: number) => `${mdFormatter(ms)}, ${new Date(ms).getFullYear()}`;

// Local-calendar constructor (setDate = DST-true calendar math, not ms offsets)
const localOn = (daysBack: number, hour: number) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysBack);
  d.setHours(hour, 0, 0, 0);
  return new Date(d).toISOString();
};

describe('relativeAge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    [null, 'never synced'],
    ['', 'never synced'],
    ['not-a-date', 'never synced'],
    [new Date(NOW - 90_000).toISOString(), 'just now'],
    [new Date(NOW - 59 * MIN).toISOString(), 'just now'],
    [new Date(NOW - HOUR).toISOString(), '1h ago'],
    [new Date(NOW - 3 * HOUR).toISOString(), '3h ago'],
  ])('%s → %s', (iso, want) => {
    expect(relativeAge(iso)).toBe(want);
  });

  it('same-calendar-day sub-24h reads Nh ago (today 05:00 local — hours, not yesterday)', () => {
    expect(relativeAge(localOn(0, 5))).toBe(`${new Date(NOW).getHours() - 5}h ago`);
  });

  it('calendar-yesterday wins regardless of hour (13h ago and ~36h ago)', () => {
    expect(relativeAge(localOn(1, 23))).toBe('yesterday');
    expect(relativeAge(localOn(1, 0))).toBe('yesterday');
  });

  it('2d and 6d read Nd ago (integer floor, not calendar-day count)', () => {
    expect(relativeAge(new Date(NOW - 2 * DAY).toISOString())).toBe('2d ago');
    expect(relativeAge(new Date(NOW - 6 * DAY).toISOString())).toBe('6d ago');
  });

  it('7d boundary and 100d current-year render plain month-day', () => {
    const d7 = NOW - 7 * DAY;
    expect(relativeAge(new Date(d7).toISOString())).toBe(mdFormatter(d7));
    const d100 = NOW - 100 * DAY;
    expect(relativeAge(new Date(d100).toISOString())).toBe(mdFormatter(d100));
  });

  it('previous-year (<365d) and ≥365d render year-inclusive', () => {
    const d300 = NOW - 300 * DAY;
    expect(relativeAge(new Date(d300).toISOString())).toBe(yearInclusive(d300));
    const d365 = NOW - 365 * DAY;
    expect(relativeAge(new Date(d365).toISOString())).toBe(yearInclusive(d365));
  });

  it('future dates render absolute year-inclusive (spec L10: future → absolute)', () => {
    const fut = NOW + DAY;
    expect(relativeAge(new Date(fut).toISOString())).toBe(yearInclusive(fut));
  });
});