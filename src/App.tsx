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
import VoiceNoteReview from './components/VoiceNoteReview';
import * as api from './api/client';
import type { VoiceRecordingDto } from './api/types';
import { useStore } from './stores/store';

type VoiceFlow =
  | { mode: 'new' }
  | { mode: 'resume'; recording: VoiceRecordingDto }
  | { mode: 'retranscribe'; noteId: string };

export default function App() {
  const { connection, notes, checklists, selectedNoteId, selectedChecklistId, selectedCategory, listMode, prefs, branding, themeOverride, selectNote, selectChecklist, refreshAll, refreshUpdate } = useStore();
  const [showConflicts, setShowConflicts] = useState(false);
  const [voice, setVoice] = useState<VoiceFlow | null>(null);
  const [resumeRows, setResumeRows] = useState<VoiceRecordingDto[] | null>(null);
  const [contentNonce, setContentNonce] = useState(0); // remounts NoteEditor after a retranscribe save

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
  // Mobile layout (Pixel 9 etc.): the sidebar becomes an off-canvas drawer and
  // the editor takes the full screen; the desktop grid is untouched (CSS gates
  // both behaviors behind a max-width media query).
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => { setDrawerOpen(false); }, [selectedNoteId, selectedChecklistId]);

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
  // Site themes with a ported palette render as themselves; everything else
  // falls back to dark (upstream adds themes faster than we port them).
  const THEMED = ['light', 'rwmarkable-dark'] as const;
  // 0.10.7: when the user has no personal theme, adopt the site's scheme from
  // the manifest theme_color (upstream writes getThemeBackgroundColor there).
  const SITE_BG: Record<string, string> = { '#111827': 'rwmarkable-dark' };
  const siteTheme = branding?.themeColor ? SITE_BG[branding.themeColor.toLowerCase()] : undefined;
  // 0.10.8: an explicit in-app choice (Settings → Theme) wins over everything;
  // 'auto' / null restores the mirror chain (site pref → manifest → dark).
  const dataTheme = themeOverride && themeOverride !== 'auto' ? themeOverride
    : (THEMED as readonly string[]).includes(themeId) ? themeId
    : themeId === 'system' ? (systemPrefersDark ? 'dark' : 'light')
    : siteTheme ?? 'dark';

  useEffect(() => {
    refreshAll();
    refreshUpdate();
    // resume prompt (spec §6): unsaved non-recording drafts survive restart
    api.voiceListUnsaved().then((rows) => {
      if (Array.isArray(rows) && rows.length > 0) setResumeRows(rows);
    }).catch(() => {});
    const un = listen('sync-updated', () => refreshAll());
    const uv = listen('voice-updated', () => refreshAll());
    return () => { un.then((f) => f()); uv.then((f) => f()); };
  }, [refreshAll, refreshUpdate]);

  const startVoiceNote = async () => {
    // unconfigured AI server -> prompt to open Settings (spec §4)
    try {
      const s = await api.getAiSettings();
      if (!s.baseUrl || !s.hasKey) { setShowSettings(true); return; }
    } catch { setShowSettings(true); return; }
    setVoice({ mode: 'new' });
  };

  const noteSaved = (noteId: string) => {
    setVoice(null);
    setContentNonce((n) => n + 1); // retranscribe saves change content under an open editor
    selectNote(noteId);
    refreshAll();
  };

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
    <div id="app" data-theme={dataTheme} className={drawerOpen ? 'drawer-open' : ''}>
    <header className="topbar">
      <button
        className="menu-btn"
        aria-label="Toggle navigation"
        onClick={() => setDrawerOpen((o) => !o)}
      >☰</button>
      <span className="topbar-title">{title}</span>
    </header>
    {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
    <Sidebar onOpenSettings={() => { setDrawerOpen(false); setShowSettings(true); }} />
    <main className={selectedNoteId || selectedChecklistId ? '' : 'list-only'}>
      {listMode === 'notes'
        ? <NoteList notes={visibleNotes} onStartVoiceNote={startVoiceNote} onOpenSettings={() => setShowSettings(true)} />
        : <ChecklistList checklists={visibleChecklists} />}
        {selectedNoteId ? <NoteEditor key={`${selectedNoteId}-${contentNonce}`} noteId={selectedNoteId} onRetranscribe={(id) => setVoice({ mode: 'retranscribe', noteId: id })}/> : selectedChecklistId ? <ChecklistView checklistId={selectedChecklistId}/> : null}
      </main>
      {(selectedNoteId || selectedChecklistId) && (
        <button
          className="back-btn"
          aria-label="Back to list"
          onClick={() => {
            // Return to the section of the entity being closed: calling BOTH
            // select actions made the checklist call win and back always landed
            // on the checklists list (field report 2026-09-21).
            if (selectedNoteId) selectNote(null);
            else selectChecklist(null);
          }}
        >←</button>
      )}
      <SyncBadge onOpenConflicts={() => setShowConflicts(true)} onOpenSettings={() => setShowSettings(true)} />
      {showConflicts && <ConflictDialog onClose={() => setShowConflicts(false)} />}
      {showSearch && <SearchPalette onClose={() => setShowSearch(false)} onSelectNote={(id) => selectNote(id)} onSelectChecklist={(id) => selectChecklist(id)} />}
      {showSettings && <SettingsModal mode="settings" onClose={() => setShowSettings(false)} />}
      {resumeRows && (
        <div className="modal-backdrop" onClick={() => setResumeRows(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Unfinished voice note</h2>
            <p>You have a voice recording that was never saved.</p>
            <div className="voice-actions">
              <button className="primary" onClick={() => { setVoice({ mode: 'resume', recording: resumeRows[0] }); setResumeRows(null); }}>Resume review</button>
              <button onClick={async () => {
                for (const r of resumeRows) {
                  try { await api.voiceDeleteRecording(r.id); } catch { /* best-effort */ }
                }
                setResumeRows(null);
              }}>Discard</button>
            </div>
          </div>
        </div>
      )}
      {voice?.mode === 'new' && (
        <VoiceNoteReview mode="new" onClose={() => setVoice(null)} onSaved={noteSaved} />
      )}
      {voice?.mode === 'resume' && (
        <VoiceNoteReview mode="resume" recording={voice.recording} onClose={() => setVoice(null)} onSaved={noteSaved} />
      )}
      {voice?.mode === 'retranscribe' && (
        <VoiceNoteReview mode="retranscribe" noteId={voice.noteId} onClose={() => setVoice(null)} onSaved={noteSaved} />
      )}
    </div>
  );
}