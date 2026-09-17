import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import Sidebar from './components/Sidebar';
import NoteList from './components/NoteList';
import ChecklistList from './components/ChecklistList';
import NoteEditor from './components/NoteEditor';
import SyncBadge from './components/SyncBadge';
import { useStore } from './stores/store';

export default function App() {
  const { connection, notes, checklists, selectedNoteId, refreshAll } = useStore();

  useEffect(() => {
    refreshAll();
    const un = listen('sync-updated', () => refreshAll());
    return () => { un.then((f) => f()); };
  }, [refreshAll]);

  if (!connection) {
    return <div id="app">Not connected — open settings to connect your jotty instance.</div>;
  }

  return (
    <div id="app">
      <Sidebar />
      <main>
        <NoteList notes={notes} />
        {selectedNoteId ? <NoteEditor noteId={selectedNoteId}/> : <ChecklistList checklists={checklists}/>}
      </main>
      <SyncBadge />
    </div>
  );
}
