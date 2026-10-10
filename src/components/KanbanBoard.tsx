import { useEffect, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import * as api from '../api/client';
import type { BoardStatusDto, ItemDto } from '../api/types';
import Dropdown from './Dropdown';
import DateDropdown from './DateDropdown';
import { timeDropdownOptions, roundToQuarter } from './timeOptions';
import { dateLabel, todayYmd } from './calendarGrid';
import { Icon } from './icons';

// Z-form/offset ISO -> local 'YYYY-MM-DDTHH:mm' for datetime-local prefill (T7.1):
// datetime-local inputs SANITIZE TZ-suffixed values to empty, so raw stored reminders
// must be converted to local wall time before prefilling. Round-trips: Save re-ISOs
// the local value back to the exact same instant.
const toLocalInput = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Bell chip time (R6): local HH:MM of the reminder — toLocaleTimeString with
// 2-digit hour/minute in the default locale; empty/null/invalid (NaN instant)
// → '' so a malformed stored value never renders "Invalid Date" in the chip.
// Exported: AgendaView's bell chip shares this exact formatting.
export const formatReminderTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

// Recurrence chip (task 4): the LOCAL-ONLY recurrence JSON ({rrule, dtstart,
// nextDue, ...} — device-local, never synced) -> display label + next reset
// date. Null when absent/unparseable (never a lying chip); an unrecognized
// rrule still labels 'Repeat' (custom rules authored on the web stay visible).
// Preset RRULEs are byte-verbatim from the rust engine (db/recurrence.rs).
const RECURRENCE_LABELS: Record<string, string> = {
  'FREQ=DAILY;INTERVAL=1': 'Daily',
  'FREQ=WEEKLY;INTERVAL=1': 'Weekly',
  'FREQ=WEEKLY;INTERVAL=2': 'Bi-weekly',
  'FREQ=MONTHLY;INTERVAL=1': 'Monthly',
  'FREQ=YEARLY;INTERVAL=1': 'Yearly',
};
const recurrenceMeta = (raw: string | null | undefined): { label: string; nextDueYmd: string | null } | null => {
  if (!raw) return null;
  let rec: { rrule?: unknown; nextDue?: unknown };
  try { rec = JSON.parse(raw) as { rrule?: unknown; nextDue?: unknown }; } catch { return null; }
  if (!rec || typeof rec.rrule !== 'string') return null;
  const nextDue = typeof rec.nextDue === 'string' && !isNaN(new Date(rec.nextDue).getTime())
    ? rec.nextDue.slice(0, 10) // UTC date part (R-rec-8: stamps use the UTC date)
    : null;
  return { label: RECURRENCE_LABELS[rec.rrule] ?? 'Repeat', nextDueYmd: nextDue };
};

export default function KanbanBoard({ checklistId, items, reload }: {
  checklistId: string; items: ItemDto[]; reload: () => Promise<void>;
}) {
  const [columns, setColumns] = useState<BoardStatusDto[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [newCard, setNewCard] = useState('');
  const [newCardDate, setNewCardDate] = useState('');
  // date editor (appointments): which card's date is being edited + the picker value
  const [dating, setDating] = useState<string | null>(null);
  const [dateVal, setDateVal] = useState('');
  // reminder editor (appointments T7, split 2026-09-29): the single
  // datetime-local input is unusable on the Tauri Linux webview (WebKitGTK:
  // days-only grabbing popup; typed time segments never commit .value) —
  // split into a native date input + the pure-DOM Time Dropdown, which work
  // on every engine. Save stays disabled until both parts are picked; the
  // ONLY clear path is the menu's Clear reminder row (never a half-save null).
  const [reminding, setReminding] = useState<string | null>(null);
  const [reminderDate, setReminderDate] = useState('');
  const [reminderTime, setReminderTime] = useState('');
  // recurrence menu (task 4): which card's Repeat preset list is open —
  // mirrors dating/reminding, cleared with them on the backdrop tap.
  const [repeating, setRepeating] = useState<string | null>(null);
  // details sub-panel (P8): which card's Details editor is open + the values
  // it authors (description textarea + estimated-hours input). estErr gates
  // the negative-hours inline error (a rejected value never invokes).
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [descVal, setDescVal] = useState('');
  const [estVal, setEstVal] = useState('');
  const [estErr, setEstErr] = useState(false);
  // Start-date picker (P8): prefill mirrors dateVal on the Set-date open; the
  // touched flag decides whether Save forwards `startDate` at all — untouched
  // saves keep the legacy 3-arg invoke shape (byte-frozen date fences).
  const [startDateVal, setStartDateVal] = useState('');
  const [startDateTouched, setStartDateTouched] = useState(false);
  const TIME_OPTIONS = timeDropdownOptions();
  // P9 column editor state: one open menu at a time
  const [colMenuFor, setColMenuFor] = useState<string | null>(null);
  const [colNewLabel, setColNewLabel] = useState('');
  const [colNewColor, setColNewColor] = useState<string | null>(null);
  const [colRenameLabel, setColRenameLabel] = useState('');
  const [colError, setColError] = useState<string | null>(null);
  const [colsGen, setColsGen] = useState(0);
  const PALETTE = ['#3b82f6','#ef4444','#22c55e','#eab308','#a855f7','#ec4899','#14b8a6','#f97316'];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cached = await api.getBoardColumns(checklistId);
        if (!cancelled) setColumns(cached.statuses);
      } catch { /* uncached + no client: defaults render below */ }
      try {
        const fresh = await api.fetchTaskBoard(checklistId); // live refresh, silent on failure
        if (!cancelled) setColumns(fresh.statuses);
      } catch { /* offline: cache stays */ }
    })();
    return () => { cancelled = true; };
  }, [checklistId, colsGen]);

  // Column render order = the `order` field, not the payload's array order:
  // upstream persists statuses as a literal YAML array (insertion order — its
  // own web UI sorts defensively: Kanban.tsx `statuses.sort((a,b) => a.order
  // - b.order)`), so a same-array-order render shows a moved column stuck in
  // place until some other remount refetches a luckily-sorted array.
  const cols: BoardStatusDto[] = (columns ?? []).slice().sort((a, b) => a.order - b.order);
  const top = items.filter((i) => i.parentLocalId === null).sort((a, b) => a.position - b.position);
  const validIds = new Set(cols.map((c) => c.id));
  const firstId = cols.slice().sort((a, b) => a.order - b.order)[0]?.id;
  const cardsFor = (col: BoardStatusDto) =>
    top.filter((i) => i.status === col.id || (col.id === firstId && (!i.status || !validIds.has(i.status))));

  const move = async (localId: string, status: string) => {
    setMenuFor(null);
    await api.setItemStatus(checklistId, localId, status);
    await reload();
  };
  const onDrop = async (colId: string, e: DragEvent) => {
    const drag = e.dataTransfer.getData('text/plain') || dragId;
    setDragId(null);
    if (!drag) return;
    await move(drag, colId);
  };
  const rename = async (localId: string) => {
    setRenaming(null);
    if (!renameText.trim()) return;
    await api.setItemText(checklistId, localId, renameText.trim());
    await reload();
  };
  const addCard = async (colId: string) => {
    if (!newCard.trim()) return;
    await api.addItem(checklistId, newCard.trim(), null, colId, newCardDate || null);
    setNewCard('');
    setNewCardDate('');
    setAddingTo(null);
    await reload();
  };
  const closeAddForm = () => { setAddingTo(null); setNewCard(''); setNewCardDate(''); };
  const saveDate = async (localId: string) => {
    setDating(null);
    setMenuFor(null);
    // empty picker = clear (null clears server-side; the badge disappears on reload).
    // P8 task 2 — the Start date rides the SAME set_item_target_date op: the
    // touched Start picker forwards its value RAW ('' = explicit-clear
    // SENTINEL; never normalized to null — a literal null at this invoke
    // boundary is indistinguishable from an absent key, tauri Option<String>
    // flattens it, so the sentinel '' is the only expressible clear) and the
    // untouched picker keeps the legacy 3-arg shape (the wrapper forwards the
    // key only when !== undefined, so the byte-frozen 3-key fences hold).
    await api.setItemTargetDate(checklistId, localId, dateVal || null, startDateTouched ? startDateVal : undefined);
    await reload();
  };
  const saveReminder = async (localId: string) => {
    // both parts required; an incomplete editor NEVER saves (and therefore
    // never null-clears an existing reminder — the WebKitGTK half-save trap)
    if (!reminderDate || !reminderTime) return;
    setReminding(null);
    setMenuFor(null);
    // local wall time -> ISO carries the offset (matches the enrichment format)
    await api.setItemReminder(checklistId, localId, new Date(`${reminderDate}T${reminderTime}:00`).toISOString());
    await reload();
  };
  const clearReminder = async (localId: string) => {
    setReminding(null);
    setMenuFor(null);
    await api.setItemReminder(checklistId, localId, null);
    await reload();
  };
  // Recurrence picking (task 4): null clears the rule, a preset key authors
  // the LOCAL-ONLY one (set_item_recurrence writes the recurrence column,
  // never an outbox op); menu closes + reload mirrors move().
  const pickRecurrence = async (localId: string, preset: string | null) => {
    setRepeating(null);
    setMenuFor(null);
    await api.setItemRecurrence(checklistId, localId, preset);
    await reload();
  };
  // Details sub-panel actions (P8): description Save commits + closes (empty
  // = null clear); priority/est-hours commits close too (the menu idiom —
  // every committing action closes). A NEGATIVE hours value stays open with
  // the inline error and never invokes; empty hours = null (clear).
  const saveDescription = async (localId: string) => {
    setDetailFor(null);
    setMenuFor(null);
    const v = descVal.trim();
    await api.setDescription(checklistId, localId, v === '' ? null : v);
    await reload();
  };
  const pickPriority = async (localId: string, priority: 'critical' | 'high' | 'medium' | 'low' | null) => {
    setDetailFor(null);
    setMenuFor(null);
    await api.setPriority(checklistId, localId, priority);
    await reload();
  };
  const saveEstTime = async (localId: string) => {
    const raw = estVal.trim();
    if (raw === '') {
      setEstErr(false);
      setDetailFor(null);
      setMenuFor(null);
      await api.setEstimatedTime(checklistId, localId, null);
      await reload();
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      // inline error, NO invoke, panel stays open (the WebKitGTK half-save trap
      // never re-enters: a rejected value cannot silently clear the hours)
      setEstErr(true);
      return;
    }
    // safe-integer bound: the truncated hour count crossing the tauri i64 wire
    // must fit |n| ≤ 2^53-1. A value like 9e18 is not exactly representable as a
    // JSON integer and trips the invoke arg boundary — reject rather than fail
    // silently on the backend.
    const truncated = Math.trunc(n);
    if (!Number.isSafeInteger(truncated)) {
      setEstErr(true);
      return;
    }
    setEstErr(false);
    setDetailFor(null);
    setMenuFor(null);
    // upstream truncates fractional hours server-side; we truncate BEFORE the
    // invoke (whole hours cross the op payload as JSON integers only)
    await api.setEstimatedTime(checklistId, localId, truncated);
    await reload();
  };

  // P9 column editor actions (ONLINE-ONLY: no local cache/outbox writes; UI
  // refresh rides the caller's reload after the server call succeeds).
  const closeColMenu = () => {
    setColMenuFor(null);
    setColError(null);
    setColNewLabel('');
    setColNewColor(null);
    setColRenameLabel('');
  };
  const openColMenu = (colId: string, label: string) => {
    setColMenuFor(colId);
    setColError(null);
    setColNewLabel('');
    setColNewColor(null);
    setColRenameLabel(label);
  };
  const addColumn = async () => {
    if (!colNewLabel.trim()) return;
    try {
      await api.addBoardColumn(checklistId, colNewLabel.trim(), colNewColor);
      closeColMenu();
      setColsGen((g) => g + 1);
      await reload();
    } catch (e) {
      setColError(String(e));
    }
  };
  const renameColumn = async (col: BoardStatusDto) => {
    if (!colRenameLabel.trim()) return;
    try {
      await api.updateBoardColumn(checklistId, col.id, colRenameLabel.trim(), null, null);
      closeColMenu();
      setColsGen((g) => g + 1);
      await reload();
    } catch (e) {
      setColError(String(e));
    }
  };
  const toggleColumnAutoComplete = async (col: BoardStatusDto) => {
    try {
      await api.updateBoardColumn(checklistId, col.id, null, null, !col.autoComplete);
      closeColMenu();
      setColsGen((g) => g + 1);
      await reload();
    } catch (e) {
      setColError(String(e));
    }
  };
  const moveColumn = async (col: BoardStatusDto, direction: 'up' | 'down') => {
    try {
      await api.moveBoardColumn(checklistId, col.id, direction);
      closeColMenu();
      setColsGen((g) => g + 1);
      await reload();
    } catch (e) {
      setColError(String(e));
    }
  };
  const deleteColumn = async (col: BoardStatusDto) => {
    try {
      await api.deleteBoardColumn(checklistId, col.id);
      closeColMenu();
      setColsGen((g) => g + 1);
      await reload();
    } catch (e) {
      setColError(String(e));
    }
  };

  return (
    <div className="kanban-board">
      {(menuFor || renaming || addingTo || colMenuFor) && <div className="kanban-backdrop" onClick={() => { setMenuFor(null); setRenaming(null); setDating(null); setReminding(null); setRepeating(null); setDetailFor(null); setReminderDate(''); setReminderTime(''); closeAddForm(); closeColMenu(); }} />}
      {cols.map((col) => (
        <div className="kanban-col" key={col.id}
             onDragOver={(e) => e.preventDefault()}
             onDrop={(e) => onDrop(col.id, e)}>
          <div className="kanban-col-head">
            <span className="kanban-dot" style={col.color ? { background: col.color } : undefined} />
            <span className="kanban-col-title">{col.label}</span>
            <span className="kanban-count">{cardsFor(col).length}</span>
            <button className="kanban-col-menu-btn" aria-label="Column actions" onClick={(e) => { e.stopPropagation(); colMenuFor === col.id ? closeColMenu() : openColMenu(col.id, col.label); }}><Icon name="more" size={13} /></button>
            {colMenuFor === col.id && (
              <div className="kanban-menu" onClick={(e) => e.stopPropagation()} onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape') closeColMenu(); }}>
                <div className="kanban-col-section">
                  <input className="kanban-col-label-input" placeholder="New column name" value={colNewLabel} onChange={(e) => setColNewLabel(e.target.value)} />
                  <div className="kanban-col-palette">
                    {PALETTE.map((c) => (
                      <button key={c} className={`kanban-swatch${colNewColor === c ? ' picked' : ''}`} style={{ background: c }} aria-label={c} onClick={() => setColNewColor(c)} />
                    ))}
                    <button className={`kanban-swatch${colNewColor === null ? ' picked' : ''}`} aria-label="None" onClick={() => setColNewColor(null)} />
                  </div>
                  <button className="kanban-menu-primary" onClick={() => addColumn()}>Add column</button>
                </div>
                <div className="kanban-col-section">
                  <input className="kanban-col-label-input" aria-label="Rename column" value={colRenameLabel} onChange={(e) => setColRenameLabel(e.target.value)} />
                  <button onClick={() => renameColumn(col)}>Apply</button>
                </div>
                <button onClick={() => toggleColumnAutoComplete(col)}>Auto-complete: {col.autoComplete ? 'On' : 'Off'}</button>
                <button onClick={() => moveColumn(col, 'up')}>Move up</button>
                <button onClick={() => moveColumn(col, 'down')}>Move down</button>
                {cols.length > 2 && (() => {
                  const dest = cols.filter((c) => c.id !== col.id).sort((a, b) => a.order - b.order)[0];
                  const count = cardsFor(col).length;
                  return (
                    <div className="kanban-danger kanban-col-delete">
                      <span>{dest ? `${dest.label} · ${count} card${count === 1 ? '' : 's'}` : ''}</span>
                      <button onClick={() => deleteColumn(col)}>Delete</button>
                    </div>
                  );
                })()}
                {colError && <p className="kanban-error">{colError}</p>}
                <button onClick={closeColMenu}>Back</button>
              </div>
            )}
          </div>
          <div className="kanban-cards">
            {cardsFor(col).map((item) => (
              <div key={item.localId}
                   className={`kanban-card${item.completed || col.autoComplete ? ' completed-item' : ''}${menuFor === item.localId ? ' menu-open' : ''}${dragId === item.localId ? ' dragging' : ''}`}
                   draggable
                   onDragStart={(e) => { setColMenuFor(null); setDragId(item.localId); e.dataTransfer.setData('text/plain', item.localId); }}
                   onDragEnd={() => setDragId(null)}>
                {renaming === item.localId ? (
                  <input value={renameText} autoFocus
                         onChange={(e) => setRenameText(e.target.value)}
                         onBlur={() => rename(item.localId)}
                         onKeyDown={(e: KeyboardEvent) => {
                           if (e.key === 'Enter') rename(item.localId);
                           else if (e.key === 'Escape') { setRenaming(null); setRenameText(''); }
                         }} />
                ) : (
                  <span className="kanban-card-text"
                        onClick={(e) => { e.stopPropagation(); setRenameText(item.text); setRenaming(item.localId); }}>{item.text}</span>
                )}
                <span className="kanban-badges">
                  {item.priority && <span className="kanban-badge">{item.priority}</span>}
                  {item.targetDate && (() => {
                    const today = todayYmd();
                    const cls = item.targetDate === today ? ' due-today' : item.targetDate < today ? ' overdue' : '';
                    return (
                      <span className={`kanban-badge${cls}`} title={`Due ${dateLabel(item.targetDate)}`}>
                        <Icon name="calendar" size={11}/> {dateLabel(item.targetDate)}
                      </span>
                    );
                  })()}
                  {item.reminderDatetime && (
                    <span className={`kanban-badge kanban-reminder${item.reminderNotified ? ' notified' : ''}`}
                          title={new Date(item.reminderDatetime).toLocaleString()}>
                      <Icon name="bell" size={11}/> {formatReminderTime(item.reminderDatetime)}
                    </span>
                  )}
                  {(() => {
                    // Recurrence chip (task 4): LOCAL-ONLY rrule label; a
                    // COMPLETED card announces its next reset date (R-rec-1
                    // mirror-the-web: completed stays completed until its slot).
                    const meta = recurrenceMeta(item.recurrence);
                    if (!meta) return null;
                    const title = item.completed && meta.nextDueYmd ? `Resets ${dateLabel(meta.nextDueYmd)}` : `Repeats ${meta.label}`;
                    return (
                      <span className="kanban-badge kanban-recurrence" title={title}>
                        <Icon name="repeat" size={11}/> {meta.label}
                      </span>
                    );
                  })()}
                  {item.children.length > 0 && <span className="kanban-badge">{item.children.length} subtask{item.children.length === 1 ? '' : 's'}</span>}
                </span>
                <button className="kanban-card-menu" aria-label="Card actions" title="Card actions"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuFor((m) => (m === item.localId ? null : item.localId));
                        }}>
                  <Icon name="more" size={13}/>
                </button>
                {menuFor === item.localId && (
                  <div className="kanban-menu" onClick={(e) => e.stopPropagation()}>
                    {detailFor === item.localId ? (
                      <div className="kanban-detail-edit" onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape') setDetailFor(null); }}>
                        {/* P8 details sub-panel (task 2): description/priority/
                            est-hours in ONE panel (no mode swaps inside). The
                            textarea is multiline — Enter NEVER commits (kanban
                            keydown Enter-guard contract; only Save does).
                            Container-level Escape closes; no new badges. */}
                        <textarea aria-label="Card description" value={descVal} rows={4}
                                  onChange={(e) => setDescVal(e.target.value)} />
                        <button aria-label="Save description" onClick={() => saveDescription(item.localId)}>Save</button>
                        <button onClick={() => setDetailFor(null)}>Back</button>
                        <div className="kanban-detail-priority">
                          <button onClick={() => pickPriority(item.localId, 'critical')}>critical</button>
                          <button onClick={() => pickPriority(item.localId, 'high')}>high</button>
                          <button onClick={() => pickPriority(item.localId, 'medium')}>medium</button>
                          <button onClick={() => pickPriority(item.localId, 'low')}>low</button>
                          <button onClick={() => pickPriority(item.localId, null)}>Clear priority</button>
                        </div>
                        <span className="kanban-detail-label">Estimated hours</span>
                        <input type="number" min={0} step={1} aria-label="Estimated hours" value={estVal}
                               onChange={(e) => { setEstVal(e.target.value); setEstErr(false); }} />
                        {estErr && <p className="kanban-est-error">Estimated hours must not be negative</p>}
                        <button onClick={() => saveEstTime(item.localId)}>Save hours</button>
                      </div>
                    ) : dating === item.localId ? (
                      <div className="kanban-date-edit">
                        {/* WebKitGTK eradication (v0.22.2): the native date
                            calendar commits a pick but never closes and keeps
                            grabbing input; DateDropdown is the engine-proof
                            replacement (closes on pick/outside/Escape).
                            showClear: '' = clear here (saveDate semantics). */}
                        <DateDropdown value={dateVal} onChange={setDateVal}
                                      placeholder="Pick a date" ariaLabel="Date (clearable)"
                                      showClear />
                        {/* P8 task 2: the Start date rides the SAME set_date op —
                            the touched picker forwards its value ('' = explicit
                            null clear) alongside targetDate on Save. */}
                        <span className="kanban-date-label">Start date</span>
                        <DateDropdown value={startDateVal}
                                      onChange={(v) => { setStartDateVal(v); setStartDateTouched(true); }}
                                      placeholder="Pick a date" ariaLabel="Start date"
                                      showClear />
                        <button onClick={() => saveDate(item.localId)}>Save date</button>
                        <button onClick={() => setDating(null)}>Back</button>
                      </div>
                    ) : reminding === item.localId ? (
                      <div className="kanban-reminder-edit">
                        <DateDropdown value={reminderDate} onChange={setReminderDate}
                                      placeholder="Pick a date" ariaLabel="Reminder date" />
                        <Dropdown value={reminderTime} options={TIME_OPTIONS}
                                  onChange={setReminderTime} ariaLabel="Reminder time"
                                  placeholder="Pick a time" />
                        {(!reminderDate || !reminderTime) && (
                          <p className="kanban-reminder-hint">Pick a date and a time</p>
                        )}
                        <button disabled={!reminderDate || !reminderTime} aria-label="Save reminder"
                                onClick={() => saveReminder(item.localId)}>Save</button>
                        <button onClick={() => setReminding(null)}>Back</button>
                      </div>
                    ) : repeating === item.localId ? (
                      <div className="kanban-recurrence-edit">
                        {/* picking calls set_item_recurrence; preset keys match
                            the rust engine's Preset::key (db/recurrence.rs) */}
                        <button onClick={() => pickRecurrence(item.localId, null)}>None</button>
                        <button onClick={() => pickRecurrence(item.localId, 'daily')}>Daily</button>
                        <button onClick={() => pickRecurrence(item.localId, 'weekly')}>Weekly</button>
                        <button onClick={() => pickRecurrence(item.localId, 'biweekly')}>Bi-weekly</button>
                        <button onClick={() => pickRecurrence(item.localId, 'monthly')}>Monthly</button>
                        <button onClick={() => pickRecurrence(item.localId, 'yearly')}>Yearly</button>
                        <button onClick={() => setRepeating(null)}>Back</button>
                      </div>
                    ) : (
                      <>
                        {cols.filter((c) => c.id !== col.id).map((c) => (
                          <button key={c.id} onClick={() => move(item.localId, c.id)}>Move to {c.label}</button>
                        ))}
                        <button onClick={() => { setDescVal(item.description ?? ''); setEstVal(item.estimatedTime != null ? String(item.estimatedTime) : ''); setEstErr(false); setDetailFor(item.localId); }}>Details</button>
                        <button onClick={() => { setDateVal(item.targetDate ?? ''); setStartDateVal(item.startDate ?? ''); setStartDateTouched(false); setDating(item.localId); }}>Set date</button>
                        <button onClick={() => {
                          if (item.reminderDatetime) {
                            const local = toLocalInput(item.reminderDatetime); // 'YYYY-MM-DDTHH:mm'
                            setReminderDate(local.slice(0, 10));
                            setReminderTime(roundToQuarter(local.slice(11, 16)));
                          } else {
                            setReminderDate(''); setReminderTime('');
                          }
                          setReminding(item.localId);
                        }}>Set reminder</button>
                        <button onClick={() => setRepeating(item.localId)}>Repeat</button>
                        {item.reminderDatetime && <button onClick={() => clearReminder(item.localId)}>Clear reminder</button>}
                        <button onClick={() => { setRenameText(item.text); setRenaming(item.localId); setMenuFor(null); }}>Rename</button>
                        <button className="kanban-danger" onClick={async () => { setMenuFor(null); await api.deleteItem(checklistId, item.localId); await reload(); }}>Delete</button>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
            {addingTo === col.id ? (
              <div className="kanban-add-form">
                <input className="kanban-add-input" placeholder="New card" autoFocus value={newCard}
                       onChange={(e) => setNewCard(e.target.value)}
                       onKeyDown={(e: KeyboardEvent) => e.key === 'Enter' && addCard(col.id)} />
                <DateDropdown value={newCardDate} onChange={setNewCardDate}
                              placeholder="Date (optional)" ariaLabel="Date (optional)" />
                <div className="kanban-add-actions">
                  <button className="kanban-add-confirm" onClick={() => addCard(col.id)}>Add card</button>
                  <button onClick={closeAddForm}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="kanban-add" onClick={() => setAddingTo(col.id)}>+</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}