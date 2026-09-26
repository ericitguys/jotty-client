import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { noteEditorExtensions } from '../editor/extensions';
import ExtraItemsDropdown from './ExtraItemsDropdown';

function makeEditor(content = '<p>x</p>'): Editor {
  return new Editor({ extensions: noteEditorExtensions(), content });
}

describe('ExtraItemsDropdown (P3 task 6)', () => {
  const editors: Editor[] = [];
  afterEach(() => {
    for (const ed of editors.splice(0)) ed.destroy();
  });

  it('renders Image/File/Abbreviation/Collapsible with the portal shortcut hints', () => {
    const editor = makeEditor('<p>x</p>');
    editors.push(editor);
    render(<ExtraItemsDropdown editor={editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Extra items' }));
    expect(screen.getByText('Image')).toBeTruthy();
    expect(screen.getByText('File')).toBeTruthy();
    expect(screen.getByText('Abbreviation')).toBeTruthy();
    expect(screen.getByText('Collapsible')).toBeTruthy();
    expect(screen.getByText('⇧CtrlI')).toBeTruthy();
    expect(screen.getByText('⇧CtrlF')).toBeTruthy();
    expect(screen.getByText('⇧CtrlA')).toBeTruthy();
    expect(screen.getByText('⇧CtrlD')).toBeTruthy();
  });

  it('omits the items that shipped as toolbar buttons (Table/Highlight/Sub/Sup)', () => {
    const editor = makeEditor('<p>x</p>');
    editors.push(editor);
    render(<ExtraItemsDropdown editor={editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Extra items' }));
    expect(screen.queryByText('Table')).toBeNull();
    expect(screen.queryByText('Highlight')).toBeNull();
    expect(screen.queryByText('Subscript')).toBeNull();
    expect(screen.queryByText('Superscript')).toBeNull();
  });

  it('Image plants the existing imageModal storage flag (button origin: range null) + meta tick, no insert', () => {
    const editor = makeEditor('<p>x</p>');
    editors.push(editor);
    render(<ExtraItemsDropdown editor={editor} />);
    const metas: unknown[] = [];
    editor.on('transaction', ({ transaction }: { transaction: { getMeta: (k: string) => unknown } }) => {
      metas.push(transaction.getMeta('imageModal'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Extra items' }));
    fireEvent.click(screen.getByText('Image'));
    const flag = (editor.storage as { imageModal?: { open: boolean; range: unknown } }).imageModal;
    expect(flag?.open).toBe(true);
    // button origin — nothing to delete at confirm (T4 contract, range null)
    expect(flag?.range).toBeNull();
    expect(metas.filter(Boolean).length).toBe(1);
    expect(editor.getHTML()).not.toContain('<img');
  });

  it('File plants the existing fileModal storage flag (button origin: range null) + meta tick, no insert', () => {
    const editor = makeEditor('<p>x</p>');
    editors.push(editor);
    render(<ExtraItemsDropdown editor={editor} />);
    const metas: unknown[] = [];
    editor.on('transaction', ({ transaction }: { transaction: { getMeta: (k: string) => unknown } }) => {
      metas.push(transaction.getMeta('fileModal'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Extra items' }));
    fireEvent.click(screen.getByText('File'));
    const flag = (editor.storage as { fileModal?: { open: boolean; range: unknown } }).fileModal;
    expect(flag?.open).toBe(true);
    expect(flag?.range).toBeNull();
    expect(metas.filter(Boolean).length).toBe(1);
    expect(editor.getHTML()).not.toContain('data-file-attachment');
  });

  it('Collapsible toggles a details wrap around the selection (summary from the selection)', () => {
    const editor = makeEditor('<p>x</p>');
    editors.push(editor);
    render(<ExtraItemsDropdown editor={editor} />);
    editor.commands.setTextSelection({ from: 1, to: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Extra items' }));
    fireEvent.click(screen.getByText('Collapsible'));
    // T2 shape: the summary serializes BOTH as the details attr and the
    // summary child element (the extension renders attr + summary child).
    expect(editor.getHTML()).toContain('<details');
    expect(editor.getHTML()).toContain('<summary>x</summary>');
  });

  it('Abbreviation requests the NoteEditor modal when inactive; unsets the mark when active', () => {
    const editor = makeEditor('<p>word</p>');
    editors.push(editor);
    const onAbbreviationRequest = vi.fn();
    render(<ExtraItemsDropdown editor={editor} onAbbreviationRequest={onAbbreviationRequest} />);
    editor.commands.setTextSelection({ from: 1, to: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'Extra items' }));
    fireEvent.click(screen.getByText('Abbreviation'));
    expect(onAbbreviationRequest).toHaveBeenCalledTimes(1);
    expect(editor.getHTML()).not.toContain('<abbr');
    // active → the same item toggles the mark OFF (portal toggleAbbreviation)
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.chain().focus().setMark('abbreviation', { title: 'T' }).run();
    fireEvent.click(screen.getByRole('button', { name: 'Extra items' }));
    fireEvent.click(screen.getByText('Abbreviation'));
    expect(editor.getHTML()).not.toContain('<abbr');
    expect(onAbbreviationRequest).toHaveBeenCalledTimes(1); // no re-request
  });

  it('markdown mode: trigger stays enabled, the TipTap-driven items disable', () => {
    const editor = makeEditor('<p>x</p>');
    editors.push(editor);
    render(<ExtraItemsDropdown editor={editor} markdownMode />);
    expect(screen.getByRole('button', { name: 'Extra items' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Extra items' }));
    for (const label of ['Image', 'File', 'Abbreviation', 'Collapsible']) {
      expect(screen.getByText(label).closest('button')).toBeDisabled();
    }
  });

  it('trigger is inert without an editor', () => {
    render(<ExtraItemsDropdown editor={null} />);
    expect(screen.getByRole('button', { name: 'Extra items' })).toBeDisabled();
  });
});