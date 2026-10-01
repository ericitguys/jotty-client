import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import * as api from '../api/client';
import type { ChecklistDto, ItemDto } from '../api/types';
import { useStore } from '../stores/store';
import KanbanBoard from './KanbanBoard';
import Dropdown from './Dropdown';
import type { DropdownOption } from './Dropdown';
import { Icon } from './icons';
import { relativeAge } from '../util/relativeTime';

export default function ChecklistView({ checklistId }: { checklistId: string }) {
  const refreshAll = useStore((s) => s.refreshAll);
  const clickAction = useStore((s) => s.prefs?.checklistItemClickAction ?? 'toggle');
  const categories = useStore((s) => s.categories);
  const listRows = useStore((s) => s.checklists);
  const [items, setItems] = useState<ItemDto[]>([]);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [listMeta, setListMeta] = useState<ChecklistDto | null>(null);
  const [newText, setNewText] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);

  // Meta (title/category) is loaded ONLY when switching checklists — reload()
  // below must never snap the header fields back while the user edits them.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await api.getChecklist(checklistId);
      if (cancelled) return;
      setItems(list.items ?? []);
      // One-shot agenda click-through (T6-N1): after the items resolve, consume
      // the pending highlight — the deferred path the agenda's immediate lookup
      // can't cover on a fresh open. React commits the new rows in a following
      // task, so wait one macrotask hop before the lookup (both jsdom and
      // browsers schedule the commit before our setTimeout fires). Found →
      // scroll (try/catch: jsdom lacks scrollIntoView); NOT found → the
      // row-absent path (T6-I1): still clear, never throw. The consume is
      // unconditional on the source checklist — a stale id for a DIFFERENT
      // checklist clears here too without scrolling (one-shot).
      const pending = useStore.getState().pendingHighlightId;
      if (pending) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (cancelled) return;
        try {
          document.getElementById(`item-${pending}`)?.scrollIntoView({ block: 'center' });
        } catch { /* no layout engine in tests */ }
        useStore.getState().clearPendingHighlight();
      }
      setTitle(list.title);
      setCategory(list.category);
      setListMeta(list);
    })();
    return () => { cancelled = true; };
  }, [checklistId]);

  // Item ops re-fetch ONLY the items — header state stays local.
  const reload = useCallback(async () => {
    const list = await api.getChecklist(checklistId);
    setItems(list.items ?? []);
  }, [checklistId]);

  // R6 (T3-review F4): item ops move item COUNTS too — the sidebar's n-of-m
  // rows + completed tint ride the store's catalog refetch (refreshAll), not
  // the next sync tick (or nothing, offline). Same shape as saveMeta below;
  // reload() stays first so the rows re-render immediately.
  const refreshCatalog = useCallback(async () => {
    await refreshAll();
  }, [refreshAll]);

  // Board mode: kanban/task listTypes render the KanbanBoard; plain lists keep
  // the checkbox list. Derived from the loaded meta (not the row stub) so the
  // header stays editable in BOTH modes.
  const isBoard = !!listMeta && (listMeta.listType === 'kanban' || listMeta.listType === 'task');

  const top = items.filter((i) => i.parentLocalId === null).sort((a, b) => a.position - b.position);

  // Completed grouping (spec L8) is a DISPLAY-ONLY partition: open rows render
  // in position order, THEN a labeled divider, THEN the done rows. Positions,
  // the DnD payload and children attachment are untouched (done rows keep
  // rendering inside their parent — children live where the parent lives, and
  // drop targets on open rows behave exactly as before).
  const openTop = top.filter((i) => !i.completed);
  const doneTop = top.filter((i) => i.completed);

  // Category instant-apply (spec L5): options merge BOTH store trees by path
  // (a path can exist on notes AND checklists — one option), sorted by path;
  // an empty path renders as 'Uncategorized'. The list's own current value
  // rides along when the merged set misses it — but never rescues an EMPTY
  // set: categories null OR no category nodes at all (disconnected/empty
  // tree) → the merged set stays empty and the OLD text input renders
  // (fallback, blur commit) instead of a dropdown with a lone or zero options.
  const catOptions = useMemo<DropdownOption[]>(() => {
    if (!categories) return [];
    const byPath = new Map<string, DropdownOption>();
    for (const node of [...categories.notes, ...categories.checklists]) {
      byPath.set(node.path, { id: node.path, name: node.path || 'Uncategorized' });
    }
    if (byPath.size > 0 && category && !byPath.has(category)) byPath.set(category, { id: category, name: category });
    return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [categories, category]);

  // Header counts (plain lists) ride the T3 wire, never a client re-derivation.
  // get_checklist serializes 0/0 defaults (dto.rs From<ChecklistRow>) — the REAL
  // counts live on the store's list row (list_checklists_inner fills
  // item_count/done_count over ALL checklist_items, nested children included).
  // No row on the wire (older schema) → no meta line (ChecklistList parity).
  // `?? []`: refreshAll sets whatever listChecklists resolved — a null payload
  // nulls the store field at runtime (typed non-null, runtime nullable).
  const listRow = (listRows ?? []).find((c) => c.id === checklistId);
  const headerCounts = !isBoard && listMeta && listRow && typeof listRow.itemCount === 'number'
    ? { item: listRow.itemCount, done: listRow.doneCount ?? 0, updatedAt: listRow.updatedAt }
    : null;

  const toggle = async (item: ItemDto) => {
    await api.setItemChecked(checklistId, item.localId, !item.completed);
    await reload();
    await refreshCatalog();
  };

  const rename = async (item: ItemDto, text: string) => {
    await api.setItemText(checklistId, item.localId, text);
    await reload();
    await refreshCatalog();
  };

  const remove = async (item: ItemDto) => {
    await api.deleteItem(checklistId, item.localId);
    await reload();
    await refreshCatalog();
  };

  const add = async () => {
    if (!newText.trim()) return;
    await api.addItem(checklistId, newText.trim(), null, null);
    setNewText('');
    await reload();
    await refreshCatalog();
  };

  const onDrop = async (targetId: string, e: DragEvent) => {
    const drag = e.dataTransfer.getData('text/plain') || dragId;
    if (!drag || drag === targetId) return;
    const ordered = top.map((i) => i.localId).filter((id) => id !== drag);
    ordered.splice(ordered.indexOf(targetId), 0, drag);
    setDragId(null);
    await api.reorderItems(checklistId, ordered);
    await reload();
  };

  // saveMeta commits title+category; the Dropdown passes its selection so the
  // commit is never a state-tick behind, blur callers pass nothing.
  const saveMeta = async (categoryOverride?: string) => {
    await api.updateChecklist(checklistId, title, categoryOverride ?? category);
    await refreshAll();
  };

  // Web preference mirror: checklistItemClickAction toggle|edit. Web default
  // is toggle; "edit" makes a text click start the rename instead.
  const onTextClick = (item: ItemDto) => {
    if (clickAction === 'edit') {
      const row = document.getElementById(`item-${item.localId}`);
      row?.querySelector<HTMLInputElement>('input:not([type=checkbox])')?.focus();
      return;
    }
    toggle(item);
  };

  const renderRow = (item: ItemDto) => (
    <li key={item.localId} id={`item-${item.localId}`}
        className={item.completed ? 'completed-item' : ''}
        draggable
        onDragStart={(e) => { setDragId(item.localId); e.dataTransfer.setData('text/plain', item.localId); }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDrop(item.localId, e)}>
      <div className="row-line">
        <input type="checkbox" checked={item.completed} onChange={() => toggle(item)} />
        <span className="item-text" style={{ cursor: 'pointer' }} onClick={() => onTextClick(item)}>{item.text}</span>
        {item.targetDate && <span className="item-date-chip">{item.targetDate}</span>}
        <input value={item.text} onChange={(e) => rename(item, e.target.value)} />
        <button aria-label="Delete item" title="Delete" onClick={() => remove(item)}><Icon name="x" size={12}/></button>
      </div>
      <ul>
        {(item.children ?? []).map((c) => (
          <li key={c.localId} className="child">
            <div className="row-line">
              <input type="checkbox" checked={c.completed} onChange={() => toggle(c)} />
              <span className="item-text" style={{ cursor: 'pointer' }} onClick={() => onTextClick(c)}>{c.text}</span>
              {c.targetDate && <span className="item-date-chip">{c.targetDate}</span>}
              <input value={c.text} onChange={(e) => rename(c, e.target.value)} />
              <button aria-label="Delete subitem" title="Delete" onClick={() => remove(c)}><Icon name="x" size={12}/></button>
            </div>
          </li>
        ))}
      </ul>
    </li>
  );

  return (
    <div id="checklist-view">
      <div id="checklist-head">
        <input
          className="cl-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => saveMeta()}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <div className="cl-meta-row">
          {catOptions.length > 0 ? (
            <Dropdown
              className="cl-cat-dd"
              ariaLabel="Category"
              value={category}
              placeholder="Category"
              options={catOptions}
              onChange={(id) => { setCategory(id); void saveMeta(id); }}
            />
          ) : (
            // Fallback (offline / empty tree): typed edits keep working, blur
            // commits. No Save button in EITHER mode.
            <input
              className="cl-category"
              value={category}
              placeholder="Category"
              onChange={(e) => setCategory(e.target.value)}
              onBlur={() => saveMeta()}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          )}
        </div>
        {headerCounts && (
          <>
            <div className="cl-progress" aria-hidden="true">
              <div
                className="cl-progress-fill"
                style={{ width: `${headerCounts.item > 0 ? Math.max(0, Math.min(100, Math.round((headerCounts.done / headerCounts.item) * 100))) : 0}%` }}
              />
            </div>
            {/* LAST block in the header (T3-review F1 pattern). One inner span
                so the joined text is a single flex item (no per-text-node
                anonymous-item gaps) and textContent stays readable. */}
            <div className="row-meta meta-line">
              <span>{headerCounts.done} of {headerCounts.item} done · {relativeAge(headerCounts.updatedAt)}</span>
            </div>
          </>
        )}
      </div>
      {/* Top-of-list add row (spec L8, Things/Todoist pattern): Enter adds,
          the explicit Add button stays beside the input. */}
      <div className="cl-add-row">
        <input
          placeholder="Add an item ⏎"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button onClick={add}>Add</button>
      </div>
      {isBoard ? (
        <KanbanBoard checklistId={checklistId} items={items} reload={reload} />
      ) : (
      <ul>
        {openTop.map(renderRow)}
        {doneTop.length > 0 && (
          <div className="completed-group">
            {/* Divider rides inside the ul between open and done rows: the
                group fence pins done rows as direct `#checklist-view > ul > li`
                children, so the divider must be a non-li sibling. */}
            <h3>Completed · {doneTop.length}</h3>
          </div>
        )}
        {doneTop.map(renderRow)}
      </ul>
      )}
    </div>
  );
}