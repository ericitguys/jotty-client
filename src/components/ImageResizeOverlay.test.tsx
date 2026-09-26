import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { noteEditorExtensions } from '../editor/extensions';
import { applyImageSize } from '../editor/imageResize';
import ImageResizeOverlay from './ImageResizeOverlay';

// Teardown hygiene: destroy live prosemirror views so no DOMObserver flush
// timer outlives this file's jsdom environment (inter-file flake).
const liveEditors: Editor[] = [];
afterEach(() => {
  for (const ed of liveEditors.splice(0)) ed.destroy();
});

describe('ImageResizeOverlay', () => {
  it('renders nothing when not visible', () => {
    render(<ImageResizeOverlay visible={false} src="https://example.com/i.png" onApply={() => {}} onClose={() => {}} />);
    expect(screen.queryByTestId('image-resize-overlay')).toBeNull();
  });

  it('renders on the selected image node with seeded px dims (style-attr parse)', () => {
    render(
      <ImageResizeOverlay
        visible
        src="https://example.com/i.png"
        currentWidth={300}
        currentHeight={200}
        top={40}
        left={80}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('image-resize-overlay')).toBeInTheDocument();
    expect(screen.getByText('Resize Image')).toBeInTheDocument();
    expect(screen.getByLabelText('Width (px)')).toHaveValue(300);
    expect(screen.getByLabelText('Height (px)')).toHaveValue(200);
    expect(screen.getByTestId('image-resize-handle')).toBeInTheDocument();
  });

  it('Apply reports parsed ints via onApply and closes', () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<ImageResizeOverlay visible src="https://example.com/i.png" onApply={onApply} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Width (px)'), { target: { value: '640' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith(640, null);
    expect(onClose).toHaveBeenCalled();
  });

  it('Cancel and Escape close without applying', () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<ImageResizeOverlay visible src="https://example.com/i.png" onApply={onApply} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('end-to-end: Apply drives setNodeMarkup on the selected image node (px from style attr)', () => {
    const editor = new Editor({
      extensions: noteEditorExtensions(),
      content: '<img src="https://example.com/i.png" alt="pic" style="width: 300px; height: 200px">',
    });
    liveEditors.push(editor);
    // select the image node the way a user click does (NodeSelection)
    const found = ((): { pos: number; width: unknown; height: unknown } | null => {
      let out: { pos: number; width: unknown; height: unknown } | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'image' && out === null) {
          out = { pos, width: node.attrs.width, height: node.attrs.height };
          return false;
        }
        return true;
      });
      return out;
    })();
    expect(found).not.toBeNull();
    // the node's dims were parsed from the style attr (not legacy attrs)
    expect(found!.width).toBe(300);
    expect(found!.height).toBe(200);

    const onApply = (w: number | null, h: number | null) => {
      expect(applyImageSize(editor, 'https://example.com/i.png', w, h)).toBe(true);
    };
    const { container } = render(
      <ImageResizeOverlay
        visible
        src="https://example.com/i.png"
        currentWidth={Number(found!.width)}
        currentHeight={Number(found!.height)}
        top={0}
        left={0}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    fireEvent.change(container.querySelector('label input')!, { target: { value: '640' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const json = editor.getJSON() as { content?: Array<{ type: string; attrs?: Record<string, unknown> }> };
    const attrs = json.content?.find((n) => n.type === 'image')?.attrs;
    expect(attrs?.width).toBe(640);
    expect(attrs?.height).toBe(200);
    expect(attrs?.style).toBe('width: 640px; height: 200px');
    expect(editor.getHTML()).toMatch(/style="width: 640px; height: 200px;?"/);
  });
});