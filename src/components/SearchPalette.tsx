import { useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import type { SearchResultsDto } from '../api/types';

export default function SearchPalette({ onClose, onSelectNote, onSelectChecklist }: {
  onClose: () => void; onSelectNote: (id: string) => void; onSelectChecklist: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResultsDto | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) { setResults(null); return; }
    timer.current = setTimeout(async () => setResults(await api.search(q.trim())), 200);
  }, [q]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <input autoFocus placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        {results && (
          <ul>
            {results.notes.map((n) => (
              <li key={`n-${n.id}`} onClick={() => { onSelectNote(n.id); onClose(); }}>
                📝 <strong>{n.title}</strong> <small>{n.snippet}</small>
              </li>
            ))}
            {results.checklists.map((c) => (
              <li key={`c-${c.id}`} onClick={() => { onSelectChecklist(c.id); onClose(); }}>
                ☑ <strong>{c.title}</strong> <small>{c.itemText}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}