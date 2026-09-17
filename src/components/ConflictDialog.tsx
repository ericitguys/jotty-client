import { useEffect, useState } from 'react';
import * as api from '../api/client';
import type { ConflictDto } from '../api/types';

export default function ConflictDialog({ onClose }: { onClose: () => void }) {
  const [conflicts, setConflicts] = useState<ConflictDto[]>([]);
  useEffect(() => { api.listConflicts().then(setConflicts); }, []);
  const resolve = async (seq: number, keep: 'mine' | 'server') => {
    await api.resolveConflict(seq, keep);
    setConflicts((await api.listConflicts()));
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Sync conflicts</h2>
        {conflicts.length === 0 && <p>No conflicts.</p>}
        <ul>
          {conflicts.map((c) => (
            <li key={c.seq}>
              <strong>{c.label}</strong> — {c.opType} ({c.lastError ?? 'unresolved'})
              <button onClick={() => resolve(c.seq, 'mine')}>keep mine</button>
              <button onClick={() => resolve(c.seq, 'server')}>take server</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}