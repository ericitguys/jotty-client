import { useStore } from '../stores/store';

export default function SyncBadge() {
  const syncStatus = useStore((s) => s.syncStatus);
  if (!syncStatus) return null;
  return (
    <footer id="sync-badge">
      {syncStatus.pending > 0 ? `${syncStatus.pending} pending` : 'synced'}
    </footer>
  );
}
