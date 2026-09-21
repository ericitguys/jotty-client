import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import type * as T from './types';

export const getConnection = () => invoke<T.ConnectInfo | null>('get_connection');
export const listNotes = () => invoke<T.NoteDto[]>('list_notes');
export const getNote = (id: string) => invoke<T.NoteDto>('get_note', { id });
export const createNote = (title: string, category: string) => invoke<T.NoteDto>('create_note', { title, category });
export const updateNote = (id: string, title: string, content: string, category: string) => invoke<T.NoteDto>('update_note', { id, title, content, category });
export const deleteNote = (id: string) => invoke<void>('delete_note', { id });
export const listChecklists = () => invoke<T.ChecklistDto[]>('list_checklists');
export const getChecklist = (id: string) => invoke<T.ChecklistDto>('get_checklist', { id });
export const createChecklist = (title: string, category: string) => invoke<T.ChecklistDto>('create_checklist', { title, category });
export const updateChecklist = (id: string, title: string, category: string) => invoke<T.ChecklistDto>('update_checklist', { id, title, category });
export const deleteChecklist = (id: string) => invoke<void>('delete_checklist', { id });
export const addItem = (checklistId: string, text: string, parentLocalId: string | null, status: string | null) => invoke<T.ItemDto>('add_item', { checklistId, text, parentLocalId, status });
export const setItemText = (checklistId: string, itemLocalId: string, text: string) => invoke<void>('set_item_text', { checklistId, itemLocalId, text });
export const setItemChecked = (checklistId: string, itemLocalId: string, checked: boolean) => invoke<void>('set_item_checked', { checklistId, itemLocalId, checked });
export const setItemStatus = (checklistId: string, itemLocalId: string, status: string) => invoke<void>('set_item_status', { checklistId, itemLocalId, status });
export const getBoardColumns = (checklistId: string) => invoke<T.BoardDto>('get_board_columns', { checklistId });
export const fetchTaskBoard = (checklistId: string) => invoke<T.BoardDto>('fetch_task_board', { checklistId });
export const createBoard = (title: string, category: string) => invoke<T.ChecklistDto>('create_task_board', { title, category });
export const deleteItem = (checklistId: string, itemLocalId: string) => invoke<void>('delete_item', { checklistId, itemLocalId });
export const reorderItems = (checklistId: string, orderedTopLevelIds: string[]) => invoke<void>('reorder_items', { checklistId, orderedTopLevelIds });
export const listCategories = () => invoke<T.CategoriesDto>('list_categories');
export const search = (query: string) => invoke<T.SearchResultsDto>('search', { query });
export const triggerSync = () => invoke<unknown>('trigger_sync');
export const syncStatus = () => invoke<T.SyncStatusDto>('sync_status');
export const listConflicts = () => invoke<T.ConflictDto[]>('list_conflicts');
export const resolveConflict = (seq: number, keep: 'mine' | 'server') => invoke<void>('resolve_conflict', { seq, keep });
export const connectInstance = (url: string, apiKey: string) => invoke<T.ConnectInfo>('connect_instance', { url, apiKey });
export const disconnectInstance = () => invoke<void>('disconnect_instance');
export const getSettings = () => invoke<{ instanceUrl: string | null; syncIntervalMinutes: number }>('get_settings');
export const setSyncInterval = (minutes: number) => invoke<void>('set_sync_interval', { minutes });
export const checkUpdate = () => invoke<T.UpdateInfo>('check_update');
export const downloadUpdate = (url: string) => invoke<string>('download_update', { url });
export const installUpdate = (path: string) => invoke<void>('install_update', { path });
// Android guided update: hand the APK URL to the system browser/Download
// Manager; the user installs via the system prompt (no silent self-install).
export const openUpdateUrl = (url: string) => invoke<void>('open_update_url', { url });
export const restartApp = () => invoke<void>('restart_app');
export const getPrefs = () => invoke<T.UserPrefs>('get_prefs');
export const getBranding = () => invoke<T.Branding>('get_branding');
export const voiceStartRecording = () => invoke<T.VoiceRecordingDto>('voice_start_recording');
export const voiceStopRecording = () => invoke<T.VoiceRecordingDto>('voice_stop_recording');
export const voiceTranscribe = (recordingId: string) => invoke<T.VoiceRecordingDto>('voice_transcribe', { recordingId });
export const voiceTidy = (recordingId: string | null, raw: string) => invoke<{ tidied: string }>('voice_tidy', { recordingId, raw });
export const voiceDeleteRecording = (recordingId: string) => invoke<void>('voice_delete_recording', { recordingId });
export const voiceSaveNote = (recordingId: string, title: string, category: string, useTidied: boolean, contentOverride: string | null) =>
  invoke<T.NoteDto>('voice_save_note', { recordingId, title, category, useTidied, contentOverride });
export const voiceListUnsaved = () => invoke<T.VoiceRecordingDto[]>('voice_list_unsaved');
export const voiceTranscribeNote = (noteId: string) => invoke<{ text: string }>('voice_transcribe_note', { noteId });
export const voiceDeleteNoteAudio = (noteId: string) => invoke<T.NoteDto>('voice_delete_note_audio', { noteId });
export const aiGetModels = () => invoke<string[]>('ai_get_models');
export const getAiSettings = () => invoke<T.AiSettingsDto>('get_ai_settings');
export const setAiSettings = (baseUrl: string | null, model: string | null, languageHint: string | null, apiKey: string | null) =>
  invoke<T.AiSettingsDto>('set_ai_settings', { baseUrl, model, languageHint, apiKey });
// Tauri asset-protocol URL for a local audio file; the try/catch keeps jsdom
// tests honest (no __TAURI_INTERNALS__ there) — audioSrc falls back to the
// raw path, which component tests assert on.
export const audioSrc = (path: string): string => {
  try { return convertFileSrc(path); } catch { return path; }
};

// Microphone permission (Android runtime prompt): the Rust recorder (cpal/
// AAudio) cannot request RECORD_AUDIO itself, but wry's WebChromeClient maps a
// webview AUDIO_CAPTURE request onto the native RECORD_AUDIO +
// MODIFY_AUDIO_SETTINGS dialog. So: a one-shot getUserMedia({audio:true}) fires
// the system prompt (first run) and resolves once granted; tracks are stopped
// immediately — nothing is captured here, this only unlocks the permission.
// Desktop (Linux) ignores this: no getUserMedia prompt, resolves instantly.
export const ensureMicPermission = async (): Promise<void> => {
  const md = navigator.mediaDevices as MediaDevices | undefined;
  if (!md?.getUserMedia) return; // no mediaDevices (old webview / jsdom default): let the recorder surface any error
  let stream: MediaStream | null = null;
  try {
    stream = await md.getUserMedia({ audio: true });
  } catch (e) {
    const name = (e as { name?: string })?.name ?? '';
    throw new Error(
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Microphone access denied — allow mic permission for jotty in Android settings, then retry.'
        : `Microphone unavailable: ${String(e)}`,
    );
  }
  for (const t of stream.getTracks()) t.stop();
};
