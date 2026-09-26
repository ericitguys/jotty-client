import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { noteEditorExtensions, CODE_LANGS, findActiveCodeLanguage, applyCodeLanguage } from './extensions';

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
});

// Reassure StarterKit import stays used alongside the extension module.
void StarterKit;