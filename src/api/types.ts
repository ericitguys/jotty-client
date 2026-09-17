export interface NoteDto {
  id: string; title: string; content: string; category: string;
  createdAt: string | null; updatedAt: string | null; deletedAt: string | null; dirty: boolean;
}
export interface ItemDto {
  localId: string; checklistId: string; parentLocalId: string | null;
  text: string; completed: boolean; position: number; dirty: boolean;
  children: ItemDto[];
}
export interface ChecklistDto {
  id: string; title: string; category: string;
  createdAt: string | null; updatedAt: string | null; deletedAt: string | null;
  dirty: boolean; items: ItemDto[];
}
export interface CategoryNode { name: string; path: string; count: number; level: number; }
export interface CategoriesDto { notes: CategoryNode[]; checklists: CategoryNode[]; }
export interface SearchResultsDto {
  notes: { id: string; title: string; snippet: string }[];
  checklists: { id: string; title: string; itemText: string; snippet: string }[];
}
export interface SyncStatusDto { pending: number; lastSyncAt: string | null; syncing: boolean; }
export interface ConflictDto { seq: number; entity: string; entityId: string; opType: string; lastError: string | null; label: string | null; }
export interface ConnectInfo { instanceUrl: string; version: string | null; }