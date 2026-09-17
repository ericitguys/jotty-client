import { useStore } from '../stores/store';

export default function Sidebar() {
  const { categories, refreshAll } = useStore();
  return (
    <nav id="sidebar">
      <h2>Categories</h2>
      <ul>
        {categories?.notes.map((c) => (
          <li key={c.path}>{c.name} <span className="count">{c.count}</span></li>
        ))}
        {categories?.checklists.map((c) => (
          <li key={`cl-${c.path}`}>{c.name} <span className="count">{c.count}</span></li>
        ))}
      </ul>
      <button onClick={() => refreshAll()}>Refresh</button>
    </nav>
  );
}
