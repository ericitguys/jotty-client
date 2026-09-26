import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor, Range } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import * as api from '../api/client';
import { useAutosave } from '../hooks/useAutosave';
import { useStore } from '../stores/store';
import { noteEditorExtensions } from '../editor/extensions';
import { applyImageSize } from '../editor/imageResize';
import { convertHtmlToMarkdown, convertMarkdownToHtml } from '../editor/markdown';
import type { FileModalStorage, ImageModalStorage, SlashCommandsStorage, SlashItem, TableModalStorage } from '../editor/slashCommands';
import { sniffFileAttachment } from '../editor/extensions/rich-blocks';
import EditorToolbar from './EditorToolbar';
import BubbleMenu from './BubbleMenu';
import PromptModal from './modals/PromptModal';
import TableInsertModal from './modals/TableInsertModal';
import ImageSizeModal from './ImageSizeModal';
import ImageResizeOverlay from './ImageResizeOverlay';
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

  // Image insert flow (P3 task 4, R23): ONE modal chain for the entry points
  // — the slash /image item plants an editor-storage flag that the
  // transaction tick re-renders and reads here (a suggestion callback cannot
  // render into React — the /table pattern), and the Extra-dropdown button
  // lands with T6 through the same state. Stage 1 = PromptModal ("Add
  // Image") collects the URL; stage 2 = ImageSizeModal (live preview) sizes
  // it; Apply deletes the /query range (slash origin) and insertImage's.
  // Cancel/Escape/backdrop at any stage inserts nothing.
  const [imageSizing, setImageSizing] = useState<{ src: string; range: Range | null } | null>(null);
  const imageModalFlag = editor
    ? ((editor.storage.imageModal ?? undefined) as ImageModalStorage | undefined)
    : undefined;
  const isImagePromptOpen = !!imageModalFlag?.open;

  const clearImageFlag = () => {
    if (!editor || !imageModalFlag?.open) return;
    editor.storage.imageModal = { open: false, range: null };
    try {
      editor.view.dispatch(editor.state.tr.setMeta('imageModal', Date.now()));
    } catch { /* view tearing down: nothing left to notify */ }
  };

  const confirmImageUrl = (url: string) => {
    const range = imageModalFlag?.range ?? null;
    clearImageFlag();
    if (!url) return;
    setImageSizing({ src: url, range });
  };

  const insertImageFromModal = (width: number | null, height: number | null) => {
    if (!editor || !imageSizing) return;
    const options: { src: string; width?: number; height?: number } = { src: imageSizing.src };
    if (width != null && width > 0) options.width = width;
    if (height != null && height > 0) options.height = height;
    if (imageSizing.range) {
      editor.chain().focus().deleteRange(imageSizing.range).insertImage(options).run();
    } else {
      editor.chain().focus().insertImage(options).run();
    }
  };

  // File-attachment insert flow (P3 task 5, R18): URL-ONLY insert surface —
  // no FileModal/upload exists (the server has no REST upload endpoint), so
  // the single stage is this PromptModal ("Attachment URL"). The /file slash
  // item (T6) plants the editor-storage flag that the transaction tick
  // re-renders and reads here (the /table //image pattern; T6's Extra-
  // dropdown File button goes through the same flag). Confirm sniffs the
  // attachment type from the URL (portal /api/ prefixes, then extension)
  // and inserts the fileAttachment node; Cancel/Escape/backdrop inserts
  // nothing.
  const fileModalFlag = editor
    ? ((editor.storage.fileModal ?? undefined) as FileModalStorage | undefined)
    : undefined;
  const isFilePromptOpen = !!fileModalFlag?.open;

  const clearFileFlag = () => {
    if (!editor || !fileModalFlag?.open) return;
    editor.storage.fileModal = { open: false, range: null };
    try {
      editor.view.dispatch(editor.state.tr.setMeta('fileModal', Date.now()));
    } catch { /* view tearing down: nothing left to notify */ }
  };

  const confirmFileUrl = (url: string) => {
    const range = fileModalFlag?.range ?? null;
    clearFileFlag();
    if (!editor || !url) return;
    const sniffed = sniffFileAttachment(url);
    if (range) {
      editor.chain().focus().deleteRange(range).setFileAttachment(sniffed).run();
    } else {
      editor.chain().focus().setFileAttachment(sniffed).run();
    }
  };

  // Selection-driven resize overlay (P3 task 4 — the portal useImageResize
  // hook collapses into this transaction-tick read): mounted while a
  // NodeSelection sits on an image node; px dims come off the node's attrs
  // (parsed from the style attr at parse time); Apply dispatches
  // setNodeMarkup (applyImageSize) and parks the caret after the image so
  // the selection leaves the node (portal's closeOverlay). Drag geometry is
  // ship-time QA — jsdom has no rects (coordsAtPos falls back to the default
  // corner, like slashCoords above).
  const selectedImage = (() => {
    if (!editor || isMarkdownMode) return null;
    const sel = editor.state.selection;
    if (!(sel instanceof NodeSelection)) return null;
    if (sel.node.type.name !== 'image') return null;
    let top = 0;
    let left = 0;
    try {
      const c = editor.view.coordsAtPos(sel.from);
      top = c.bottom + 8;
      left = c.left;
    } catch { /* headless/jsdom: default corner */ }
    return {
      pos: sel.from,
      src: (sel.node.attrs.src as string) ?? '',
      width: sel.node.attrs.width as number | null,
      height: sel.node.attrs.height as number | null,
      top,
      left,
    };
  })();

  const closeImageOverlay = () => {
    if (!editor || !selectedImage) return;
    try {
      editor.commands.setTextSelection(Math.min(selectedImage.pos + 1, editor.state.doc.content.size));
    } catch { /* headless/jsdom */ }
  };

  const applyImageSizeFromOverlay = (width: number | null, height: number | null) => {
    if (!editor || !selectedImage) return;
    if (applyImageSize(editor, selectedImage.src, width, height)) {
      closeImageOverlay();
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
      {/* Selection-driven resize overlay (P3 task 4, useImageResize port):
          mounted while a NodeSelection sits on an image node; Apply
          dispatches the setNodeMarkup resize and parks the caret after the
          image. Position falls back to the default corner headless. */}
      {editor && !isMarkdownMode && selectedImage && (
        <ImageResizeOverlay
          visible
          src={selectedImage.src}
          currentWidth={selectedImage.width}
          currentHeight={selectedImage.height}
          top={selectedImage.top}
          left={selectedImage.left}
          onApply={applyImageSizeFromOverlay}
          onClose={closeImageOverlay}
        />
      )}
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
      {/* Image insert flow (P3 task 4, R23): stage 1 = PromptModal ("Add
          Image" / "Enter image URL") — the single URL surface for the /image
          slash item (the Extra-dropdown button lands with T6 through the same
          state); stage 2 = ImageSizeModal with the live preview — Apply
          deletes the /query range and insertImage's; Cancel/Escape/backdrop
          at any stage inserts nothing. */}
      <PromptModal
        isOpen={isImagePromptOpen}
        onClose={clearImageFlag}
        onConfirm={confirmImageUrl}
        title="Add Image"
        message="Enter image URL"
        placeholder="https://example.com/image.jpg"
      />
      <ImageSizeModal
        isOpen={!!imageSizing}
        onClose={() => setImageSizing(null)}
        onConfirm={insertImageFromModal}
        imageUrl={imageSizing?.src}
      />
      {/* File-attachment insert flow (P3 task 5, R18): URL-ONLY — the single
          "Attachment URL" PromptModal; the /file slash item and the
          Extra-dropdown File button (T6) plant the fileModal flag this modal
          reads. Confirm sniffs the type from the URL and setFileAttachment's;
          Cancel/Escape/backdrop inserts nothing. */}
      <PromptModal
        isOpen={isFilePromptOpen}
        onClose={clearFileFlag}
        onConfirm={confirmFileUrl}
        title="Attachment URL"
        message="Enter file URL"
        placeholder="https://example.com/file.pdf"
      />
      <div className="editor-foot">
        {autosave.saving && <span id="saving">saving…</span>}
        <button className="cl-save" onClick={() => autosave.flush()}>Save</button>
      </div>
    </div>
  );
}
