import { useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import hljs from 'highlight.js/lib/core';
import markdown from 'highlight.js/lib/languages/markdown';
import { convertMarkdownToHtml } from '../editor/markdown';
import { enhanceDiagramFragment, renderMermaidToSvg } from './diagrams/diagramUtils';

// R12 (plan): the desktop consolidates on highlight.js (the TipTap code-block
// path already uses it via lowlight) — the raw-editor overlay registers the
// markdown grammar directly; prismjs stays portal-only.
hljs.registerLanguage('markdown', markdown);

// Markdown mode (P2 Task 3): controlled textarea with a highlight.js
// syntax-highlighted overlay synced to the textarea's value and scroll, an
// optional line-numbers gutter, and a read-only preview rendered from the
// same value. `editor` is unused here in markdown mode — the prop exists for
// symmetry with the visual-mode wiring (the TipTap instance stays mounted and
// alive under NoteEditor; this component never touches it).
interface MarkdownEditorProps {
  value: string;
  onChange: (md: string) => void;
  editor: Editor | null;
  preview?: boolean;
  showLineNumbers?: boolean;
}

export default function MarkdownEditor({
  value,
  onChange,
  preview = false,
  showLineNumbers = true,
}: MarkdownEditorProps) {
  const overlayRef = useRef<HTMLPreElement>(null);

  if (preview) {
    // Read-only preview: the same remark/rehype pipeline the storage contract
    // uses (raw HTML passes through; script stripping happens at TipTap load,
    // not here). No textarea is rendered in preview mode. Diagram shapes
    // (R19) are enriched in place by <MarkdownPreview> below.
    return <MarkdownPreview value={value} />;
  }

  const lines = value.split('\n');
  // Guarded highlight: a pathological raw-HTML token stream can raise
  // (illegal lexeme) and take the whole editor view down with it — fall back
  // to escaped plain text so markdown mode always renders.
  let highlighted: string;
  try {
    highlighted = hljs.highlight(value, { language: 'markdown', ignoreIllegals: true }).value;
  } catch {
    highlighted = value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
  }
  return (
    <div className="md-editor">
      {showLineNumbers && (
        <div className="md-editor-gutter" aria-hidden="true">
          {lines.map((_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
      )}
      <div className="md-editor-stack">
        <pre
          ref={overlayRef}
          className="md-editor-overlay"
          aria-hidden="true"
        >
          <code
            className="hljs language-markdown"
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </pre>
        <textarea
          className="md-editor-area"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            const t = e.currentTarget;
            if (overlayRef.current) {
              overlayRef.current.scrollTop = t.scrollTop;
              overlayRef.current.scrollLeft = t.scrollLeft;
            }
          }}
          spellCheck={false}
        />
      </div>
    </div>
  );
}

// R19 (plan): the preview keeps the convertMarkdownToHtml +
// dangerouslySetInnerHTML pipeline, then a post-process walk enriches the
// rendered fragment in place — ```mermaid fences arrive as
// div[data-mermaid][data-mermaid-content] (rendered via guarded lazy
// mermaid.render, theme from the live CSS custom properties, error-box
// fallback), and draw.io / excalidraw shapes arrive as
// div[data-drawio-*] / div[data-excalidraw-*] with RAW svg payloads
// (base64-tolerant), injected inline with the dark-mode invert filter.
// The walk is idempotent (data-diagram-done / data-diagram-mermaid flags)
// and every injection re-checks node connectivity, so re-renders and
// double-mounts never double-render.
function MarkdownPreview({ value }: { value: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    enhanceDiagramFragment(containerRef.current, {
      renderMermaid: (code) => renderMermaidToSvg(code),
    }).catch(() => {
      // The walk itself never rejects (per-block try/catch), but a full
      // rejection must never take the preview down.
    });
  }, [value]);

  return (
    <div
      ref={containerRef}
      className="md-preview"
      dangerouslySetInnerHTML={{ __html: convertMarkdownToHtml(value) }}
    />
  );
}