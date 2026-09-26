import { Extension } from '@tiptap/core';
import type { Editor, Range } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { DEFAULT_MERMAID } from './extensions/diagrams';

// Context handed to a slash item's command: the editor plus the range
// covering the `/query` text the suggestion plugin matched. Every item
// deletes that range first, then runs its command on the now-current block.
export interface SlashCommandContext {
  editor: Editor;
  range: Range;
}

// One slash-menu entry. The set mirrors the portal SlashCommands.tsx items —
// the 8 canonical P1 titles, /image (T4, R23), and the P3 task 6 completers
// (file / collapsible / callout / mermaid / draw.io / excalidraw) with the
// portal labels.
export interface SlashItem {
  id: string;
  title: string;
  hint: string;
  command: (ctx: SlashCommandContext) => void;
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'heading-1',
    title: 'Heading 1',
    hint: 'Big section title',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(),
  },
  {
    id: 'heading-2',
    title: 'Heading 2',
    hint: 'Medium section title',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(),
  },
  {
    id: 'bullet-list',
    title: 'Bullet list',
    hint: 'Simple bulleted list',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: 'ordered-list',
    title: 'Ordered list',
    hint: 'Numbered list',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    id: 'task-list',
    title: 'Task list',
    hint: 'Checklist with checkboxes',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    id: 'code-block',
    title: 'Code block',
    hint: 'Fenced code with syntax highlighting',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setCodeBlock({ language: 'plaintext' }).run(),
  },
  {
    id: 'quote',
    title: 'Quote',
    hint: 'Blockquote',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    id: 'table',
    title: 'Table',
    hint: 'Rows × columns grid',
    command: ({ editor, range }) => {
      // P2 task 5 (R13/R14): the /table item opens the shared TableInsertModal
      // instead of prompting. The suggestion plugin cannot render into React,
      // so the command plants a storage flag carrying the /query range (the
      // modal's onInsert deletes it before insertTable; nothing is inserted
      // here) and pings the React layer with a meta transaction — the same
      // dispatch safety argument as the sync() ping above: a command body
      // runs outside any view update, so this dispatch cannot re-enter one.
      editor.storage.tableModal = { open: true, range };
      try {
        if (!editor.isDestroyed) {
          editor.view.dispatch(editor.state.tr.setMeta('tableModal', Date.now()));
        }
      } catch { /* view tearing down: nothing left to notify */ }
    },
  },
  {
    id: 'image',
    title: 'Image',
    hint: 'Insert an image',
    command: ({ editor, range }) => {
      // P3 task 4 (R23): the /image item opens the shared insert flow instead
      // of prompting — PromptModal ("Add Image") → ImageSizeModal. Same
      // storage-flag + meta-tick pattern as the /table item above (the
      // suggestion plugin cannot render into React; the range rides along
      // and the Apply step deletes it before insertImage).
      editor.storage.imageModal = { open: true, range };
      try {
        if (!editor.isDestroyed) {
          editor.view.dispatch(editor.state.tr.setMeta('imageModal', Date.now()));
        }
      } catch { /* view tearing down: nothing left to notify */ }
    },
  },
  {
    id: 'file',
    title: 'File',
    hint: 'Insert a file attachment',
    command: ({ editor, range }) => {
      // P3 task 6 (R18/R23): the /file item plants the FileModalStorage
      // flag — the exact /table + /image mirror-and-tick pattern;
      // NoteEditor's confirm deletes the /query range before
      // setFileAttachment (no native prompt: the URL arrives through the
      // "Attachment URL" PromptModal — the button-origin Extra-dropdown
      // File item plants range: null the same way).
      editor.storage.fileModal = { open: true, range };
      try {
        if (!editor.isDestroyed) {
          editor.view.dispatch(editor.state.tr.setMeta('fileModal', Date.now()));
        }
      } catch { /* view tearing down: nothing left to notify */ }
    },
  },
  {
    id: 'collapsible',
    title: 'Collapsible',
    hint: 'Create a collapsible section',
    command: ({ editor, range }) => {
      // Portal SlashCommands.tsx:136-150: read the live selection (the
      // summary candidate) BEFORE the /query range is deleted. Portal runs
      // deleteRange + toggleWrap in ONE chain; desktop splits them into two
      // dispatches — inside one composed transaction the wrap steps are
      // computed against the pre-delete geometry and map back through the
      // deleted range to an EMPTY block range (probed: the wrap silently
      // no-ops), while the separate dispatch sees the post-delete doc.
      // The observable contract is unchanged: /query deleted, then wrapped.
      const { from, to, empty } = editor.state.selection;
      const selectedText = editor.state.doc.textBetween(from, to, ' ');
      editor.chain().focus().deleteRange(range).run();
      editor
        .chain()
        .focus()
        .toggleWrap('details', !empty ? { summary: selectedText } : undefined)
        .run();
    },
  },
  {
    id: 'callout',
    title: 'Callout',
    hint: 'Create a callout block',
    // Portal :151-158 — the info type; the type change lives in the
    // callout's own icon menu (Info/Warning/Success/Danger), not at
    // insert time.
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setCallout('info').run(),
  },
  {
    id: 'mermaid-diagram',
    title: 'Mermaid Diagram',
    hint: 'Create a Mermaid diagram',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setMermaid(DEFAULT_MERMAID).run(),
  },
  {
    id: 'drawio-diagram',
    title: 'Draw.io Diagram',
    hint: 'Create a visual diagram',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).insertDrawIo().run(),
  },
  {
    id: 'excalidraw-diagram',
    title: 'Excalidraw Diagram',
    hint: 'Create an Excalidraw diagram',
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).insertExcalidraw().run(),
  },
];

// Case-insensitive substring filter on the item title.
export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((item) => item.title.toLowerCase().includes(q));
}

export interface SlashCommandsOptions {
  char: string;
  startOfLine: boolean;
}

// Live suggestion state mirrored into editor storage for the React layer:
// NoteEditor ticks on every transaction and re-reads this to mount/unmount
// the SlashMenu popup (the plugin's own callbacks cannot render into React).
export interface SlashCommandsStorage {
  open: boolean;
  query: string;
  range: Range | null;
  items: SlashItem[];
}

// Table-insert modal request (P2 task 5, R13): the slash /table item no
// longer prompts — its command plants this flag under editor.storage.tableModal
// (carrying the /query range that onInsert deletes before insertTable) and
// pings a meta transaction; NoteEditor's transaction tick re-renders, re-reads
// it and mounts <TableInsertModal> (the suggestion plugin cannot render into
// React — the same mirror-and-tick pattern the slash popup itself uses).
export interface TableModalStorage {
  open: boolean;
  range: Range | null;
}

// Image-insert modal request (P3 task 4, R23): the slash /Image item plants
// this flag under editor.storage.imageModal (carrying the /query range that
// the Apply step deletes before insertImage) and pings a meta transaction;
// NoteEditor's transaction tick re-renders, re-reads it and mounts the
// PromptModal → ImageSizeModal chain (no native prompt dialog — the same
// mirror-and-tick
// pattern as the /table item above).
export interface ImageModalStorage {
  open: boolean;
  range: Range | null;
}

// File-attachment insert request (P3 task 5, R18): the /file slash item and
// the Extra-dropdown File button (T6) plant this flag under
// editor.storage.fileModal (carrying the /query range that the confirm step
// deletes before setFileAttachment) and ping a meta transaction;
// NoteEditor's transaction tick re-renders, re-reads it and mounts the
// PromptModal "Attachment URL" (URL-ONLY — no FileModal/upload: the server
// has no REST upload endpoint; the same mirror-and-tick pattern as the
// /table and /image items above).
export interface FileModalStorage {
  open: boolean;
  range: Range | null;
}

// Typing `/` at the start of a block opens the slash-commands menu
// (@tiptap/suggestion under the hood; state mirrored to storage above).
// Keyboard selection (arrows/Enter) is ship-time QA — Escape closes by
// deleting the `/query` text, which deactivates the suggestion.
export const SlashCommands = Extension.create<SlashCommandsOptions, SlashCommandsStorage>({
  name: 'slashCommands',

  addOptions() {
    return {
      char: '/',
      startOfLine: true,
    };
  },

  addStorage() {
    return {
      open: false,
      query: '',
      range: null,
      items: [] as SlashItem[],
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const storage = this.storage;

    // Ping the React layer. The suggestion plugin's view update is async —
    // its renderer callbacks run after an await — so this dispatch can never
    // re-enter a view update. The meta transaction carries no steps, so it
    // leaves undo history and the suggestion state untouched.
    const sync = () => {
      if (editor.isDestroyed) return;
      try {
        editor.view.dispatch(editor.state.tr.setMeta('slashCommands', Date.now()));
      } catch { /* view tearing down: nothing left to notify */ }
    };

    const mirror = (props: SuggestionProps<SlashItem>) => {
      storage.open = true;
      storage.query = props.query;
      storage.range = props.range;
      storage.items = props.items;
    };

    const clear = () => {
      storage.open = false;
      storage.query = '';
      storage.range = null;
      storage.items = [];
    };

    return [
      Suggestion<SlashItem, SlashItem>({
        editor,
        char: this.options.char,
        startOfLine: this.options.startOfLine,
        items: ({ query }) => filterSlashItems(query),
        command: ({ editor: target, range, props: picked }) => picked.command({ editor: target, range }),
        render: () => ({
          onStart: (props: SuggestionProps<SlashItem>) => {
            mirror(props);
            sync();
          },
          onUpdate: (props: SuggestionProps<SlashItem>) => {
            mirror(props);
            sync();
          },
          onExit: () => {
            clear();
            sync();
          },
          onKeyDown: ({ event, range }: SuggestionKeyDownProps) => {
            if (event.key === 'Escape') {
              editor.chain().focus().deleteRange(range).run();
              return true;
            }
            return false;
          },
        }),
      }),
    ];
  },
});