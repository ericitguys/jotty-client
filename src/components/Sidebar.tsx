import { useStore } from '../stores/store';

export default function Sidebar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { categories, refreshAll } = useStore();
  return (
    <nav id="sidebar">
      <div className="brand">jotty·desktop</div>
      <h2>Categories</h2>
      <h3>Notes</h3>
      <ul>
        {categories?.notes.map((c) => (
          <li key={c.path} style={{ paddingLeft: 10 + (c.level || 0) * 14 }}>{c.name} <span className="count">{c.count}</span></li>
        ))}
      </ul>
      <h3>Checklists</h3>
      <ul>
        {categories?.checklists.map((c) => (
          <li key={`cl-${c.path}`} style={{ paddingLeft: 10 + (c.level || 0) * 14 }}>{c.name} <span className="count">{c.count}</span></li>
        ))}
      </ul>
      <div className="sidebar-actions">
        <button onClick={() => refreshAll()}>Refresh</button>
        {onOpenSettings && <button onClick={onOpenSettings}>Settings</button>}
      </div>
    </nav>
  );
}