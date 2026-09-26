import type { Editor } from '@tiptap/core';
import { toggleDetails } from '../editor/extensions';
import ToolbarDropdown, { ToolbarDropdownItem } from './ToolbarDropdown';

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

// Portal shortcut hints (ExtraItemsDropdown getShortcutDisplay: the shift
// glyph rides in front — ⇧⌘I on Mac, ⇧CtrlI elsewhere). The KEY HANDLING
// itself stays portal-side: the desktop has no useShortcuts infra, and
// registering global combos here would fight the existing keymaps —
// disclosed ship-QA (the hints are display-only).
const shortcut = (code: string): string => `⇧${isMac ? '⌘' : 'Ctrl'}${code.replace('Key', '')}`;

interface ExtraItemsDropdownProps {
  editor: Editor | null;
  markdownMode?: boolean;
  disabled?: boolean;
  onAbbreviationRequest?: () => void;
}

// Portal ExtraItemsDropdown.tsx port (P3 task 6) — MINUS the four items that
// shipped as toolbar buttons in P1/P2 (Table ⌘⇧T / Highlight ⌘⇧H /
// Subscript ⌘, / Superscript ⌘. — controller binding: omit them). The P3
// item set: Image, File, Abbreviation, Collapsible (portal order).
export default function ExtraItemsDropdown({
  editor,
  markdownMode = false,
  disabled = false,
  onAbbreviationRequest,
}: ExtraItemsDropdownProps) {
  const md = !!markdownMode;

  // P3 task 6 (R23 + the T4/T5 contracts): the Image / File buttons plant
  // the EXISTING imageModal / fileModal storage flags — button origin, so
  // range: null (only slash origins carry the /query range; NoteEditor's
  // confirm deletes it) — plus the meta-tick ping its transaction tick
  // re-reads (the suggestion plugin cannot render into React; the same
  // mirror-and-tick pattern the /table + /image slash items use).
  const plant = (key: 'imageModal' | 'fileModal') => {
    if (!editor) return;
    editor.storage[key] = { open: true, range: null };
    try {
      if (!editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr.setMeta(key, Date.now()));
      }
    } catch { /* view tearing down: nothing left to notify */ }
  };

  // Portal toggleAbbreviation: when the mark is active the item toggles it
  // OFF; otherwise it opens the NoteEditor-owned PromptModal ("Abbreviation")
  // whose confirm stamps setMark('abbreviation', { title }) (R23 — no
  // native prompt; the modal lives in NoteEditor per the task binding).
  const toggleAbbreviation = () => {
    if (!editor) return;
    if (editor.isActive('abbreviation')) {
      editor.chain().focus().unsetMark('abbreviation').run();
      return;
    }
    onAbbreviationRequest?.();
  };

  const dis = disabled || !editor;

  return (
    <ToolbarDropdown
      glyph="⋯"
      ariaLabel="Extra items"
      disabled={disabled || !editor}
      menuClassName="edt-extra-menu"
    >
      <ToolbarDropdownItem
        glyph="🖼️"
        label="Image"
        shortcut={shortcut('KeyI')}
        disabled={dis || md}
        title={md ? 'Rich mode only' : undefined}
        onClick={() => plant('imageModal')}
      />
      <ToolbarDropdownItem
        glyph="📎"
        label="File"
        shortcut={shortcut('KeyF')}
        disabled={dis || md}
        title={md ? 'Rich mode only' : undefined}
        onClick={() => plant('fileModal')}
      />
      <ToolbarDropdownItem
        glyph="AB"
        label="Abbreviation"
        shortcut={shortcut('KeyA')}
        disabled={dis || md}
        active={!!editor?.isActive('abbreviation')}
        title={md ? 'Rich mode only' : undefined}
        onClick={toggleAbbreviation}
      />
      <ToolbarDropdownItem
        glyph="⤵"
        label="Collapsible"
        shortcut={shortcut('KeyD')}
        disabled={dis || md}
        active={!!editor?.isActive('details')}
        title={md ? 'Rich mode only' : undefined}
        onClick={() => { if (editor && !md) toggleDetails(editor); }}
      />
    </ToolbarDropdown>
  );
}