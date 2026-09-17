import type { NoteDto } from '../api/types';
import { useStore } from '../stores/store';

export default function NoteList({ notes }: { notes: NoteDto[] }) {
  const { selectedNoteId, selectNote, createNote } = useStore();
  return (
    <section id="notes">
      <div className="section-head">
        <h2>Notes</h2>
        <button className="new-btn" onClick={() => createNote('Untitled note', 'Uncategorized')}>+ New note</button>
      </div>
      <ul>
        {notes.map((n) => (
          <li key={n.id} className={n.id === selectedNoteId ? 'selected' : ''} onClick={() => selectNote(n.id)}>
            <span className="item-title">{n.title}{n.dirty ? ' •' : ''}</span>
            <span className="chip">{n.category}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}