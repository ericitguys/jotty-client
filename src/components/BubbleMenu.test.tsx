import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { noteEditorExtensions } from '../editor/extensions';
import BubbleMenu from './BubbleMenu';

describe('BubbleMenu', () => {
  it('renders on visible and applies bold to the selection', () => {
    const editor = new Editor({ extensions: noteEditorExtensions(), content: '<p>hi</p>' });
    editor.commands.setTextSelection({ from: 1, to: 3 });
    const onClose = vi.fn();
    render(<BubbleMenu editor={editor} visible onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(editor.getHTML()).toContain('<strong>');
    // Escape or applying closes it
    expect(onClose).toHaveBeenCalled();
  });
  it('renders nothing when not visible', () => {
    const editor = new Editor({ extensions: noteEditorExtensions(), content: '<p>hi</p>' });
    render(<BubbleMenu editor={editor} visible={false} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull();
  });
});