import type { ChecklistDto } from '../api/types';
import { useStore } from '../stores/store';

export default function ChecklistList({ checklists }: { checklists: ChecklistDto[] }) {
  const { selectedChecklistId, selectChecklist, createChecklist } = useStore();
  return (
    <section id="checklists">
      <div className="section-head">
        <h2>Checklists</h2>
        <button className="new-btn" onClick={() => createChecklist('New checklist', 'Uncategorized')}>+ New checklist</button>
      </div>
      <ul>
        {checklists.map((c) => (
          <li key={c.id} className={c.id === selectedChecklistId ? 'selected' : ''} onClick={() => selectChecklist(c.id)}>
            <span className="item-title">{c.title}{c.dirty ? ' •' : ''}</span>
            <span className="chip">{c.category}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}