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
  refreshAll: () => Promise<void>;
  selectNote: (id: string | null) => void;
  selectChecklist: (id: string | null) => void;
  selectCategory: (c: CategoryFilter | null) => void;
  createNote: (title: string, category: string) => Promise<T.NoteDto>;
  createChecklist: (title: string, category: string) => Promise<T.ChecklistDto>;
}

export interface CategoryFilter {
  type: 'notes' | 'checklists';
  path: string;
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
  refreshAll: async () => {
    const [connection, notes, checklists, categories, syncStatus] = await Promise.all([
      api.getConnection(), api.listNotes(), api.listChecklists(), api.listCategories(), api.syncStatus(),
    ]);
    set({ connection, notes, checklists, categories, syncStatus });
  },
  selectNote: (id) => {
    set({ selectedNoteId: id, selectedChecklistId: null });
  },
  selectChecklist: (id) => {
    set({ selectedChecklistId: id, selectedNoteId: null });
  },
  selectCategory: (c) => {
    set({ selectedCategory: c });
  },
  createNote: async (title, category) => {
    const note = await api.createNote(title, category);
    await get().refreshAll();
    set({ selectedNoteId: note.id, selectedChecklistId: null });
    return note;
  },
  createChecklist: async (title, category) => {
    const list = await api.createChecklist(title, category);
    await get().refreshAll();
    set({ selectedChecklistId: list.id, selectedNoteId: null });
    return list;
  },
}));
