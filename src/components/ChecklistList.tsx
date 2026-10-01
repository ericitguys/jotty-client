import { useState } from 'react';
import type { ChecklistDto } from '../api/types';
import { useStore } from '../stores/store';
import ConfirmModal from './modals/ConfirmModal';
import { Icon } from './icons';
import { relativeAge } from '../util/relativeTime';

export default function ChecklistList({ checklists }: { checklists: ChecklistDto[] }) {
  const { selectedChecklistId, selectChecklist, createChecklist, createBoard, deleteChecklist, connection } = useStore();
  const [pendingDelete, setPendingDelete] = useState<ChecklistDto | null>(null);
  return (
    <section id="checklists">
      <div className="section-head">
        <h2>Checklists</h2>
        <div className="head-actions">
          <button className="new-btn" onClick={() => createBoard('New board', 'Uncategorized')} disabled={!connection}
                  title={connection ? 'Create a kanban board' : 'Connect to create boards'}><Icon name="columns" size={12}/> New board</button>
          <button className="new-btn" onClick={() => createChecklist('New checklist', 'Uncategorized')}><Icon name="plus" size={12}/> New checklist</button>
        </div>
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
            ><Icon name="x" size={12}/></button>
            {/* Row meta (tier A task 3 + T3-review F1/F3): LAST flex child —
                flex-basis:100% wraps it to its own second line under
                title+chips (NoteList parity; mid-row placement broke the
                chip/cascade onto a third line in the real engine). Meta line
                renders ONLY when the wire carried counts — old fixtures
                (no itemCount) skip. Board chip survives beside it. One span
                so textContent reads "N of M done · <age>"; meta-line class
                gives the muted 11.5px tabular-nums typography (review F3). */}
            {typeof c.itemCount === 'number' && (
              <span className="row-meta meta-line">{c.doneCount ?? 0} of {c.itemCount} done · {relativeAge(c.updatedAt)}</span>
            )}
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