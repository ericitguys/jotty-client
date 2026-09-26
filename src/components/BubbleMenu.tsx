import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';

// Pill width mirrors the rendered .edt-bubble width (5 icon buttons); used only
// for clamping the fixed position inside the editor container.
const BUBBLE_W = 230;

// Place the pill just above the selection end, clamped into the editor
// container. coordsAtPos does DOM measurement the jsdom tests do not make
// deterministic, so any failure/zero-rect falls back to a fixed corner.
function bubbleCoords(editor: Editor): { top: number; left: number } {
  try {
    const c = editor.view.coordsAtPos(editor.state.selection.to);
    const r = editor.view.dom.getBoundingClientRect();
    const top = Math.max(c.top - 44, r.top + 4);
    const left = Math.min(Math.max(c.left - BUBBLE_W / 2, r.left + 4), Math.max(r.right - BUBBLE_W - 4, r.left + 4));
    if (Number.isFinite(top) && Number.isFinite(left)) return { top, left };
  } catch { /* jsdom/headless view: fall through to the default placement */ }
  return { top: 0, left: 0 };
}

export default function BubbleMenu({ editor, visible, onClose }: {
  editor: Editor; visible: boolean; onClose: () => void;
}) {
  // Active-state styling tracks the live document: re-render on every editor
  // transaction (the same tick pattern EditorToolbar uses — ruling R8).
  const [, setTick] = useState(0);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  useEffect(() => {
    if (!visible) return;
    const onTx = () => setTick((t) => t + 1);
    const onSel = () => setCoords(bubbleCoords(editor));
    onSel(); // initial placement at visibility time
    editor.on('transaction', onTx);
    editor.on('selectionUpdate', onSel); // recompute on every selection move
    return () => {
      editor.off('transaction', onTx);
      editor.off('selectionUpdate', onSel);
    };
  }, [editor, visible]);

  if (!visible) return null;
  const chain = () => editor.chain().focus();
  const apply = (fn: () => void) => { fn(); onClose(); };
  return (
    <div className="edt-bubble" style={{ top: coords.top, left: coords.left }} onMouseDown={(e) => e.preventDefault()}>
      <button aria-label="Bold" className={editor.isActive('bold') ? 'active' : ''} onClick={() => apply(() => chain().toggleBold().run())}><b>B</b></button>
      <button aria-label="Italic" className={editor.isActive('italic') ? 'active' : ''} onClick={() => apply(() => chain().toggleItalic().run())}><i>I</i></button>
      <button aria-label="Underline" className={editor.isActive('underline') ? 'active' : ''} onClick={() => apply(() => chain().toggleUnderline().run())}><u>U</u></button>
      <button aria-label="Strikethrough" className={editor.isActive('strike') ? 'active' : ''} onClick={() => apply(() => chain().toggleStrike().run())}><s>S</s></button>
      <button aria-label="Link" onClick={() => apply(() => {
        const url = prompt('Link URL', editor.getAttributes('link').href || 'https://');
        if (url) chain().setLink({ href: url }).run();
      })}>🔗</button>
    </div>
  );
}