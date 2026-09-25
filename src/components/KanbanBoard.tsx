import { useEffect, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import * as api from '../api/client';
import type { BoardStatusDto, ItemDto } from '../api/types';

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

  return (
    <div className="kanban-board">
      {(menuFor || renaming || addingTo) && <div className="kanban-backdrop" onClick={() => { setMenuFor(null); setRenaming(null); setDating(null); closeAddForm(); }} />}
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
                       if (next !== item.localId) setDating(null);
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
                    ) : (
                      <>
                        {cols.filter((c) => c.id !== col.id).map((c) => (
                          <button key={c.id} onClick={() => move(item.localId, c.id)}>Move to {c.label}</button>
                        ))}
                        <button onClick={() => { setDateVal(item.targetDate ?? ''); setDating(item.localId); }}>Set date</button>
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