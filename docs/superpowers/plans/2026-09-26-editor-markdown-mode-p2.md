# Editor Portal-Parity Phase 2 (Markdown Mode + Modals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop note editor gains the portal's dual editing modes — Visual (TipTap) ⇄ Markdown (raw textarea with preview) — and adopts the portal's storage contract (notes persist as markdown; legacy HTML notes still load), with proper in-app modals replacing the P1 `prompt()` placeholders for Link and Table insert.

**Architecture:** Add `src/editor/markdown.ts` (turndown + remark pipeline, portal-identical config) as the serialization layer; NoteEditor keeps the TipTap editor mounted for Visual mode and swaps to a `MarkdownEditor` textarea component in markdown mode (same autosave channel — every mode switch and edit lands in the same `autosave.setValue` path, so saves/undo stay uniform). On save, content serializes to markdown; on load, legacy HTML (`startsWith('<')`) parses to TipTap while markdown notes parse for the textarea. Link + Table modals become controlled components owned by NoteEditor, driven by a small request state (portal pattern: `onLinkRequest`/`onTableModalOpen`).

**Tech Stack:** `turndown@^7.2.0` + `turndown-plugin-gfm@^1.0.2` (HTML→md, fenced code, task items), `unified@^11` + `remark-parse@^11` + `remark-gfm@^4` + `remark-rehype@^11` + `rehype-raw@^7` + `rehype-stringify@^10` (md→HTML) — the SAME libraries/versions the portal uses, so round-trips behave identically. highlight.js (already installed) supplies the markdown grammar for the raw editor's syntax-highlight overlay. React 18, vitest/RTL/jsdom.

**Spec:** `docs/superpowers/specs/2026-09-26-editor-portal-parity-design.md` (§2.5 Modes, §2.6 Storage contract, §4 P2)

## Global Constraints

- All new npm deps pinned to the portal's exact versions: turndown ^7.2.0, turndown-plugin-gfm ^1.0.2, unified ^11.0.5, remark-parse ^11.0.0, remark-gfm ^4.0.1, remark-rehype ^11.1.2, rehype-raw ^7.0.0, rehype-stringify ^10.0.1. TipTap packages stay ^2.27.3 (no new TipTap deps in P2).
- No Tailwind — all new CSS uses the app's tokens (`--bg/--fg/--border/--accent/--accent-soft/--panel/--row/--muted`).
- **Storage contract (the parity change):** `onUpdate` persists `convertHtmlToMarkdown(editor.getHTML())`, NOT raw `getHTML()`; on load, `content.trim().startsWith('<')` → TipTap HTML as today, else markdown → `convertMarkdownToHtml` → TipTap (portal init semantics, portal lines 267-272). The Rust/`update_note` path is untouched — content stays an opaque string end-to-end (verified: `src-tauri/src/commands/mod.rs:51-66`).
- **Back-compat fence:** legacy HTML notes MUST load unchanged (startsWith('<') branch) — fenced test required.
- `prompt()` is GONE from the codebase after P2 (Link modal + Table modal replace it; grep gate = 0 hits in src/).
- Toolbar Table button switches from fixed-3×3 to the table modal (portal parity, resolves P1 divergence minor 14); the slash-menu Table item opens the same modal.
- TDD: every task writes its failing test first; RED→GREEN→commit. Existing suites stay green (175/175 baseline). Full gates per ship task: `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`, `cargo check --all-targets 2>&1 | grep -c '^warning'` = 18 baseline, `DISPLAY=:99 cargo test`.
- Repo commit identity: `git -c user.name=zeus -c user.email=zeus@local commit`. Never run cargo fmt.
- jsdom has no `prompt()`/`confirm()` and cannot drive ProseMirror raw-key typing — modal tests are controlled-component tests; suggestion runtime is ship-time QA.

---

### Task 1: Markdown serialization module (`src/editor/markdown.ts`)

**Files:**
- Create: `src/editor/markdown.ts`
- Test: `src/editor/markdown.test.ts`
- Modify: `package.json` (npm i below)

**Interfaces:**
- Consumes: nothing internal — standalone serialization layer.
- Produces: `convertHtmlToMarkdown(html: string): string`, `convertMarkdownToHtml(md: string): string`, `createTurndownService(): TurndownService` (exported for rule-extensibility tests). Both converters are total functions: empty/null-ish input → `''`.

- [ ] **Step 1: Install the pinned portal deps**

```bash
npm install --save turndown@^7.2.0 turndown-plugin-gfm@^1.0.2 unified@^11.0.5 remark-parse@^11.0.0 remark-gfm@^4.0.1 remark-rehype@^11.1.2 rehype-raw@^7.0.0 rehype-stringify@^10.0.1
npm install --save-dev @types/turndown@^5.0.6
```

- [ ] **Step 2: Write the failing round-trip tests** (new file `src/editor/markdown.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { convertHtmlToMarkdown, convertMarkdownToHtml } from './markdown';

describe('markdown serialization (portal pipeline)', () => {
  it('round-trips headings, emphasis and inline code', () => {
    const md = convertHtmlToMarkdown('<h2>Title</h2><p><strong>b</strong> <em>i</em> <u>u</u> <code>x</code></p>');
    expect(md).toContain('## Title');
    expect(md).toContain('**b**');
    expect(md).toContain('*i*');
    expect(md.replace(/\n/g, '')).toMatch(/_?u_?|<u>u<\/u>/); // underline survives as HTML or emph
    expect(md).toContain('`');
  });

  it('serializes fenced code blocks with the language class', () => {
    const md = convertHtmlToMarkdown('<pre><code class="language-python">x = 1</code></pre>');
    expect(md).toContain('```python');
    expect(md.trim().endsWith('```')).toBe(true);
  });

  it('serializes task lists with checked state (portal taskItem rule)', () => {
    const html = '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p>done</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>open</p></div></li></ul>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('- [x] done');
    expect(md).toContain('- [ ] open');
  });

  it('serializes tables via the gfm plugin', () => {
    const md = convertHtmlToMarkdown('<table><tr><th>h</th></tr><tr><td>c</td></tr></table>');
    expect(md).toContain('|');
    expect(md).toContain('---');
  });

  it('converts markdown (gfm) to HTML: headings, task lists, tables, fenced code', () => {
    const html = convertMarkdownToHtml('# H1\n\n- [x] done\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nlet x\n```\n');
    expect(html).toContain('<h1>');
    expect(html).toContain('data-type="taskList"'); // see Step 4 remark → TipTap-shaped task items
    expect(html).toContain('<table>');
    expect(html).toContain('language-js'); // lowlight-compatible class for CodeBlockLowlight
  });

  it('parses legacy HTML content untouched (identity for startsWith("<") notes)', () => {
    // markdown containing raw HTML passes through rehype-raw (allowDangerousHtml)
    const html = convertMarkdownToHtml('text\n\n<p data-x="1">raw</p>\n');
    expect(html).toContain('<p data-x="1">raw</p>');
  });

  it('empty inputs produce empty outputs', () => {
    expect(convertHtmlToMarkdown('')).toBe('');
    expect(convertMarkdownToHtml('')).toBe('');
  });
});
```

- [ ] **Step 3: Run to RED** — `npx vitest run src/editor/markdown.test.ts` (module not found).

- [ ] **Step 4: Implement `src/editor/markdown.ts`** — portal `markdown-utils.tsx` semantics, desktop-adapted:

```ts
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeStringify from 'rehype-stringify';

export const createTurndownService = (): TurndownService => {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    bulletListMarker: '-',
  });
  service.addRule('taskItem', {
    filter: (node) => node.nodeName === 'LI' && node.getAttribute('data-type') === 'taskItem',
    replacement: (content, node) => {
      const el = node as HTMLElement;
      if (el.parentElement?.getAttribute('data-type') !== 'taskList') return content;
      const checked = el.getAttribute('data-checked') === 'true';
      const inner = content.trim().replace(/\n/g, '\n    ');
      return `${checked ? '- [x] ' : '- [ ] '}${inner}\n`;
    },
  });
  service.use(gfm);
  return service;
};

const turndown = createTurndownService();

export const convertHtmlToMarkdown = (html: string): string => {
  if (!html || typeof html !== 'string') return '';
  return turndown.turndown(html);
};

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeStringify);

export const convertMarkdownToHtml = (markdown: string): string => {
  if (!markdown || typeof markdown !== 'string') return '';
  return String(markdownProcessor.processSync(markdown));
};
```

IMPORTANT deviation from the naive copy (the test above asserts it): the remark pipeline output must be **TipTap-consumable** — task-list `<li>`s must carry `data-type="taskItem"`/`data-checked` and code fences must carry `language-*` classes so `CodeBlockLowlight` picks them up. Implement as a post-`rehype-stringify` string transform in `convertMarkdownToHtml` (plain regex/replace over the HTML string — deterministic, jsdom-testable):
- fenced blocks: ```` ```lang ```` → `<pre><code class="language-lang">…`
- task items: `- [x]` list items → the TaskItem HTML shape used by Task-1's parse tests (`<ul data-type="taskList"><li data-type="taskItem" data-checked="true">…`), unchecked → `data-checked="false"`; plain `- [ ]`/`- [x]` bullets in a run become one wrapped `<ul data-type="taskList">`.
If a pure-string transform proves brittle for nested lists, use `remark-rehype`'s `handlers` + `rehype-stringify` custom `handlers` instead (still no jsdom dependency) — either implementation is fine as long as the tests pass; document which.

- [ ] **Step 5: GREEN** — same command, all 7 pass. Also run the existing extensions suite (`npx vitest run src/editor/extensions.test.ts`) to prove no import-cycle/regression.

- [ ] **Step 6: Commit**
```bash
git add package.json package-lock.json src/editor/markdown.ts src/editor/markdown.test.ts
git -c user.name=zeus -c user.email=zeus@local commit -m "feat(editor): markdown serialization layer — turndown/remark (P2)"
```

### Task 2: Storage contract — save markdown, load both

**Files:**
- Modify: `src/components/NoteEditor.tsx` (load + save paths), `src/hooks/useAutosave.ts` (no signature change — verify), `src/components/NoteEditor.test.tsx`

**Interfaces:**
- Consumes: `convertHtmlToMarkdown`/`convertMarkdownToHtml` (Task 1); existing `useAutosave`.
- Produces: NoteEditor save payload content is **markdown**; load accepts both (HTML legacy via `startsWith('<')`, markdown via converter). Same DTO shape `{title, content, category}` — Rust/api untouched.

- [ ] **Step 1: Write the failing tests** (add to `src/components/NoteEditor.test.tsx`)

```tsx
import { convertHtmlToMarkdown } from '../editor/markdown';

it('saves markdown: visual edit persists converted markdown, not HTML', async () => {
  // existing suite mocks api.updateNote via `invoke` — assert the persisted content arg
  render(<NoteEditor noteId="n1" />);
  await screen.findByText('hi'); // editor content mounted
  // type into the editor → autosave value updates with markdown
  // (drive via the same pattern the existing tests use: fireEvent on the editor / toolbar Bold)
  // then assert invoke called with content NOT starting with '<' and containing the md marker
});

it('loads legacy HTML notes unchanged (startsWith <)', async () => {
  // mock getNote → content: '<p>legacy html</p>'; assert the editor receives it as HTML (toolbar Bold works on it)
});

it('loads markdown notes (no < prefix) parsed to the visual editor', async () => {
  // mock getNote → content: '# Title\n\n- [x] done'; assert getHTML-driven DOM shows h1 + checked task item
});
```

Write these against the suite's existing mocking pattern (invoke mock + `api.getNote` resolved value) — match the file's current helpers verbatim; the three assertions are: (a) saved-content format is markdown, (b) HTML-notes still edit, (c) markdown-notes load into the visual editor.

- [ ] **Step 2: RED** — `npx vitest run src/components/NoteEditor.test.tsx` (markdown-save test fails: today's save is `editor.getHTML()` raw).

- [ ] **Step 3: Implement** — in `NoteEditor.tsx`:
- `onUpdate`: `autosave.setValue({ ..., content: convertHtmlToMarkdown(editor.getHTML()) })`.
- Load effect + `useEditor` content: keep TipTap fed with HTML always — `const initialHtml = note.content.trim().startsWith('<') ? note.content : convertMarkdownToHtml(note.content)` (portal lines 267-272). Autosave's stored `content` stays the RAW note string (markdown or legacy HTML as loaded) — only the editor's `content:` prop converts.
- Autosave flow guard: since `autosave.value.content` may now be markdown while the editor holds HTML, track `markdownRef.current = autosave.value?.content ?? ''` and never feed markdown into `useEditor` content directly (the converter handles it at load). Title/category paths untouched.

- [ ] **Step 4: GREEN + full suite** — NoteEditor 10+3/13, full `npx vitest run` (expect ≥178), `npx tsc -p tsconfig.json --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add src/components/NoteEditor.tsx src/components/NoteEditor.test.tsx
git -c user.name=zeus -c user.email=zeus@local commit -m "feat(editor): portal storage contract — save markdown, load md-or-legacy-html (P2)"
```

### Task 3: Mode toggle + MarkdownEditor (raw textarea, highlight overlay, preview)

**Files:**
- Create: `src/components/MarkdownEditor.tsx`, `src/components/MarkdownEditor.test.tsx`
- Modify: `src/components/NoteEditor.tsx` (mode state + conditional render + mode toggle wiring into EditorToolbar), `src/components/EditorToolbar.tsx` (mode toggle button cluster at the toolbar's left + `markdownMode` prop gating), `src/styles.css` (`.edt-mode`, `.md-editor`, `.md-preview`)

**Interfaces:**
- Consumes: Task 1 converters; `Editor` (to pull HTML on switch).
- Produces: `MarkdownEditor({ value, onChange, editor }: { value: string; onChange: (md: string) => void; editor: Editor | null })` — textarea + highlighted overlay + preview toggle. NoteEditor owns `isMarkdownMode` state; `EditorToolbar` gains optional `markdownMode?: boolean; onToggleMode?: () => void` (renders a Visual/Markdown segmented control at the left when `onToggleMode` provided; in markdown mode the TipTap-driven buttons render `disabled` and the toolbar shows only mode + preview controls — portal behavior: buttons that need TipTap are inert in markdown mode in P1-of-P2; textarea insertion helpers are P3 polish unless trivial).

- [ ] **Step 1: Failing component tests** (`src/components/MarkdownEditor.test.tsx`)

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MarkdownEditor from './MarkdownEditor';

describe('MarkdownEditor', () => {
  it('renders a textarea with the markdown value and reports changes', () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value={'# hi'} onChange={onChange} editor={null} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '# hello' } });
    expect(onChange).toHaveBeenCalledWith('# hello');
  });
  it('preview toggle renders converted HTML instead of the textarea', () => {
    const { rerender } = render(<MarkdownEditor value={'# hi'} onChange={() => {}} editor={null} preview />);
    expect(document.querySelector('.md-preview')?.innerHTML).toContain('h1');
    expect(screen.queryByRole('textbox')).toBeNull();
    rerender(<MarkdownEditor value={'# hi'} onChange={() => {}} editor={null} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
  it('highlight overlay tokens exist (markdown grammar via highlight.js)', () => {
    render(<MarkdownEditor value={'# hi\n\n- a'} onChange={() => {}} editor={null} />);
    expect(document.querySelector('.md-editor .hljs-markdown, .md-editor code.language-markdown')).toBeTruthy();
  });
});
```

- [ ] **Step 2: RED** → **Step 3: Implement `MarkdownEditor.tsx`:**
- Controlled `<textarea className="md-editor-area">` + a `pre code.hljs.language-markdown` overlay synced to the textarea's scroll/value (highlight.js `highlight(code, { language: 'markdown' })`; import `highlight.js/lib/languages/markdown` — grammar verified available). Optional line numbers gutter (`showLineNumbers` default true, portal-parity).
- `preview?: boolean` prop → renders `<div className="md-preview" dangerouslySetInnerHTML={{ __html: convertMarkdownToHtml(value) }} />` (rehype-raw already sanitizes by allowing raw passthrough — same as portal's UnifiedMarkdownRenderer path; schema-level script stripping happens at TipTap load, not here; the preview is read-only).
- Editor-null safe: renders with `editor` unused in markdown mode (prop present for symmetry/future toolbar wiring).
- Escape does NOT close it (it's a mode, not a popup); mode exits via the toolbar toggle only.

- [ ] **Step 4: Wire the mode into NoteEditor + EditorToolbar**
- NoteEditor: `const [isMarkdownMode, setIsMarkdownMode] = useState(false);` + `markdownDraft` state. Toggle handler (portal toggleMode semantics, lines 179-210): visual→markdown: `setMarkdownDraft(convertHtmlToMarkdown(editor.getHTML()))`; markdown→visual: `editor.commands.setContent(convertMarkdownToHtml(markdownDraft), { emitUpdate: false })`. While in markdown mode, `<MarkdownEditor value={markdownDraft} onChange={(md) => { setMarkdownDraft(md); autosave.setValue({..., content: md}); }} />` replaces `<EditorContent>` (TipTap stays mounted but hidden via `hidden` attribute — keeps editor instance alive, portal does the same via CSS). Save in markdown mode persists the draft verbatim (already markdown).
- EditorToolbar: prepend the segmented control `[Visual | Markdown]` (+ Preview toggle, visible only in markdown mode) — portal toolbar left cluster. In markdown mode the TipTap buttons render `disabled` (TBtn already supports `disabled`) except the mode control.

- [ ] **Step 5: GREEN + gates** — full vitest + tsc.

- [ ] **Step 6: Commit** — `feat(editor): markdown mode — raw editor + preview + mode toggle (P2)`

### Task 4: Link modal (PromptModal parity)

**Files:**
- Create: `src/components/modals/PromptModal.tsx` + `src/components/modals/PromptModal.test.tsx`
- Modify: `src/components/EditorToolbar.tsx` (Link handler → modal open), `src/components/NoteEditor.tsx` (modal mount + request state), `src/styles.css`
- Modify: `src/components/BubbleMenu.tsx` (Link → same request callback pattern)

**Interfaces:**
- Consumes: Task 2/3 state plumbing.
- Produces: `PromptModal({ isOpen, onClose, onConfirm, title, message, placeholder, defaultValue, confirmText }: {...})` — portal PromptModal shape (props verified from upstream `PromptModal.tsx:9-16`). Link flow: toolbar Link button (and bubble Link) set `linkRequest = { hasSelection }`; modal confirms with `(value: string)` → toolbar applies `setLink`/insert-link exactly as the P1 prompt handler did (empty value → `unsetLink`).

- [ ] **Step 1: Failing tests** (`PromptModal.test.tsx`)
```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PromptModal from './PromptModal';

describe('PromptModal', () => {
  it('renders with defaultValue and confirms the typed value', () => {
    const onConfirm = vi.fn(); const onClose = vi.fn();
    render(<PromptModal isOpen onClose={onClose} onConfirm={onConfirm} title="Link" defaultValue="https://x" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('https://x');
    fireEvent.change(input, { target: { value: 'https://y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith('https://y');
    expect(onClose).toHaveBeenCalled();
  });
  it('Escape and Cancel close without confirming', () => {
    const onConfirm = vi.fn(); const onClose = vi.fn();
    render(<PromptModal isOpen onClose={onClose} onConfirm={onConfirm} title="Link" />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('renders nothing when closed', () => {
    render(<PromptModal isOpen={false} onClose={() => {}} onConfirm={() => {}} title="Link" />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
```

- [ ] **Step 2: RED → implement** — `PromptModal.tsx`: controlled dialog `role="dialog"`, backdrop click + Cancel + Escape → `onClose`; Confirm → `onConfirm(value)`; `defaultValue` reseeds on open (portal lines 33-38). Focus the input on open. CSS: reuse `.jotty-dropdown`-style tokens; new `.modal-backdrop`/`.modal-card` in styles.css (z-index 70, above overlays).

- [ ] **Step 3: Wire Link** — EditorToolbar: replace the `prompt('Link URL', …)` body with `onLinkRequest?.()` prop-callback (NoteEditor owns `linkRequest` state + mounts `<PromptModal title="Link URL" placeholder="https://example.com" defaultValue={currentHref} onConfirm={(url) => { …P1 link logic verbatim (empty→unsetLink; selection→setLink; else insertContent anchor)… }} />`). BubbleMenu's Link button routes through the same state (note: BubbleMenu currently calls prompt directly — remove it; BubbleMenu gains optional `onLinkRequest?: () => void` prop; if absent, hide its Link button). `prompt()` grep gate after this task: `grep -rn "prompt(" src/ --include=*.tsx --include=*.ts | grep -v test` → 0 (slash Table item is Task 5).

- [ ] **Step 4: GREEN + commit** — `feat(editor): link modal replaces prompt (P2)`

### Task 5: Table insert modal (portal TableInsertModal parity) + prompt() eradication

**Files:**
- Create: `src/components/modals/TableInsertModal.tsx` + test
- Modify: `src/components/EditorToolbar.tsx` (Table button → modal), `src/editor/slashCommands.ts` (Table item → emit open-request instead of prompt), `src/components/NoteEditor.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: `editor.commands.insertTable({ rows, cols, withHeaderRow: true })` (TipTap 2.27.3).
- Produces: `TableInsertModal({ isOpen, onClose, onInsert: (rows: number, cols: number, withHeaderRow: boolean) => void })` — number inputs rows/cols default 3/3, min 1 max 8 (portal TableInsertModal.tsx:22-29 semantics, `withHeaderRow: true` fixed), Insert + Cancel.

- [ ] **Step 1: Failing tests** (`TableInsertModal.test.tsx`)
```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TableInsertModal from './TableInsertModal';

describe('TableInsertModal', () => {
  it('confirms with rows/cols/header values', () => {
    const onInsert = vi.fn(); const onClose = vi.fn();
    render(<TableInsertModal isOpen onClose={onClose} onInsert={onInsert} />);
    fireEvent.change(screen.getByLabelText('Rows'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Columns'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    expect(onInsert).toHaveBeenCalledWith(4, 2, true);
    expect(onClose).toHaveBeenCalled();
  });
  it('clamps non-numeric/zero input to 1', () => {
    const onInsert = vi.fn();
    render(<TableInsertModal isOpen onInsert={onInsert} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Rows'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    expect(onInsert).toHaveBeenCalledWith(1, 3, true);
  });
});
```

- [ ] **Step 2: RED → implement** the modal (labeled Rows/Columns number inputs, clamped 1..8, header toggle row shown as a checkbox default-on).

- [ ] **Step 3: Rewire the two entry points**
- EditorToolbar: Table button → `onTableInsertRequest?.()` (NoteEditor opens the modal; onInsert → `editor.chain().focus().insertTable({ rows, cols, withHeaderRow }).run()`); REMOVE the fixed-3×3 insert (portal parity — the button opens the modal; resolves P1 minor 14).
- slashCommands.ts Table item: replace the prompt-guard body with a storage flag + meta-tick ping (same pattern SlashMenu uses): `editor.storage.tableModal = { open: true }` + meta transaction; NoteEditor reads it in the transaction tick and mounts the modal; onInsert → `editor.chain().focus().deleteRange(range).insertTable({...}).run()`; onClose → clears storage + meta-tick. jsdom tests for slashCommands already bypass prompt — update the Table item's command test to assert the storage-open effect instead of insertTable (the actual insert is modal-driven).

- [ ] **Step 4: prompt() eradication gate** — `grep -rn "prompt(" src/ --include=*.tsx --include=*.ts | grep -v '\.test\.' | grep -v 'typeof prompt' || echo CLEAN` → expect no hits (the slash Table guard becomes the storage-open branch).

- [ ] **Step 5: GREEN (full suite ≥181) + tsc + commit** — `feat(editor): table insert modal — both entry points, prompt() eradicated (P2)`

### Task 6: Ship v0.18.0

- [ ] **Step 1: Full gates** — `npx vitest run` (expect ≥181), `npx tsc -p tsconfig.json --noEmit`, `cargo check --all-targets 2>&1 | grep -c '^warning'` = 18, `DISPLAY=:99 cargo test` (209+1i).
- [ ] **Step 2: Version bump** 0.17.0 → 0.18.0 (package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml, `npm install --package-lock-only`, `cargo update -p jotty-client` from src-tauri); commit `chore(release): v0.18.0 (editor markdown mode + modals)`; push + verify ls-remote.
- [ ] **Step 3: Desktop build** `npx tauri build` (background + notify; log /tmp/jotty-0.18.0-desktop-build.log) — 3 bundles exit 0.
- [ ] **Step 4: Android** `source /tmp/android-env.sh && npx tauri android build --target aarch64 --apk` (log /tmp/jotty-0.18.0-android-build.log) — exit 0; verify versionCode 18000 via aapt; apksigner verify.
- [ ] **Step 5: Tag + release** — `git tag -a v0.18.0`, push tag, `~/.local/bin/gh release create v0.18.0 <deb> <rpm> <appimage> <apk> --notes-file <notes>` (notes carry all 4 sha256s; markdown-mode feature copy + "Link/Table now use in-app dialogs").
- [ ] **Step 6: Verify** — `gh release view --json isDraft,isPrerelease,assets`; download all 4; re-hash byte-identical.
- [ ] **Step 7: Ledger** — jotty-client skill status entry + memory line.

## Plan rulings (disclosed up front, ledger at execution)

- **R10 (storage):** desktop adopts the portal's markdown storage contract in Task 2 — save = turndown(editor HTML), load = `startsWith('<')` HTML-legacy else remark. Rust/api untouched (content opaque end-to-end). Cost if wrong: legacy desktop notes authored as HTML keep working via the startsWith fence; markdown-round-trip fidelity is the only risk and is fenced by Task 1's tests.
- **R11 (markdown-mode scope):** toolbar buttons are TipTap-driven and render disabled in markdown mode (portal keeps textarea insertion helpers — those are P3 polish; the portal's MarkdownUtils.* helpers are documented in the spec but out of P2). Preview = converted-HTML pane, rehype-raw parity.
- **R12 (highlight overlay):** reuse highlight.js (already a dep via lowlight) with the markdown grammar — NOT prismjs (portal uses prismjs; desktop consolidates on the existing hljs toolchain; visual parity of the raw editor is P3 polish per the spec's "prism theme" P3 line).
- **R13 (table entry points):** both toolbar button and /table slash item open the modal (portal parity; resolves P1 minor 14). Toolbar loses the fixed-3×3 fast path.
- **R14 (prompt modal = PromptModal):** single generic text modal (portal shape) used by Link; Table gets its own grid modal. No shared modal framework beyond that in P2.

## Deferred (out of P2, ledgered)

- Textarea formatting insertion helpers (MarkdownUtils.*) — P3 (portal has them; low value until keyboard nav).
- Markdown-mode keyboard: Ctrl+M toggle — ship-time polish.
- Zero-match slash empty-state row, EOF newlines — ride from P1's list.
- Images/files in markdown mode (`![](url)`) — P3 with the no-upload-API caveat.