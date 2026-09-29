import { describe, expect, it } from 'vitest';
import { allQuarterHourValues, roundToQuarter, timeDropdownOptions, timeLabel } from './timeOptions';

describe('timeOptions (WebKitGTK engine-proof time grid)', () => {
  it('full grid = 96 quarter-hour values', () => {
    const grid = allQuarterHourValues();
    expect(grid.length).toBe(96);
    expect(grid[0]).toBe('00:00');
    expect(grid[95]).toBe('23:45');
    expect(new Set(grid).size).toBe(96); // no dupes
  });

  it('labels every option 12h (AM/PM); every grid value maps to a valid label', () => {
    const opts = timeDropdownOptions();
    expect(opts.length).toBe(96); // quick times are a subset of the grid -> deduped
    for (const o of opts) expect(o.name).toMatch(/^\d{2}:\d{2} (AM|PM)$/);
    // spot values
    expect(timeLabel('00:00')).toBe('12:00 AM');
    expect(timeLabel('09:30')).toBe('09:30 AM');
    expect(timeLabel('12:00')).toBe('12:00 PM');
    expect(timeLabel('14:30')).toBe('02:30 PM');
    expect(timeLabel('23:45')).toBe('11:45 PM');
    expect(timeLabel('24:00')).toBeNull();
    expect(timeLabel('9:30')).toBeNull();
    expect(timeLabel('09:5x')).toBeNull();
  });

  it('roundToQuarter: exact stays, below-round rounds UP, 23:46+ clamps to 23:45 (never next-day)', () => {
    expect(roundToQuarter('09:00')).toBe('09:00');
    expect(roundToQuarter('09:15')).toBe('09:15');
    expect(roundToQuarter('09:01')).toBe('09:15');
    expect(roundToQuarter('09:44')).toBe('09:45');
    expect(roundToQuarter('09:37')).toBe('09:45');
    expect(roundToQuarter('23:45')).toBe('23:45');
    expect(roundToQuarter('23:46')).toBe('23:45');
    expect(roundToQuarter('23:59')).toBe('23:45');
    expect(roundToQuarter('09:60')).toBe('09:00'); // invalid -> default 09:00
    expect(roundToQuarter('garbage')).toBe('09:00');
  });
});