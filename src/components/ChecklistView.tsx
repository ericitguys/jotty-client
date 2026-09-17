import { useCallback, useEffect, useState } from 'react';
import type { DragEvent } from 'react';
import * as api from '../api/client';
import type { ItemDto } from '../api/types';
import { useStore } from '../stores/store';

export default function ChecklistView({ checklistId }: { checklistId: string }) {
  const refreshAll = useStore((s) => s.refreshAll);
  const [items, setItems] = useState<ItemDto[]>([]);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
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
      setTitle(list.title);
      setCategory(list.category);
    })();
    return () => { cancelled = true; };
  }, [checklistId]);

  // Item ops re-fetch ONLY the items — header state stays local.
  const reload = useCallback(async () => {
    const list = await api.getChecklist(checklistId);
    setItems(list.items ?? []);
  }, [checklistId]);

  const top = items.filter((i) => i.parentLocalId === null).sort((a, b) => a.position - b.position);

  const toggle = async (item: ItemDto) => {
    await api.setItemChecked(checklistId, item.localId, !item.completed);
    await reload();
  };

  const rename = async (item: ItemDto, text: string) => {
    await api.setItemText(checklistId, item.localId, text);
    await reload();
  };

  const remove = async (item: ItemDto) => {
    await api.deleteItem(checklistId, item.localId);
    await reload();
  };

  const add = async () => {
    if (!newText.trim()) return;
    await api.addItem(checklistId, newText.trim(), null);
    setNewText('');
    await reload();
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

  const saveMeta = async () => {
    await api.updateChecklist(checklistId, title, category);
    await refreshAll();
  };

  return (
    <div id="checklist-view">
      <div id="checklist-head">
        <input
          className="cl-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveMeta}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <div className="cl-meta-row">
          <input
            className="cl-category"
            value={category}
            placeholder="Category"
            onChange={(e) => setCategory(e.target.value)}
            onBlur={saveMeta}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          {/* preventDefault on mousedown keeps input focus; Save then commits once */}
          <button className="cl-save" onMouseDown={(e) => e.preventDefault()} onClick={saveMeta}>Save</button>
        </div>
      </div>
      <ul>
        {top.map((item) => (
          <li key={item.localId}
              className={item.completed ? 'completed-item' : ''}
              draggable
              onDragStart={(e) => { setDragId(item.localId); e.dataTransfer.setData('text/plain', item.localId); }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop(item.localId, e)}>
            <div className="row-line">
              <input type="checkbox" checked={item.completed} onChange={() => toggle(item)} />
              <span className="item-text">{item.text}</span>
              <input value={item.text} onChange={(e) => rename(item, e.target.value)} />
              <button onClick={() => remove(item)}>✕</button>
            </div>
            <ul>
              {(item.children ?? []).map((c) => (
                <li key={c.localId} className="child">
                  <div className="row-line">
                    <input type="checkbox" checked={c.completed} onChange={() => toggle(c)} />
                    <span className="item-text">{c.text}</span>
                    <input value={c.text} onChange={(e) => rename(c, e.target.value)} />
                    <button onClick={() => remove(c)}>✕</button>
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <input placeholder="New item" value={newText} onChange={(e) => setNewText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
      <button onClick={add}>Add</button>
    </div>
  );
}