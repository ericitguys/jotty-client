export interface NoteDto {
  id: string; title: string; content: string; category: string;
  createdAt: string | null; updatedAt: string | null; deletedAt: string | null; dirty: boolean;
  audioPath: string | null; audioDurationSecs: number | null;
}
export interface ItemDto {
  localId: string; checklistId: string; parentLocalId: string | null;
  text: string; completed: boolean; position: number; dirty: boolean;
  children: ItemDto[];
}
export interface ChecklistDto {
  id: string; title: string; category: string;
  createdAt: string | null; updatedAt: string | null; deletedAt: string | null;
  dirty: boolean; completed: boolean; listType: string; items: ItemDto[];
}
export interface Branding { name: string | null; iconDataUrl: string | null; }
export interface CategoryNode { name: string; path: string; count: number; level: number; }
export interface CategoriesDto { notes: CategoryNode[]; checklists: CategoryNode[]; }
export interface SearchResultsDto {
  notes: { id: string; title: string; snippet: string }[];
  checklists: { id: string; title: string; itemText: string }[];
}
export interface SyncStatusDto { pending: number; lastSyncAt: string | null; syncing: boolean; lastError: string | null; }
export interface ConflictDto { seq: number; entity: string; entityId: string; opType: string; lastError: string | null; label: string | null; }
export interface ConnectInfo { instanceUrl: string; version: string | null; }
export interface UpdateInfo { current: string; latest: string; available: boolean; rpmUrl: string | null; }
export interface UserPrefs {
  preferredTheme: string | null;          // system | light | dark | <custom id>
  defaultNoteFilter: string | null;       // all | recent | pinned
  defaultChecklistFilter: string | null;  // all | completed | incomplete | pinned | ...
  checklistItemClickAction: string | null; // toggle | edit
  hideConnectionIndicator: string | null; // enable | disable
  pinnedNotes: string[];
  pinnedLists: string[];
}