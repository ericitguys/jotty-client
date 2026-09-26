import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import Dropdown, { type DropdownOption } from './Dropdown';

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
  // transaction (the same tick pattern NoteEditor uses for the code-language picker).
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
  return (
    <div className="edt-toolbar">
      <TBtn label="Bold" active={editor?.isActive('bold')} disabled={dis} onClick={() => chain().toggleBold().run()}><b>B</b></TBtn>
      <TBtn label="Italic" active={editor?.isActive('italic')} disabled={dis} onClick={() => chain().toggleItalic().run()}><i>I</i></TBtn>
      <TBtn label="Underline" active={editor?.isActive('underline')} disabled={dis} onClick={() => chain().toggleUnderline().run()}><u>U</u></TBtn>
      <TBtn label="Strikethrough" active={editor?.isActive('strike')} disabled={dis} onClick={() => chain().toggleStrike().run()}><s>S</s></TBtn>
      <TBtn label="Inline code" active={editor?.isActive('code')} disabled={dis} onClick={() => chain().toggleCode().run()}><code>{'<>'}</code></TBtn>
      <span className="edt-sep" />
      <TBtn label="Heading" active={editor?.isActive('heading', { level: 2 })} disabled={dis} onClick={() => chain().toggleHeading({ level: 2 }).run()}><strong>H</strong></TBtn>
      <TBtn label="Bullet list" active={editor?.isActive('bulletList')} disabled={dis} onClick={() => chain().toggleBulletList().run()}>•≡</TBtn>
      <TBtn label="Ordered list" active={editor?.isActive('orderedList')} disabled={dis} onClick={() => chain().toggleOrderedList().run()}>1≡</TBtn>
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
      {/* color + highlight dropdowns land in Task 4; code-language picker mounts in Task 4 */}
    </div>
  );
}