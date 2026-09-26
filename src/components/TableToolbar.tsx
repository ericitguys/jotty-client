import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';

// Fixed bar placed just above the active table. Measured from the table's DOM
// node (domAtPos on the position before the table node); jsdom/headless views
// fall back to the default corner placement — exact placement is ship-time QA
// (same policy as BubbleMenu/SlashMenu).
function tableCoords(editor: Editor): { top: number; left: number } {
  try {
    const { $from } = editor.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'table') {
        const at = editor.view.domAtPos($from.before(d));
        const host = at.node as HTMLElement;
        const el: HTMLElement | null =
          host.nodeType === 1 ? ((host.childNodes[at.offset] as HTMLElement) ?? host) : host.parentElement;
        if (el && typeof el.getBoundingClientRect === 'function') {
          const r = el.getBoundingClientRect();
          if (Number.isFinite(r.top) && Number.isFinite(r.left)) {
            return { top: Math.max(r.top - 40, 4), left: r.left };
          }
        }
      }
    }
  } catch { /* jsdom/headless view: fall through to the default placement */ }
  return { top: 0, left: 0 };
}

// Table context toolbar (portal parity P1): row/col add-delete, delete table
// and header toggle for the table under the selection. NoteEditor mounts it
// with visible={editor.isActive('table')} (transaction/selectionUpdate sync,
// the same pattern as BubbleMenu); it renders nothing while not visible.
export default function TableToolbar({ editor, visible }: { editor: Editor; visible: boolean }) {
  // Active-state styling tracks the live document: re-render on every editor
  // transaction (the same tick pattern EditorToolbar/BubbleMenu use — R8).
  const [, setTick] = useState(0);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  useEffect(() => {
    if (!visible) return;
    const onTx = () => setTick((t) => t + 1);
    const onSel = () => setCoords(tableCoords(editor));
    onSel(); // initial placement at visibility time
    editor.on('transaction', onTx);
    editor.on('selectionUpdate', onSel); // re-anchor as the caret moves rows
    return () => {
      editor.off('transaction', onTx);
      editor.off('selectionUpdate', onSel);
    };
  }, [editor, visible]);

  if (!visible) return null;
  const chain = () => editor.chain().focus();
  return (
    <div className="edt-tablebar" style={{ top: coords.top, left: coords.left }} onMouseDown={(e) => e.preventDefault()}>
      <button type="button" aria-label="Row +" title="Row +" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().addRowAfter().run()}>+R</button>
      <button type="button" aria-label="Row -" title="Row -" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteRow().run()}>-R</button>
      <button type="button" aria-label="Col +" title="Col +" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().addColumnAfter().run()}>+C</button>
      <button type="button" aria-label="Col -" title="Col -" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteColumn().run()}>-C</button>
      <button type="button" aria-label="Delete table" title="Delete table" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteTable().run()}>✕</button>
      <button
        type="button"
        aria-label="Header toggle"
        title="Header toggle"
        className={editor.isActive('tableHeader') ? 'active' : ''}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => chain().toggleHeaderRow().run()}
      >H</button>
    </div>
  );
}