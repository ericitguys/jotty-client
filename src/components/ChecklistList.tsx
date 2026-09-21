import type { ChecklistDto } from '../api/types';
import { useStore } from '../stores/store';

export default function ChecklistList({ checklists }: { checklists: ChecklistDto[] }) {
  const { selectedChecklistId, selectChecklist, createChecklist, createBoard, connection } = useStore();
  return (
    <section id="checklists">
      <div className="section-head">
        <h2>Checklists</h2>
        <button className="new-btn" onClick={() => createBoard('New board', 'Uncategorized')} disabled={!connection}
                title={connection ? 'Create a kanban board' : 'Connect to create boards'}>+ New board</button>
        <button className="new-btn" onClick={() => createChecklist('New checklist', 'Uncategorized')}>+ New checklist</button>
      </div>
      <ul>
        {checklists.map((c) => (
          <li key={c.id} className={c.id === selectedChecklistId ? 'selected' : ''} onClick={() => selectChecklist(c.id)}>
            <span className="item-title">{c.title}{c.dirty ? ' •' : ''}</span>
            {(c.listType === 'kanban' || c.listType === 'task') && <span className="chip board-chip">board</span>}
            <span className="chip">{c.category}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}