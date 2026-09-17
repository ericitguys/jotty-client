import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import Sidebar from './components/Sidebar';
import NoteList from './components/NoteList';
import ChecklistList from './components/ChecklistList';
import ChecklistView from './components/ChecklistView';
import NoteEditor from './components/NoteEditor';
import SyncBadge from './components/SyncBadge';
import ConflictDialog from './components/ConflictDialog';
import SearchPalette from './components/SearchPalette';
import { useStore } from './stores/store';

export default function App() {
  const { connection, notes, checklists, selectedNoteId, selectedChecklistId, selectNote, selectChecklist, refreshAll } = useStore();
  const [showConflicts, setShowConflicts] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  useEffect(() => {
    refreshAll();
    const un = listen('sync-updated', () => refreshAll());
    return () => { un.then((f) => f()); };
  }, [refreshAll]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!connection) {
    return <div id="app">Not connected — open settings to connect your jotty instance.</div>;
  }

  return (
    <div id="app">
      <Sidebar />
      <main>
        <NoteList notes={notes} />
        {selectedNoteId ? <NoteEditor noteId={selectedNoteId}/> : selectedChecklistId ? <ChecklistView checklistId={selectedChecklistId}/> : <ChecklistList checklists={checklists}/>}
      </main>
      <SyncBadge onOpenConflicts={() => setShowConflicts(true)} />
      {showConflicts && <ConflictDialog onClose={() => setShowConflicts(false)} />}
      {showSearch && <SearchPalette onClose={() => setShowSearch(false)} onSelectNote={(id) => selectNote(id)} onSelectChecklist={(id) => selectChecklist(id)} />}
    </div>
  );
}