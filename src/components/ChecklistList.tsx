import { useState } from 'react';
import type { ChecklistDto } from '../api/types';
import { useStore } from '../stores/store';
import ConfirmModal from './modals/ConfirmModal';

export default function ChecklistList({ checklists }: { checklists: ChecklistDto[] }) {
  const { selectedChecklistId, selectChecklist, createChecklist, createBoard, deleteChecklist, connection } = useStore();
  const [pendingDelete, setPendingDelete] = useState<ChecklistDto | null>(null);
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
            {/* Delete affordance — covers boards AND plain checklists (the
                server's deleteList is type-agnostic; desktop routes both
                through DELETE /api/checklists/{id}). stopPropagation keeps the
                row click from selecting; ConfirmModal guards the op. */}
            <button
              className="row-del"
              aria-label={`Delete ${c.title}`}
              title="Delete"
              onClick={(e) => { e.stopPropagation(); setPendingDelete(c); }}
            >✕</button>
          </li>
        ))}
      </ul>
      {/* Portal confirmDeleteItem string (en.json:188) with the list title. */}
      <ConfirmModal
        isOpen={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => { if (pendingDelete) void deleteChecklist(pendingDelete.id); }}
        title="Delete"
        message={pendingDelete ? `Are you sure you want to delete "${pendingDelete.title}"?` : ''}
        confirmText="Delete"
        destructive
      />
    </section>
  );
}