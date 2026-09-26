import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { noteEditorExtensions } from '../editor/extensions';
import FontFamilyDropdown from './FontFamilyDropdown';

function makeEditor(content = '<p>plain</p>'): Editor {
  return new Editor({ extensions: noteEditorExtensions(), content });
}

describe('FontFamilyDropdown (P3 task 6)', () => {
  const editors: Editor[] = [];
  afterEach(() => {
    for (const ed of editors.splice(0)) ed.destroy();
  });

  it('renders the trigger with the searchable list: Default first, ~110 system fonts, rows preview in their own face', () => {
    const editor = makeEditor('<p>plain</p>');
    editors.push(editor);
    render(<FontFamilyDropdown editor={editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Font family' }));
    expect(screen.getByPlaceholderText('Search fonts...')).toBeTruthy();
    // 'Default' (portal settings.default) is the first row (portal :13)
    // portal :13-121 — Default first, 96 system fonts after (97 rows
    // total; portal-exact list, rows preview in their own face)
    const rows = Array.from(document.querySelectorAll('.edt-font-row'));
    expect(rows.length).toBe(97);
    expect((rows[0] as HTMLElement).textContent).toBe('Default');
    // portal :191 — each row previews in its own face
    const georgia = screen.getByText('Georgia').closest('button') as HTMLElement;
    expect(georgia.style.fontFamily).toContain('Georgia');
  });

  it('filters as you type; garbage search shows the portal empty state', () => {
    const editor = makeEditor('<p>plain</p>');
    editors.push(editor);
    render(<FontFamilyDropdown editor={editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Font family' }));
    const search = screen.getByPlaceholderText('Search fonts...') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'georgia' } });
    expect(screen.queryByText('Georgia')).toBeTruthy();
    expect(screen.queryByText('Arial')).toBeNull();
    fireEvent.change(search, { target: { value: 'zzzz-not-a-font' } });
    expect(screen.getByText('No fonts found')).toBeTruthy();
  });

  it('mousedown inside the search field does not close the menu', () => {
    const editor = makeEditor('<p>plain</p>');
    editors.push(editor);
    render(<FontFamilyDropdown editor={editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Font family' }));
    const search = screen.getByPlaceholderText('Search fonts...');
    fireEvent.mouseDown(search);
    expect(screen.getByPlaceholderText('Search fonts...')).toBeTruthy();
  });

  it('picking a font stamps the fontFamily mark; Default unsets it', () => {
    const editor = makeEditor('<p>plain</p>');
    editors.push(editor);
    render(<FontFamilyDropdown editor={editor} />);
    act(() => editor.commands.setTextSelection({ from: 1, to: 6 }));
    fireEvent.click(screen.getByRole('button', { name: 'Font family' }));
    fireEvent.click(screen.getByText('Georgia'));
    expect(editor.getHTML()).toContain('font-family: Georgia');
    const marks = (
      editor.getJSON() as {
        content?: Array<{ content?: Array<{ marks?: Array<{ type: string; attrs?: { style?: string } }> }> }>;
      }
    ).content?.[0]?.content?.[0]?.marks;
    expect(marks?.find((m) => m.type === 'fontFamily')?.attrs?.style).toBe('font-family: Georgia, serif');
    // menu closes after a pick, reopen → Default row selected, then unset
    fireEvent.click(screen.getByRole('button', { name: 'Font family' }));
    expect(
      (screen.getByText('Georgia').closest('button') as HTMLElement).className,
    ).toContain('selected');
    fireEvent.click(screen.getByText('Default'));
    expect(editor.getHTML()).not.toContain('font-family: Georgia');
  });

  it('trigger is inert without an editor', () => {
    render(<FontFamilyDropdown editor={null} />);
    expect(screen.getByRole('button', { name: 'Font family' })).toBeDisabled();
  });
});