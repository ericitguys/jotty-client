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