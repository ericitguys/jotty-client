import { useEffect, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import * as api from '../api/client';
import type { BoardStatusDto, ItemDto } from '../api/types';
import Dropdown from './Dropdown';
import { timeDropdownOptions, roundToQuarter } from './timeOptions';

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

// 🔔 chip time (R6): local HH:MM of the reminder — toLocaleTimeString with
// 2-digit hour/minute in the default locale; empty/null/invalid (NaN instant)
// → '' so a malformed stored value never renders "Invalid Date" in the chip.
// Exported: AgendaView's bell chip shares this exact formatting.
export const formatReminderTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  const TIME_OPTIONS = timeDropdownOptions();

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
  }, [checklistId]);

  const cols: BoardStatusDto[] = columns ?? [];
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
    // empty picker = clear (null clears server-side; the badge disappears on reload)
    await api.setItemTargetDate(checklistId, localId, dateVal || null);
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

  return (
    <div className="kanban-board">
      {(menuFor || renaming || addingTo) && <div className="kanban-backdrop" onClick={() => { setMenuFor(null); setRenaming(null); setDating(null); setReminding(null); setReminderDate(''); setReminderTime(''); closeAddForm(); }} />}
      {cols.map((col) => (
        <div className="kanban-col" key={col.id}
             onDragOver={(e) => e.preventDefault()}
             onDrop={(e) => onDrop(col.id, e)}>
          <div className="kanban-col-head">
            <span className="kanban-dot" style={col.color ? { background: col.color } : undefined} />
            <span className="kanban-col-title">{col.label}</span>
            <span className="kanban-count">{cardsFor(col).length}</span>
          </div>
          <div className="kanban-cards">
            {cardsFor(col).map((item) => (
              <div key={item.localId}
                   className={`kanban-card${item.completed || col.autoComplete ? ' completed-item' : ''}${menuFor === item.localId ? ' menu-open' : ''}`}
                   draggable
                   onDragStart={(e) => { setDragId(item.localId); e.dataTransfer.setData('text/plain', item.localId); }}
                   onClick={(e) => {
                     e.stopPropagation();
                     if (renaming) return;
                     setMenuFor((m) => {
                       const next = m === item.localId ? null : item.localId;
                       if (next !== item.localId) { setDating(null); setReminding(null); }
                       return next;
                     });
                   }}>
                {renaming === item.localId ? (
                  <input value={renameText} autoFocus
                         onChange={(e) => setRenameText(e.target.value)}
                         onBlur={() => rename(item.localId)}
                         onKeyDown={(e: KeyboardEvent) => e.key === 'Enter' && rename(item.localId)} />
                ) : (
                  <span className="kanban-card-text">{item.text}</span>
                )}
                <span className="kanban-badges">
                  {item.priority && <span className="kanban-badge">{item.priority}</span>}
                  {item.targetDate && <span className="kanban-badge">{item.targetDate}</span>}
                  {item.reminderDatetime && (
                    <span className={`kanban-badge kanban-reminder${item.reminderNotified ? ' notified' : ''}`}
                          title={new Date(item.reminderDatetime).toLocaleString()}>
                      🔔 {formatReminderTime(item.reminderDatetime)}
                    </span>
                  )}
                  {item.children.length > 0 && <span className="kanban-badge">{item.children.length} subtask{item.children.length === 1 ? '' : 's'}</span>}
                </span>
                {menuFor === item.localId && (
                  <div className="kanban-menu" onClick={(e) => e.stopPropagation()}>
                    {dating === item.localId ? (
                      <div className="kanban-date-edit">
                        <input type="date" value={dateVal} autoFocus
                               onChange={(e) => setDateVal(e.target.value)}
                               onKeyDown={(e: KeyboardEvent) => e.key === 'Enter' && saveDate(item.localId)} />
                        <button onClick={() => saveDate(item.localId)}>Save date</button>
                        <button onClick={() => setDating(null)}>Back</button>
                      </div>
                    ) : reminding === item.localId ? (
                      <div className="kanban-reminder-edit">
                        <input type="date" value={reminderDate} autoFocus
                               onChange={(e) => setReminderDate(e.target.value)}
                               onKeyDown={(e: KeyboardEvent) => e.key === 'Enter' && saveReminder(item.localId)} />
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
                    ) : (
                      <>
                        {cols.filter((c) => c.id !== col.id).map((c) => (
                          <button key={c.id} onClick={() => move(item.localId, c.id)}>Move to {c.label}</button>
                        ))}
                        <button onClick={() => { setDateVal(item.targetDate ?? ''); setDating(item.localId); }}>Set date</button>
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
                <input type="date" aria-label="Date (optional)" value={newCardDate}
                       onChange={(e) => setNewCardDate(e.target.value)}
                       onKeyDown={(e: KeyboardEvent) => e.key === 'Enter' && addCard(col.id)} />
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