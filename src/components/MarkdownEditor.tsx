import { useRef } from 'react';
import type { Editor } from '@tiptap/core';
import hljs from 'highlight.js/lib/core';
import markdown from 'highlight.js/lib/languages/markdown';
import { convertMarkdownToHtml } from '../editor/markdown';

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
    // not here). No textarea is rendered in preview mode.
    return (
      <div
        className="md-preview"
        dangerouslySetInnerHTML={{ __html: convertMarkdownToHtml(value) }}
      />
    );
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