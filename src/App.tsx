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
import SettingsModal from './components/SettingsModal';
import { useStore } from './stores/store';

export default function App() {
  const { connection, notes, checklists, selectedNoteId, selectedChecklistId, selectedCategory, listMode, selectNote, selectChecklist, refreshAll, refreshUpdate } = useStore();
  const [showConflicts, setShowConflicts] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Category filter: exact path match or a descendant (prefix) — clicking the
  // parent "Work" also shows notes in "Work/Projects".
  const inCategory = (cat: string, path: string) => cat === path || cat.startsWith(`${path}/`);
  const filteredNotes = selectedCategory?.type === 'notes'
    ? notes.filter((n) => inCategory(n.category, selectedCategory.path))
    : notes;
  const filteredChecklists = selectedCategory?.type === 'checklists'
    ? checklists.filter((c) => inCategory(c.category, selectedCategory.path))
    : checklists;

  useEffect(() => {
    refreshAll();
    refreshUpdate();
    const un = listen('sync-updated', () => refreshAll());
    return () => { un.then((f) => f()); };
  }, [refreshAll, refreshUpdate]);

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
    return (
      <div id="app">
        <SettingsModal mode="onboarding" onClose={() => {}} onConnected={refreshAll} />
        <p>Not connected — open settings to connect your jotty instance.</p>
      </div>
    );
  }

  return (
    <div id="app">
      <Sidebar onOpenSettings={() => setShowSettings(true)} />
      <main className={selectedNoteId || selectedChecklistId ? '' : 'list-only'}>
        {listMode === 'notes' ? <NoteList notes={filteredNotes} /> : <ChecklistList checklists={filteredChecklists} />}
        {selectedNoteId ? <NoteEditor noteId={selectedNoteId}/> : selectedChecklistId ? <ChecklistView checklistId={selectedChecklistId}/> : null}
      </main>
      <SyncBadge onOpenConflicts={() => setShowConflicts(true)} onOpenSettings={() => setShowSettings(true)} />
      {showConflicts && <ConflictDialog onClose={() => setShowConflicts(false)} />}
      {showSearch && <SearchPalette onClose={() => setShowSearch(false)} onSelectNote={(id) => selectNote(id)} onSelectChecklist={(id) => selectChecklist(id)} />}
      {showSettings && <SettingsModal mode="settings" onClose={() => setShowSettings(false)} />}
    </div>
  );
}