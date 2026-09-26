import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { noteEditorExtensions } from '../editor/extensions';
import TableToolbar from './TableToolbar';

function editorWith(content = '<p>hi</p>'): Editor {
  return new Editor({ extensions: noteEditorExtensions(), content });
}

// Cursor position inside the first cell's paragraph: table → row → cell →
// paragraph → content is pos + 4 — the deterministic way to park the caret
// inside the table under test (insertTable itself lands the caret there too).
function firstCellPos(editor: Editor): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'table') {
      found = pos + 4;
      return false;
    }
    return true;
  });
  return found;
}

function tableRows(editor: Editor): Array<unknown> {
  const json = editor.getJSON() as { content?: Array<{ type: string; content?: unknown[] }> };
  const table = json.content?.find((n) => n.type === 'table');
  return table?.content ?? [];
}

describe('TableToolbar', () => {
  // Pre-condition folded from Task 1 (extensions.test.ts pins the same schema
  // behavior) — the bar's commands only operate on a parsed/serializable table.
  it('pre-condition: table html parses to a table node and round-trips <th', () => {
    const editor = editorWith('<table><tr><th>h</th></tr><tr><td>c</td></tr></table>');
    const json = editor.getJSON() as { content?: Array<{ type: string }> };
    expect(json.content?.some((n) => n.type === 'table')).toBe(true);
    expect(editor.getHTML()).toContain('<th');
  });

  it('insertTable 3x3 produces 3 rows with a header row; addRowAfter adds a row; deleteTable removes it', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setTextSelection(1);
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    expect(tableRows(editor)).toHaveLength(3);
    expect(editor.getHTML()).toContain('<th');

    editor.commands.setTextSelection(firstCellPos(editor));
    editor.chain().focus().addRowAfter().run();
    expect(tableRows(editor)).toHaveLength(4);

    editor.chain().focus().deleteTable().run();
    const json = editor.getJSON() as { content?: Array<{ type: string }> };
    expect(json.content?.some((n) => n.type === 'table')).toBe(false);
  });

  it('renders the six table controls while visible and hides when not', () => {
    const editor = editorWith('<table><tr><th>h</th></tr><tr><td>c</td></tr></table>');
    const names = ['Row +', 'Row -', 'Col +', 'Col -', 'Delete table', 'Header toggle'];
    const { rerender } = render(<TableToolbar editor={editor} visible={true} />);
    for (const name of names) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    rerender(<TableToolbar editor={editor} visible={false} />);
    for (const name of names) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('clicking Row + executes addRowAfter on the editor', () => {
    const editor = editorWith('<table><tr><th>h</th></tr><tr><td>c</td></tr></table>');
    editor.commands.setTextSelection(firstCellPos(editor));
    render(<TableToolbar editor={editor} visible={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Row +' }));
    expect(tableRows(editor)).toHaveLength(3);
  });

  it('clicking Header toggle converts the header row and Delete table removes the table', () => {
    const editor = editorWith('<table><tr><th>h</th></tr><tr><td>c</td></tr></table>');
    editor.commands.setTextSelection(firstCellPos(editor));
    render(<TableToolbar editor={editor} visible={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Header toggle' }));
    expect(editor.getHTML()).not.toContain('<th'); // header row converted to body cells
    fireEvent.click(screen.getByRole('button', { name: 'Delete table' }));
    expect(editor.getHTML()).not.toContain('<table');
  });
});