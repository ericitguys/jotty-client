import { useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import type { SearchResultsDto, ThemeOverride } from '../api/types';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Icon } from './icons';
import type { IconName } from './icons';
import { useStore } from '../stores/store';

// Unified command bar (tier B S1): commands + search in ONE ⌘K surface.
// Empty query = the 7 pinned commands; typing filters commands (label
// containment) and debounces (200ms) into the same search the old palette ran.
// ↑/↓ walk ONE flat rows array (commands first); Enter runs; Esc closes.
// Theme cycle (R-B4): setThemeOverride takes the RAW value; null = follow site.
const THEME_CYCLE: (ThemeOverride | null)[] = [null, 'dark', 'light', 'rwmarkable-dark'];

export default function CommandBar({ onClose, onSelectNote, onSelectChecklist, onStartVoiceNote, onOpenSettings }: {
  onClose: () => void;
  onSelectNote: (id: string) => void;
  onSelectChecklist: (id: string) => void;
  onStartVoiceNote?: () => void;
  onOpenSettings?: () => void;
}) {
  const { connection, checklists, refreshAll, createNote, createChecklist, createBoard, themeOverride, setThemeOverride } = useStore();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResultsDto | null>(null);
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) { setResults(null); return; }
    timer.current = setTimeout(async () => setResults(await api.search(q.trim())), 200);
  }, [q]);

  const needle = q.trim().toLowerCase();
  const commands = [
    { label: 'New note', icon: 'note' as IconName, run: async () => { await createNote('Untitled note', 'Uncategorized'); onClose(); } },
    { label: 'New checklist', icon: 'list' as IconName, run: async () => { await createChecklist('New checklist', 'Uncategorized'); onClose(); } },
    { label: 'New board', icon: 'columns' as IconName, run: async () => { if (connection) { await createBoard('New board', 'Uncategorized'); } onClose(); } },
    { label: 'New voice note', icon: 'mic' as IconName, run: () => { onStartVoiceNote?.(); onClose(); } },
    { label: 'Sync now', icon: 'refresh' as IconName, run: async () => { await refreshAll(); onClose(); } },
    { label: 'Toggle theme', icon: 'sun' as IconName, run: () => {
        const i = THEME_CYCLE.indexOf(themeOverride);
        setThemeOverride(THEME_CYCLE[(i + 1) % THEME_CYCLE.length]);
      } },
    { label: 'Open settings', icon: 'settings' as IconName, run: () => { onOpenSettings?.(); onClose(); } },
  ];
  const shownCmds = needle ? commands.filter((c) => c.label.toLowerCase().includes(needle)) : commands;

  type Ent = { kind: 'note' | 'checklist'; id: string; title: string; sub: string | null; board: boolean };
  const ents: Ent[] = needle && results ? [
    ...results.notes.map((n) => ({ kind: 'note' as const, id: n.id, title: n.title, sub: n.snippet, board: false })),
    ...results.checklists.map((c) => {
      const known = checklists.find((k) => k.id === c.id)?.listType;
      return { kind: 'checklist' as const, id: c.id, title: c.title, sub: c.itemText, board: known === 'kanban' || known === 'task' };
    }),
  ] : [];

  type Row = { type: 'cmd'; label: string; icon: IconName; run: () => void | Promise<void> }
    | { type: 'ent'; ent: Ent };
  const rows: Row[] = [
    ...shownCmds.map((c) => ({ type: 'cmd' as const, label: c.label, icon: c.icon, run: c.run })),
    ...ents.map((e) => ({ type: 'ent' as const, ent: e })),
  ];
  const activeRow = rows[Math.min(active, rows.length - 1)];

  const runRow = (row: Row) => {
    if (row.type === 'cmd') void row.run();
    else {
      if (row.ent.kind === 'note') onSelectNote(row.ent.id); else onSelectChecklist(row.ent.id);
      onClose();
    }
  };

  const onInputKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { if (activeRow) runRow(activeRow); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal command-bar" onClick={(e) => e.stopPropagation()}>
        <input autoFocus placeholder="Search commands and notes…" value={q}
               onChange={(e) => { setQ(e.target.value); setActive(0); }}
               onKeyDown={onInputKeyDown} />
        {shownCmds.map((c, i) => (
          <button key={c.label} className={`command-row${i === active ? ' active' : ''}`} onClick={() => runRow(rows[i])}>
            <Icon name={c.icon} size={14} className="palette-ico"/> <span>{c.label}</span>
          </button>
        ))}
        {needle && ents.length > 0 && shownCmds.length > 0 && <h3 className="meta-line palette-sep">Results</h3>}
        {ents.map((ent, j) => {
          const i = shownCmds.length + j;
          return (
            <button key={`${ent.kind}-${ent.id}`} className={`command-row${i === active ? ' active' : ''}`}
                    onClick={() => runRow(rows[i])}>
              <Icon name={ent.kind === 'note' ? 'note' : 'list'} size={13} className="palette-ico"/>
              <strong>{ent.title}</strong> <small>{ent.sub}</small>
              {ent.board && <span className="chip board-chip">board</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}