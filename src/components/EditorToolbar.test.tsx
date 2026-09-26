import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
    expect(screen.getByRole('button', { name: 'Table' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    // active state styling flips on the bold button
    expect(screen.getByRole('button', { name: 'Bold' }).className).toContain('active');
  });

  it('toolbar is inert without an editor', () => {
    render(<EditorToolbar editor={null} />);
    expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled();
  });

  it('color dropdown applies a preset color; highlight toggles a mark', () => {
    const editor = makeEditor('<p>hi</p>');
    editor.commands.setTextSelection({ from: 1, to: 3 });
    render(<EditorToolbar editor={editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Text color' }));
    fireEvent.click(screen.getByRole('option', { name: 'Red' }));
    // The Red preset hex is stored verbatim on the textStyle mark. The
    // serialized inline style reads back CSSOM-normalized: prosemirror-model
    // applies `style` via dom.style.cssText, and both jsdom and Chromium
    // serialize the opaque color as rgb() — so the html never shows the hex.
    const json = editor.getJSON() as { content?: Array<{ content?: Array<{ marks?: Array<{ type: string; attrs?: { color?: string } }> }> }> };
    const marks = json.content?.[0]?.content?.[0]?.marks ?? [];
    expect(marks.some((m) => m.type === 'textStyle' && m.attrs?.color === '#ff5f57')).toBe(true);
    expect(editor.getHTML()).toContain('color: rgb(255, 95, 87)');
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

  // P2 task 5 (R13): the Table button routes through NoteEditor's
  // TableInsertModal via onTableInsertRequest — the P1 fixed 3x3 insert is
  // gone (both table entry points ask rows/cols through the shared modal).
  it('Table button routes through onTableInsertRequest — no fixed 3x3 insert', () => {
    const editor = makeEditor('<p>hi</p>');
    const onTableInsertRequest = vi.fn();
    render(<EditorToolbar editor={editor} onTableInsertRequest={onTableInsertRequest} />);
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(onTableInsertRequest).toHaveBeenCalledTimes(1);
    expect(editor.getHTML()).not.toContain('<table');
  });

  it('Table button stays inert when no handler is wired', () => {
    const editor = makeEditor('<p>hi</p>');
    render(<EditorToolbar editor={editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(editor.getHTML()).not.toContain('<table');
  });
});

// --- P3 task 6: the Diagrams / FontFamily / Extra dropdowns mount (portal
// TiptapToolbar order: Diagrams after Table, Extra after; FontFamily in its
// own cluster after the inline marks) + the text-color Default reset ---

describe('EditorToolbar P3 dropdowns', () => {
  it('mounts the three dropdowns in portal order and they drive the editor', () => {
    const editor = makeEditor('<p>hi</p>');
    render(<EditorToolbar editor={editor} />);
    const table = screen.getByRole('button', { name: 'Table' });
    const diagrams = screen.getByRole('button', { name: 'Diagrams' });
    const extra = screen.getByRole('button', { name: 'Extra items' });
    const fonts = screen.getByRole('button', { name: 'Font family' });
    // Diagrams after Table; Extra after Diagrams; FontFamily sits in its
    // own cluster with the inline marks — BEFORE the block cluster (Table).
    const FOLLOWING = typeof Node !== 'undefined' ? Node.DOCUMENT_POSITION_FOLLOWING : 4;
    expect(table.compareDocumentPosition(diagrams) & FOLLOWING).toBeTruthy();
    expect(diagrams.compareDocumentPosition(extra) & FOLLOWING).toBeTruthy();
    expect(fonts.compareDocumentPosition(table) & FOLLOWING).toBeTruthy();
    // through the Diagrams dropdown → the mermaid node inserts
    fireEvent.click(diagrams);
    fireEvent.click(screen.getByText('Mermaid Diagram'));
    expect(editor.getHTML()).toContain('data-mermaid');
  });

  it('the text-color palette carries the portal Default reset; picking it unsets the color', () => {
    const editor = makeEditor('<p>hi</p>');
    editor.commands.setTextSelection({ from: 1, to: 3 });
    render(<EditorToolbar editor={editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Text color' }));
    fireEvent.click(screen.getByRole('option', { name: 'Blue' }));
    expect(editor.getHTML()).toContain('rgb(87, 165, 255)');
    fireEvent.click(screen.getByRole('button', { name: 'Text color' }));
    fireEvent.click(screen.getByRole('option', { name: 'Default' }));
    expect(editor.getHTML()).not.toContain('rgb(87, 165, 255)');
    const marks = (
      editor.getJSON() as {
        content?: Array<{ content?: Array<{ marks?: Array<{ type: string; attrs?: { color?: string } }> }> }>;
      }
    ).content?.[0]?.content?.[0]?.marks ?? [];
    expect(marks.some((m) => m.type === 'textStyle' && m.attrs?.color)).toBe(false);
  });

  it('markdown mode: dropdown triggers stay enabled, TipTap-driven items disable, FontFamily hides', () => {
    const editor = makeEditor('<p>x</p>');
    render(<EditorToolbar editor={editor} markdownMode onToggleMode={() => {}} />);
    expect(screen.getByRole('button', { name: 'Diagrams' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Extra items' })).not.toBeDisabled();
    // portal TiptapToolbar :462-468 — FontFamily renders only in visual mode
    expect(screen.queryByRole('button', { name: 'Font family' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Diagrams' }));
    expect(screen.getByText('Draw.io Diagram').closest('button')).toBeDisabled();
    expect(screen.getByText('Mermaid Diagram').closest('button')).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Extra items' }));
    expect(screen.getByText('Image').closest('button')).toBeDisabled();
  });

  it('the Extra Image button plants the imageModal storage flag (button origin: range null)', () => {
    const editor = makeEditor('<p>x</p>');
    render(<EditorToolbar editor={editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Extra items' }));
    fireEvent.click(screen.getByText('Image'));
    const flag = (editor.storage as { imageModal?: { open: boolean; range: unknown } }).imageModal;
    expect(flag?.open).toBe(true);
    expect(flag?.range).toBeNull();
    expect(editor.getHTML()).not.toContain('<img');
  });
});