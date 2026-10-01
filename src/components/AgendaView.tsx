import { useEffect, useState } from 'react';
import * as api from '../api/client';
import type { AgendaEntry } from '../api/types';
import { formatReminderTime } from './KanbanBoard';
import { useStore } from '../stores/store';
import { Icon } from './icons';

/** Local-time date key ('YYYY-MM-DD') of an ISO string. Date-only strings
 * parse as UTC midnight, so in UTC-behind timezones the local key can trail
 * the calendar date by a day — the same disclosed drift as upstream's
 * toDateKey (appointments spec §5.5); ISO strings carrying a time part are
 * exact. */
function dateKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Bucket order is the rendered order; completed entries always land last.
const GROUP_NAMES = ['Overdue', 'Today', 'Tomorrow', 'Next 7 days', 'Later', 'Completed'] as const;
const COMPLETED = 5;
const LATER = 4;

export default function AgendaView() {
  const selectChecklist = useStore((s) => s.selectChecklist);
  const setPendingHighlight = useStore((s) => s.setPendingHighlight);
  const [entries, setEntries] = useState<AgendaEntry[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');

  // Pure local read (Rust list_agenda): one fetch on mount, cancelled on
  // unmount, offline-safe like KanbanBoard — a failure keeps entries [] and
  // renders a small inline error line (no modals).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await api.listAgenda();
        if (cancelled) return;
        setEntries(Array.isArray(rows) ? rows : []);
        setPhase('ready');
      } catch {
        if (cancelled) return;
        setPhase('error'); // entries stay []
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const today = new Date();
  const plusDays = (days: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    return dateKey(d.toISOString());
  };
  const todayKey = dateKey(today.toISOString());
  const tomorrowKey = plusDays(1);
  const weekKey = plusDays(7); // inclusive upper bound of "Next 7 days"

  const groups = GROUP_NAMES.map((name) => ({ name, rows: [] as AgendaEntry[] }));
  for (const entry of entries) {
    // each entry's group is computed once — first matching bucket wins
    groups[entry.completed ? COMPLETED
      : !entry.targetDate ? LATER // defensive: the wire only carries dated items
      : dateKey(entry.targetDate) < todayKey ? 0
      : dateKey(entry.targetDate) === todayKey ? 1
      : dateKey(entry.targetDate) === tomorrowKey ? 2
      : dateKey(entry.targetDate) <= weekKey ? 3
      : LATER].rows.push(entry);
  }

  const open = (entry: AgendaEntry) => {
    // Deferred highlight FIRST (T6-N1): on a fresh open, ChecklistView fetches
    // its items async, so the immediate lookup below is usually a no-op — the
    // view consumes pendingHighlightId (scroll + one-shot clear) once its
    // items resolve. Set BEFORE selectChecklist so the request is queued for
    // the view's first load, whichever list opens.
    setPendingHighlight(entry.itemLocalId);
    selectChecklist(entry.checklistId); // flips listMode: the list + ChecklistView open
    // Best-effort highlight: ChecklistView rows carry id=item-<localId> (top-
    // level rows). The row is usually not mounted yet at this instant (the
    // view fetches items async), so the lookup may be a no-op — never let it
    // throw (jsdom has no scrollIntoView).
    try {
      document.getElementById(`item-${entry.itemLocalId}`)?.scrollIntoView({ block: 'center' });
    } catch { /* no layout engine in tests */ }
  };

  return (
    <section className="agenda-view">
      <div className="section-head"><h2>Agenda</h2></div>
      {phase === 'loading' && <p className="agenda-note">Loading agenda…</p>}
      {phase === 'error' && <p className="agenda-error">Agenda unavailable.</p>}
      {phase === 'ready' && entries.length === 0 && <p className="agenda-empty">No dated items.</p>}
      {groups.filter((g) => g.rows.length > 0).map((g) => (
        <div className="agenda-group" key={g.name}>
          <h3>{g.name}</h3>
          {g.rows.map((entry) => {
            // time-of-day only when the ISO carries a time part (date-only
            // strings carry none); shown from the local Date
            const time = entry.targetDate && entry.targetDate.includes('T')
              ? (() => {
                  const d = new Date(entry.targetDate);
                  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                })()
              : null;
            return (
              <div key={entry.itemLocalId}
                   className={`agenda-entry${entry.completed ? ' completed' : ''}`}
                   data-id={entry.itemLocalId}
                   onClick={() => open(entry)}>
                <strong className="agenda-text">{entry.text}</strong>
                <span className="agenda-list meta-line">{entry.checklistTitle}</span>
                {time && <span className="agenda-time meta-line">{time}</span>}
                {entry.reminderDatetime && (
                  <span className={`agenda-bell meta-line${entry.reminderNotified ? ' notified' : ''}`}
                        title={new Date(entry.reminderDatetime).toLocaleString()}>
                    <Icon name="bell" size={11}/> {formatReminderTime(entry.reminderDatetime)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}