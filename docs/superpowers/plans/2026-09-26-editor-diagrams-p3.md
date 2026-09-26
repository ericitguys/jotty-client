# Plan — editor diagrams + rich blocks P3 (v0.19.0 target)

jotty·desktop portal-parity Phase 3. BASE: `0fbb507` (v0.18.0). SDD on main, sequential implementers + independent reviewers (P1/P2 pattern). Ledger: `.superpowers/sdd/2026-09-26-editor-diagrams-p3/progress.md`.

## Scope (upstream inventory @ b5458a2 — research deleg_7c35bd44, sa-0-39a7ba9a)

Features ported this phase: **Mermaid diagrams, Draw.io diagrams, Excalidraw diagrams, Collapsible (details), Callouts, FontFamily, Image (URL + size + resize), FileAttachment (URL-only), Abbreviation, kbd mark, ExtraItems/Diagrams dropdowns + slash items, preview-pane rendering of all shapes**.

Persistence shapes (portal-exact, `markdown-utils.tsx` / `custom-html-utils.tsx` line refs from inventory):

| Feature | Content shape on disk |
|---|---|
| Mermaid | fenced ```` ```mermaid ```` block (turndown rule `div[data-mermaid]` → fence; remark parse-back `pre>code.language-mermaid` → `div[data-mermaid][data-mermaid-content]`, markdown-utils.tsx:352-365 / 730-768) |
| Draw.io | HTML comment `<!-- drawio-diagram\ndata: <b64 xml>\nsvg: <b64 svg>\ntheme: light -->` (turndown :367-385; remark :462-495 → `div[data-drawio-data/-svg/-theme]`) |
| Excalidraw | HTML comment `<!-- excalidraw-diagram\ndata: <b64 scene>\nsvg: <b64>\ntheme: light -->` (turndown :387-405; remark :496-527) |
| Collapsible | raw HTML `\n<details>\n<summary>S</summary>\n\nC\n\n</details>\n` (turndown :208-222) |
| Callout | GFM blockquote `> [!INFO]\n> line` — types info\|warning\|success\|danger (turndown :407-422; remark :705-728 → `div[data-type=callout][data-callout-type]`) |
| Font family | inline HTML `<span style="font-family: F">text</span>` (turndown custom-html-utils.tsx:126-146, quotes → `'`) |
| Abbreviation | `<abbr title="T">text</abbr>` (custom-html-utils.tsx:37-41,148-161) |
| kbd (tiny) | `<kbd>` mark (custom-html-utils.tsx:23-27) |
| Image | unsized `![alt](src)`; sized `<img src alt style="width: Npx; height: Npx"/>` (turndown :276-306; remark :531-544 re-adds width/height) |
| File | image `![name](url)`; video `[🎥 name](url)`; file `[📎 name](url)` (turndown :233-254; InputRules parse-back :137-173) |

TipTap shapes: custom nodes `mermaid` (block/atom, attr `content`), `drawio` (attrs diagramData/svgData/themeMode), `excalidraw` (same), `details` (block, `content: block+`, `defining`, attr `summary`), `callout` (block+, attr `type`), `fileAttachment` (block/atom on `p[data-file-attachment]`, attrs url/fileName/mimeType/type); custom MARKS `fontFamily` (span[style*='font-family'], parsed from element.style), `abbreviation` (abbr[title]), `kbd`; Image = `@tiptap/extension-image` + `width`/`height`/`style` attrs. Insert commands: `setMermaid`, `insertDrawIo`, `insertExcalidraw`, details wrap, `setCallout`, `setFileAttachment`, `setImage({src,width,height})`, `setMark('fontFamily'|'abbreviation'|'kbd')`.

Deps (pinned, one deps task only): `mermaid@10.9.8` · `@excalidraw/excalidraw@0.18.1` (⚠ verify React 18 peers — upstream pairs React 19.2.4; if peer conflict → verify 0.17.x fallback or lazy-dynamic-import w/ peer warning accepted + fence test) · `@tiptap/extension-image@^2.27.3` (**never bare-install — v3 peer conflict**) · draw.io/details/callout/fontFamily/abbreviation/kbd/fileAttachment = **zero deps** (hand-rolled Node/Mark on installed core; upstream's `@rcode-link/tiptap-drawio@1.0.21` is UNUSED by portal features — do not add).

## Rulings (bind all tasks)

- **R18 — FileAttachment is URL-only on desktop.** Portal FileModal uploads via Next Server Action `uploadFile` (`app/_server/actions/upload/index.ts`, writes `data/notes/<u>/{images,videos,files}` → `/api/image|video|file/<u>/<f>` URLs). NO REST upload endpoint exists server-side (grep: only app-icons route writes). Desktop: file insert = PromptModal **"Attachment URL"** (paste any https URL; type sniffed from the URL: `/api/image/`→image, `/api/video/`→video, else file — mirrors upstream sniff) → `setFileAttachment({url,fileName,mimeType,type})`. NO FileModal/upload. Disclosed limitation: desktop-created attachments must reference externally-served URLs; portal-uploaded files (existing URLs) render/round-trip fine.
- **R19 — Preview-pane enhancement, not a react-markdown rewrite.** The P2 preview (`MarkdownEditor.tsx`) keeps `convertMarkdownToHtml` + `dangerouslySetInnerHTML`, then a `useEffect` post-process enriches the rendered fragment: `[data-mermaid]` → `mermaid.render` (theme from CSS vars) with error-box fallback; `[data-drawio-data]`/`[data-excalidraw-data]` → atob-decode → inline SVG (+ dark invert filter); callout divs render as-is via CSS. jsdom gates: SVG-injection logic testable via data-driven unit tests on the helpers (mermaid.render itself = ship-QA class).
- **R20 — `toggleWrap` is NOT assumed on @tiptap/core 2.27.3.** T2 FIRST verifies against installed `node_modules/@tiptap/core` d.ts (grep `toggleWrap`); if absent, implement custom `toggleDetails` (wrapIn-details / unwrap-when-inside) — documented adaptation.
- **R21 — NodeViews are ship-time visual QA.** mermaid/excalidraw/drawio renderers are canvas/SVG/iframe heavy (jsdom-blind): headless gates cover serialize/parse/round-trip + attrs/commands only. Excalidraw editor = lazy dynamic import `{ ssr: false }`; excalidraw.css asset copied/injected at open (portal `/themes/excalidraw/excalidraw.css` → desktop src/assets).
- **R22 — Draw.io edit surface = iframe `https://embed.diagrams.net/?embed=1&ui=kennedy&spin=1&proto=json&saveAndExit=1&noSaveBtn=0` + postMessage protocol** (origin check `includes("diagrams.net")`), fullscreen modal, dark invert on render; no `api/diagram-proxy` (server-side), no `@rcode-link/tiptap-drawio` (upstream carries it unused).
- **R23 — prompt() stays eradicated**: slash Image item (upstream still `window.prompt("Image URL")`) routes through PromptModal ("Add Image"/"Enter image URL") → ImageSizeModal ("Image Size", Width (px)/Height (px) placeholders "Auto", hint "Leave empty for auto size", Reset/Cancel/Apply); Abbreviation via PromptModal ("Abbreviation"/"Enter abbreviation title (e.g., HyperText Markup Language)").
- Carried: zeus/zeus@local commits; never cargo fmt; tokens-only CSS; no Tailwind; src-tauri untouched; new @tiptap/* pinned ^2.27.3; existing suites stay green; one unhandled rejection (ChecklistView/App.test) = known cosmetic.

## Tasks

- **T1 — serialization layer** (`src/editor/markdown.ts` + `markdown.test.ts`): turndown rules + remark visitors for ALL shapes in the table (mermaid fence, drawio/excalidraw comments, details, callout blockquote-regex, fontFamily span, abbr, kbd, img width/height↔style, fileAttachment p[data-file-attachment]→📎/🎥/! links). Gates: new round-trip tests (each shape HTML→md→HTML stable; md→editor-parse→getHTML→md stable); full suite ≥202; tsc clean.
- **T2 — custom TipTap extensions** (`src/editor/extensions/diagrams.ts` et al or per-feature files + registration in `noteEditorExtensions()` + tests): nodes mermaid/drawio/excalidraw/details/callout/fileAttachment + marks fontFamily/abbreviation/kbd (renderHTML/parseHTML per shapes above; insert commands; Backspace-out/Enter-escape shortcuts per portal where applicable — details :71-90, callout :162-216). R20 toggleWrap check first. Gates: headless round-trip + command tests; suite grows +N.
- **T3 — deps + renderers + preview**: package.json += mermaid@10.9.8, @excalidraw/excalidraw@0.18.1 (peer-gated per R21), @tiptap/extension-image@^2.27.3; `MermaidRenderer.tsx` / `DrawioRenderer.tsx` / `ExcalidrawRenderer.tsx` (SVG inline + dark invert filter); preview-pane post-process enhancement in MarkdownEditor (R19) + tests for the enhancement walk (jsdom-testable parts); `cargo check` untouched (JS-only); tsc clean.
- **T4 — Image feature**: extension-image attrs (width/height/style) + insert flow (PromptModal → ImageSizeModal w/ live preview) + drag-resize overlay (useImageResize port: px from style attr → setNodeMarkup) + slash Image modalization (R23) + tests (modal wiring, attrs, turndown sizing).
- **T5 — FileAttachment node + URL insert** (R18): node + marks/parse InputRules (📎/🎥/![img]) + PromptModal "Attachment URL" flow + preview rendering (📎/🎥 link override) + tests. BLOCKED-items documentation in report.
- **T6 — UI surfaces + polish**: DiagramsDropdown (3 items, "Diagrams" title; drawio/excalidraw disabled in markdown mode, mermaid textarea-inserts), FontFamilyDropdown (searchable, "Search fonts...", ~110 system fonts, "Default" first — portal labels), ExtraItemsDropdown += Image/File/Abbreviation/Collapsible (⌘⇧I/⌘⇧F/⌘⇧A/⌘⇧D), slash items (Mermaid Diagram/Draw.io Diagram/Excalidraw Diagram/Collapsible/Callout/Image/File w/ portal labels; callout type via icon DropdownMenu Info/Warning/Success/Danger); polish = deferred minors triage (color-reset in palette, `<mark>` default color, sub/sup output asserts — portal labels verbatim). CSS tokens only. Gates + tsc.
- **T7 — ship v0.19.0** (controller): whole-branch review → gate confirm ("starting now — confirm?") → bump 0.18.0→0.19.0 → vitest + tsc + warnings census + DISPLAY=:99 cargo test → desktop build → Android APK → tag + release + re-hash byte-identical → ntfy `jotty-builds` ping at build start.

## Global constraints

No Tailwind — var tokens only; `src-tauri/` untouched; no new deps outside T3's three (pins verbatim); commit identity `git -c user.name=zeus -c user.email=zeus@local commit`; NEVER `cargo fmt`; prompt() eradication stands (grep gate 0, R23 flows); every brief-vs-controller conflict → controller context wins, documented.