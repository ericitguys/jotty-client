import { useState } from 'react';
import type { NoteDto } from '../api/types';
import { useStore } from '../stores/store';
import ConfirmModal from './modals/ConfirmModal';

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
          <button className="new-btn voice-btn" onClick={onStartVoiceNote}>🎙 New voice note</button>
          <button className="new-btn" onClick={() => createNote('Untitled note', 'Uncategorized')}>+ New note</button>
        </div>
      </div>
      <ul>
        {notes.map((n) => (
          <li key={n.id} className={n.id === selectedNoteId ? 'selected' : ''} onClick={() => selectNote(n.id)}>
            <span className="item-title">{n.title}{n.dirty ? ' •' : ''}</span>
            {n.audioPath && n.content === '' && (
              <span className="mic-badge" title="Pending transcription — retries after sync">🎙️</span>
            )}
            <span className="chip">{n.category}</span>
            {/* Delete affordance (portal SidebarItem ⋯→Delete parity, desktop ✕
                row-button precedent): stopPropagation keeps the row click from
                selecting; the confirm modal guards the destructive op. */}
            <button
              className="row-del"
              aria-label={`Delete ${n.title}`}
              title="Delete"
              onClick={(e) => { e.stopPropagation(); setPendingDelete(n); }}
            >✕</button>
          </li>
        ))}
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