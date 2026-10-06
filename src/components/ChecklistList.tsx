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
      <ul className="card-wall">
        {checklists.map((c) => {
          // Progress from STORE list rows only (wire-counts fact: list rows carry
          // the real COUNT(*) totals; old fixtures without counts skip bar+footer).
          const pct = typeof c.itemCount === 'number' && c.itemCount > 0
            ? Math.round(((c.doneCount ?? 0) / c.itemCount) * 100)
            : 0;
          return (
          <li key={c.id} className={c.id === selectedChecklistId ? 'selected' : ''} onClick={() => selectChecklist(c.id)}>
            <div className="card-head">
              <span className="item-title">{c.title}{c.dirty ? ' •' : ''}</span>
              {(c.listType === 'kanban' || c.listType === 'task') && <span className="chip board-chip">board</span>}
              <span className="chip">{c.category}</span>
              {/* Delete affordance — covers boards AND plain checklists (the
                  server's deleteList is type-agnostic; desktop routes both
                  through DELETE /api/checklists/{id}). stopPropagation keeps the
                  card click from selecting; ConfirmModal guards the op. */}
              <button
                className="row-del"
                aria-label={`Delete ${c.title}`}
                title="Delete"
                onClick={(e) => { e.stopPropagation(); setPendingDelete(c); }}
              ><Icon name="x" size={12}/></button>
            </div>
            {/* Completion progress (upstream ChecklistCard: bar + %). Bar reuses
                the checklist-view classes (.cl-progress 4px track + accent fill);
                fill width = the wire ratio, count-gated with the footer below. */}
            {typeof c.itemCount === 'number' && (
              <div className="card-progress">
                <div className="cl-progress" aria-hidden="true">
                  <div className="cl-progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="progress-pct">{pct}%</span>
              </div>
            )}
            {/* Card foot (fence-pinned text shape): "N of M done · <age>" rides
                the .row-meta.meta-line classes the row layout used. */}
            {typeof c.itemCount === 'number' && (
              <div className="card-foot">
                <span className="row-meta meta-line">{c.doneCount ?? 0} of {c.itemCount} done · {relativeAge(c.updatedAt)}</span>
              </div>
            )}
          </li>
        );})}
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