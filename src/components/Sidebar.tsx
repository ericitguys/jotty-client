import { useStore } from '../stores/store';
import type { CategoryFilter } from '../stores/store';

export default function Sidebar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { categories, selectedCategory, selectCategory, refreshAll } = useStore();
  const toggle = (type: CategoryFilter['type'], c: { name: string; path: string }) => {
    const active = selectedCategory?.type === type && selectedCategory.path === c.path;
    selectCategory(active ? null : { type, path: c.path });
  };
  return (
    <nav id="sidebar">
      <div className="brand">jotty·desktop</div>
      <h2>Categories</h2>
      {selectedCategory && <button className="clear-filter" onClick={() => selectCategory(null)}>Show all</button>}
      <h3>Notes</h3>
      <ul>
        {categories?.notes.map((c) => (
          <li key={c.path}
              className={selectedCategory?.type === 'notes' && selectedCategory.path === c.path ? 'selected' : ''}
              onClick={() => toggle('notes', c)}>{c.name} <span className="count">{c.count}</span></li>
        ))}
      </ul>
      <h3>Checklists</h3>
      <ul>
        {categories?.checklists.map((c) => (
          <li key={`cl-${c.path}`}
              className={selectedCategory?.type === 'checklists' && selectedCategory.path === c.path ? 'selected' : ''}
              onClick={() => toggle('checklists', c)}>{c.name} <span className="count">{c.count}</span></li>
        ))}
      </ul>
      <div className="sidebar-actions">
        <button onClick={() => refreshAll()}>Refresh</button>
        {onOpenSettings && <button onClick={onOpenSettings}>Settings</button>}
      </div>
    </nav>
  );
}