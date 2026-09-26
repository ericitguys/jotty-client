import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor, Range } from '@tiptap/core';
import * as api from '../api/client';
import { useAutosave } from '../hooks/useAutosave';
import { useStore } from '../stores/store';
import { noteEditorExtensions } from '../editor/extensions';
import { convertHtmlToMarkdown, convertMarkdownToHtml } from '../editor/markdown';
import type { SlashCommandsStorage, SlashItem, TableModalStorage } from '../editor/slashCommands';
import EditorToolbar from './EditorToolbar';
import BubbleMenu from './BubbleMenu';
import PromptModal from './modals/PromptModal';
import TableInsertModal from './modals/TableInsertModal';
import SlashMenu from './SlashMenu';
import TableToolbar from './TableToolbar';
import MarkdownEditor from './MarkdownEditor';
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
  // Markdown mode (P2 task 3): isMarkdownMode swaps the visual TipTap surface
  // for the raw markdown editor; markdownDraft holds the raw text while in
  // markdown mode; mdPreview toggles the read-only preview in the toolbar.
  const [isMarkdownMode, setIsMarkdownMode] = useState(false);
  const [markdownDraft, setMarkdownDraft] = useState('');
  const [mdPreview, setMdPreview] = useState(false);
  // Storage contract (P2): update_note persists markdown. Editor updates
  // arrive pre-converted (onUpdate); title/category edits carry the last
  // stored value, which may still be legacy HTML as loaded — normalize here
  // so every save path persists markdown. Payload shape {id,title,content,category} unchanged.
  const autosave = useAutosave(async (v: { title: string; content: string; category: string }) => {
    if (!loadedId) return;
    const content = v.content.trim().startsWith('<') ? convertHtmlToMarkdown(v.content) : v.content;
    await api.updateNote(loadedId, v.title, content, v.category);
    await refreshAll();
  });

  useEffect(() => {
    setIsMarkdownMode(false); // note switch leaves markdown mode (stale-draft guard)
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

  // Storage contract (P2): TipTap is always fed HTML — legacy HTML notes
  // (startsWith '<') pass through untouched, markdown notes convert at load
  // (portal init semantics). autosave.value.content itself stays the RAW note
  // string as loaded; once saved it is markdown (onUpdate re-converts).
  const editorContent = useMemo(() => {
    const raw = autosave.value?.content ?? '';
    return raw.trim().startsWith('<') ? raw : convertMarkdownToHtml(raw);
  }, [autosave.value?.content]);

  const editor = useEditor({
    extensions: noteEditorExtensions(),
    content: editorContent,
    onUpdate: ({ editor }) => {
      if (!loadedId) return;
      autosave.setValue({ title: metaRef.current.title, content: convertHtmlToMarkdown(editor.getHTML()), category: metaRef.current.category });
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

  // Mode toggle (P2 task 3, portal toggleMode semantics): visual→markdown
  // snapshots the live document as markdown; markdown→visual loads the draft
  // converted to HTML with emitUpdate=false (installed TipTap 2.27.3
  // setContent is positional: (content, emitUpdate?, parseOptions?, options?)),
  // so the switch never fires onUpdate / autosave — the draft is already the
  // autosave content while in markdown mode.
  const toggleMarkdownMode = () => {
    if (!editor) return;
    if (!isMarkdownMode) {
      setMarkdownDraft(convertHtmlToMarkdown(editor.getHTML()));
      setIsMarkdownMode(true);
      return;
    }
    editor.commands.setContent(convertMarkdownToHtml(markdownDraft), false);
    setIsMarkdownMode(false);
  };

  // Link modal (P2 task 4, portal parity): both Link entry points (toolbar
  // button, bubble-menu pill) route through this state instead of the
  // browser's native prompt dialog. hasSelection is captured at open time
  // and decides between setLink (selection) and insert-anchor (R17: the
  // anchor wraps the URL itself — single-URL modal, no second text prompt).
  const [linkRequest, setLinkRequest] = useState<{ hasSelection: boolean } | null>(null);
  const openLinkRequest = () => {
    if (!editor) return;
    setLinkRequest({ hasSelection: !editor.state.selection.empty });
  };

  // Table insert modal (P2 task 5, R13): ONE modal for both entry points.
  // The toolbar button routes through React state (nothing to delete — the
  // table inserts at the caret); the slash /table item plants an editor-
  // storage flag that the transaction tick above re-renders and reads here
  // (a suggestion callback cannot render into React). range null =
  // toolbar-origin; a Range = slash-origin (delete the /query text first).
  const [tableModalViaToolbar, setTableModalViaToolbar] = useState(false);
  const tableModalFlag = editor
    ? ((editor.storage.tableModal ?? undefined) as TableModalStorage | undefined)
    : undefined;
  const tableModalRange = tableModalFlag?.open ? tableModalFlag.range ?? null : null;
  const isTableModalOpen = tableModalViaToolbar || tableModalRange !== null;

  const closeTableModal = () => {
    setTableModalViaToolbar(false);
    if (!editor || !tableModalFlag?.open) return;
    editor.storage.tableModal = { open: false, range: null };
    try {
      editor.view.dispatch(editor.state.tr.setMeta('tableModal', Date.now()));
    } catch { /* view tearing down: nothing left to notify */ }
  };

  const insertTableFromModal = (rows: number, cols: number, withHeaderRow: boolean) => {
    if (!editor) return;
    if (tableModalRange) {
      editor.chain().focus().deleteRange(tableModalRange).insertTable({ rows, cols, withHeaderRow }).run();
    } else {
      editor.chain().focus().insertTable({ rows, cols, withHeaderRow }).run();
    }
  };

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
      <EditorToolbar
        editor={editor}
        markdownMode={isMarkdownMode}
        onToggleMode={toggleMarkdownMode}
        preview={mdPreview}
        onTogglePreview={() => setMdPreview((p) => !p)}
        onLinkRequest={openLinkRequest}
        onTableInsertRequest={() => setTableModalViaToolbar(true)}
      />
      {/* Markdown mode (P2 task 3): the TipTap host stays mounted (the editor
          instance must stay alive) and is hidden via the `hidden` attribute;
          the raw markdown editor replaces it visually. Edits persist through
          the SAME autosave.setValue path — the Task-2 save boundary
          normalization already passes non-HTML content through verbatim. */}
      <div hidden={isMarkdownMode}>
        <EditorContent editor={editor} />
      </div>
      {isMarkdownMode && (
        <MarkdownEditor
          value={markdownDraft}
          onChange={(md) => {
            setMarkdownDraft(md);
            autosave.setValue({ title: metaRef.current.title, content: md, category: metaRef.current.category });
          }}
          editor={editor}
          preview={mdPreview}
        />
      )}
      {editor && !isMarkdownMode && (
        <BubbleMenu
          editor={editor}
          visible={bubbleVisible}
          onClose={() => setBubbleVisible(false)}
          onLinkRequest={openLinkRequest}
        />
      )}
      {editor && !isMarkdownMode && <TableToolbar editor={editor} visible={tableVisible} />}
      {!isMarkdownMode && slashMenu}
      {/* Link modal (P2 task 4): the single prompt surface for both Link
          buttons. P1 link logic verbatim, with R17 replacing the second
          text prompt: empty value → unsetLink; non-empty selection →
          setLink(href); no selection → insert an anchor wrapping the URL. */}
      <PromptModal
        isOpen={!!linkRequest}
        onClose={() => setLinkRequest(null)}
        title="Link URL"
        placeholder="https://example.com"
        defaultValue={editor?.getAttributes('link').href ?? ''}
        onConfirm={(url) => {
          if (!editor || !linkRequest) return;
          if (url === '') { editor.chain().focus().unsetLink().run(); return; }
          if (linkRequest.hasSelection) { editor.chain().focus().setLink({ href: url }).run(); return; }
          editor.chain().focus().insertContent(`<a href="${url}">${url}</a>`).run();
        }}
      />
      {/* Table insert modal (P2 task 5, R13): the ONE insert surface for both
          entry points — the toolbar's Table button (React state; inserts at
          the caret) and the slash /table item (storage flag; deletes the
          /query range first). P1's fixed 3x3 toolbar insert and the slash
          item's native prompt body are both gone. */}
      <TableInsertModal
        isOpen={isTableModalOpen}
        onClose={closeTableModal}
        onInsert={insertTableFromModal}
      />
      <div className="editor-foot">
        {autosave.saving && <span id="saving">saving…</span>}
        <button className="cl-save" onClick={() => autosave.flush()}>Save</button>
      </div>
    </div>
  );
}
