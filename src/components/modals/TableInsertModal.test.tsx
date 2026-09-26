import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { noteEditorExtensions } from '../../editor/extensions';
import TableInsertModal from './TableInsertModal';

function editorWith(content = '<p>hi</p>'): Editor {
  return new Editor({ extensions: noteEditorExtensions(), content });
}

function tableRows(editor: Editor): Array<unknown> {
  const json = editor.getJSON() as { content?: Array<{ type: string; content?: unknown[] }> };
  const table = json.content?.find((n) => n.type === 'table');
  return table?.content ?? [];
}

describe('TableInsertModal', () => {
  // Pre-condition folded from Task 1 (P1): already pinned by extensions.test.ts
  // and TableToolbar.test.tsx — kept here as the modal flow's own schema guard.
  it('pre-condition: table html parses to a table node and round-trips <th', () => {
    const editor = editorWith('<table><tr><th>h</th></tr><tr><td>c</td></tr></table>');
    const json = editor.getJSON() as { content?: Array<{ type: string }> };
    expect(json.content?.some((n) => n.type === 'table')).toBe(true);
    expect(editor.getHTML()).toContain('<th');
  });

  it('renders nothing when closed', () => {
    render(<TableInsertModal isOpen={false} onInsert={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('defaults to 3x3 with the header row checked', () => {
    render(<TableInsertModal isOpen onInsert={() => {}} onClose={() => {}} />);
    expect(screen.getByLabelText('Rows')).toHaveValue(3);
    expect(screen.getByLabelText('Columns')).toHaveValue(3);
    expect(screen.getByLabelText('Header row')).toBeChecked();
  });

  it('confirms with rows/cols/header values and closes', () => {
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

  it('clamps values above 8 to 8', () => {
    const onInsert = vi.fn();
    render(<TableInsertModal isOpen onInsert={onInsert} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Columns'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    expect(onInsert).toHaveBeenCalledWith(3, 8, true);
  });

  it('Cancel, Escape and backdrop click close without inserting', () => {
    const onInsert = vi.fn(); const onClose = vi.fn();
    render(<TableInsertModal isOpen onClose={onClose} onInsert={onInsert} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(document.querySelector('.modal-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onInsert).not.toHaveBeenCalled();
  });

  // Real-behavior test (over a real headless editor, like the EditorToolbar
  // tests): the payload this modal reports drives insertTable end to end.
  it('its onInsert payload drives insertTable on a real editor', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setTextSelection(1);
    render(
      <TableInsertModal
        isOpen
        onClose={() => {}}
        onInsert={(rows, cols, withHeaderRow) =>
          editor.chain().focus().insertTable({ rows, cols, withHeaderRow }).run()
        }
      />
    );
    fireEvent.change(screen.getByLabelText('Rows'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Columns'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    expect(tableRows(editor)).toHaveLength(4);
    expect(editor.getHTML()).toContain('<th');
  });
});