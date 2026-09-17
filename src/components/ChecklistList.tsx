import type { ChecklistDto } from '../api/types';
import { useStore } from '../stores/store';

export default function ChecklistList({ checklists }: { checklists: ChecklistDto[] }) {
  const { selectedChecklistId, selectChecklist } = useStore();
  return (
    <section id="checklists">
      <h2>Checklists</h2>
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
