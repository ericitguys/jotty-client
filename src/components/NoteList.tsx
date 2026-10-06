import { useState } from 'react';
import type { NoteDto } from '../api/types';
import { useStore } from '../stores/store';
import { relativeAge } from '../util/relativeTime';
import { snippetFromHtml } from '../util/snippet';
import ConfirmModal from './modals/ConfirmModal';
import { Icon } from './icons';

export default function NoteList({ notes, onStartVoiceNote, onOpenSettings }: {
  notes: NoteDto[];
  onStartVoiceNote: () => void;
  onOpenSettings: () => void;
}) {
  const { selectedNoteId, selectNote, createNote, deleteNote } = useStore();
  const [pendingDelete, setPendingDelete] = useState<NoteDto | null>(null);
  void onOpenSettings; // the probe lives in App (single source); kept for future inline prompting
  return (
    <section id="notes">
      <div className="section-head">
        <h2>Notes</h2>
        <div className="head-actions">
          <button className="new-btn voice-btn" onClick={onStartVoiceNote}><Icon name="mic" size={13}/> New voice note</button>
          <button className="new-btn" onClick={() => createNote('Untitled note', 'Uncategorized')}><Icon name="plus" size={12}/> New note</button>
        </div>
      </div>
      <ul className="card-wall">
        {notes.map((n) => {
          const snippet = snippetFromHtml(n.content || '');
          return (
          <li key={n.id} className={n.id === selectedNoteId ? 'selected' : ''} onClick={() => selectNote(n.id)}>
            <div className="card-head">
              <span className="item-title">{n.title}{n.dirty ? ' •' : ''}</span>
              {n.audioPath && n.content === '' && (
                <span className="mic-badge" title="Pending transcription — retries after sync"><Icon name="mic" size={12}/></span>
              )}
              <span className="chip">{n.category}</span>
              {/* Delete affordance (portal SidebarItem ⋯→Delete parity, desktop ✕
                  row-button precedent): stopPropagation keeps the card click from
                  selecting; the confirm modal guards the destructive op. */}
              <button
                className="row-del"
                aria-label={`Delete ${n.title}`}
                title="Delete"
                onClick={(e) => { e.stopPropagation(); setPendingDelete(n); }}
              ><Icon name="x" size={12}/></button>
            </div>
            {/* Card body (spec §3.4): snippet preview, 4-line clamp. Renders ONLY
                for non-empty stripped content (RTL text-node discipline:
                element-scoped, never a joined string). */}
            {snippet !== '' && <div className="card-body"><span className="row-snippet">{snippet}</span></div>}
            {/* Card foot: relative age (relativeAge(null) renders the 'never synced' arm). */}
            <div className="card-foot"><span className="row-age">{relativeAge(n.updatedAt)}</span></div>
          </li>
          );
        })}
      </ul>
      {/* Portal confirmDeleteItem string (en.json:188) with the note title. */}
      <ConfirmModal
        isOpen={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => { if (pendingDelete) void deleteNote(pendingDelete.id); }}
        title="Delete"
        message={pendingDelete ? `Are you sure you want to delete "${pendingDelete.title}"?` : ''}
        confirmText="Delete"
        destructive
      />
    </section>
  );
}