import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import * as api from '../api/client';
import { useAutosave } from '../hooks/useAutosave';
import { useStore } from '../stores/store';
import type { NoteDto } from '../api/types';

export default function NoteEditor({ noteId, onRetranscribe }: { noteId: string; onRetranscribe?: (noteId: string) => void }) {
  const refreshAll = useStore((s) => s.refreshAll);
  const [category, setCategory] = useState<string>('Uncategorized');
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [audioDur, setAudioDur] = useState<number | null>(null);
  const autosave = useAutosave(async (v: { title: string; content: string; category: string }) => {
    if (!loadedId) return;
    await api.updateNote(loadedId, v.title, v.content, v.category);
    await refreshAll();
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const note: NoteDto | null = await api.getNote(noteId);
      if (cancelled || !note) return; // missing note: leave the editor inert
      setLoadedId(note.id);
      setCategory(note.category);
      setAudioPath(note.audioPath);
      setAudioDur(note.audioDurationSecs);
      autosave.reset({ title: note.title, content: note.content, category: note.category });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  const fmtDuration = (s: number | null): string => {
    if (s == null) return '';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };

  const deleteAudio = async () => {
    if (!loadedId) return;
    try {
      const updated = await api.voiceDeleteNoteAudio(loadedId);
      setAudioPath(updated.audioPath);
      setAudioDur(updated.audioDurationSecs);
      await refreshAll();
    } catch { /* surfaced by the store on next refresh */ }
  };

  const metaRef = useRef({ title: '', category: 'Uncategorized' });
  metaRef.current = { title: autosave.value?.title ?? '', category };

  const editor = useEditor({
    extensions: [StarterKit, Link],
    content: autosave.value?.content ?? '',
    onUpdate: ({ editor }) => {
      if (!loadedId) return;
      autosave.setValue({ title: metaRef.current.title, content: editor.getHTML(), category: metaRef.current.category });
    },
  }, [loadedId]);

  return (
    <div id="note-editor">
      <input
        id="note-title"
        value={autosave.value?.title ?? ''}
        onChange={(e) => autosave.setValue({ title: e.target.value, content: autosave.value?.content ?? '', category })}
        placeholder="Note title"
      />
      <input
        id="note-category"
        value={category}
        onChange={(e) => {
          const c = e.target.value;
          setCategory(c);
          autosave.setValue({ title: autosave.value?.title ?? '', content: autosave.value?.content ?? '', category: c });
        }}
        placeholder="Category"
      />
      {audioPath && (
        <div className="voice-panel">
          <audio controls src={api.audioSrc(audioPath)} />
          <span className="voice-duration">{fmtDuration(audioDur)}</span>
          <button className="voice-retranscribe" onClick={() => loadedId && onRetranscribe?.(loadedId)}>Re-transcribe</button>
          <button className="voice-delete-audio" onClick={deleteAudio}>Delete audio</button>
        </div>
      )}
      <EditorContent editor={editor} />
      <div className="editor-foot">
        {autosave.saving && <span id="saving">saving…</span>}
        <button className="cl-save" onClick={() => autosave.flush()}>Save</button>
      </div>
    </div>
  );
}
