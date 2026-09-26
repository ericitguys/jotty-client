import { Extension } from '@tiptap/core';
import type { Editor, Range } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';

// Context handed to a slash item's command: the editor plus the range
// covering the `/query` text the suggestion plugin matched. Every item
// deletes that range first, then runs its command on the now-current block.
export interface SlashCommandContext {
  editor: Editor;
  range: Range;
}

// One slash-menu entry. The set mirrors upstream's visual-mode inserters
// MINUS diagrams/callout/collapsible/image/file (plan ruling R3 — those are
// P3; the 8 titles in extensions.test.ts are the canonical P1 set).
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
      // P1 ruling: prompt-based rows/cols grid (upstream's modal is P3).
      // Guarded for jsdom/headless where prompt() is unusable — bail out
      // silently instead of crashing (the headless tests never pick Table).
      if (typeof prompt !== 'function') return;
      const rows = Number(prompt('Table rows', '3'));
      const cols = Number(prompt('Table columns', '3'));
      if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) return;
      editor.chain().focus().deleteRange(range).insertTable({ rows, cols, withHeaderRow: true }).run();
    },
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