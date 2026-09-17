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
            {c.title}{c.dirty ? ' •' : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}
