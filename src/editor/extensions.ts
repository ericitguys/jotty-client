import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Link from '@tiptap/extension-link';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { common, createLowlight } from 'lowlight';
import type { Editor } from '@tiptap/core';
import type { DropdownOption } from '../components/Dropdown';

// Code-block languages for the note editor (v0.15.4). lowlight's `common`
// bundle is the same 37-language set highlight.js ships as its default —
// small enough to bundle offline, big enough for real notes. The ids ARE the
// highlight.js/fence names (python, rust, ...) so the HTML class
// `language-<id>` matches what upstream jotty's renderer expects.
// Human labels for the lowlight common set (missing ones fall back to the id).
const LANG_LABELS: Record<string, string> = {
  bash: 'Bash / Shell',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  go: 'Go',
  graphql: 'GraphQL',
  ini: 'INI / TOML',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  kotlin: 'Kotlin',
  less: 'Less',
  lua: 'Lua',
  makefile: 'Makefile',
  markdown: 'Markdown',
  objectivec: 'Objective-C',
  perl: 'Perl',
  php: 'PHP',
  'php-template': 'PHP (template)',
  python: 'Python',
  'python-repl': 'Python (REPL)',
  r: 'R',
  ruby: 'Ruby',
  rust: 'Rust',
  scss: 'SCSS',
  shell: 'Shell session',
  sql: 'SQL',
  swift: 'Swift',
  typescript: 'TypeScript',
  vbnet: 'Visual Basic',
  wasm: 'WebAssembly',
  xml: 'XML / HTML',
  yaml: 'YAML',
};

export const CODE_LANGS: DropdownOption[] = [
  { id: 'plaintext', name: 'Plain text' },
  ...Object.keys(common)
    .filter((id) => id !== 'plaintext')
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id, name: LANG_LABELS[id] ?? id })),
];

const lowlight = createLowlight(common);

// The extension list for the note editor: StarterKit with its bare codeBlock
// swapped for CodeBlockLowlight (language attribute + live highlighting), plus
// the portal-parity P1 set — marks (text style/color/highlight/underline/sub/
// sup), task lists, and the table family (mirrors upstream editorConfig.ts).
export function noteEditorExtensions() {
  return [
    StarterKit.configure({
      codeBlock: false as unknown as false,
    }),
    CodeBlockLowlight.configure({
      lowlight,
      defaultLanguage: 'plaintext',
      languageClassPrefix: 'language-',
    }),
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    Underline,
    Subscript,
    Superscript,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }), // resize overlay is P3
    TableRow,
    TableHeader,
    TableCell,
    Link,
  ];
}

// The language of the codeBlock containing the cursor (null outside one).
export function findActiveCodeLanguage(editor: Editor): string | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'codeBlock') return (node.attrs.language as string) ?? null;
  }
  return null;
}

// Stamp the language on the codeBlock under the cursor. If the cursor is not
// in one, wrap the current selection as a code block with that language.
export function applyCodeLanguage(editor: Editor, language: string) {
  if (findActiveCodeLanguage(editor) !== null) {
    editor.chain().focus().updateAttributes('codeBlock', { language }).run();
  } else {
    editor.chain().focus().toggleCodeBlock({ language }).run();
  }
}

void Link;