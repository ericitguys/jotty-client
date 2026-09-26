import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import {
  noteEditorExtensions,
  toggleDetails,
} from './extensions';
import {
  MermaidExtension,
  DrawioExtension,
  ExcalidrawExtension,
} from './extensions/diagrams';
import {
  DetailsExtension,
  CalloutExtension,
  FileAttachmentExtension,
  sniffFileAttachment,
} from './extensions/rich-blocks';
import { FontFamily, Abbreviation, Kbd } from './extensions/inline-marks';
import { convertHtmlToMarkdown, convertMarkdownToHtml } from './markdown';

function editorWith(content: string): Editor {
  return new Editor({
    extensions: noteEditorExtensions(),
    content,
  });
}

/** Attrs of the first node of the given type in the doc. */
function firstNodeAttrs(
  editor: Editor,
  type: string,
): Record<string, unknown> | undefined {
  const json = editor.getJSON() as {
    content?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  };
  const found = (json.content ?? []).find((n) => n.type === type);
  return found?.attrs;
}

describe('P3 diagram nodes (mermaid / drawio / excalidraw)', () => {
  it('mermaid parses div[data-mermaid] into a block atom with the content attr', () => {
    const editor = editorWith(
      '<div data-mermaid="" data-mermaid-content="graph TD&#xA;  A --&gt; B">[Mermaid Diagram]</div>',
    );
    const json = editor.getJSON() as {
      content?: Array<{ type: string; attrs?: { content?: string } }>;
    };
    const node = json.content?.find((n) => n.type === 'mermaid');
    expect(node?.attrs?.content).toBe('graph TD\n  A --> B');
    // schema evidence: atom block, no inline content
    const spec = editor.schema.nodes.mermaid?.spec;
    expect(spec).toBeDefined();
    expect(spec?.group).toContain('block');
    expect((spec as { atom?: boolean }).atom).toBe(true);
  });

  it('mermaid renders the persistence shape (div[data-mermaid][data-mermaid-content])', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setMermaid('graph TD; A-->B');
    const html = editor.getHTML();
    expect(html).toContain('data-mermaid');
    // getHTML carries the RAW `>` (prosemirror renders via DOM; jsdom's
    // serializer escapes & and " in attributes but not >)
    expect(html).toContain('data-mermaid-content="graph TD; A-->B"');
    expect(html).toContain('[Mermaid Diagram]');
  });

  it('mermaid round-trips through the markdown pipeline (```mermaid fence)', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setMermaid('graph TD\n  A --> B');
    const md = convertHtmlToMarkdown(editor.getHTML());
    expect(md).toContain('```mermaid');
    expect(md).toContain('graph TD\n  A --> B');
    const html2 = convertMarkdownToHtml(md);
    const editor2 = editorWith(html2);
    const json = editor2.getJSON() as {
      content?: Array<{ type: string; attrs?: { content?: string } }>;
    };
    expect(json.content?.find((n) => n.type === 'mermaid')?.attrs?.content).toBe(
      'graph TD\n  A --> B',
    );
  });

  it('drawio parses div[data-drawio-*] attrs and renders them back', () => {
    const editor = editorWith(
      '<div data-drawio="" data-drawio-data="&lt;mxfile/&gt;" data-drawio-svg="&lt;svg/&gt;" data-drawio-theme="dark">[Draw.io Diagram]</div>',
    );
    const json = editor.getJSON() as {
      content?: Array<{
        type: string;
        attrs?: { diagramData?: string; svgData?: string; themeMode?: string };
      }>;
    };
    const node = json.content?.find((n) => n.type === 'drawio');
    expect(node?.attrs?.diagramData).toBe('<mxfile/>');
    expect(node?.attrs?.svgData).toBe('<svg/>');
    expect(node?.attrs?.themeMode).toBe('dark');
    const html = editor.getHTML();
    expect(html).toContain('data-drawio-data');
    expect(html).toContain('data-drawio-svg');
    expect(html).toContain('data-drawio-theme="dark"');
  });

  it('drawio insertDrawIo inserts an empty diagram node; themeMode defaults to light', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.insertDrawIo();
    const json = editor.getJSON() as {
      content?: Array<{
        type: string;
        attrs?: { diagramData?: string | null; svgData?: string | null; themeMode?: string };
      }>;
    };
    const node = json.content?.find((n) => n.type === 'drawio');
    expect(node).toBeDefined();
    expect(node?.attrs?.diagramData ?? null).toBeNull();
    expect(node?.attrs?.themeMode ?? 'light').toBe('light');
  });

  it('drawio round-trips through the base64 HTML-comment shape', () => {
    const editor = editorWith(
      '<div data-drawio="" data-drawio-data="&lt;mxfile&gt;&lt;/mxfile&gt;" data-drawio-svg="&lt;svg/&gt;" data-drawio-theme="light">[Draw.io Diagram]</div>',
    );
    const md = convertHtmlToMarkdown(editor.getHTML());
    expect(md).toContain('<!-- drawio-diagram');
    const html2 = convertMarkdownToHtml(md);
    const doc = new DOMParser().parseFromString(html2, 'text/html');
    expect(doc.querySelector('div[data-drawio]')?.getAttribute('data-drawio-data')).toBe(
      '<mxfile></mxfile>',
    );
    const editor2 = editorWith(html2);
    expect(
      (editor2.getJSON() as { content?: Array<{ type: string }> }).content?.some(
        (n) => n.type === 'drawio',
      ),
    ).toBe(true);
  });

  it('excalidraw parses and renders the div[data-excalidraw-*] shape', () => {
    const editor = editorWith(
      '<div data-excalidraw="" data-excalidraw-data="{&quot;elements&quot;:[]}" data-excalidraw-svg="" data-excalidraw-theme="light">[Excalidraw Diagram]</div>',
    );
    const json = editor.getJSON() as {
      content?: Array<{
        type: string;
        attrs?: { diagramData?: string; svgData?: string; themeMode?: string };
      }>;
    };
    const node = json.content?.find((n) => n.type === 'excalidraw');
    expect(node?.attrs?.diagramData).toBe('{"elements":[]}');
    expect(node?.attrs?.themeMode).toBe('light');
    const html = editor.getHTML();
    expect(html).toContain('data-excalidraw-data');
    expect(html).toContain('[Excalidraw Diagram]');
  });

  it('excalidraw insertExcalidraw inserts an empty node', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.insertExcalidraw();
    const json = editor.getJSON() as { content?: Array<{ type: string }> };
    expect(json.content?.some((n) => n.type === 'excalidraw')).toBe(true);
  });
});

describe('P3 rich blocks (details / callout / fileAttachment)', () => {
  it('details parses <details> with summary attr defaulting to Details', () => {
    const editor = editorWith(
      '<details><summary>More</summary><p>hidden body</p></details>',
    );
    const json = editor.getJSON() as {
      content?: Array<{
        type: string;
        attrs?: { summary?: string };
        content?: Array<{ type: string }>;
      }>;
    };
    const node = json.content?.find((n) => n.type === 'details');
    expect(node?.attrs?.summary).toBe('More');
    expect(node?.content?.some((c) => c.type === 'paragraph')).toBe(true);
  });

  it('details without a summary element defaults to "Details"', () => {
    const editor = editorWith('<details><p>body</p></details>');
    const json = editor.getJSON() as {
      content?: Array<{ type: string; attrs?: { summary?: string } }>;
    };
    expect(json.content?.find((n) => n.type === 'details')?.attrs?.summary).toBe(
      'Details',
    );
  });

  it('details renders details>summary+div and round-trips through markdown', () => {
    const editor = editorWith('<p>x</p>');
    toggleDetails(editor);
    const html = editor.getHTML();
    expect(html).toContain('<details');
    expect(html).toContain('<summary>Details</summary>');
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('<details>');
    expect(md).toContain('<summary>Details</summary>');
    const html2 = convertMarkdownToHtml(md);
    const editor2 = editorWith(html2);
    expect(editor2.getJSON().content?.some((n) => n.type === 'details')).toBe(true);
  });

  it('toggleDetails wraps the selection and unwraps when inside (core toggleWrap, R20-verified)', () => {
    const editor = editorWith('<p>hello</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    toggleDetails(editor);
    expect(editor.getJSON().content?.some((n) => n.type === 'details')).toBe(true);
    // cursor inside details: toggling again lifts out
    editor.commands.setTextSelection(3);
    toggleDetails(editor);
    const json = editor.getJSON() as { content?: Array<{ type: string }> };
    expect(json.content?.some((n) => n.type === 'details')).toBe(false);
    expect(json.content?.some((n) => n.type === 'paragraph')).toBe(true);
  });

  it('callout parses both the plain and the renderHTML wrapper shapes', () => {
    const plain = editorWith(
      '<div data-type="callout" data-callout-type="danger"><p>boom</p></div>',
    );
    const jsonPlain = plain.getJSON() as {
      content?: Array<{ type: string; attrs?: { type?: string } }>;
    };
    expect(jsonPlain.content?.find((n) => n.type === 'callout')?.attrs?.type).toBe(
      'danger',
    );

    const wrapped = editorWith(
      '<div data-type="callout" data-callout-type="info" class="callout callout-info"><div class="callout-wrapper"><span class="callout-icon callout-icon-info"></span><div class="callout-content"><p>note</p></div></div></div>',
    );
    const jsonWrapped = wrapped.getJSON() as {
      content?: Array<{ type: string; attrs?: { type?: string } }>;
    };
    expect(jsonWrapped.content?.find((n) => n.type === 'callout')?.attrs?.type).toBe('info');
  });

  it('callout renders data-callout-type + the callout class wrapper', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setCallout('warning');
    const html = editor.getHTML();
    expect(html).toContain('data-type="callout"');
    expect(html).toContain('data-callout-type="warning"');
    expect(html).toContain('callout callout-warning');
  });

  it('callout setCallout defaults to info and inserts an editable paragraph', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setCallout();
    const json = editor.getJSON() as {
      content?: Array<{
        type: string;
        attrs?: { type?: string };
        content?: Array<{ type: string }>;
      }>;
    };
    const node = json.content?.find((n) => n.type === 'callout');
    expect(node?.attrs?.type).toBe('info');
    expect(node?.content?.some((c) => c.type === 'paragraph')).toBe(true);
  });

  it('callout round-trips through the GFM blockquote shape', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setCallout('success');
    // type into the callout's empty paragraph
    editor.commands.setTextSelection(3);
    editor.commands.insertContent('saved');
    const md = convertHtmlToMarkdown(editor.getHTML());
    expect(md).toContain('> [!SUCCESS]');
    const html2 = convertMarkdownToHtml(md);
    const editor2 = editorWith(html2);
    const json2 = editor2.getJSON() as {
      content?: Array<{ type: string; attrs?: { type?: string } }>;
    };
    expect(json2.content?.find((n) => n.type === 'callout')?.attrs?.type).toBe(
      'success',
    );
  });

  it('fileAttachment parses p[data-file-attachment] with all four attrs', () => {
    const editor = editorWith(
      '<p data-file-attachment="" data-url="https://x/a.png" data-file-name="a.png" data-mime-type="image/png" data-type="image">[📎 a.png](https://x/a.png)</p>',
    );
    const json = editor.getJSON() as {
      content?: Array<{
        type: string;
        attrs?: { url?: string; fileName?: string; mimeType?: string; type?: string };
      }>;
    };
    const node = json.content?.find((n) => n.type === 'fileAttachment');
    expect(node?.attrs?.url).toBe('https://x/a.png');
    expect(node?.attrs?.fileName).toBe('a.png');
    expect(node?.attrs?.mimeType).toBe('image/png');
    expect(node?.attrs?.type).toBe('image');
  });

  it('fileAttachment renders the p[data-file-attachment] shape with the link text', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setFileAttachment({
      url: 'https://x/f.pdf',
      fileName: 'f.pdf',
      mimeType: 'application/pdf',
      type: 'file',
    });
    const html = editor.getHTML();
    expect(html).toContain('data-file-attachment');
    expect(html).toContain('data-url="https://x/f.pdf"');
    expect(html).toContain('data-file-name="f.pdf"');
    expect(html).toContain('data-mime-type="application/pdf"');
    expect(html).toContain('data-type="file"');
    expect(html).toContain('[📎 f.pdf](https://x/f.pdf)');
    // Persistence shape: HTML → markdown keeps the file link (portal-exact —
    // the remark side has NO file-attachment visitor; the 📎/🎥 input-rule
    // parse-back is T5, so node-identity does not survive save→reload).
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('[📎 f.pdf](https://x/f.pdf)');
    expect(md.trim()).not.toContain('data-file-attachment');
  });

  it('toggleDetails is exported and the extensions export real nodes', () => {
    expect(DetailsExtension.name).toBe('details');
    expect(CalloutExtension.name).toBe('callout');
    expect(FileAttachmentExtension.name).toBe('fileAttachment');
    expect(MermaidExtension.name).toBe('mermaid');
    expect(DrawioExtension.name).toBe('drawio');
    expect(ExcalidrawExtension.name).toBe('excalidraw');
  });
});

function attrOf(html: string, selector: string, attr: string): string | null | undefined {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.querySelector(selector)?.getAttribute(attr);
}

describe('P3 inline marks (fontFamily / abbreviation / kbd)', () => {
  it('registers all P3 nodes and marks in noteEditorExtensions()', () => {
    const names = noteEditorExtensions().map((e) => e.name);
    for (const want of [
      'mermaid',
      'drawio',
      'excalidraw',
      'details',
      'callout',
      'fileAttachment',
      'fontFamily',
      'abbreviation',
      'kbd',
    ]) {
      expect(names).toContain(want);
    }
  });

  it('fontFamily setMark stamps a styled span; unsetMark clears it', () => {
    const editor = editorWith('<p>plain</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.chain().focus().setMark('fontFamily', { style: 'font-family: JetBrains Mono' }).run();
    expect(editor.getHTML()).toContain('font-family: JetBrains Mono');
    const marks = (editor.getJSON() as {
      content?: Array<{ content?: Array<{ marks?: Array<{ type: string; attrs?: { style?: string } }> }> }>;
    }).content?.[0]?.content?.[0]?.marks;
    expect(marks?.find((m) => m.type === 'fontFamily')?.attrs?.style).toBe(
      'font-family: JetBrains Mono',
    );
    editor.chain().focus().unsetMark('fontFamily').run();
    expect(editor.getHTML()).not.toContain('font-family: JetBrains Mono');
  });

  it('fontFamily parses span[style*="font-family"] back into the mark', () => {
    const editor = editorWith(
      '<p><span style="font-family: JetBrains Mono">mono</span></p>',
    );
    const marks = (editor.getJSON() as {
      content?: Array<{ content?: Array<{ marks?: Array<{ type: string; attrs?: { style?: string } }> }> }>;
    }).content?.[0]?.content?.[0]?.marks;
    expect(marks?.some((m) => m.type === 'fontFamily')).toBe(true);
    // spans without font-family do NOT get the mark
    const plain = editorWith('<p><span style="color: #ff0000">red</span></p>');
    const plainMarks = (plain.getJSON() as {
      content?: Array<{ content?: Array<{ marks?: Array<{ type: string }> }> }>;
    }).content?.[0]?.content?.[0]?.marks;
    expect(plainMarks?.some((m) => m.type === 'fontFamily')).toBe(false);
  });

  it('abbreviation mark carries the title attr and parses <abbr title>', () => {
    const editor = editorWith('<p>plain</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.chain().focus().setMark('abbreviation', { title: 'Hypertext Markup Language' }).run();
    expect(editor.getHTML()).toContain('<abbr title="Hypertext Markup Language">');
    const md = convertHtmlToMarkdown(editor.getHTML());
    expect(md).toContain('<abbr title="Hypertext Markup Language">');
    const editor2 = editorWith(convertMarkdownToHtml(md));
    const marks = (editor2.getJSON() as {
      content?: Array<{ content?: Array<{ marks?: Array<{ type: string; attrs?: { title?: string } }> }> }>;
    }).content?.[0]?.content?.[0]?.marks;
    expect(marks?.find((m) => m.type === 'abbreviation')?.attrs?.title).toBe(
      'Hypertext Markup Language',
    );
  });

  it('kbd setMark wraps in <kbd> and round-trips', () => {
    const editor = editorWith('<p>plain</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.chain().focus().setMark('kbd').run();
    expect(editor.getHTML()).toContain('<kbd>plain</kbd>');
    const md = convertHtmlToMarkdown(editor.getHTML());
    expect(md).toContain('<kbd>plain</kbd>');
  });

  it('P2-gap regression: highlight/underline/sub/sup survive save→reload via the markdown pipeline', () => {
    const editor = editorWith(
      '<p><mark style="background-color: rgb(255, 0, 0); color: rgb(255, 255, 255)">hl</mark> <u>un</u> <sub>sb</sub> <sup>sp</sup></p>',
    );
    const md = convertHtmlToMarkdown(editor.getHTML());
    expect(md).toContain('<u>un</u>');
    expect(md).toContain('<sub>sb</sub>');
    expect(md).toContain('<sup>sp</sup>');
    // mark survives with its background-color; the text-color component is
    // re-computed by the P1 Highlight render (getContrastColor) on reload —
    // assert only the load-bearing part (tag + background-color + content).
    const markMatch = md.match(/<mark style="[^"]*">hl<\/mark>/);
    expect(markMatch).not.toBeNull();
    expect(markMatch?.[0]).toContain('background-color: rgb(255, 0, 0)');
    expect(markMatch?.[0].endsWith('>hl</mark>')).toBe(true);
  });
});

// --- P3 task 5 (R18): FileAttachment URL insert + typed parse-back ---

describe('P3 fileAttachment insert (R18 URL-only) + parse rules', () => {
  const liveEditors: Editor[] = [];
  function editorWithLive(content: string): Editor {
    const ed = editorWith(content);
    liveEditors.push(ed);
    return ed;
  }
  afterEach(() => {
    // T4 teardown hygiene: destroy live views so no DOMObserver timer
    // outlives this describe's jsdom environment (inter-file flake class).
    for (const ed of liveEditors.splice(0)) ed.destroy();
  });

  /**
   * Drive the typed-input path exactly as ProseMirror does: the input-rules
   * plugin advertises `handleTextInput`, and someProp invokes the first
   * plugin prop that handles it (headless-safe — no DOM events needed).
   * The typed text is NOT yet in the doc when the prop runs (mirroring real
   * keystrokes — the default insertion is cancelled when a rule fires).
   */
  function typeText(editor: Editor, text: string): boolean {
    const { from, to } = editor.state.selection;
    // The prop's real signature carries a 5th `deflt` continuation (default
    // insertion); the input-rules handler never calls it when a rule fires.
    return (
      editor.view.someProp(
        'handleTextInput',
        (f) => f(editor.view, from, to, text, () => editor.view.state.tr),
      ) === true
    );
  }

  it('sniffFileAttachment maps file extensions to attachment types', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
      expect(sniffFileAttachment(`https://x/pic.${ext}`)?.type).toBe('image');
    }
    for (const ext of ['mp4', 'webm']) {
      expect(sniffFileAttachment(`https://x/clip.${ext}`)?.type).toBe('video');
    }
    const other = sniffFileAttachment('https://x/file.pdf');
    expect(other?.type).toBe('file');
    expect(other?.mimeType).toBe('application/octet-stream');
    expect(sniffFileAttachment('https://x/no-ext')?.type).toBe('file');
    expect(sniffFileAttachment('https://x/A.PNG')?.type).toBe('image');
  });

  it('sniffFileAttachment keeps the portal /api/image|video/ prefix sniff', () => {
    expect(sniffFileAttachment('https://host/api/image/u/pic')?.type).toBe('image');
    expect(sniffFileAttachment('https://host/api/video/u/clip')?.type).toBe('video');
    expect(sniffFileAttachment('https://host/api/file/u/doc')?.type).toBe('file');
  });

  it('sniffFileAttachment mirrors the portal mimeType constants', () => {
    expect(sniffFileAttachment('https://x/a.png')?.mimeType).toBe('image/jpeg');
    expect(sniffFileAttachment('https://x/v.mp4')?.mimeType).toBe('video/mp4');
    expect(sniffFileAttachment('https://x/f.pdf')?.mimeType).toBe('application/octet-stream');
  });

  it('sniffFileAttachment derives fileName from the last decoded path segment (query/hash stripped)', () => {
    expect(sniffFileAttachment('https://x/my%20file.pdf?token=1')?.fileName).toBe('my file.pdf');
    expect(sniffFileAttachment('https://x/a.png#frag')?.fileName).toBe('a.png');
    expect(sniffFileAttachment('https://x/')?.fileName).toBe('attachment');
    expect(sniffFileAttachment('https://x/f.pdf')?.fileName).toBe('f.pdf');
  });

  it('typing [📎 name](url) parses back into a fileAttachment node (sniffed type)', () => {
    const editor = editorWithLive('<p>x</p>');
    editor.commands.setTextSelection(1);
    expect(typeText(editor, '[📎 f.pdf](https://x/f.pdf)')).toBe(true);
    const attrs = firstNodeAttrs(editor, 'fileAttachment');
    expect(attrs?.url).toBe('https://x/f.pdf');
    expect(attrs?.fileName).toBe('f.pdf');
    expect(attrs?.mimeType).toBe('application/octet-stream');
    expect(attrs?.type).toBe('file');
  });

  it('typing [📎 name](image-url) sniffs image from the extension', () => {
    const editor = editorWithLive('<p>x</p>');
    editor.commands.setTextSelection(1);
    expect(typeText(editor, '[📎 a.png](https://x/a.png)')).toBe(true);
    const attrs = firstNodeAttrs(editor, 'fileAttachment');
    expect(attrs?.type).toBe('image');
    expect(attrs?.mimeType).toBe('image/jpeg');
    expect(attrs?.fileName).toBe('a.png');
  });

  it('typing [🎥 name](url) parses back into a video attachment (portal-exact mime)', () => {
    const editor = editorWithLive('<p>x</p>');
    editor.commands.setTextSelection(1);
    expect(typeText(editor, '[🎥 v.mp4](https://x/v.mp4)')).toBe(true);
    const attrs = firstNodeAttrs(editor, 'fileAttachment');
    expect(attrs?.url).toBe('https://x/v.mp4');
    expect(attrs?.fileName).toBe('v.mp4');
    expect(attrs?.mimeType).toBe('video/mp4');
    expect(attrs?.type).toBe('video');
  });

  it('typing ![name](url) parses back into an image attachment', () => {
    const editor = editorWithLive('<p>x</p>');
    editor.commands.setTextSelection(1);
    expect(typeText(editor, '![a.png](https://x/a.png)')).toBe(true);
    const attrs = firstNodeAttrs(editor, 'fileAttachment');
    expect(attrs?.type).toBe('image');
    expect(attrs?.fileName).toBe('a.png');
  });

  it('requires the portal \\s+ gap after the emoji (📎name does not match)', () => {
    const editor = editorWithLive('<p>x</p>');
    editor.commands.setTextSelection(1);
    expect(typeText(editor, '[📎f.pdf](https://x/f.pdf)')).toBe(false);
    expect(firstNodeAttrs(editor, 'fileAttachment')).toBeUndefined();
  });

  it('image/video attachments round-trip the persisted link forms through the extension', () => {
    // Fences for the T1 serialization legs at the node level (the file-type
    // leg is pinned by the T2 test above; these cover the other two forms).
    const image = editorWithLive('<p>x</p>');
    image.commands.setFileAttachment({
      url: 'https://x/a.png',
      fileName: 'a.png',
      mimeType: 'image/jpeg',
      type: 'image',
    });
    expect(convertHtmlToMarkdown(image.getHTML())).toContain('![a.png](https://x/a.png)');
    const video = editorWithLive('<p>x</p>');
    video.commands.setFileAttachment({
      url: 'https://x/v.mp4',
      fileName: 'v.mp4',
      mimeType: 'video/mp4',
      type: 'video',
    });
    expect(convertHtmlToMarkdown(video.getHTML())).toContain('[🎥 v.mp4](https://x/v.mp4)');
  });
});