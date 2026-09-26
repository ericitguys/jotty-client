import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import Dropdown, { type DropdownOption } from './Dropdown';
import { applyCodeLanguage, CODE_LANGS, findActiveCodeLanguage } from '../editor/extensions';

// R4 (plan): fixed 8-preset text-color palette — no picker wheel in P1.
// The hex IS the option id, so picking applies `style="color: <hex>"` directly.
const TEXT_COLORS: DropdownOption[] = [
  { id: '#ff5f57', name: 'Red', swatch: { bg: '#ff5f57', primary: 'var(--border)' } },
  { id: '#febc2e', name: 'Yellow', swatch: { bg: '#febc2e', primary: 'var(--border)' } },
  { id: '#28c840', name: 'Green', swatch: { bg: '#28c840', primary: 'var(--border)' } },
  { id: '#57a5ff', name: 'Blue', swatch: { bg: '#57a5ff', primary: 'var(--border)' } },
  { id: '#9d5ffe', name: 'Purple', swatch: { bg: '#9d5ffe', primary: 'var(--border)' } },
  { id: '#ff6ac1', name: 'Pink', swatch: { bg: '#ff6ac1', primary: 'var(--border)' } },
  { id: '#f9f9f9', name: 'White', swatch: { bg: '#f9f9f9', primary: 'var(--border)' } },
  { id: '#333', name: 'Black', swatch: { bg: '#333', primary: 'var(--border)' } },
];

// Site-style icon buttons (mousedown preventDefault keeps editor focus — upstream pattern).
function TBtn({ label, onClick, active, disabled, children }: {
  label: string; onClick: () => void; active?: boolean; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`edt-btn${active ? ' active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={!!active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => { if (!disabled) onClick(); }}
    >{children}</button>
  );
}

export default function EditorToolbar({ editor }: { editor: Editor | null }) {
  // Active-state styling tracks the live document: re-render on every editor
  // transaction (the tick pattern NoteEditor also keeps for editor-driven UI).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const onTx = () => setTick((t) => t + 1);
    editor.on('transaction', onTx);
    return () => { editor.off('transaction', onTx); };
  }, [editor]);

  // Interface: the button row renders even while the editor instance is still
  // null (useEditor yields null on first render) — inert, all controls disabled.
  const chain = () => editor!.chain().focus();
  const dis = !editor;
  const activeColor = editor ? String(editor.getAttributes('textStyle').color ?? '') : '';
  const activeLang = editor ? findActiveCodeLanguage(editor) : null;
  return (
    <div className="edt-toolbar">
      <TBtn label="Bold" active={editor?.isActive('bold')} disabled={dis} onClick={() => chain().toggleBold().run()}><b>B</b></TBtn>
      <TBtn label="Italic" active={editor?.isActive('italic')} disabled={dis} onClick={() => chain().toggleItalic().run()}><i>I</i></TBtn>
      <TBtn label="Underline" active={editor?.isActive('underline')} disabled={dis} onClick={() => chain().toggleUnderline().run()}><u>U</u></TBtn>
      <TBtn label="Strikethrough" active={editor?.isActive('strike')} disabled={dis} onClick={() => chain().toggleStrike().run()}><s>S</s></TBtn>
      <TBtn label="Inline code" active={editor?.isActive('code')} disabled={dis} onClick={() => chain().toggleCode().run()}><code>{'<>'}</code></TBtn>
      <Dropdown
        value={activeColor}
        options={TEXT_COLORS}
        onChange={(id) => { if (editor) chain().setColor(id).run(); }}
        placeholder="Text color"
        ariaLabel="Text color"
        className="edt-color-dd"
        swatchClassName="edt-swatch"
        disabled={dis}
      />
      <TBtn label="Highlight" active={editor?.isActive('highlight')} disabled={dis} onClick={() => chain().toggleHighlight().run()}><mark>H</mark></TBtn>
      <span className="edt-sep" />
      <TBtn label="Heading" active={editor?.isActive('heading', { level: 2 })} disabled={dis} onClick={() => chain().toggleHeading({ level: 2 }).run()}><strong>H</strong></TBtn>
      <TBtn label="Bullet list" active={editor?.isActive('bulletList')} disabled={dis} onClick={() => chain().toggleBulletList().run()}>•≡</TBtn>
      <TBtn label="Ordered list" active={editor?.isActive('orderedList')} disabled={dis} onClick={() => chain().toggleOrderedList().run()}>1≡</TBtn>
      <TBtn label="Task list" active={editor?.isActive('taskList')} disabled={dis} onClick={() => chain().toggleTaskList().run()}>☑</TBtn>
      <TBtn label="Blockquote" active={editor?.isActive('blockquote')} disabled={dis} onClick={() => chain().toggleBlockquote().run()}>❝</TBtn>
      <span className="edt-sep" />
      <TBtn label="Link" active={editor?.isActive('link')} disabled={dis} onClick={() => {
        const { from, to } = editor!.state.selection;
        const url = prompt('Link URL', editor!.getAttributes('link').href || 'https://');
        if (url === null) return;
        if (url === '') { chain().unsetLink().run(); return; }
        if (from !== to) { chain().setLink({ href: url }).run(); return; }
        const text = prompt('Link text', '');
        if (text) chain().insertContent(`<a href="${url}">${text}</a>`).run();
      }}>🔗</TBtn>
      <span className="edt-sep" />
      <TBtn label="Undo" disabled={dis} onClick={() => chain().undo().run()}>↶</TBtn>
      <TBtn label="Redo" disabled={dis} onClick={() => chain().redo().run()}>↷</TBtn>
      <span className="edt-sep" />
      {/* Code-language picker (v0.15.4) — moved from the editor foot into the
          toolbar (portal parity P1). Mirrors the codeBlock under the cursor and
          applies a choice to it; outside a code block it converts the selection. */}
      <span className="edt-codelang">
        <Dropdown
          value={activeLang ?? 'plaintext'}
          options={CODE_LANGS}
          onChange={(id) => { if (editor) applyCodeLanguage(editor, id); }}
          placeholder="Code language"
          ariaLabel="Code language"
          disabled={dis}
        />
        <span className="code-lang-hint">{activeLang ? 'applies to this code block' : 'select text, then pick a language'}</span>
      </span>
    </div>
  );
}