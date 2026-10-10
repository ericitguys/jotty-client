import { create } from 'zustand';
import * as api from '../api/client';
import { deriveCategories } from '../api/categories';
import type * as T from '../api/types';

// Quick capture (capture-foundation P1): captured notes land in the reserved
// `!INBOX` category tree. One shared definition for the App filter (T3), route
// validation (P2 triage) and AI flows (P3): a category IS a capture zone when
// it is `!INBOX` or a descendant (`!INBOX/...`).
export const INBOX_CATEGORY = '!INBOX';
export const isCaptureZone = (category: string | null | undefined): boolean =>
  !!category && (category === INBOX_CATEGORY || category.startsWith(`${INBOX_CATEGORY}/`));

interface AppState {
  connection: T.ConnectInfo | null;
  notes: T.NoteDto[];
  checklists: T.ChecklistDto[];
  categories: T.CategoriesDto | null;
  syncStatus: T.SyncStatusDto | null;
  selectedNoteId: string | null;
  selectedChecklistId: string | null;
  selectedCategory: CategoryFilter | null;
  listMode: ListMode;
  /** One-shot agenda click-through request (v0.21 scroll-to-item): set by
   * AgendaView BEFORE selectChecklist; consumed by ChecklistView (scroll +
   * clear) once its items resolve — a fresh open's immediate lookup is a
   * no-op because the rows are not mounted yet. */
  pendingHighlightId: string | null;
  updateInfo: T.UpdateInfo | null;
  refreshUpdate: () => Promise<void>;
  prefs: T.UserPrefs | null;
  branding: T.Branding | null;
  stalePieces: { categories: boolean; prefs: boolean; branding: boolean };
  /** In-app theme override (0.10.8): null = follow the site mirror. */
  themeOverride: T.ThemeOverride | null;
  setThemeOverride: (v: T.ThemeOverride | null) => void;
  /** Tier B S2: prefers-reduced-motion in-app override (Settings → Appearance checkbox). */
  reduceMotion: boolean;
  setReduceMotion: (v: boolean) => void;
  refreshAll: () => Promise<void>;
  selectNote: (id: string | null) => void;
  selectChecklist: (id: string | null) => void;
  selectCategory: (c: CategoryFilter | null) => void;
  setListMode: (m: ListMode) => void;
  setPendingHighlight: (id: string | null) => void;
  clearPendingHighlight: () => void;
  createNote: (title: string, category: string) => Promise<T.NoteDto>;
  /** Quick capture (capture-foundation P1 T2): create an entropy-titled !INBOX note; store state unchanged except the lists refresh. */
  quickCapture: (text: string) => Promise<T.NoteDto>;
  createChecklist: (title: string, category: string) => Promise<T.ChecklistDto>;
  createBoard: (title: string, category: string) => Promise<T.ChecklistDto>;
  /** Delete a note (soft-delete local + outbox "delete" op → DELETE /api/notes/{id} on push). */
  deleteNote: (id: string) => Promise<void>;
  /** Delete a checklist or board (deleteList is type-agnostic server-side — boards route through the same DELETE /api/checklists/{id}). */
  deleteChecklist: (id: string) => Promise<void>;
  saveVoiceNoteWithBoard: (input: VoiceBoardInput) => Promise<{ noteId: string; boardId: string }>;
}

export interface CategoryFilter {
  type: 'notes' | 'checklists';
  path: string;
}

export type ListMode = 'notes' | 'checklists' | 'agenda';

export interface VoiceBoardInput {
  recordingId: string | null; // new/resume modes
  noteId: string | null;      // retranscribe mode
  title: string;
  category: string;
  useTidied: boolean;
  text: string;
  tasks: string[];
  noteSavedId?: string | null; // set on retry after a board-stage failure
  targetBoardId?: string | null; // set = add cards to an EXISTING board instead of creating a new one
  /** Voice → appointment (appointments Task 8): replaces the tasks loop — ONE
   * card on the chosen board + target date + optional reminder. */
  appointment?: { title: string; targetDate: string; reminderDatetime: string | null; boardId: string } | null;
}

export const useStore = create<AppState>((set, get) => ({
  connection: null,
  notes: [],
  checklists: [],
  categories: null,
  syncStatus: null,
  selectedNoteId: null,
  selectedChecklistId: null,
  selectedCategory: null,
  listMode: 'notes',
  pendingHighlightId: null,
  updateInfo: null,
  prefs: null,
  branding: null,
  stalePieces: { categories: false, prefs: false, branding: false },
  themeOverride: (() => {
    try { return (localStorage.getItem('jotty.theme-override') as T.ThemeOverride | null) ?? null; }
    catch { return null; }
  })(),
  reduceMotion: (() => {
    try { return localStorage.getItem('jotty.reduce-motion') === 'true'; } catch { return false; }
  })(),
  setThemeOverride: (v) => {
    set({ themeOverride: v });
    try {
      if (v) localStorage.setItem('jotty.theme-override', v);
      else localStorage.removeItem('jotty.theme-override');
    } catch { /* storage unavailable: session-only override */ }
  },
  setReduceMotion: (v) => {
    set({ reduceMotion: v });
    try {
      if (v) localStorage.setItem('jotty.reduce-motion', 'true');
      else localStorage.removeItem('jotty.reduce-motion');
    } catch { /* storage unavailable */ }
  },
  refreshUpdate: async () => {
    try {
      const info = await api.checkUpdate();
      set({ updateInfo: info });
    } catch {
      // offline / rate-limited / private repo: never surface update errors unprompted
    }
  },
  refreshAll: async () => {
    const [connection, notes, checklists, categoriesResult, syncStatus, prefsResult, brandingResult] = await Promise.all([
      api.getConnection(), api.listNotes(), api.listChecklists(),
      // listCategories is a LIVE server fetch: offline it fails, and an unguarded
      // rejection killed the WHOLE refresh — connection stayed null and the app
      // fell back to the onboarding screen on an offline start (v0.9.1 fix).
      api.listCategories().catch(() => null),
      api.syncStatus(),
      api.getPrefs().catch(() => null),
      api.getBranding().catch(() => null),
    ]);
    // Staleness is only meaningful while online: an offline start (connection
    // null) intentionally fails live fetches, so clear/keep flags false.
    const online = !!connection;
    const stalePieces = {
      categories: categoriesResult === null && online,
      prefs: prefsResult === null && online,
      branding: brandingResult === null && online,
    };
    set({ connection, notes, checklists, syncStatus, stalePieces });
    // Mirror-only fields overwrite only on a successful fetch so a transient
    // failure keeps the last known value (offline-safe, no flicker).
    const categories = categoriesResult;
    if (categories) set({ categories });
    else if (!get().categories) {
      // Cold-start offline fallback: there is no last-known value to preserve,
      // so derive the tree from the local rows fetched above — the same
      // derivation the server performs on its own rows (api/categories.ts).
      set({ categories: deriveCategories(notes ?? [], checklists ?? []) });
    }
    const prefs = prefsResult;
    if (prefs) set({ prefs });
    const branding = brandingResult;
    if (branding) set({ branding });
  },
  selectNote: (id) => {
    // selecting an entity of a type implies browsing that section
    set({ selectedNoteId: id, selectedChecklistId: null, listMode: 'notes' });
  },
  selectChecklist: (id) => {
    set({ selectedChecklistId: id, selectedNoteId: null, listMode: 'checklists' });
  },
  selectCategory: (c) => {
    // a category click means browsing that section: switch lists + close open items
    set(c
      ? { selectedCategory: c, listMode: c.type, selectedNoteId: null, selectedChecklistId: null }
      : { selectedCategory: null });
  },
  setListMode: (m) => {
    // section header click = browse that section fresh: no filter, nothing open
    set({ listMode: m, selectedCategory: null, selectedNoteId: null, selectedChecklistId: null });
  },
  setPendingHighlight: (id) => {
    set({ pendingHighlightId: id });
  },
  clearPendingHighlight: () => {
    set({ pendingHighlightId: null });
  },
  createNote: async (title, category) => {
    const note = await api.createNote(title, category);
    await get().refreshAll();
    set({ selectedNoteId: note.id, selectedChecklistId: null, listMode: 'notes' });
    return note;
  },
  quickCapture: async (text: string) => {
    const note = await api.quickCapture(text);
    await get().refreshAll();
    return note;
  },
  createChecklist: async (title, category) => {
    const list = await api.createChecklist(title, category);
    await get().refreshAll();
    set({ selectedChecklistId: list.id, selectedNoteId: null, listMode: 'checklists' });
    return list;
  },
  createBoard: async (title, category) => {
    const board = await api.createBoard(title, category);
    await get().refreshAll();
    set({ selectedChecklistId: board.id, selectedNoteId: null, listMode: 'checklists' });
    return board;
  },
  deleteNote: async (id) => {
    await api.deleteNote(id);
    await get().refreshAll();
    // Deselect when the deleted note was open: clearing selection unmounts
    // NoteEditor (App renders null without a selection) and drops the back
    // button — same semantics as the back button's selectNote(null).
    if (get().selectedNoteId === id) set({ selectedNoteId: null });
  },
  deleteChecklist: async (id) => {
    await api.deleteChecklist(id);
    await get().refreshAll();
    if (get().selectedChecklistId === id) set({ selectedChecklistId: null });
  },
  saveVoiceNoteWithBoard: async (input) => {
    const boardTitle = input.title.trim() || 'Tasks from voice note';
    let noteId = input.noteSavedId ?? null;
    if (!noteId) {
      const note = input.noteId
        ? await api.updateNote(input.noteId, input.title, input.text, input.category)
        : await api.voiceSaveNote(input.recordingId as string, input.title, input.category, input.useTidied, input.text);
      noteId = note.id;
      // Sidebar/list freshness even if the board part fails below.
      await get().refreshAll();
    }
    try {
      let boardId: string;
      if (input.appointment) {
        // Voice → appointment (appointments Task 8): ONE card on the chosen
        // board, then the date, then the optional reminder. add_item returns
        // ItemDto (commands add_item → Result<ItemDto, String>), so the localId
        // chains directly from the return — no read-back needed.
        boardId = input.appointment.boardId;
        const item = await api.addItem(boardId, input.appointment.title, null, null);
        await api.setItemTargetDate(boardId, item.localId, input.appointment.targetDate);
        if (input.appointment.reminderDatetime) {
          await api.setItemReminder(boardId, item.localId, input.appointment.reminderDatetime);
        }
        // Open the board AFTER the adds so the freshly mounted view fetches them.
        get().selectChecklist(boardId);
        await get().refreshAll();
      } else if (input.targetBoardId) {
        // Existing board: cards land locally (offline-safe, outbox-replayed) — no live create needed.
        boardId = input.targetBoardId;
        for (const raw of input.tasks) {
          const text = raw.trim();
          if (text) await api.addItem(boardId, text, null, null);
        }
        // Open the target board AFTER the adds so the freshly mounted view fetches them.
        get().selectChecklist(boardId);
        await get().refreshAll();
      } else {
        const board = await get().createBoard(boardTitle, input.category); // refreshAll + selects the board
        boardId = board.id;
        for (const raw of input.tasks) {
          const text = raw.trim();
          if (text) await api.addItem(boardId, text, null, null);
        }
      }
      return { noteId: noteId as string, boardId };
    } catch (e) {
      throw Object.assign(new Error(String(e)), { boardStage: true, noteId });
    }
  },
}));
