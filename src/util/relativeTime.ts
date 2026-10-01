// Relative-age formatter for list-row meta lines (UX tier A task 2; spec L7).
// Pure + local-timezone; every branch string is pinned by the plan interface
// (docs/superpowers/plans/2026-10-01-ux-polish.md §Task 2):
//   null/''/unparseable → 'never synced'
//   sub-hour age        → 'just now'   (any sub-hour age, not minute-precise)
//   calendar-yesterday  → 'yesterday'  (regardless of hour, within 7d — the
//                                      calendar arm outranks the hour arm)
//   < 24h               → '<N>h ago'   (integer floor hours)
//   < 7d                → '<N>d ago'   (integer floor days)
//   future              → absolute year-inclusive (spec L10: future → absolute)
//   ≥ 7d                → 'Sep 21' month-day when the instants share the
//                         local calendar year AND age < 365d, else
//                         'Sep 21, 2025' year-inclusive (age ≥ 365d always
//                         carries the year). Locale pinned en-US so the row
//                         renders identically across webviews/environments.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;

const monthDay = (d: Date): string =>
  d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const formatDate = (ms: number, withYear: boolean): string => {
  const d = new Date(ms);
  return withYear ? `${monthDay(d)}, ${d.getFullYear()}` : monthDay(d);
};

const isCalendarYesterday = (tMs: number, nowMs: number): boolean => {
  const t = new Date(tMs);
  const yesterday = new Date(nowMs);
  yesterday.setDate(yesterday.getDate() - 1); // DST-true calendar arithmetic
  return (
    t.getFullYear() === yesterday.getFullYear() &&
    t.getMonth() === yesterday.getMonth() &&
    t.getDate() === yesterday.getDate()
  );
};

export function relativeAge(iso: string | null): string {
  if (!iso) return 'never synced';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'never synced';
  const now = Date.now();
  const age = now - t;
  if (age < 0) return formatDate(t, true); // future: absolute, year included
  if (age < HOUR_MS) return 'just now';
  if (age < 7 * DAY_MS && isCalendarYesterday(t, now)) return 'yesterday';
  if (age < 24 * HOUR_MS) return `${Math.floor(age / HOUR_MS)}h ago`;
  if (age < 7 * DAY_MS) return `${Math.floor(age / DAY_MS)}d ago`;
  const withYear =
    age >= YEAR_MS || new Date(t).getFullYear() !== new Date(now).getFullYear();
  return formatDate(t, withYear);
}