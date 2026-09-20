import type { NoteDto } from '../api/types';
import { useStore } from '../stores/store';

export default function NoteList({ notes, onStartVoiceNote, onOpenSettings }: {
  notes: NoteDto[];
  onStartVoiceNote: () => void;
  onOpenSettings: () => void;
}) {
  const { selectedNoteId, selectNote, createNote } = useStore();
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
          </li>
        ))}
      </ul>
    </section>
  );
}