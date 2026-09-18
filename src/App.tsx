import { useEffect, useState, useSyncExternalStore } from 'react';
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
  const { connection, notes, checklists, selectedNoteId, selectedChecklistId, selectedCategory, listMode, prefs, branding, selectNote, selectChecklist, refreshAll, refreshUpdate } = useStore();
  const [showConflicts, setShowConflicts] = useState(false);

  // Branding mirror: window title follows the instance's app name. The native
  // setTitle call is best-effort (skipped outside a real webview, e.g. tests).
  const title = branding?.name ?? 'jotty·desktop';
  useEffect(() => {
    document.title = title;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setTitle(title);
      } catch { /* not in a Tauri webview (vitest) or unsupported */ }
    })();
  }, [title]);
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

  // Web preference mirror: default filters (read-only — edited on the web).
  const noteFilter = prefs?.defaultNoteFilter ?? 'all';
  const listFilter = prefs?.defaultChecklistFilter ?? 'all';
  const visibleNotes = (() => {
    let list = filteredNotes;
    if (noteFilter === 'pinned' && prefs) list = list.filter((n) => prefs.pinnedNotes.includes(n.id));
    if (noteFilter === 'recent') list = [...list].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return list;
  })();
  const visibleChecklists = (() => {
    let list = filteredChecklists;
    if (listFilter === 'pinned' && prefs) list = list.filter((c) => prefs.pinnedLists.includes(c.id));
    if (listFilter === 'completed') list = list.filter((c) => c.completed);
    if (listFilter === 'incomplete') list = list.filter((c) => !c.completed);
    if (listFilter === 'task' || listFilter === 'simple') list = list.filter((c) => c.listType === listFilter);
    return list;
  })();

  // Theme mirror: light/dark/system (any custom theme id falls back to dark).
  // "system" follows the OS live via prefers-color-scheme. matchMedia is
  // feature-detected (jsdom lacks it; every real webview has it).
  const mq = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const systemPrefersDark = useSyncExternalStore(
    (cb) => { mq?.addEventListener('change', cb); return () => mq?.removeEventListener('change', cb); },
    () => mq?.matches ?? true,
    () => true, // jsdom/server snapshot: dark
  );
  const themeId = prefs?.preferredTheme ?? 'dark';
  const dataTheme = themeId === 'light' ? 'light'
    : themeId === 'system' ? (systemPrefersDark ? 'dark' : 'light')
    : 'dark';

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
    <div id="app" data-theme={dataTheme}>
    <Sidebar onOpenSettings={() => setShowSettings(true)} />
    <main className={selectedNoteId || selectedChecklistId ? '' : 'list-only'}>
      {listMode === 'notes' ? <NoteList notes={visibleNotes} /> : <ChecklistList checklists={visibleChecklists} />}
        {selectedNoteId ? <NoteEditor noteId={selectedNoteId}/> : selectedChecklistId ? <ChecklistView checklistId={selectedChecklistId}/> : null}
      </main>
      <SyncBadge onOpenConflicts={() => setShowConflicts(true)} onOpenSettings={() => setShowSettings(true)} />
      {showConflicts && <ConflictDialog onClose={() => setShowConflicts(false)} />}
      {showSearch && <SearchPalette onClose={() => setShowSearch(false)} onSelectNote={(id) => selectNote(id)} onSelectChecklist={(id) => selectChecklist(id)} />}
      {showSettings && <SettingsModal mode="settings" onClose={() => setShowSettings(false)} />}
    </div>
  );
}