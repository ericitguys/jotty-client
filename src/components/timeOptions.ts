// Engine-proof time picker helpers (2026-09-29 WebKitGTK probe, see skill
// jotty-client references/webkitgtk-datetime-probe.md): the Tauri Linux
// webview's native <input type=time>/<input type=datetime-local> render typed
// segments but never commit .value (no input/change events, silent date-only
// saves), and their popup is a days-only calendar that grabs focus. Every
// reminder-time UI in this app goes through THIS module: pure-DOM quarter-hour
// options rendered with the existing Dropdown, labeled in the user's locale.
export const QUICK_TIMES: string[] = [
  '06:00', '07:00', '08:00', '09:00', '12:00', '13:00', '17:00', '18:00', '21:00',
];

/** All quarter-hour times 00:00..23:45 in 24h value space. */
export const allQuarterHourValues = (): string[] => {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return out;
};

/** 12h label "09:30 AM"/"02:45 PM" for a "HH:MM" value; invalid input -> null. */
export const timeLabel = (v: string): string | null => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2];
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${min} ${period}`;
};

/** Dropdown options: quick times first, then the full grid (labels localized). */
export const timeDropdownOptions = (): { id: string; name: string }[] => {
  const values = [...QUICK_TIMES, ...allQuarterHourValues()];
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    const label = timeLabel(v);
    if (label) out.push({ id: v, name: label });
  }
  return out;
};

/**
 * Round a "HH:MM" wall time UP to the next quarter-hour grid point
 * ("09:37"->"09:45", "09:45"->"09:45", "23:50"->"00:00" next-day NOT wanted —
 * clamps to "23:45" so the reminder stays on the picked date).
 */
export const roundToQuarter = (v: string): string => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (!m) return '09:00';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min % 15 === 0) return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  // past 23:45 -> clamp to 23:45 (never roll the reminder onto the next day)
  if (h === 23 && min > 45) return '23:45';
  const r = (Math.floor(min / 15) + 1) * 15;
  return r === 60
    ? `${String((h + 1) % 24).padStart(2, '0')}:00`
    : `${String(h).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
};