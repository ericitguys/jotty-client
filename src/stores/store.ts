import { create } from 'zustand';
import * as api from '../api/client';
import type * as T from '../api/types';

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
  refreshAll: () => Promise<void>;
  selectNote: (id: string | null) => void;
  selectChecklist: (id: string | null) => void;
  selectCategory: (c: CategoryFilter | null) => void;
  setListMode: (m: ListMode) => void;
  createNote: (title: string, category: string) => Promise<T.NoteDto>;
  createChecklist: (title: string, category: string) => Promise<T.ChecklistDto>;
}

export interface CategoryFilter {
  type: 'notes' | 'checklists';
  path: string;
}

export type ListMode = 'notes' | 'checklists';

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
  refreshAll: async () => {
    const [connection, notes, checklists, categories, syncStatus] = await Promise.all([
      api.getConnection(), api.listNotes(), api.listChecklists(), api.listCategories(), api.syncStatus(),
    ]);
    set({ connection, notes, checklists, categories, syncStatus });
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
  createNote: async (title, category) => {
    const note = await api.createNote(title, category);
    await get().refreshAll();
    set({ selectedNoteId: note.id, selectedChecklistId: null, listMode: 'notes' });
    return note;
  },
  createChecklist: async (title, category) => {
    const list = await api.createChecklist(title, category);
    await get().refreshAll();
    set({ selectedChecklistId: list.id, selectedNoteId: null, listMode: 'checklists' });
    return list;
  },
}));
