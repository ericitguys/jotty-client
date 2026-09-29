import { describe, expect, it } from 'vitest';
import { monthMatrix, ymd, parseYmd, monthLabel, YMD_PATTERN } from './calendarGrid';

// Invariants-first fences (locale-sensitive strings computed, never hardcoded):
// the matrix always starts on SUNDAY, is 7-wide, covers every day of the month
// exactly once in-month, and pads the rest with adjacent-month dimmed days.
const pad = (n: number) => String(n).padStart(2, '0');

describe('ymd', () => {
  it('formats a local date as YYYY-MM-DD', () => {
    expect(ymd(new Date(2026, 8, 15))).toBe('2026-09-15');
    expect(ymd(new Date(2027, 0, 2))).toBe('2027-01-02');
  });
});

describe('parseYmd', () => {
  it('round-trips a YYYY-MM-DD string to the same local day', () => {
    const s = '2026-09-15';
    const d = parseYmd(s);
    expect(d).not.toBeNull();
    expect(ymd(d!)).toBe(s);
  });
  it('rejects empty and malformed strings', () => {
    expect(parseYmd('')).toBeNull();
    expect(parseYmd('garbage')).toBeNull();
    expect(parseYmd('2026-9-15')).toBeNull();
  });
});

describe('YMD_PATTERN', () => {
  it('accepts exactly the wire format the save paths send', () => {
    expect(YMD_PATTERN.test('2026-09-15')).toBe(true);
    expect(YMD_PATTERN.test('2026-09-15T00:00')).toBe(false);
    expect(YMD_PATTERN.test('')).toBe(false);
  });
});

describe('monthMatrix', () => {
  // September 2026: the 1st is a TUESDAY — the first grid row must therefore
  // begin on Sunday Aug 30, and the matrix must end on a Saturday.
  const m = monthMatrix(2026, 8); // month is 0-based: 8 = September

  it('produces rows of 7 that start on Sunday and end on Saturday', () => {
    expect(m.year).toBe(2026);
    expect(m.month).toBe(8);
    expect(m.weeks.length).toBeGreaterThanOrEqual(4);
    for (const week of m.weeks) {
      expect(week).toHaveLength(7);
      const first = week[0].date;
      const last = week[6].date;
      const f = parseYmd(first)!;
      const l = parseYmd(last)!;
      expect(f.getDay()).toBe(0); // Sunday
      expect(l.getDay()).toBe(6); // Saturday
    }
  });

  it('covers September 2026 exactly once among in-month cells', () => {
    const inMonth = m.weeks.flat().filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(30);
    expect(inMonth[0].date).toBe('2026-09-01');
    expect(inMonth[29].date).toBe('2026-09-30');
    const unique = new Set(inMonth.map((c) => c.date));
    expect(unique.size).toBe(30);
  });

  it('pads the leading row with prior-August dimmed days and starts on Sunday', () => {
    const first = parseYmd(m.weeks[0][0].date)!;
    expect(first.getDay()).toBe(0);
    // first in-month cell is Sep 1 (Tue) — so the two cells before it are Aug 30/31, dimmed
    const cells = m.weeks[0];
    const sepIdx = cells.findIndex((c) => c.date === '2026-09-01');
    expect(sepIdx).toBe(2); // Sun(30) Mon(31) Tue(1)
    expect(cells[0].inMonth).toBe(false);
    expect(cells[1].inMonth).toBe(false);
    const aug30 = parseYmd(cells[0].date)!;
    expect(`${aug30.getFullYear()}-${pad(aug30.getMonth() + 1)}-${pad(aug30.getDate())}`).toBe('2026-08-30');
  });

  it('leap-year February spans correctly (Feb 2028 starts on Tuesday, 29 days)', () => {
    const m = monthMatrix(2028, 1);
    const inMonth = m.weeks.flat().filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(29);
    expect(inMonth[0].date).toBe('2028-02-01');
    expect(inMonth[28].date).toBe('2028-02-29');
  });

  it('a Sunday-starting month needs NO leading padding (March 2026)', () => {
    const m = monthMatrix(2026, 2); // Mar 1 2026 = Sunday
    expect(m.weeks[0][0].date).toBe('2026-03-01');
    expect(m.weeks[0][0].inMonth).toBe(true);
  });
});

describe('monthLabel', () => {
  it('names the month and year (computed, locale-robust)', () => {
    const label = monthLabel(2026, 8);
    const ref = new Date(2026, 8, 15).toLocaleString([], { month: 'long', year: 'numeric' });
    expect(label).toBe(ref);
    expect(label.length).toBeGreaterThan(3); // not empty/'' — the grid header is never blank
  });
});