// FIELD BUG 2026-10-18 #2 (prod note "test"): the client distinguishes
// LEGACY full-HTML note bodies (pre-markdown-storage era, written by the old
// client as raw editor HTML) from MARKDOWN via `startsWith('<')`. That
// detector misfired on markdown whose FIRST BLOCK is an inline-HTML element —
// e.g. `<span style="color: …">…` — feeding raw markdown to TipTap as HTML
// (document structure collapsed into one paragraph blob) and letting the
// Save-flush run turndown over the markdown string, destroying the note on
// the server. The old client's only HTML writer was TipTap getHTML, whose
// root is always a BLOCK element (p/h1-6/ul/ol/blockquote/pre/table/div) —
// markdown, by contrast, can legitimately OPEN with any inline tag (span,
// mark, u, sub, sup, kbd, abbr, img) or a raw comment/details block produced
// by the serializer. So: legacy only when the first tag is one of those
// block shapes; everything else is markdown.

// Block-level shapes that a legacy (pre-markdown-storage) full-HTML note body
// starts with. Client getHTML roots only ever emitted these — the pre-P2 editor
// had NO table extension and never emitted a bare root <div>, so <table>/<div>
// openers are MARKDOWN by definition (p19/F2: they render + round-trip
// losslessly through the remark path).
const LEGACY_HTML_FIRST_BLOCK = /^<(p|h[1-6]|ul|ol|blockquote|pre)\b/i;

export const isLegacyHtmlDoc = (content: string): boolean => {
  const trimmed = content.trim();
  return trimmed.startsWith('<') && LEGACY_HTML_FIRST_BLOCK.test(trimmed);
};