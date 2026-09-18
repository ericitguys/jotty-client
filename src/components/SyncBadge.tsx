import { useEffect, useState } from 'react';
import * as api from '../api/client';
import { useStore } from '../stores/store';

export default function SyncBadge({ onOpenConflicts, onOpenSettings }: {
  onOpenConflicts: () => void; onOpenSettings: () => void;
}) {
  const syncStatus = useStore((s) => s.syncStatus);
  const updateInfo = useStore((s) => s.updateInfo);
  const [conflicts, setConflicts] = useState(0);
  useEffect(() => {
    api.listConflicts().then((c) => setConflicts(Array.isArray(c) ? c.length : 0));
  }, [syncStatus]);
  if (!syncStatus) return null;
  const state = conflicts > 0 ? 'conflict' : syncStatus.pending > 0 ? 'pending' : 'synced';
  return (
    <footer id="sync-badge" className={state} title={syncStatus.lastError ?? undefined}>
      {updateInfo?.available && (
        <button className="update-chip" onClick={onOpenSettings}>⬆ {updateInfo.latest}</button>
      )}
      <span className="dot" />
      {state === 'conflict' && <button onClick={onOpenConflicts}>{conflicts} conflicts</button>}
      {state === 'pending' && <span>{syncStatus.pending} pending</span>}
      {state === 'synced' && <span>synced</span>}
      {syncStatus.lastError && <span className="sync-error">— {syncStatus.lastError}</span>}
      <button onClick={() => api.triggerSync()}>sync now</button>
    </footer>
  );
}