import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import { noteEditorExtensions, CODE_LANGS, findActiveCodeLanguage, applyCodeLanguage } from './extensions';
import { SLASH_ITEMS } from './slashCommands';
import { DEFAULT_MERMAID } from './extensions/diagrams';
import { convertHtmlToMarkdown, convertMarkdownToHtml } from './markdown';

function editorWith(content: string): Editor {
  return new Editor({
    extensions: noteEditorExtensions(),
    content,
  });
}

describe('note editor code-block languages', () => {
  it('CODE_LANGS covers the common languages including python and rust', () => {
    const ids = CODE_LANGS.map((l) => l.id);
    for (const want of ['plaintext', 'python', 'javascript', 'typescript', 'rust', 'go', 'bash', 'json', 'yaml', 'sql', 'xml', 'css', 'c', 'cpp', 'java']) {
      expect(ids).toContain(want);
    }
    // site-style Dropdown options carry human labels
    expect(CODE_LANGS.find((l) => l.id === 'python')?.name).toBe('Python');
  });

  it('parses a code block with a language class and keeps the language in the html round-trip', () => {
    const editor = editorWith('<pre><code class="language-python">x = 1</code></pre>');
    const json = editor.getJSON() as { content?: Array<{ type: string; attrs?: { language?: string } }> };
    const block = json.content?.find((n) => n.type === 'codeBlock');
    expect(block?.attrs?.language).toBe('python');
    expect(editor.getHTML()).toContain('class="language-python"');
  });

  it('toggleCodeBlock with a language wraps selected text and stamps the language class', () => {
    const editor = editorWith('<p>hi</p>');
    editor.commands.setTextSelection({ from: 1, to: 3 });
    editor.chain().focus().toggleCodeBlock({ language: 'rust' }).run();
    expect(editor.isActive('codeBlock')).toBe(true);
    expect(editor.getHTML()).toContain('class="language-rust"');
  });

  it('findActiveCodeLanguage returns the language of the block under the cursor', () => {
    const editor = editorWith('<pre><code class="language-python">x = 1</code></pre>');
    editor.commands.setTextSelection(2); // inside the code block
    expect(findActiveCodeLanguage(editor)).toBe('python');
  });

  it('applyCodeLanguage stamps the language on the active code block', () => {
    const editor = editorWith('<pre><code>x = 1</code></pre>');
    editor.commands.setTextSelection(2);
    applyCodeLanguage(editor, 'go');
    expect(findActiveCodeLanguage(editor)).toBe('go');
    expect(editor.getHTML()).toContain('class="language-go"');
  });

  it('noteEditorExtensions replaces the bare codeBlock with the lowlight one', () => {
    const editor = editorWith('<pre><code class="language-python">x = 1</code></pre>');
    // ProseMirror schema evidence: the codeBlock node carries a language attribute
    const schema = editor.schema;
    expect((schema.nodes.codeBlock.spec.attrs as Record<string, unknown>)?.language).toBeDefined();
    // highlighting is wired: the codeBlock extension carries the lowlight instance
    const ext = noteEditorExtensions().find((e) => e.name === 'codeBlock');
    expect(ext).toBeDefined();
    expect((ext as unknown as { options: { lowlight: unknown } }).options.lowlight).toBeDefined();
  });

  it('parses task list items with checked state and round-trips them', () => {
    const editor = editorWith(
      '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked><span></span></label><div><p>done</p></div></li><li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>open</p></div></li></ul>'
    );
    const json = editor.getJSON() as { content?: Array<{ type: string; content?: Array<{ type: string; attrs?: { checked?: boolean } }> }> };
    const list = json.content?.find((n) => n.type === 'taskList');
    const items = list?.content ?? [];
    expect(items).toHaveLength(2);
    expect(items[0].attrs?.checked).toBe(true);
    expect(items[1].attrs?.checked).toBe(false);
    expect(editor.getHTML()).toContain('data-type="taskList"');
  });

  it('parses and serializes tables', () => {
    const editor = editorWith(
      '<table><tr><th>h</th></tr><tr><td>c</td></tr></table>'
    );
    const json = editor.getJSON() as { content?: Array<{ type: string }> };
    expect(json.content?.some((n) => n.type === 'table')).toBe(true);
    expect(editor.getHTML()).toContain('<th');
  });

  it('underline and highlight marks round-trip', () => {
    const editor = editorWith('<p><u>under</u> and <mark data-color="#ff0000" style="background-color: #ff0000; color: #ffffff;">hl</mark></p>');
    const html = editor.getHTML();
    expect(html).toContain('<u>');
    expect(html).toContain('mark');
  });

  it('color and subscript/superscript marks work', () => {
    const editor = editorWith('<p>plain</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.chain().focus().setColor('#ff0000').run();
    editor.chain().focus().toggleSubscript().run();
    expect(editor.getHTML()).toContain('color');
  });
});

// Reassure StarterKit import stays used alongside the extension module.
void StarterKit;

describe('slash commands', () => {
  it('offers the portal set of inserters', () => {
    const titles = SLASH_ITEMS.map((i) => i.title);
    for (const want of ['Heading 1', 'Heading 2', 'Bullet list', 'Ordered list', 'Task list', 'Code block', 'Quote', 'Table']) {
      expect(titles).toContain(want);
    }
  });

  it('running the code-block item converts the current block', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setTextSelection(1);
    const item = SLASH_ITEMS.find((i) => i.title === 'Code block')!;
    item.command({ editor, range: { from: 1, to: 2 } });
    expect(editor.isActive('codeBlock')).toBe(true);
  });

  // P2 task 5 (R13): the /table item opens the shared TableInsertModal via an
  // editor-storage flag + meta-tick ping (the suggestion plugin cannot render
  // into React) — no prompt(), no immediate insert; the insert is modal-driven.
  it('the Table item plants the tableModal storage flag instead of inserting', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setTextSelection(1);
    const item = SLASH_ITEMS.find((i) => i.title === 'Table')!;
    item.command({ editor, range: { from: 1, to: 2 } });
    const flag = editor.storage.tableModal as { open: boolean; range: unknown } | undefined;
    expect(flag?.open).toBe(true);
    expect(flag?.range).toEqual({ from: 1, to: 2 });
    expect(editor.getHTML()).not.toContain('<table');
  });
});

// --- P3 task 6: the portal-labeled insert items (/image landed with T4;
// file/collapsible/callout/mermaid/drawio/excalidraw land here) ---

describe('P3 slash additions (file / collapsible / callout / diagrams)', () => {
  it('offers the portal-labeled P3 items alongside the canonical P1 set', () => {
    const titles = SLASH_ITEMS.map((i) => i.title);
    for (const want of ['Image', 'File', 'Collapsible', 'Callout', 'Mermaid Diagram', 'Draw.io Diagram', 'Excalidraw Diagram']) {
      expect(titles).toContain(want);
    }
  });

  it('the File item plants the fileModal storage flag (the T5 contract) instead of inserting', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setTextSelection(1);
    const item = SLASH_ITEMS.find((i) => i.title === 'File')!;
    item.command({ editor, range: { from: 1, to: 2 } });
    const flag = editor.storage.fileModal as { open: boolean; range: unknown } | undefined;
    expect(flag?.open).toBe(true);
    // slash origin — the /query range rides along; NoteEditor's confirm
    // deletes it before setFileAttachment (the exact /table + /image pattern).
    expect(flag?.range).toEqual({ from: 1, to: 2 });
    expect(editor.getHTML()).not.toContain('data-file-attachment');
  });

  it('the Collapsible item deletes the /query range and wraps, summary from the selection', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setTextSelection({ from: 1, to: 2 });
    const item = SLASH_ITEMS.find((i) => i.title === 'Collapsible')!;
    item.command({ editor, range: { from: 1, to: 2 } });
    const html = editor.getHTML();
    // T2 shape: the summary serializes BOTH as the details attr and the
    // summary child element.
    expect(html).toContain('<details');
    expect(html).toContain('<summary>x</summary>');
  });

  it('the Callout item inserts an info callout (portal SlashCommands.tsx:151-158)', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setTextSelection(1);
    const item = SLASH_ITEMS.find((i) => i.title === 'Callout')!;
    item.command({ editor, range: { from: 1, to: 2 } });
    const json = editor.getJSON() as { content?: Array<{ type: string; attrs?: { type?: string } }> };
    expect(json.content?.find((n) => n.type === 'callout')?.attrs?.type).toBe('info');
  });

  it('the Mermaid item inserts the portal default template', () => {
    const editor = editorWith('<p>x</p>');
    editor.commands.setTextSelection(1);
    const item = SLASH_ITEMS.find((i) => i.title === 'Mermaid Diagram')!;
    item.command({ editor, range: { from: 1, to: 2 } });
    const json = editor.getJSON() as { content?: Array<{ type: string; attrs?: { content?: string } }> };
    expect(json.content?.find((n) => n.type === 'mermaid')?.attrs?.content).toBe(DEFAULT_MERMAID);
  });

  it('the Draw.io and Excalidraw items insert their (empty) diagram nodes', () => {
    const drawio = editorWith('<p>x</p>');
    drawio.commands.setTextSelection(1);
    SLASH_ITEMS.find((i) => i.title === 'Draw.io Diagram')!.command({ editor: drawio, range: { from: 1, to: 2 } });
    expect(drawio.getHTML()).toContain('data-drawio');
    const excal = editorWith('<p>x</p>');
    excal.commands.setTextSelection(1);
    SLASH_ITEMS.find((i) => i.title === 'Excalidraw Diagram')!.command({ editor: excal, range: { from: 1, to: 2 } });
    expect(excal.getHTML()).toContain('data-excalidraw');
  });
});

// --- P3 task 6 polish: the deferred minors ---

describe('P3 polish: subscript/superscript getHTML round-trips (T1-P1 minor)', () => {
  it('<sub>/<sup> parse and survive the markdown pipeline as tags', () => {
    const editor = editorWith('<p><sub>sb</sub> <sup>sp</sup></p>');
    const html = editor.getHTML();
    expect(html).toContain('<sub>sb</sub>');
    expect(html).toContain('<sup>sp</sup>');
    const md = convertHtmlToMarkdown(html);
    expect(md).toContain('<sub>sb</sub>');
    expect(md).toContain('<sup>sp</sup>');
    const editor2 = editorWith(convertMarkdownToHtml(md));
    expect(editor2.getHTML()).toContain('<sub>sb</sub>');
    expect(editor2.getHTML()).toContain('<sup>sp</sup>');
  });

  it('toggleSubscript/toggleSuperscript emit <sub>/<sup> output', () => {
    const sub = editorWith('<p>plain</p>');
    sub.commands.setTextSelection({ from: 1, to: 6 });
    sub.chain().focus().toggleSubscript().run();
    expect(sub.getHTML()).toContain('<sub>plain</sub>');
    const sup = editorWith('<p>plain</p>');
    sup.commands.setTextSelection({ from: 1, to: 6 });
    sup.chain().focus().toggleSuperscript().run();
    expect(sup.getHTML()).toContain('<sup>plain</sup>');
  });
});

describe('P3 polish: plain highlight keeps a style-less <mark> (P1 minor pin)', () => {
  // P1 review minor adjudicated (probed at base 4475d3a): the stock
  // multicolor Highlight renderHTML returns {} for a null color, so the
  // PLAIN path already serializes a bare <mark> through getHTML AND the
  // markdown pipeline; the `color: inherit` companion appears only on
  // COLORED highlights (upstream stock, portal-exact — left untouched).
  it('a color-less toggleHighlight serializes <mark> WITHOUT a style attr', () => {
    const editor = editorWith('<p>plain</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.chain().focus().toggleHighlight().run();
    expect(editor.getHTML()).toContain('<mark>plain</mark>');
    expect(editor.getHTML()).not.toContain('<mark style');
  });
});