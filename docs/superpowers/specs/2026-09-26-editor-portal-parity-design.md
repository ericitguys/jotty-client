# Editor Portal-Parity Design (desktop note editor)

**Date:** 2026-09-26
**Status:** Approved direction (user: "look at the portal UI for the editor features and lay out. fully copy it" → "do them all, take your time")
**Upstream reference:** /tmp/jotty-upstream @ b5458a2 (source-verified throughout)

## 1. Goal

The desktop note editor copies the portal (web) jotty editor's features and layout:
a sticky toolbar over the editor content, dual editing modes (Visual ⇄ Markdown),
a selection bubble menu, slash commands, and the full formatting/diagram feature
set — same buttons, same behavior, same keyboard shortcuts.

## 2. Portal inventory (source-verified, b5458a2)

### 2.1 Layout
- Sticky toolbar row (`bg-background border-b px-4 py-2`) at the top of the editor:
  left cluster = mode buttons (Rich ⇄ Markdown toggle, mobile preview toggle);
  main cluster = feature buttons in a horizontally scrollable row.
- Below: either the VisualEditor (TipTap) or the MarkdownEditor (raw textarea),
  plus overlays (upload overlay, image-resize overlay, table toolbar).
- Bubble menu over selected text (bold/italic/underline/strike/link).
- Modals: link (text+url), table insert, image size, file.

### 2.2 Toolbar buttons (visual mode)
Bold (⌘B) · Italic (⌘I) · Underline (⌘U) · Strikethrough (⌘⇧X) · Inline code (⌘E)
| Font-family dropdown | Heading H2 toggle | List menu (bullet / ordered / indent / outdent)
| Blockquote (⌘⇧B) | Link (⌘⇧K) | (contextual: image size)
| Code-blocks dropdown (37→46 languages) | Diagrams dropdown (Mermaid / Draw.io / Excalidraw)
| Extra dropdown (Image ⌘⇧I, File ⌘⇧F, Table ⌘⇧T, Highlight ⌘⇧H, Subscript ⌘,,
  Superscript ⌘., Abbreviation ⌘⇧A, Collapsible ⌘⇧D)

### 2.3 Extensions (editorConfig.ts)
StarterKit (minus codeBlock/underline/link/listItem/bulletList/hardBreak) ·
custom-HTML extensions · Details (collapsible) · Callout · KeyboardShortcuts ·
Overlay (image/table click) · TextStyle · Color · Highlight multicolor ·
SlashCommands (14 inserters + note/checklist/tag/@mention search) · InternalLink ·
TagLink · Underline · HardBreak · CodeBlock+NodeView+PrismPlugin · Link ·
Image (with style attr) · FileAttachment · Mermaid · Drawio · Excalidraw ·
Table (resizable, content tableRow+) · TableRow · TableHeader · TableCell (block+)
· ListItem (block+) · TaskList · TaskItem (nested, data-checked) · BulletList (listItem+)

### 2.4 Slash command menu (14 entries)
Heading 1/2 · bullet list · ordered list · task list · code block · quote ·
table · image · collapsible · callout · mermaid · drawio · excalidraw
(+ embedded note/checklist/tag search suggestions)

### 2.5 Modes
- Visual mode: TipTap (above extensions).
- Markdown mode: raw textarea (SyntaxHighlightedEditor = textarea + prism
  markdown highlighting + optional line numbers + visual guide ruler) +
  preview toggle (UnifiedMarkdownRenderer). Toolbar buttons keep working in
  markdown mode via textarea text-insertion helpers (MarkdownUtils.*).

### 2.6 Storage contract (both apps)
- Stored note content is MARKDOWN (web) with raw-HTML accepted when the content
  starts with `<` (web init: `startsWith("<") ? content : convertMarkdownToHtml(content)`).
- Web save path: HTML → turndown (codeBlockStyle fenced) → markdown.
- Desktop save path today: `editor.getHTML()` saved as-is (HTML convention).
  **Parity change:** adopt the web's contract — visual edits serialize to
  markdown before persisting; markdown notes parse to HTML on load. This makes
  desktop notes round-trip with the web renderer (fences, task lists, tables).

## 3. Desktop architecture (this repo)

- React + TipTap 2.27 (jsdom-tested, vitest). Reuse `src/editor/extensions.ts`
  (v0.16.0 code-block/lowlight work) as the base and grow it.
- Markdown conversion: `turndown` (HTML→md) + `unified`/`remark-parse`/`remark-gfm`/
  `remark-rehype`/`rehype-raw`/`rehype-stringify` (md→HTML) — the SAME libraries
  the portal uses, so round-trips behave identically.
- New components: `EditorToolbar` (sticky, desktop CSS), `BubbleMenu` (selection),
  `SlashCommands` extension + suggestion list, `MarkdownMode` (textarea +
  preview), modals (link/table/image-size), `TaskList/TaskItem/Table/TextStyle/
  Color/Highlight/Underline/Subscript/Superscript/Details/Callout` wiring.
- No Tailwind: restyle to this app's CSS tokens (existing pattern — jotty-dropdown,
  kanban board CSS).

### 3.1 The one unavoidable deviation: file uploads
The portal uploads images/files to the server. Upstream jotty's REST API has NO
file-upload endpoint (established in the voice-notes spec: audio can't sync for
the same reason). Desktop-side: images/files = URL references only
(`![alt](url)`), or skipped. Documented as the single parity gap; revisit only
if upstream adds an upload API.

## 4. Phases

- **P1 Core toolbar parity** — sticky toolbar (bold/italic/underline/strike/
  inline-code, heading, bullet/ordered lists, blockquote, link, code-language
  picker [v0.16.0], undo/redo), bubble menu on selection, slash commands
  (headings/lists/task list/code/quote/table), task lists, tables (insert +
  context toolbar), text color + highlight, underline, sub/superscript.
- **P2 Markdown mode** — visual⇄markdown toggle; raw editing (syntax-highlighted
  textarea, line numbers optional) + preview toggle; toolbar works in both
  modes (textarea insertion helpers); storage round-trip via turndown/remark.
- **P3 Rich extras** — images (URL insert + size), collapsible details, callouts,
  abbreviations, font family, prism theme for code blocks, Mermaid rendering
  (render-only, bundled mermaid lib), Draw.io/Excalidraw embed placeholders.
- **P4 (conditional)** — file/image attachment UX within the no-upload-API limit.

## 5. Testing

- Headless editor tests (vitest + @tiptap/core) per extension: parse/serialize
  round-trips pinned (task list items, tables, marks, details, callouts).
- Component tests per toolbar button + bubble menu + slash menu (RTL).
- Round-trip property tests: markdown→HTML→markdown idempotence on a fixture
  corpus (fences w/ language, task lists, tables, nested lists, quotes).
- Existing fences untouched; gates re-censused per phase.

## 6. Release mapping

P1 → v0.17.0; P2 → v0.18.0; P3 → v0.19.0 (versions adjust as needed). Each phase
ships through the standing ship procedure (TDD, gates, bundles, APK, release).