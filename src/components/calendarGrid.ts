// Pure calendar math for the DateDropdown (WebKitGTK eradication, v0.22.2):
// the desktop webview's native date calendar commits a day-pick but NEVER
// closes its popup and keeps grabbing pointer+keyboard (probed 2026-09-29,
// references/webkitgtk-datetime-probe.md) — so date entry becomes pure DOM.
// Grid convention matches the native popup we replace (and JS getDay()):
// weeks start on SUNDAY, outside-month cells are dimmed padding.

export const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** Local date -> 'YYYY-MM-DD' (the exact format every save path consumes). */
export const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 'YYYY-MM-DD' -> local Date, or null for anything malformed/empty. */
export const parseYmd = (s: string): Date | null => {
  if (!YMD_PATTERN.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return isNaN(date.getTime()) ? null : date;
};

export interface CalendarCell {
  date: string; // 'YYYY-MM-DD'
  inMonth: boolean;
}

export interface MonthMatrix {
  year: number;
  month: number; // 0-based
  weeks: CalendarCell[][];
}

/** Sunday-anchored month grid: whole weeks, current month + dimmed padding. */
export const monthMatrix = (year: number, month: number): MonthMatrix => {
  const first = new Date(year, month, 1);
  const lead = first.getDay(); // 0 = the 1st itself lands on Sunday
  const start = new Date(year, month, 1 - lead);
  const end = new Date(year, month + 1, 0); // last day of the month
  const trail = 6 - end.getDay();

  const cells: CalendarCell[] = [];
  const total = lead + end.getDate() + trail;
  for (let i = 0; i < total; i++) {
    const d = new Date(year, month, 1 - lead + i);
    cells.push({ date: ymd(d), inMonth: d.getMonth() === month });
  }
  const weeks: CalendarCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { year, month, weeks };
};

/** Grid header label ('September 2026') — localized via toLocaleString. */
export const monthLabel = (year: number, month: number): string =>
  new Date(year, month, 15).toLocaleString([], { month: 'long', year: 'numeric' });

/** Trigger label ('Sep 29, 2026') for a set value; '' stays ''. */
export const dateLabel = (value: string): string => {
  const d = parseYmd(value);
  return d ? d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : value;
};

/** Weekday header row (localized abbreviations, Sunday-first). */
export const weekdayLabels = (): string[] => {
  // Feb 4 2024 is a known Sunday; only the weekday of each offset matters.
  return Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 1, 4 + i).toLocaleDateString([], { weekday: 'short' }),
  );
};

export const todayYmd = (): string => ymd(new Date());