import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor, Range } from '@tiptap/core';
import * as api from '../api/client';
import { useAutosave } from '../hooks/useAutosave';
import { useStore } from '../stores/store';
import { noteEditorExtensions } from '../editor/extensions';
import type { SlashCommandsStorage, SlashItem } from '../editor/slashCommands';
import EditorToolbar from './EditorToolbar';
import BubbleMenu from './BubbleMenu';
import SlashMenu from './SlashMenu';
import TableToolbar from './TableToolbar';
import type { NoteDto } from '../api/types';

// Place the slash popup just below the `/` block start, clamped-free fixed
// positioning (same coordsAtPos pattern as BubbleMenu — jsdom/headless views
// fall back to the default corner placement; exact placement is ship-time QA).
function slashCoords(editor: Editor, range: Range): { top: number; left: number } {
  try {
    const c = editor.view.coordsAtPos(range.from);
    const top = c.bottom + 4;
    if (Number.isFinite(top) && Number.isFinite(c.left)) return { top, left: c.left };
  } catch { /* fall through to the default placement */ }
  return { top: 0, left: 0 };
}

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
    extensions: noteEditorExtensions(),
    content: autosave.value?.content ?? '',
    onUpdate: ({ editor }) => {
      if (!loadedId) return;
      autosave.setValue({ title: metaRef.current.title, content: editor.getHTML(), category: metaRef.current.category });
    },
  }, [loadedId]);

  // Editor-transaction tick (v0.15.4 pattern): re-render NoteEditor on every
  // editor transaction. The code-language picker moved into the toolbar (portal
  // parity P1) and owns its own tick there; this one keeps editor-driven state
  // in NoteEditor's render current (e.g. autosave saving flag, future UI).
  const [, setEditorTick] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const onTx = () => setEditorTick((t) => t + 1);
    editor.on('transaction', onTx);
    return () => { editor.off('transaction', onTx); };
  }, [editor]);

  // Selection bubble menu (portal parity P1): visible while a non-empty text
  // selection exists outside a code block; hidden on Escape, an empty
  // selection, or after a bubble button applies (onClose).
  const [bubbleVisible, setBubbleVisible] = useState(false);
  useEffect(() => {
    if (!editor) return;
    const sync = () => setBubbleVisible(!editor.state.selection.empty && !editor.isActive('codeBlock'));
    sync(); // initial check
    editor.on('selectionUpdate', sync);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setBubbleVisible(false); };
    editor.view.dom.addEventListener('keydown', onKey);
    return () => {
      editor.off('selectionUpdate', sync);
      editor.view.dom.removeEventListener('keydown', onKey);
    };
  }, [editor]);

  // Table context toolbar (portal parity P1): visible while the selection sits
  // inside a table. Synced on transaction + selectionUpdate like the bubble
  // menu; deleteTable closes it (isActive('table') flips) while row/col edits
  // keep it open because the caret stays in the table.
  const [tableVisible, setTableVisible] = useState(false);
  useEffect(() => {
    if (!editor) return;
    const sync = () => setTableVisible(editor.isActive('table'));
    sync(); // initial check
    editor.on('transaction', sync);
    editor.on('selectionUpdate', sync);
    return () => {
      editor.off('transaction', sync);
      editor.off('selectionUpdate', sync);
    };
  }, [editor]);

  // Slash-commands popup (portal parity P1): the SlashCommands extension
  // mirrors its live suggestion state into editor storage and pings a meta
  // transaction; the transaction tick above re-renders this component, which
  // re-reads the storage to mount/unmount <SlashMenu>. Escape and applying
  // an item both deactivate the suggestion, so the same tick unmounts it.
  const slash = editor ? (editor.storage.slashCommands as SlashCommandsStorage | undefined) : undefined;
  const slashOpen = !!slash?.open && !!slash.range && slash.items.length > 0;
  const slashRange = slashOpen && slash?.range ? slash.range : null;
  const slashMenu = (() => {
    if (!editor || !slashRange) return null;
    const range = slashRange;
    const items = slash?.items ?? [];
    const { top, left } = slashCoords(editor, range);
    return (
      <SlashMenu
        items={items}
        top={top}
        left={left}
        onPick={(picked: SlashItem) => picked.command({ editor, range })}
      />
    );
  })();

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
      <EditorToolbar editor={editor} />
      <EditorContent editor={editor} />
      {editor && (
        <BubbleMenu
          editor={editor}
          visible={bubbleVisible}
          onClose={() => setBubbleVisible(false)}
        />
      )}
      {editor && <TableToolbar editor={editor} visible={tableVisible} />}
      {slashMenu}
      <div className="editor-foot">
        {autosave.saving && <span id="saving">saving…</span>}
        <button className="cl-save" onClick={() => autosave.flush()}>Save</button>
      </div>
    </div>
  );
}
