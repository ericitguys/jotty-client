import { useEffect, useMemo, useState } from 'react';
import type { Editor } from '@tiptap/core';
import ToolbarDropdown from './ToolbarDropdown';

// Portal FontFamilyDropdown.tsx:12-122 — the hand-rolled system-font array,
// VERBATIM (plan gate: no webfont dep, no @font-face — these are system
// stacks the webview resolves natively; rows preview in their own face).
// Portal spellings kept verbatim (including 'Franklin Gothic Medium' /
// 'Cooper Black' / 'Candara' as the portal ships them).
const ALL_FONTS: { name: string; value: string }[] = [
  { name: 'Default', value: '' },
  { name: 'American Typewriter', value: "'American Typewriter', serif" },
  { name: 'Andale Mono', value: "'Andale Mono', monospace" },
  { name: 'Arial', value: 'Arial, sans-serif' },
  { name: 'Arial Black', value: "'Arial Black', sans-serif" },
  { name: 'Arial Narrow', value: "'Arial Narrow', sans-serif" },
  { name: 'Arial Rounded MT Bold', value: "'Arial Rounded MT Bold', sans-serif" },
  { name: 'Avant Garde', value: "'Avant Garde', sans-serif" },
  { name: 'Baskerville', value: 'Baskerville, serif' },
  { name: 'Big Caslon', value: "'Big Caslon', serif" },
  { name: 'Bodoni MT', value: "'Bodoni MT', serif" },
  { name: 'Book Antiqua', value: "'Book Antiqua', serif" },
  { name: 'Bookman', value: "'Bookman Old Style', serif" },
  { name: 'Bradley Hand', value: "'Bradley Hand', cursive" },
  { name: 'Brush Script MT', value: "'Brush Script MT', cursive" },
  { name: 'Calibri', value: 'Calibri, sans-serif' },
  { name: 'Calisto MT', value: "'Calisto MT', serif" },
  { name: 'Cambria', value: 'Cambria, serif' },
  { name: 'Candara', value: 'Candara, sans-serif' },
  { name: 'Century', value: 'Century, serif' },
  { name: 'Century Gothic', value: "'Century Gothic', sans-serif" },
  { name: 'Century Schoolbook', value: "'Century Schoolbook', serif" },
  { name: 'Chalkboard', value: 'Chalkboard, sans-serif' },
  { name: 'Chalkboard SE', value: "'Chalkboard SE', sans-serif" },
  { name: 'Cochin', value: 'Cochin, serif' },
  { name: 'Comic Sans MS', value: "'Comic Sans MS', cursive" },
  { name: 'Consolas', value: 'Consolas, monospace' },
  { name: 'Constantia', value: 'Constantia, serif' },
  { name: 'Cooper Black', value: "'Cooper Black', serif" },
  { name: 'Copperplate', value: 'Copperplate, fantasy' },
  { name: 'Corbel', value: 'Corbel, sans-serif' },
  { name: 'Courier', value: 'Courier, monospace' },
  { name: 'Courier New', value: "'Courier New', monospace" },
  { name: 'Cursive', value: 'cursive' },
  { name: 'Didot', value: 'Didot, serif' },
  { name: 'Ebrima', value: 'Ebrima, sans-serif' },
  { name: 'Fantasy', value: 'fantasy' },
  { name: 'Footlight MT Light', value: "'Footlight MT Light', serif" },
  { name: 'Franklin Gothic Medium', value: "'Franklin Gothic Medium', sans-serif" },
  { name: 'Futura', value: 'Futura, sans-serif' },
  { name: 'Gabriola', value: 'Gabriola, cursive' },
  { name: 'Garamond', value: 'Garamond, serif' },
  { name: 'Geneva', value: 'Geneva, sans-serif' },
  { name: 'Georgia', value: 'Georgia, serif' },
  { name: 'Gill Sans', value: "'Gill Sans', sans-serif" },
  { name: 'Gloucester MT Extra Condensed', value: "'Gloucester MT Extra Condensed', sans-serif" },
  { name: 'Goudy Old Style', value: "'Goudy Old Style', serif" },
  { name: 'Helvetica', value: 'Helvetica, sans-serif' },
  { name: 'Helvetica Neue', value: "'Helvetica Neue', sans-serif" },
  { name: 'Herculanum', value: 'Herculanum, fantasy' },
  { name: 'Hoefler Text', value: "'Hoefler Text', serif" },
  { name: 'Impact', value: 'Impact, fantasy' },
  { name: 'Luminari', value: 'Luminari, fantasy' },
  { name: 'Lucida Bright', value: "'Lucida Bright', serif" },
  { name: 'Lucida Calligraphy', value: "'Lucida Calligraphy', cursive" },
  { name: 'Lucida Console', value: "'Lucida Console', monospace" },
  { name: 'Lucida Fax', value: "'Lucida Fax', serif" },
  { name: 'Lucida Grande', value: "'Lucida Grande', sans-serif" },
  { name: 'Lucida Handwriting', value: "'Lucida Handwriting', cursive" },
  { name: 'Lucida Sans', value: "'Lucida Sans', sans-serif" },
  { name: 'Lucida Sans Typewriter', value: "'Lucida Sans Typewriter', monospace" },
  { name: 'Lucida Sans Unicode', value: "'Lucida Sans Unicode', sans-serif" },
  { name: 'MS Gothic', value: "'MS Gothic', sans-serif" },
  { name: 'MS Sans Serif', value: "'MS Sans Serif', sans-serif" },
  { name: 'MS Serif', value: "'MS Serif', serif" },
  { name: 'Marker Felt', value: "'Marker Felt', fantasy" },
  { name: 'Menlo', value: 'Menlo, monospace' },
  { name: 'Microsoft Sans Serif', value: "'Microsoft Sans Serif', sans-serif" },
  { name: 'Monaco', value: 'Monaco, monospace' },
  { name: 'Monospace', value: 'monospace' },
  { name: 'Noteworthy', value: 'Noteworthy, sans-serif' },
  { name: 'Optima', value: 'Optima, sans-serif' },
  { name: 'Palatino', value: "'Palatino Linotype', serif" },
  { name: 'Papyrus', value: 'Papyrus, fantasy' },
  { name: 'Perpetua', value: 'Perpetua, serif' },
  { name: 'Phosphate', value: 'Phosphate, fantasy' },
  { name: 'Rockwell', value: 'Rockwell, serif' },
  { name: 'Rockwell Extra Bold', value: "'Rockwell Extra Bold', serif" },
  { name: 'Sans-serif', value: 'sans-serif' },
  { name: 'Segoe Print', value: "'Segoe Print', cursive" },
  { name: 'Segoe Script', value: "'Segoe Script', cursive" },
  { name: 'Segoe UI', value: "'Segoe UI', sans-serif" },
  { name: 'Segoe UI Symbol', value: "'Segoe UI Symbol', sans-serif" },
  { name: 'Serif', value: 'serif' },
  { name: 'Signpainter', value: 'Signpainter, fantasy' },
  { name: 'Skia', value: 'Skia, sans-serif' },
  { name: 'Snell Roundhand', value: "'Snell Roundhand', cursive" },
  { name: 'Sylfaen', value: 'Sylfaen, serif' },
  { name: 'Symbol', value: 'Symbol, serif' },
  { name: 'Tahoma', value: 'Tahoma, sans-serif' },
  { name: 'Times', value: 'Times, serif' },
  { name: 'Times New Roman', value: "'Times New Roman', serif" },
  { name: 'Trattatello', value: 'Trattatello, fantasy' },
  { name: 'Trebuchet MS', value: "'Trebuchet MS', sans-serif" },
  { name: 'Tw Cen MT', value: "'Tw Cen MT', sans-serif" },
  { name: 'Verdana', value: 'Verdana, sans-serif' },
  { name: 'Zapfino', value: 'Zapfino, cursive' },
];

// Portal FontFamilyDropdown.tsx port (P3 task 6): searchable list with the
// "Search fonts..." placeholder, "No fonts found" empty state, "Default"
// first (unsets the mark), each row previewed in its own face (portal :191).
// Rendered only in visual mode (portal TiptapToolbar :462-468 — the toolbar
// hides this cluster in markdown mode; font spans have no markdown shape).
export default function FontFamilyDropdown({ editor, disabled = false }: {
  editor: Editor | null;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');

  // Live mark tracking: re-render on every editor transaction (the
  // EditorToolbar tick pattern — this component also mounts standalone in
  // tests, where the parent tick does not exist).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const onTx = () => setTick((t) => t + 1);
    editor.on('transaction', onTx);
    return () => { editor.off('transaction', onTx); };
  }, [editor]);

  // Current font off the live mark attrs (portal :128-130). Re-read on every
  // EditorToolbar transaction tick — selection changes re-render the parent.
  const currentStyle = (editor ? editor.getAttributes('fontFamily').style : '') as
    | string
    | undefined;
  const currentFont = currentStyle?.match(/font-family:\s*([^;]+)/)?.[1]?.trim() ?? '';

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ALL_FONTS;
    return ALL_FONTS.filter((font) => font.name.toLowerCase().includes(q));
  }, [search]);

  const handleSelect = (value: string) => {
    if (!editor) return;
    if (!value) {
      editor.chain().focus().unsetMark('fontFamily').run();
    } else {
      editor.chain().focus().setMark('fontFamily', { style: `font-family: ${value}` }).run();
    }
    setSearch('');
  };

  return (
    <ToolbarDropdown
      glyph="T"
      ariaLabel="Font family"
      active={!!currentFont}
      disabled={disabled || !editor}
      menuClassName="edt-fonts-menu"
    >
      <div className="edt-dd-search">
        <input
          type="text"
          placeholder="Search fonts..."
          aria-label="Search fonts"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="edt-fonts">
        {filtered.length > 0 ? (
          filtered.map((font) => (
            <button
              key={font.value || 'default'}
              type="button"
              className={`edt-dd-item edt-font-row${currentFont === font.value ? ' selected' : ''}`}
              style={{ fontFamily: font.value || 'inherit' }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSelect(font.value)}
            >
              {font.name}
            </button>
          ))
        ) : (
          <div className="edt-dd-empty">No fonts found</div>
        )}
      </div>
    </ToolbarDropdown>
  );
}