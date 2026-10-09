export interface NoteDto {
  id: string; title: string; content: string; category: string;
  createdAt: string | null; updatedAt: string | null; deletedAt: string | null; dirty: boolean;
  audioPath: string | null; audioDurationSecs: number | null;
}
export interface ItemDto {
  localId: string; checklistId: string; parentLocalId: string | null;
  text: string; completed: boolean; position: number; dirty: boolean;
  status: string | null; priority: string | null; targetDate: string | null;
  // Appointments wire fields (ItemDto, commands/dto.rs): nullable like every
  // serde Option; optional in TS so pre-appointments mocks keep compiling.
  startDate?: string | null; serverItemId?: string | null;
  reminderDatetime?: string | null; reminderNotified?: boolean | null;
  // LOCAL-ONLY client-side recurrence (migration v5): raw JSON string
  // {rrule, dtstart, nextDue, ...}; never synced, never in outbox payloads.
  recurrence?: string | null;
  // P8 card details (ItemDto, commands/dto.rs): nullable like every serde
  // Option — description = long-form card text, estimatedTime = whole hours
  // (upstream truncates fractions server-side; never a float on the wire).
  description?: string | null;
  estimatedTime?: number | null;
  children: ItemDto[];
}
/** Appointments agenda row (Rust AgendaEntryDto, commands/dto.rs — serde
 * camelCase): one dated item across synced, non-deleted lists, pre-sorted by
 * targetDate. Field order mirrors the struct; required fields are the
 * non-Option ones. */
export interface AgendaEntry {
  checklistId: string; checklistTitle: string; itemLocalId: string;
  text: string; completed: boolean;
  startDate?: string | null; targetDate?: string | null;
  reminderDatetime?: string | null; reminderNotified?: boolean | null;
  status?: string | null; position: number;
}
export interface BoardStatusDto { id: string; label: string; color: string | null; order: number; autoComplete: boolean; }
export interface BoardDto { checklistId: string; statuses: BoardStatusDto[]; }
export interface ChecklistDto {
  id: string; title: string; category: string;
  createdAt: string | null; updatedAt: string | null; deletedAt: string | null;
  dirty: boolean; completed: boolean; listType: string; items: ItemDto[];
  // tier A task 3: list-checklist counts ride list_checklists (Rust
  // ChecklistDto item_count/done_count, serde camelCase). Optional so older
  // mocks keep compiling — a row without itemCount renders no meta line.
  itemCount?: number; doneCount?: number;
}
export interface Branding { name: string | null; iconDataUrl: string | null; themeColor: string | null; }
/** In-app theme choices: 'auto' follows the site mirror chain. */
export type ThemeOverride = 'auto' | 'dark' | 'light' | 'rwmarkable-dark';
export interface CategoryNode { name: string; path: string; count: number; level: number; }
export interface CategoriesDto { notes: CategoryNode[]; checklists: CategoryNode[]; }
export interface SearchResultsDto {
  notes: { id: string; title: string; snippet: string }[];
  checklists: { id: string; title: string; itemText: string }[];
}
export interface SyncStatusDto { pending: number; lastSyncAt: string | null; syncing: boolean; lastError: string | null; }
/** trigger_sync's report (Rust SyncReportDto, commands/dto.rs — serde
 * camelCase). NOT the "sync-updated" event payload: that serializes
 * sync::PullStats SNAKE_CASE (enrichment_errors/notes_applied/lists_applied/
 * tombstones) and is ignored by the UI today. enrichmentErrors is optional so
 * older mocks without it keep compiling. */
export interface SyncReport {
  pending: number; conflicts: number; lastSyncAt: string | null;
  enrichmentErrors?: number;
}
export interface ConflictDto { seq: number; entity: string; entityId: string; opType: string; lastError: string | null; label: string | null; }
export interface ConnectInfo { instanceUrl: string; version: string | null; }
export interface UpdateInfo { current: string; latest: string; available: boolean; downloadUrl: string | null; }
export interface UserPrefs {
  preferredTheme: string | null;          // system | light | dark | <custom id>
  defaultNoteFilter: string | null;       // all | recent | pinned
  defaultChecklistFilter: string | null;  // all | completed | incomplete | pinned | ...
  checklistItemClickAction: string | null; // toggle | edit
  hideConnectionIndicator: string | null; // enable | disable
  pinnedNotes: string[];
  pinnedLists: string[];
}
export interface VoiceRecordingDto {
  id: string; path: string; durationSecs: number;
  rawTranscript: string | null; tidiedTranscript: string | null;
  state: 'recording' | 'recorded' | 'transcribing' | 'transcribed' | 'transcription_failed' | 'transcription_failed_auth';
  lastError: string | null; createdAt: string;
}
export interface AiSettingsDto {
  baseUrl: string; model: string; languageHint: string; apiPathSuffix: string; hasKey: boolean;
}
/** One AI triage suggestion (Rust TriageSuggestionDto, commands/dto.rs — serde
 * camelCase; wire-key SET pinned by the dto.rs fence). Advisory-only: never
 * applied without the user's HITL action (Task 3). */
export interface TriageSuggestionDto {
  noteId: string; route: string;
  suggestedBoard: string | null; suggestedTitle: string | null;
  suggestedTags: string[]; confidence: number;
}
/** Triage settings (Rust TriageSettingsDto): the confidence gate as a fraction
 * 0..=1. The Rust kv stores TEXT; the DTO carries it parsed. */
export interface TriageSettings {
  confidenceThreshold: number;
}
/** Result of the on-demand transcription retry pass (Rust VoiceRetryStatsDto,
 * commands/dto.rs — serde camelCase): staging rows re-attempted / succeeded and
 * saved notes backfilled by this pass. */
export interface VoiceRetryStatsDto {
  stagingRetried: number; stagingSucceeded: number; notesFilled: number;
}
/** One LLM-extracted appointment draft (Rust AppointmentDraftDto,
 * commands/dto.rs — serde camelCase): all fields nullable; a null title means
 * "no appointment in the transcript" (the command returns null then). */
export interface AppointmentDraftDto {
  title: string | null; date: string | null; time: string | null;
}