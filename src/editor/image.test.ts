import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { noteEditorExtensions } from './extensions';
import { SLASH_ITEMS } from './slashCommands';
import { applyImageSize, buildResizedStyle, findImageNodeBySrc, parseImageSizeFromStyle } from './imageResize';
import { convertHtmlToMarkdown, convertMarkdownToHtml } from './markdown';

const liveEditors: Editor[] = [];
function editorWith(content: string): Editor {
  const ed = new Editor({
    extensions: noteEditorExtensions(),
    content,
  });
  liveEditors.push(ed);
  return ed;
}

// Teardown hygiene: destroy the live prosemirror views so no DOMObserver
// flush timer outlives this file's jsdom environment (inter-file flake).
afterEach(() => {
  for (const ed of liveEditors.splice(0)) ed.destroy();
});

/** Attrs of the first node of the given type in the doc. */
function firstNodeAttrs(editor: Editor, type: string): Record<string, unknown> | undefined {
  const json = editor.getJSON() as { content?: Array<{ type: string; attrs?: Record<string, unknown> }> };
  return json.content?.find((n) => n.type === type)?.attrs;
}

describe('P3 image extension', () => {
  it('registers a block image node (inline: false, portal shape)', () => {
    const editor = editorWith('<p>before</p><img src="https://example.com/i.png"><p>after</p>');
    const spec = editor.schema.nodes.image?.spec;
    expect(spec).toBeDefined();
    expect(spec?.group).toContain('block');
  });

  it('insertImage inserts a block image node with src/alt/title', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.insertImage({ src: 'https://example.com/i.png', alt: 'pic' });
    const attrs = firstNodeAttrs(editor, 'image');
    expect(attrs?.src).toBe('https://example.com/i.png');
    expect(attrs?.alt).toBe('pic');
    // unsized: width/height stay null
    expect(attrs?.width ?? null).toBeNull();
    expect(attrs?.height ?? null).toBeNull();
  });

  it('sized image renders the portal persistence shape (style="width: Npx; height: Npx")', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.insertImage({ src: 'https://example.com/i.png', alt: 'pic', width: 300, height: 200 });
    const html = editor.getHTML();
    expect(html).toContain('src="https://example.com/i.png"');
    expect(html).toMatch(/style="width: 300px; height: 200px;?"/);
  });

  it('partially sized image renders only the set dimension', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.insertImage({ src: 'https://example.com/i.png', width: 300 });
    expect(editor.getHTML()).toMatch(/style="width: 300px;?"/);
    expect(editor.getHTML()).not.toContain('height:');
  });

  it('unsized image serializes as a plain markdown image (no <img>)', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.insertImage({ src: 'https://example.com/i.png', alt: 'pic' });
    const md = convertHtmlToMarkdown(editor.getHTML());
    expect(md).toContain('![pic](https://example.com/i.png)');
    expect(md).not.toContain('<img');
  });

  it('sized image round-trips through the markdown pipeline and is stable', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.insertImage({ src: 'https://example.com/i.png', alt: 'pic', width: 300, height: 200 });
    const md = convertHtmlToMarkdown(editor.getHTML());
    expect(md).toContain('<img src="https://example.com/i.png" alt="pic" style="width: 300px; height: 200px" />');

    const html2 = convertMarkdownToHtml(md);
    const editor2 = editorWith(html2);
    const attrs = firstNodeAttrs(editor2, 'image');
    expect(attrs?.src).toBe('https://example.com/i.png');
    expect(attrs?.alt).toBe('pic');
    expect(attrs?.width).toBe(300);
    expect(attrs?.height).toBe(200);

    const md2 = convertHtmlToMarkdown(editor2.getHTML());
    expect(md2).toContain('<img src="https://example.com/i.png" alt="pic" style="width: 300px; height: 200px" />');
  });

  it('unsized image round-trips through the markdown pipeline as ![alt](src)', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.insertImage({ src: 'https://example.com/i.png', alt: 'pic' });
    const md = convertHtmlToMarkdown(editor.getHTML());
    expect(md).toContain('![pic](https://example.com/i.png)');
    const html2 = convertMarkdownToHtml(md);
    const editor2 = editorWith(html2);
    const md2 = convertHtmlToMarkdown(editor2.getHTML());
    expect(md2).toContain('![pic](https://example.com/i.png)');
    expect(md2).not.toContain('<img');
  });

  it('parses width/height from the disk style attribute', () => {
    const editor = editorWith(
      '<img src="https://example.com/i.png" alt="pic" style="width: 300px; height: 200px">',
    );
    const attrs = firstNodeAttrs(editor, 'image');
    expect(attrs?.width).toBe(300);
    expect(attrs?.height).toBe(200);
    expect(attrs?.style).toBe('width: 300px; height: 200px');
  });

  it('falls back to legacy width/height attributes when style is absent', () => {
    const editor = editorWith('<img src="https://example.com/i.png" alt="pic" width="120" height="90">');
    const attrs = firstNodeAttrs(editor, 'image');
    expect(attrs?.width).toBe(120);
    expect(attrs?.height).toBe(90);
  });

  it('parses a width buried among other style declarations (height null)', () => {
    const editor = editorWith('<img src="https://example.com/i.png" style="border-radius: 4px; width: 150px">');
    const attrs = firstNodeAttrs(editor, 'image');
    expect(attrs?.width).toBe(150);
    expect(attrs?.height ?? null).toBeNull();
  });

  it('parses a p-wrapped inline image by lifting it to a block', () => {
    const editor = editorWith('<p>a<img src="https://example.com/i.png" alt="p"></p>');
    const json = editor.getJSON() as { content?: Array<{ type: string }> };
    const types = (json.content ?? []).map((n) => n.type);
    expect(types).toContain('image');
    expect(types).toContain('paragraph');
  });
});

describe('image resize helpers (portal useImageResize.ts:10-136 port)', () => {
  it('parseImageSizeFromStyle reads px decls and ignores others', () => {
    expect(parseImageSizeFromStyle('width: 300px; height: 200px; border-radius: 4px')).toEqual({ width: 300, height: 200 });
    expect(parseImageSizeFromStyle('border-radius: 4px')).toEqual({ width: null, height: null });
    expect(parseImageSizeFromStyle('width:0px')).toEqual({ width: 0, height: null });
  });

  it('buildResizedStyle strips old sizing and appends the new px decls', () => {
    expect(buildResizedStyle('width: 300px; height: 200px; border-radius: 4px', 120, 90)).toBe(
      'border-radius: 4px; width: 120px; height: 90px',
    );
    expect(buildResizedStyle('width: 300px; height: 200px', null, 90)).toBe('height: 90px');
    expect(buildResizedStyle('', 120, 90)).toBe('width: 120px; height: 90px');
    expect(buildResizedStyle('width: 300px', null, null)).toBe('');
  });

  it('applyImageSize dispatches setNodeMarkup with rebuilt style + width/height', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.insertImage({ src: 'https://example.com/i.png', alt: 'pic', width: 300, height: 200 });
    expect(applyImageSize(editor, 'https://example.com/i.png', 120, 90)).toBe(true);
    const attrs = firstNodeAttrs(editor, 'image');
    expect(attrs?.width).toBe(120);
    expect(attrs?.height).toBe(90);
    expect(attrs?.style).toBe('width: 120px; height: 90px');
    // getHTML reflects the new size (portal persistence shape)
    expect(editor.getHTML()).toMatch(/style="width: 120px; height: 90px;?"/);
  });

  it('applyImageSize preserves non-sizing style declarations', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.insertImage({ src: 'https://example.com/i.png', alt: 'pic', width: 300, height: 200 });
    const found = findImageNodeBySrc(editor, 'https://example.com/i.png');
    expect(found).not.toBeNull();
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(found!.pos, undefined, { ...found!.node.attrs, style: 'border-radius: 4px; width: 300px; height: 200px' }),
    );
    expect(applyImageSize(editor, 'https://example.com/i.png', 120, 90)).toBe(true);
    expect(firstNodeAttrs(editor, 'image')?.style).toBe('border-radius: 4px; width: 120px; height: 90px');
  });

  it('applyImageSize with null clears the sizing back to auto', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.insertImage({ src: 'https://example.com/i.png', alt: 'pic', width: 300, height: 200 });
    expect(applyImageSize(editor, 'https://example.com/i.png', null, null)).toBe(true);
    const attrs = firstNodeAttrs(editor, 'image');
    expect(attrs?.width ?? null).toBeNull();
    expect(attrs?.height ?? null).toBeNull();
    expect(convertHtmlToMarkdown(editor.getHTML())).toContain('![pic](https://example.com/i.png)');
  });

  it('applyImageSize reports false when no image matches the src', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.insertImage({ src: 'https://example.com/i.png' });
    expect(applyImageSize(editor, 'https://example.com/other.png', 120, 90)).toBe(false);
  });
});

describe('Image slash item (R23 — modalized, no prompt())', () => {
  it('the Image item exists with the portal labels', () => {
    const titles = SLASH_ITEMS.map((i) => i.title);
    expect(titles).toContain('Image');
  });

  it('the Image item plants the imageModal storage flag instead of inserting', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setTextSelection(1);
    const item = SLASH_ITEMS.find((i) => i.title === 'Image')!;
    item.command({ editor, range: { from: 1, to: 2 } });
    const flag = editor.storage.imageModal as { open: boolean; range: unknown } | undefined;
    expect(flag?.open).toBe(true);
    expect(flag?.range).toEqual({ from: 1, to: 2 });
    // nothing inserted at command time — the insert is modal-driven
    expect(firstNodeAttrs(editor, 'image')).toBeUndefined();
  });
});