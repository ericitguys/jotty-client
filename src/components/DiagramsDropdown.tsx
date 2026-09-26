import type { Editor } from '@tiptap/core';
import { DEFAULT_MERMAID } from '../editor/extensions/diagrams';
import ToolbarDropdown, { ToolbarDropdownItem } from './ToolbarDropdown';

// Portal DiagramsDropdown.tsx port (P3 task 6): trigger (gravity glyph +
// caret, title "Diagrams" — portal t('editor.diagrams')) over the three
// insert items. Mermaid inserts the portal default template; in markdown
// mode it splices a ```mermaid fence into the raw editor's textarea at the
// cursor (portal insertMermaid — the editor instance is hidden but the
// textarea is the markdown-mode source of truth), while draw.io and
// Excalidraw are TipTap-driven and render disabled there with the portal
// "Rich mode only" hint (DiagramsDropdown.tsx:93-124).
interface DiagramsDropdownProps {
  editor: Editor | null;
  markdownMode?: boolean;
  disabled?: boolean;
  onMarkdownChange?: (md: string) => void;
}

export default function DiagramsDropdown({ editor, markdownMode = false, disabled = false, onMarkdownChange }: DiagramsDropdownProps) {
  const md = !!markdownMode;
  const active = !!(editor && (editor.isActive('mermaid') || editor.isActive('drawio') || editor.isActive('excalidraw')));

  // Markdown-mode insert (portal markdown-editor-utils insertMermaid):
  // ```mermaid fence at the textarea cursor. The desktop raw editor's
  // textarea is .md-editor-area (the portal's #markdown-editor-textarea);
  // the new content routes through onMarkdownChange (the same
  // setMarkdownDraft + autosave path the raw editor's typing uses).
  const insertMermaidMarkdown = () => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.md-editor-area');
    if (!textarea || !onMarkdownChange) return;
    const value = textarea.value;
    const start = textarea.selectionStart ?? value.length;
    const end = textarea.selectionEnd ?? start;
    const prefix = '```mermaid\n';
    const fence = prefix + DEFAULT_MERMAID + '\n```\n';
    const newline = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
    onMarkdownChange(value.slice(0, start) + newline + fence + value.slice(end));
    // Portal handleMarkdownButtonClick: restore the caret into the
    // textarea after React applies the controlled value.
    const pos = start + newline.length + prefix.length + DEFAULT_MERMAID.length + 1;
    requestAnimationFrame(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.md-editor-area');
      if (ta) ta.setSelectionRange(pos, pos);
    });
  };

  const insertMermaid = () => {
    if (!editor) return;
    if (md) {
      insertMermaidMarkdown();
      return;
    }
    editor.chain().focus().setMermaid(DEFAULT_MERMAID).run();
  };

  return (
    <ToolbarDropdown
      glyph="△"
      ariaLabel="Diagrams"
      active={active}
      disabled={disabled || !editor}
      menuClassName="edt-diagrams-menu"
    >
      <ToolbarDropdownItem
        glyph="📊"
        label="Mermaid Diagram"
        desc="Text-based flowcharts & diagrams"
        disabled={disabled}
        onClick={insertMermaid}
      />
      <ToolbarDropdownItem
        glyph="🖌️"
        label="Draw.io Diagram"
        desc={md ? 'Rich mode only' : 'Visual diagram editor'}
        disabled={disabled || md}
        title={md ? 'Not available in markdown mode' : undefined}
        onClick={() => { if (editor && !md) editor.chain().focus().insertDrawIo().run(); }}
      />
      <ToolbarDropdownItem
        glyph="✏️"
        label="Excalidraw Diagram"
        desc={md ? 'Rich mode only' : 'Sketch-style diagram editor'}
        disabled={disabled || md}
        title={md ? 'Not available in markdown mode' : undefined}
        onClick={() => { if (editor && !md) editor.chain().focus().insertExcalidraw().run(); }}
      />
    </ToolbarDropdown>
  );
}