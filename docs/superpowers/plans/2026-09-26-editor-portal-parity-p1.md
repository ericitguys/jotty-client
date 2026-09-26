# Editor Portal-Parity Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 of the portal-parity spec — sticky formatting toolbar, selection bubble menu, slash-commands menu, task lists, tables, text color/highlight, underline, sub/superscript, and undo/redo in the desktop note editor.

**Architecture:** Grow `src/editor/extensions.ts` (v0.16.0 base) with the TipTap 2.27.3 extension set mirroring upstream's editorConfig.ts; add new UI components (toolbar, bubble menu, slash menu) restyled to this app's CSS tokens; keep the desktop's HTML content convention (round-trip via `getHTML()`), with markdown parsing tests pinning what the stored HTML must look like.

**Tech Stack:** TipTap 2.27.3 (all `@tiptap/extension-*@2.27.3` — the bare `npm i` trap grabs v3, always pin ^2.27.3), `@tiptap/suggestion@^2.27.3` for slash commands, vitest + RTL + jsdom, React 18.

**Spec:** `docs/superpowers/specs/2026-09-26-editor-portal-parity-design.md`

## Global Constraints

- All TipTap packages pinned `^2.27.3` (TipTap 3 exists and conflicts — proven in v0.16.0).
- No Tailwind — restyle with this app's CSS tokens (styles.css, `--accent`/`--fg`/`--border` vars).
- Existing test fences must stay green: NoteEditor tests 10, extensions tests 6; full gate = vitest run + tsc -p tsconfig.json --noEmit + cargo test (unchanged expectations) — frontend-only work but cargo gate runs after any Cargo.toml touch (none expected).
- Editor storage stays `editor.getHTML()` (HTML convention) for P1; markdown round-trip arrives in P2.
- RTL text-node matching: wrap interpolated text in elements (T17-F2 precedent).
- jsdom ProseMirror: selection drivable via `fireEvent.click` + `editor.commands.setTextSelection` through the headless editor instance.
- Repo commit identity: `git -c user.name=zeus -c user.email=zeus@local commit`.

---

### Task 1: Extension set grows — marks, task lists, tables

**Files:**
- Modify: `src/editor/extensions.ts`
- Test: `src/editor/extensions.test.ts`
- Modify: `package.json` (npm i below)

**Interfaces:**
- Consumes: `noteEditorExtensions()` (v0.16.0) — returns Extension[]
- Produces: same `noteEditorExtensions()` now including Underline, TextStyle, Color, Highlight(multicolor), Subscript, Superscript, TaskList, TaskItem(nested), Table/TableRow/TableHeader/TableCell; upstream-parity node/mark behavior.

- [ ] **Step 1: Install the pinned TipTap packages**

```bash
npm install --save \
  @tiptap/extension-underline@^2.27.3 \
  @tiptap/extension-text-style@^2.27.3 \
  @tiptap/extension-color@^2.27.3 \
  @tiptap/extension-highlight@^2.27.3 \
  @tiptap/extension-subscript@^2.27.3 \
  @tiptap/extension-superscript@^2.27.3 \
  @tiptap/extension-task-list@^2.27.3 \
  @tiptap/extension-task-item@^2.27.3 \
  @tiptap/extension-table@^2.27.3 \
  @tiptap/extension-table-row@^2.27.3 \
  @tiptap/extension-table-header@^2.27.3 \
  @tiptap/extension-table-cell@^2.27.3
```

- [ ] **Step 2: Write the failing tests** (add to `src/editor/extensions.test.ts`)

```ts
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';

// (add inside the existing describe)
it('parses task list items with checked state and round-trips them', () => {
  const editor = editorWith(
    '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked><span></span></label><div><p>done</p></div></li><li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>open</p></div></li></ul>'
  );
  const json = editor.getJSON() as { content?: Array<{ type: string; content?: Array<{ type: string; attrs?: { checked?: boolean } }> }> };
  const list = json.content?.find((n) => n.type === 'taskList');
  const items = list?.content ?? [];
  expect(items).toHaveLength(2);
  expect(items[0].attrs?.checked).toBe(true);
  expect(items[1].attrs?.checked).toBe(false);
  expect(editor.getHTML()).toContain('data-type="taskList"');
});

it('parses and serializes tables', () => {
  const editor = editorWith(
    '<table><tr><th>h</th></tr><tr><td>c</td></tr></table>'
  );
  const json = editor.getJSON() as { content?: Array<{ type: string }> };
  expect(json.content?.some((n) => n.type === 'table')).toBe(true);
  expect(editor.getHTML()).toContain('<th');
});

it('underline and highlight marks round-trip', () => {
  const editor = editorWith('<p><u>under</u> and <mark data-color="#ff0000" style="background-color: #ff0000; color: #ffffff;">hl</mark></p>');
  const html = editor.getHTML();
  expect(html).toContain('<u>');
  expect(html).toContain('mark');
});

it('color and subscript/superscript marks work', () => {
  const editor = editorWith('<p>plain</p>');
  editor.commands.setTextSelection({ from: 1, to: 6 });
  editor.chain().focus().setColor('#ff0000').run();
  editor.chain().focus().toggleSubscript().run();
  expect(editor.getHTML()).toContain('color');
});
```

- [ ] **Step 3: Run to verify RED** — `npx vitest run src/editor/extensions.test.ts`
Expected: the task-list test FAILS (`taskList` node type missing → parses as bulletList).

- [ ] **Step 4: Implement** — in `src/editor/extensions.ts` extend `noteEditorExtensions()`:

```ts
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

// inside noteEditorExtensions(), after CodeBlockLowlight, before Link:
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    Underline,
    Subscript,
    Superscript,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),   // resize overlay is P3
    TableRow,
    TableHeader,
    TableCell,
```

- [ ] **Step 5: Run to GREEN** — same command. Expected: all pass.

- [ ] **Step 6: Commit**
```bash
git add package.json package-lock.json src/editor/extensions.ts src/editor/extensions.test.ts
git -c user.name=zeus -c user.email=zeus@local commit -m "feat(editor): marks, task lists, tables extensions (P1)"
```

### Task 2: Toolbar component (sticky, desktop-styled)

**Files:**
- Create: `src/components/EditorToolbar.tsx`
- Test: `src/components/EditorToolbar.test.tsx`
- Modify: `src/components/NoteEditor.tsx` (mount toolbar), `src/styles.css`

**Interfaces:**
- Consumes: `Editor` from '@tiptap/core'; `CODE_LANGS`/`applyCodeLanguage` from '../editor/extensions'
- Produces: `EditorToolbar({ editor }: { editor: Editor | null })` — renders the button row; disabled when `editor` is null.

- [ ] **Step 1: Write the failing component test** (`src/components/EditorToolbar.test.tsx`)

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { noteEditorExtensions } from '../editor/extensions';
import EditorToolbar from './EditorToolbar';

function makeEditor(content = '<p>hi</p>'): Editor {
  return new Editor({ extensions: noteEditorExtensions(), content });
}

describe('EditorToolbar', () => {
  it('renders the formatting buttons and they drive the editor', () => {
    const editor = makeEditor('<p>hi</p>');
    editor.commands.setTextSelection({ from: 1, to: 3 });
    render(<EditorToolbar editor={editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(editor.getHTML()).toContain('<strong>');
    fireEvent.click(screen.getByRole('button', { name: 'Italic' }));
    expect(editor.getHTML()).toContain('<em>');
    expect(screen.getByRole('button', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bullet list' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ordered list' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Blockquote' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    // active state styling flips on the bold button
    expect(screen.getByRole('button', { name: 'Bold' }).className).toContain('active');
  });

  it('toolbar is inert without an editor', () => {
    render(<EditorToolbar editor={null} />);
    expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled();
  });
});
```

- [ ] **Step 2: RED** — `npx vitest run src/components/EditorToolbar.test.tsx` (module not found)

- [ ] **Step 3: Implement** `src/components/EditorToolbar.tsx`:

```tsx
import type { Editor } from '@tiptap/core';
import Dropdown, { type DropdownOption } from './Dropdown';

// Site-style icon buttons (mousedown preventDefault keeps editor focus — upstream pattern).
function TBtn({ label, onClick, active, disabled, children }: {
  label: string; onClick: () => void; active?: boolean; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`edt-btn${active ? ' active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={!!active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >{children}</button>
  );
}

export default function EditorToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  const chain = () => editor.chain().focus();
  return (
    <div className="edt-toolbar">
      <TBtn label="Bold" active={editor.isActive('bold')} onClick={() => chain().toggleBold().run()}><b>B</b></TBtn>
      <TBtn label="Italic" active={editor.isActive('italic')} onClick={() => chain().toggleItalic().run()}><i>I</i></TBtn>
      <TBtn label="Underline" active={editor.isActive('underline')} onClick={() => chain().toggleUnderline().run()}><u>U</u></TBtn>
      <TBtn label="Strikethrough" active={editor.isActive('strike')} onClick={() => chain().toggleStrike().run()}><s>S</s></TBtn>
      <TBtn label="Inline code" active={editor.isActive('code')} onClick={() => chain().toggleCode().run()}><code>{'<>'}</code></TBtn>
      <span className="edt-sep" />
      <TBtn label="Heading" active={editor.isActive('heading', { level: 2 })} onClick={() => chain().toggleHeading({ level: 2 }).run()}><strong>H</strong></TBtn>
      <TBtn label="Bullet list" active={editor.isActive('bulletList')} onClick={() => chain().toggleBulletList().run()}>•≡</TBtn>
      <TBtn label="Ordered list" active={editor.isActive('orderedList')} onClick={() => chain().toggleOrderedList().run()}>1≡</TBtn>
      <TBtn label="Blockquote" active={editor.isActive('blockquote')} onClick={() => chain().toggleBlockquote().run()}>❝</TBtn>
      <span className="edt-sep" />
      <TBtn label="Link" active={editor.isActive('link')} onClick={() => {
        const { from, to } = editor.state.selection;
        const url = prompt('Link URL', editor.getAttributes('link').href || 'https://');
        if (url === null) return;
        if (url === '') { chain().unsetLink().run(); return; }
        if (from !== to) { chain().setLink({ href: url }).run(); return; }
        const text = prompt('Link text', '');
        if (text) chain().insertContent(`<a href="${url}">${text}</a>`).run();
      }}>🔗</TBtn>
      <span className="edt-sep" />
      <TBtn label="Undo" onClick={() => chain().undo().run()}>↶</TBtn>
      <TBtn label="Redo" onClick={() => chain().redo().run()}>↷</TBtn>
      {/* color + highlight dropdowns land in Task 4; code-language picker mounts in Task 4 */}
    </div>
  );
}
```

(Note: `prompt()` does not exist in jsdom — the component test never clicks Link; the headless link flow is covered by an editor-level test in Task 3. The Link modal becomes a proper component in P2/P3; prompt() is the P1 placeholder and is flagged for replacement.)

- [ ] **Step 4: GREEN + CSS** — append to styles.css (before the sync-badge block):

```css
/* editor toolbar (portal parity P1) */
.edt-toolbar { display: flex; align-items: center; gap: 2px; padding: 4px 8px; background: var(--bg); border-bottom: 1px solid var(--border); border-radius: 8px 8px 0 0; flex-wrap: wrap; }
.edt-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; height: 28px; border: none; background: transparent; color: var(--fg); border-radius: 5px; cursor: pointer; font-size: 13px; padding: 0 6px; }
.edt-btn:hover { background: var(--accent-soft); }
.edt-btn.active { background: var(--accent-soft); color: var(--accent); }
.edt-btn:disabled { opacity: .4; cursor: default; }
.edt-sep { width: 1px; height: 18px; background: var(--border); margin: 0 4px; }
```

- [ ] **Step 5: Mount in NoteEditor** — inside `#note-editor`, directly above `<EditorContent editor={editor} />` add `<EditorToolbar editor={editor} />`. Run the FULL NoteEditor suite (existing fences must stay green).

- [ ] **Step 6: Commit**
```bash
git add src/components/EditorToolbar.tsx src/components/EditorToolbar.test.tsx src/components/NoteEditor.tsx src/styles.css
git -c user.name=zeus -c user.email=zeus@local commit -m "feat(editor): formatting toolbar (P1)"
```

### Task 3: Bubble menu on text selection

**Files:**
- Create: `src/components/BubbleMenu.tsx` (plain component, NOT @tiptap/extension-bubble-menu — jsdom/host constraints; positioned from the editor's view coords)
- Test: `src/components/BubbleMenu.test.tsx`
- Modify: `src/components/NoteEditor.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: `Editor`
- Produces: `BubbleMenu({ editor, visible, onClose })` — renders when `visible` (text selection non-empty); buttons bold/italic/underline/strike/link reusing Task 2 handlers.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { noteEditorExtensions } from '../editor/extensions';
import BubbleMenu from './BubbleMenu';

describe('BubbleMenu', () => {
  it('renders on visible and applies bold to the selection', () => {
    const editor = new Editor({ extensions: noteEditorExtensions(), content: '<p>hi</p>' });
    editor.commands.setTextSelection({ from: 1, to: 3 });
    const onClose = vi.fn();
    render(<BubbleMenu editor={editor} visible onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(editor.getHTML()).toContain('<strong>');
    // Escape or applying closes it
    expect(onClose).toHaveBeenCalled();
  });
  it('renders nothing when not visible', () => {
    const editor = new Editor({ extensions: noteEditorExtensions(), content: '<p>hi</p>' });
    render(<BubbleMenu editor={editor} visible={false} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull();
  });
});
```

- [ ] **Step 2: RED** (module not found)

- [ ] **Step 3: Implement** — `src/components/BubbleMenu.tsx`:

```tsx
import type { Editor } from '@tiptap/core';

export default function BubbleMenu({ editor, visible, onClose }: {
  editor: Editor; visible: boolean; onClose: () => void;
}) {
  if (!visible) return null;
  const chain = () => editor.chain().focus();
  const apply = (fn: () => void) => { fn(); onClose(); };
  return (
    <div className="edt-bubble" onMouseDown={(e) => e.preventDefault()}>
      <button aria-label="Bold" className={editor.isActive('bold') ? 'active' : ''} onClick={() => apply(() => chain().toggleBold().run())}><b>B</b></button>
      <button aria-label="Italic" className={editor.isActive('italic') ? 'active' : ''} onClick={() => apply(() => chain().toggleItalic().run())}><i>I</i></button>
      <button aria-label="Underline" className={editor.isActive('underline') ? 'active' : ''} onClick={() => apply(() => chain().toggleUnderline().run())}><u>U</u></button>
      <button aria-label="Strikethrough" className={editor.isActive('strike') ? 'active' : ''} onClick={() => apply(() => chain().toggleStrike().run())}><s>S</s></button>
      <button aria-label="Link" onClick={() => apply(() => {
        const url = prompt('Link URL', editor.getAttributes('link').href || 'https://');
        if (url) chain().setLink({ href: url }).run();
      })}>🔗</button>
    </div>
  );
}
```

Visibility in NoteEditor: local state `bubbleVisible` driven by a selectionUpdate handler — `editor.on('selectionUpdate')` → `visible = !editor.state.selection.empty && !editor.isActive('codeBlock')`; hide on Escape/apply. CSS `.edt-bubble` (floating pill, var tokens).

- [ ] **Step 4: GREEN + CSS + NoteEditor mount** (same pattern as Task 2 steps 4-5)

- [ ] **Step 5: Commit** — `feat(editor): selection bubble menu (P1)`

### Task 4: Toolbar completion — color/highlight, undo/redo, code picker + lists menu

**Files:**
- Modify: `src/components/EditorToolbar.tsx`, `src/components/NoteEditor.tsx`, `src/styles.css`
- Test: `src/components/EditorToolbar.test.tsx`

**Interfaces:**
- Consumes: Task 1 extensions (setColor/toggleHighlight/undo/redo/toggleTaskList), `CODE_LANGS`, `applyCodeLanguage`, Dropdown
- Produces: full P1 toolbar — Text color dropdown (8 preset swatches), Highlight toggle, Undo/Redo, Task-list toggle, code-language Dropdown (reuse v0.16.0), table-insert button (Task 5 wires the grid).

- [ ] **Step 1: Write the failing tests** (extend EditorToolbar.test.tsx)

```tsx
it('color dropdown applies a preset color; highlight toggles a mark', () => {
  const editor = makeEditor('<p>hi</p>');
  editor.commands.setTextSelection({ from: 1, to: 3 });
  render(<EditorToolbar editor={editor} />);
  fireEvent.click(screen.getByRole('button', { name: 'Text color' }));
  fireEvent.click(screen.getByRole('option', { name: 'Red' }));
  expect(editor.getHTML()).toContain('color: #ff5f57');
  fireEvent.click(screen.getByRole('button', { name: 'Highlight' }));
  expect(editor.getHTML()).toContain('<mark');
});

it('undo and redo round-trip an edit', () => {
  const editor = makeEditor('<p>hi</p>');
  editor.commands.setTextSelection({ from: 1, to: 3 });
  render(<EditorToolbar editor={editor} />);
  fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(editor.getHTML()).not.toContain('<strong>');
  fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
  expect(editor.getHTML()).toContain('<strong>');
});

it('task list toggle produces a taskList node', () => {
  const editor = makeEditor('<p>task</p>');
  editor.commands.setTextSelection(1);
  render(<EditorToolbar editor={editor} />);
  fireEvent.click(screen.getByRole('button', { name: 'Task list' }));
  expect(editor.getHTML()).toContain('data-type="taskList"');
});
```

- [ ] **Step 2: RED → implement** — add to EditorToolbar: color dropdown (site-style Dropdown reusing `jotty-dropdown` classes, options: 8 swatches with `swatch` bg — Red #ff5f57, Yellow #febc2e, Green #28c840, Blue #57a5ff, Purple #9d5ffe, Pink #ff6ac1, White #f9f9f9, Black #333), Highlight toggle (`chain().toggleHighlight().run()`), Undo/Redo, Task list (`chain().toggleTaskList().run()` — TaskList/TaskItem from Task 1), and mount the existing code-language Dropdown (`value = findActiveCodeLanguage(editor) ?? 'plaintext'`, onChange = `applyCodeLanguage(editor, id)`) into the toolbar replacing the editor-foot placement. REMOVE the editor-foot picker row from NoteEditor (moved into the toolbar — portal layout).

- [ ] **Step 3: GREEN + NoteEditor cleanup + CSS** — `.edt-swatch` chips, color dropdown menu.

- [ ] **Step 4: Commit** — `feat(editor): color/highlight/task-list/undo-redo + code picker into toolbar (P1)`

### Task 5: Slash commands menu

**Files:**
- Create: `src/editor/slashCommands.ts` (extension + item list + filter)
- Test: `src/editor/extensions.test.ts` (slash items headless) + `src/components/SlashMenu.test.tsx` (render)
- Modify: `src/components/NoteEditor.tsx`

**Interfaces:**
- Consumes: `Editor`, Task 1 extensions
- Produces: `SlashCommands` extension (typing `/` at block start opens a suggestion popup; items below), `SLASH_ITEMS` (id/label/hint/exec).

- [ ] **Step 1: Write the failing headless tests**

```ts
import { SLASH_ITEMS } from '../editor/slashCommands';

describe('slash commands', () => {
  it('offers the portal set of inserters', () => {
    const titles = SLASH_ITEMS.map((i) => i.title);
    for (const want of ['Heading 1', 'Heading 2', 'Bullet list', 'Ordered list', 'Task list', 'Code block', 'Quote', 'Table']) {
      expect(titles).toContain(want);
    }
  });
  it('running the code-block item converts the current block', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setTextSelection(1);
    const item = SLASH_ITEMS.find((i) => i.title === 'Code block')!;
    item.command({ editor, range: { from: 1, to: 2 } });
    expect(editor.isActive('codeBlock')).toBe(true);
  });
});
```

- [ ] **Step 2: RED → implement `src/editor/slashCommands.ts`** — a TipTap Extension using `@tiptap/suggestion` (`char: '/'`, `startOfLine`, items filtered by query on title, render = ReactRenderer of a simple list div `.edt-slash-menu`); items execute `editor.chain().focus().deleteRange(range).<cmd>.run()`. Table item opens a prompt-based grid (rows/cols prompt) in P1; image item inserts a URL prompt (P3 replaces with modal).

- [ ] **Step 3: Component test** — NoteEditor renders `/` popup with the items when the editor reports the suggestion active (drive via headless: mount, focus, `fireEvent.input` typing `/` is jsdom-unreliable — instead export `SlashMenu` as a controlled component {items, onPick} rendered by the suggestion plugin; test renders it directly with a fake editor command spy).

- [ ] **Step 4: GREEN + CSS (.edt-slash-list) + commit** — `feat(editor): slash commands menu (P1)`

### Task 6: Tables — insert + context toolbar

**Files:**
- Create: `src/components/TableToolbar.tsx` + test
- Modify: `src/components/EditorToolbar.tsx` (Table button → insert 3×3 via prompt or fixed 3×3), `src/styles.css`

**Interfaces:**
- Consumes: Table extensions (Task 1)
- Produces: `TableToolbar({ editor, tablePos })` — add row/col, delete row/col/table, toggle header row; shown when `editor.isActive('table')`.

- [ ] **Step 1: Failing headless tests** — insertTable → schema has table; addRowAfter/deleteTable commands exist; serialize round-trip `<table><tr><td>` .
- [ ] **Step 2: Implement TableToolbar** (fixed-position bar above the table when active; buttons: Row +/−, Col +/−, Delete table, Header toggle) + EditorToolbar Table button (`chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()`).
- [ ] **Step 3: GREEN + CSS (.edt-tablebar) + commit** — `feat(editor): tables insert + context toolbar (P1)`

### Task 7: Ship v0.17.0

- [ ] **Step 1: Full gates** — `npx vitest run` (expect ≥165), `npx tsc -p tsconfig.json --noEmit`, `DISPLAY=:99 cargo test` (209+1i unchanged), warnings 18=18 census.
- [ ] **Step 2: Version bump** 0.16.0 → 0.17.0 (package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml, `npm install --package-lock-only`, `cargo update -p jotty-client`).
- [ ] **Step 3: Commit** — `chore(release): v0.17.0 (editor portal-parity P1)`.
- [ ] **Step 4: Push + verify ls-remote** — `git push && git ls-remote origin main`.
- [ ] **Step 5: Build** (desktop `npx tauri build`; android `source /tmp/android-env.sh && npx tauri android build --target aarch64 --apk` — background + notify; BOTH must EXIT 0; remember the gtk dep is target-gated — android builds clean).
- [ ] **Step 6: Tag + release** — `git tag -a v0.17.0`, push tag, `~/.local/bin/gh release create v0.17.0 <rpm> <deb> <appimage> <apk>` with notes file carrying computed sha256 of all four.
- [ ] **Step 7: Verify** — `gh release view --json isDraft,isPrerelease,assets`; download all four + re-hash byte-identical.
- [ ] **Step 8: Ledger** — skill status entry + memory (jotty line).

## Plan rulings (disclosed)

- R1: Link insertion via `prompt()` in P1 (jsdom `prompt` is undefined — the EditorToolbar test avoids clicking Link; replace with a proper modal in P2 alongside markdown mode). Upstream uses a modal; flagged as a known deviation to remove in P2.
- R2: Bubble menu is a plain component driven by `selectionUpdate` (not @tiptap/extension-bubble-menu) — the extension's Tippy positioning depends on DOM measurement that jsdom tests poorly and the host webview is fine with plain CSS positioning; keeps tests deterministic.
- R3: Slash menu items mirror upstream's visual-mode set MINUS diagrams/callout/collapsible/image/file (P3). Note/checklist/@mention/tag search suggestions are P3 (they need store data plumbing).
- R4: Color presets are fixed 8 (no color picker wheel) — matches upstream's common palette usage; wheel is P3 polish.
- R5: Task 1's table content spec matches upstream (`tableRow+`, `tableHeader|tableCell` block+ content) — same schema as editorConfig.ts so round-trips behave identically.
- R6: No Tailwind classes anywhere — all new CSS uses this app's tokens and the existing jotty-dropdown component.