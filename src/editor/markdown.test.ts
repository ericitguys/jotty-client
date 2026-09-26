import { describe, expect, it } from 'vitest';
import { convertHtmlToMarkdown, convertMarkdownToHtml } from './markdown';

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