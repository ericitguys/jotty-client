import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { convertHtmlToMarkdown, convertMarkdownToHtml } from './markdown';
import { isLegacyHtmlDoc } from './contentKind';
import { noteEditorExtensions } from './extensions';

function editorWith(content: string): Editor {
  return new Editor({
    extensions: noteEditorExtensions(),
    content,
  });
}

describe('markdown serialization (portal pipeline)', () => {
  it('round-trips headings, emphasis and inline code', () => {
    const md = convertHtmlToMarkdown('<h2>Title</h2><p><strong>b</strong> <em>i</em> <u>u</u> <code>x</code></p>');
    expect(md).toContain('## Title');
    expect(md).toContain('**b**');
    expect(md).toContain('*i*');
    expect(md.replace(/\n/g, '')).toMatch(/_?u_?|<u>u<\/u>/); // underline survives as HTML or emph
    expect(md).toContain('`');
  });

  it('serializes fenced code blocks with the language class', () => {
    const md = convertHtmlToMarkdown('<pre><code class="language-python">x = 1</code></pre>');
    expect(md).toContain('```python');
    expect(md.trim().endsWith('```')).toBe(true);
  });

  it('serializes task lists with checked state (portal taskItem rule)', () => {
    const html = '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p>done</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>open</p></div></li></ul>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('- [x] done');
    expect(md).toContain('- [ ] open');
  });

  it('serializes tables via the gfm plugin', () => {
    const md = convertHtmlToMarkdown('<table><tr><th>h</th></tr><tr><td>c</td></tr></table>');
    expect(md).toContain('|');
    expect(md).toContain('---');
  });

  it('converts markdown (gfm) to HTML: headings, task lists, tables, fenced code', () => {
    const html = convertMarkdownToHtml('# H1\n\n- [x] done\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nlet x\n```\n');
    expect(html).toContain('<h1>');
    expect(html).toContain('data-type="taskList"'); // see Step 4 remark → TipTap-shaped task items
    expect(html).toContain('<table>');
    expect(html).toContain('language-js'); // lowlight-compatible class for CodeBlockLowlight
  });

  it('parses legacy HTML content untouched (identity for startsWith("<") notes)', () => {
    // markdown containing raw HTML passes through rehype-raw (allowDangerousHtml)
    const html = convertMarkdownToHtml('text\n\n<p data-x="1">raw</p>\n');
    expect(html).toContain('<p data-x="1">raw</p>');
  });

  it('empty inputs produce empty outputs', () => {
    expect(convertHtmlToMarkdown('')).toBe('');
    expect(convertMarkdownToHtml('')).toBe('');
  });
});

describe('P3 diagram + rich-block shapes (portal-exact serialization)', () => {
  const attrOf = (html: string, selector: string, attr: string): string | null | undefined => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.querySelector(selector)?.getAttribute(attr);
  };

  it('mermaid: div[data-mermaid] → ```mermaid fence; fence → div[data-mermaid][data-mermaid-content]', () => {
    const html = '<div data-mermaid="" data-mermaid-content="graph TD&#xA;  A --&gt; B">[Mermaid Diagram]</div>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('```mermaid');
    expect(md).toContain('graph TD\n  A --> B');
    const html2 = convertMarkdownToHtml(md);
    expect(html2).toContain('data-mermaid');
    expect(attrOf(html2, 'div[data-mermaid]', 'data-mermaid-content')).toBe('graph TD\n  A --> B');
    expect(attrOf(html2, 'div[data-mermaid]', 'data-mermaid-content')).toBe('graph TD\n  A --> B');
    const md2 = convertHtmlToMarkdown(html2);
    expect(md2.trim()).toBe(md.trim());
  });

  it('drawio: div[data-drawio-*] → base64 HTML comment; comment → div[data-drawio-*]', () => {
    const xml = '<mxfile><diagram>x=1</diagram></mxfile>';
    const svg = `<svg width='1' height='1'></svg>`;
    const html = '<div data-drawio="" data-drawio-data="' + xml + '" data-drawio-svg="' + svg + '" data-drawio-theme="dark">[Draw.io Diagram]</div>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('<!-- drawio-diagram');
    expect(md).toMatch(/data: [A-Za-z0-9+/=]+/);
    expect(md).toMatch(/svg: [A-Za-z0-9+/=]+/);
    expect(md).toContain('theme: dark');
    expect(md.trim()).not.toContain(xml); // raw XML is base64-encoded in the comment

    const html2 = convertMarkdownToHtml(md);
    expect(attrOf(html2, 'div[data-drawio]', 'data-drawio-data')).toBe(xml);
    expect(attrOf(html2, 'div[data-drawio]', 'data-drawio-svg')).toBe(svg);
    expect(attrOf(html2, 'div[data-drawio]', 'data-drawio-theme')).toBe('dark');
    expect(html2).toContain('[Draw.io Diagram]');
    const md2 = convertHtmlToMarkdown(html2);
    expect(md2.trim()).toBe(md.trim());
  });

  it('excalidraw: comment with data only (no svg line) → div[data-excalidraw-*]', () => {
    const scene = '{"elements":[]}';
    const b64 = (value: string): string => {
      const bytes = new TextEncoder().encode(value);
      let binary = '';
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      return btoa(binary);
    };
    const md = `<!-- excalidraw-diagram\ndata: ${b64(scene)}\ntheme: light -->`;
    const html = convertMarkdownToHtml(md);
    expect(attrOf(html, 'div[data-excalidraw]', 'data-excalidraw-data')).toBe(scene);
    expect(attrOf(html, 'div[data-excalidraw]', 'data-excalidraw-svg')).toBe('');
    expect(attrOf(html, 'div[data-excalidraw]', 'data-excalidraw-theme')).toBe('light');
    expect(html).toContain('[Excalidraw Diagram]');
  });

  it('excalidraw: EMPTY svg: line swallows the theme line on parse-back → comment stays (portal quirk, bug-for-bug)', () => {
    // Portal markdown-utils.tsx:497-499 — /svg:\s*([^\n]+)/ is greedy across
    // newlines, so an empty `svg: ` line captures `theme: …` and base64 decode
    // throws; the portal's empty catch keeps the raw comment.
    const md = '<!-- excalidraw-diagram\ndata: eyJlbG\nsvg: \ntheme: light -->';
    const html = convertMarkdownToHtml(md);
    expect(html).toContain('excalidraw-diagram'); // stays an HTML comment
    expect(html).not.toContain('data-excalidraw-data');
  });

  it('excalidraw: div[data-excalidraw-*] with svg+theme → comment → div (full shape)', () => {
    const scene = '{"a":1}';
    // Build the fixture via DOM so embedded double quotes stay escaped in the attribute.
    const seed = new DOMParser().parseFromString('<div data-excalidraw="">[Excalidraw Diagram]</div>', 'text/html');
    seed.querySelector('div[data-excalidraw]')?.setAttribute('data-excalidraw-data', scene);
    seed.querySelector('div[data-excalidraw]')?.setAttribute('data-excalidraw-svg', `svg width='1' height='1'`);
    const html = seed.documentElement.outerHTML;
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('<!-- excalidraw-diagram');
    expect(md).toMatch(/data: [A-Za-z0-9+/=]+/);
    expect(md).toMatch(/svg: [A-Za-z0-9+/=]+/);
    expect(md.trim()).not.toContain(scene); // raw scene is base64-encoded in the comment
    const html2 = convertMarkdownToHtml(md);
    expect(attrOf(html2, 'div[data-excalidraw]', 'data-excalidraw-data')).toBe(scene);
    expect(attrOf(html2, 'div[data-excalidraw]', 'data-excalidraw-theme')).toBe('light');
    const md2 = convertHtmlToMarkdown(html2);
    expect(md2.trim()).toBe(md.trim());
  });

  it('malformed diagram comments pass through without crashing', () => {
    const md = '<!-- drawio-diagram\ndata: !!!not-base64!!!\nsvg: abc\ntheme: light -->';
    const html = convertMarkdownToHtml(md);
    expect(html).toContain('drawio-diagram'); // stays an HTML comment (portal catch {} leaves it untouched)
  });

  it('details: raw <details> HTML block round-trips', () => {
    const html = '<details><summary>More</summary><p>hidden body</p></details>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('<details>');
    expect(md).toContain('<summary>More</summary>');
    expect(md).toContain('hidden body');
    const html2 = convertMarkdownToHtml(md);
    const doc = new DOMParser().parseFromString(html2, 'text/html');
    expect(doc.querySelector('details summary')?.textContent).toBe('More');
    expect(doc.querySelector('details')?.textContent).toContain('hidden body');
    const md2 = convertHtmlToMarkdown(doc.documentElement.outerHTML);
    expect(md2).toContain('<summary>More</summary>');
  });

  it('callout: div[data-type=callout] → GFM [!TYPE] blockquote; blockquote marker → callout div', () => {
    const html = '<div data-type="callout" data-callout-type="info"><p>warn text</p></div>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('> [!INFO]');
    expect(md).toContain('> warn text');
    const html2 = convertMarkdownToHtml(md);
    expect(html2).toContain('data-type="callout"');
    expect(html2).toContain('data-callout-type="info"');
    expect(html2).toContain('callout callout-info');
    expect(html2).toContain('warn text');
    const md2 = convertHtmlToMarkdown(html2);
    expect(md2.trim()).toBe(md.trim());
  });

  it('callout: all four portal types map uppercased on serialize, lowercased on parse-back', () => {
    for (const type of ['info', 'warning', 'success', 'danger']) {
      const html = `<div data-type="callout" data-callout-type="${type}"><p>note</p></div>`;
      const md = convertHtmlToMarkdown(html);
      expect(md).toContain(`> [!${type.toUpperCase()}]`);
      const html2 = convertMarkdownToHtml(md);
      expect(html2).toContain(`data-callout-type="${type}"`);
    }
  });

  it('fontFamily: span[style*="font-family"] stays inline HTML with single-quoted fonts', () => {
    const html = '<p><span style="font-family: &quot;JetBrains Mono&quot;, monospace">mono</span></p>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('<span style="font-family: \'JetBrains Mono\', monospace">mono</span>');
    const html2 = convertMarkdownToHtml(md);
    const doc = new DOMParser().parseFromString(html2, 'text/html');
    expect(doc.querySelector('span[style*="font-family"]')?.textContent).toBe('mono');
    const md2 = convertHtmlToMarkdown(html2);
    expect(md2.trim()).toBe(md.trim());
  });

  it('abbr + kbd: inline HTML marks round-trip', () => {
    const html = '<p><abbr title="HyperText Markup Language">HTML</abbr> and <kbd>Ctrl</kbd></p>';
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('<abbr title="HyperText Markup Language">HTML</abbr>');
    expect(md).toContain('<kbd>Ctrl</kbd>');
    const html2 = convertMarkdownToHtml(md);
    expect(html2).toContain('<abbr title="HyperText Markup Language">HTML</abbr>');
    expect(html2).toContain('<kbd>Ctrl</kbd>');
  });

  it('img: unsized → image link; sized → style attr; parse-back re-adds width/height', () => {
    expect(convertHtmlToMarkdown('<img src="https://x/y.png" alt="pic">')).toContain('![pic](https://x/y.png)');
    const md = convertHtmlToMarkdown('<img src="https://x/y.png" alt="pic" width="100" height="50">');
    expect(md).toContain('<img src="https://x/y.png" alt="pic" style="width: 100px; height: 50px" />');
    const html2 = convertMarkdownToHtml(md);
    expect(html2).toContain('style="width: 100px; height: 50px"');
    expect(attrOf(html2, 'img', 'width')).toBe('100');
    expect(attrOf(html2, 'img', 'height')).toBe('50');
    const md2 = convertHtmlToMarkdown(html2);
    expect(md2.trim()).toBe(md.trim());
  });

  it('img: zero/empty dimensions stay unsized image links', () => {
    expect(convertHtmlToMarkdown('<img src="https://x/y.png" alt="pic" width="0">')).toContain('![pic](https://x/y.png)');
    expect(convertHtmlToMarkdown('<img src="https://x/y.png" alt="pic" width="">')).toContain('![pic](https://x/y.png)');
  });

  it('fileAttachment: image/video/file link forms', () => {
    const p = (type: string, url: string, name: string) =>
      `<p data-file-attachment="" data-url="${url}" data-file-name="${name}" data-type="${type}">[📎 ${name}](${url})</p>`;
    expect(convertHtmlToMarkdown(p('image', 'https://x/a.png', 'a.png'))).toContain('![a.png](https://x/a.png)');
    expect(convertHtmlToMarkdown(p('video', 'https://x/v.mp4', 'v.mp4'))).toContain('[🎥 v.mp4](https://x/v.mp4)');
    expect(convertHtmlToMarkdown(p('file', 'https://x/f.pdf', 'f.pdf'))).toContain('[📎 f.pdf](https://x/f.pdf)');
  });
});

describe('P2-gap mark serialization fix (portal custom-html-utils.tsx:11-48)', () => {
  it('mark keeps its style attr; bare mark serializes without one', () => {
    const md = convertHtmlToMarkdown(
      '<p><mark style="background-color: rgb(255, 0, 0); color: rgb(255, 255, 255)">hl</mark></p>',
    );
    expect(md).toContain('<mark style="background-color: rgb(255, 0, 0); color: rgb(255, 255, 255)">hl</mark>');
    expect(convertHtmlToMarkdown('<p><mark>plain</mark></p>')).toContain('<mark>plain</mark>');
  });

  it('u / sub / sup serialize as inline HTML (previously dropped wholesale)', () => {
    const md = convertHtmlToMarkdown('<p><u>under</u> <sub>sub</sub> <sup>sup</sup></p>');
    expect(md).toContain('<u>under</u>');
    expect(md).toContain('<sub>sub</sub>');
    expect(md).toContain('<sup>sup</sup>');
  });

  it('styled highlight parses back into the Highlight mark (native parse)', () => {
    const editor = editorWith('<p><mark style="background-color: rgb(255, 0, 0)">hl</mark></p>');
    const json = editor.getJSON() as {
      content?: Array<{ content?: Array<{ marks?: Array<{ type: string; attrs?: { color?: string } }> }> }>;
    };
    const mark = json.content?.[0]?.content?.[0]?.marks?.find((m) => m.type === 'highlight');
    expect(mark?.attrs?.color).toBe('rgb(255, 0, 0)');
  });

  // --- P3 task 5: fileAttachment persisted link forms are md-stable ---
  it('fileAttachment link forms are markdown-stable (md → html → md)', () => {
    // file/video links keep their exact link text; the image form survives
    // through the unsized-image link (the fileAttachment-image persistence
    // shape, portal :233-254).
    const forms = [
      { md: '[📎 f.pdf](https://x/f.pdf)', marker: 'href="https://x/f.pdf"' },
      { md: '[🎥 v.mp4](https://x/v.mp4)', marker: 'href="https://x/v.mp4"' },
      { md: '![a.png](https://x/a.png)', marker: 'src="https://x/a.png"' },
    ];
    for (const form of forms) {
      const html = convertMarkdownToHtml(form.md);
      expect(html).toContain(form.marker);
      expect(convertHtmlToMarkdown(html)).toContain(form.md);
    }
  });
});

// FIELD BUG (2026-10-18): toolbar text color (<span style="color: …">, the
// Color/textStyle mark) had NO turndown rule → the span was dropped wholesale
// at note save, offline AND online (the loss happens in this conversion,
// before SQLite/sync). The fontFamily rule (which handles font-only spans
// portal-exact) must generalize to color spans; and FontFamily's parse rule
// consumes the DOM node (priority 1000), so a span carrying BOTH decls parses
// as fontFamily only — color must survive combined spans too.
describe('color/textStyle serialization fix (field bug: toolbar colors lost on save)', () => {
  // Marks across ALL text nodes of the first paragraph (the end-to-end test
  // colors only part of the paragraph, so the mark can sit on any child).
  const getMarks = (editor: Editor) => {
    const json = editor.getJSON() as {
      content?: Array<{
        content?: Array<{ marks?: Array<{ type: string; attrs?: Record<string, unknown> }> }>;
      }>;
    };
    return json.content?.[0]?.content?.flatMap((node) => node.marks ?? []) ?? [];
  };

  it('color: span[style*="color"] serializes as inline HTML (was dropped wholesale)', () => {
    const md = convertHtmlToMarkdown('<p><span style="color: rgb(255, 0, 0);">bc</span></p>');
    expect(md).toContain('<span style="color: rgb(255, 0, 0)">bc</span>');
  });

  it('color: parses back into the textStyle mark and is md-stable across cycles', () => {
    const md = convertHtmlToMarkdown('<p><span style="color: rgb(255, 0, 0);">bc</span></p>');
    const editor = editorWith(convertMarkdownToHtml(md));
    expect(getMarks(editor).find((m) => m.type === 'textStyle')?.attrs?.color).toBe('rgb(255, 0, 0)');
    expect(convertHtmlToMarkdown(editor.getHTML())).toContain('<span style="color: rgb(255, 0, 0)">bc</span>');
  });

  it('font+color: both decls serialize; BOTH marks parse back (FontFamily must not consume)', () => {
    const html = `<p><span style="color: rgb(255, 0, 0); font-family: 'JetBrains Mono', monospace">x</span></p>`;
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('color: rgb(255, 0, 0)');
    expect(md).toContain("font-family: 'JetBrains Mono', monospace");
    const marks = getMarks(editorWith(convertMarkdownToHtml(md)));
    expect(marks.find((m) => m.type === 'textStyle')?.attrs?.color).toBe('rgb(255, 0, 0)');
    expect(marks.find((m) => m.type === 'fontFamily')).toBeDefined();
  });

  it('font-only span still parses into fontFamily (consuming:false regression fence)', () => {
    const marks = getMarks(editorWith("<p><span style=\"font-family: 'JetBrains Mono', monospace\">mono</span></p>"));
    expect(marks.some((m) => m.type === 'fontFamily')).toBe(true);
  });

  it('editor end-to-end: setColor → save → reload keeps the color (field repro)', () => {
    const editor = editorWith('<p>abcdef</p>');
    editor.commands.setTextSelection({ from: 2, to: 4 });
    editor.chain().setColor('#ff0000').run();
    const md = convertHtmlToMarkdown(editor.getHTML());
    const reloaded = editorWith(convertMarkdownToHtml(md));
    expect(getMarks(reloaded).find((m) => m.type === 'textStyle')?.attrs?.color).toBe('rgb(255, 0, 0)');
    expect(convertHtmlToMarkdown(reloaded.getHTML())).toContain('color: rgb(255, 0, 0)');
  });
});

describe('isLegacyHtmlDoc (FIELD BUG 2026-10-18 #2: span-first markdown misread as legacy HTML)', () => {
  it('claims only block-level HTML documents (the shapes the old client emitted)', () => {
    for (const head of ['<p>x', '<p> x', '<h1>H</h1>', '<ul><li>', '<ol><li>', '<blockquote>a', '<pre><code>b']) {
      expect(isLegacyHtmlDoc(`  ${head}`)).toBe(true);
    }
  });

  // p19/F2 (2026-10-18 audit): the pre-P2 client had NO tables and never
  // emitted a bare root <div>, so <table>/<div>-opening content can only be
  // MARKDOWN — it must take the remark path (raw HTML renders + gfm
  // round-trips losslessly) instead of the legacy raw feed.
  it('table/div-opening markdown is NOT legacy (p19/F2)', () => {
    expect(isLegacyHtmlDoc('<table><tr><td>x</td></tr></table>')).toBe(false);
    expect(isLegacyHtmlDoc('<div class="x">y</div>')).toBe(false);
    // a table opening AFTER the legacy tag would still be legacy (first tag rules)
    expect(isLegacyHtmlDoc('<p>then<table>')).toBe(true);
  });

  it('markdown opening with inline tags/comments is NOT legacy (the field-note case)', () => {
    expect(isLegacyHtmlDoc('<span style="color: rgb(0, 0, 0)"><span style="font-family: Arial">text</span></span>')).toBe(false);
    for (const head of ['<mark style="background-color: rgb(1,2,3)">hl</mark>', '<kbd>Ctrl</kbd>', '<abbr title="x">H</abbr>', '<u>u</u>', '<sub>1</sub>', '<sup>2</sup>', '<img src="https://x/y.png" style="width: 20px" />', '<!-- drawio-diagram\ndata: AA -->', '<details>\n<summary>s</summary>', 'plain **markdown** first']) {
      expect(isLegacyHtmlDoc(head)).toBe(false);
    }
    expect(isLegacyHtmlDoc('')).toBe(false);
    expect(isLegacyHtmlDoc('   ')).toBe(false);
  });
});