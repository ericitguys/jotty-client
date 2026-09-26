import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
    expect(screen.getByRole('button', { name: 'Link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    // active state styling flips on the bold button
    expect(screen.getByRole('button', { name: 'Bold' }).className).toContain('active');
  });

  it('toolbar is inert without an editor', () => {
    render(<EditorToolbar editor={null} />);
    expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled();
  });
});