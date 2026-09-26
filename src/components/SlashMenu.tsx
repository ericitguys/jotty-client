import type { SlashItem } from '../editor/slashCommands';

// Controlled slash-commands popup (portal parity P1). NoteEditor renders it
// from the SlashCommands extension's mirrored suggestion state ({items,
// onPick} is the whole contract — the extension owns open/close/filter).
// Keyboard selection is integration polish, ship-time QA; click picks an
// item. mousedown preventDefault keeps the editor focused while picking
// (same pattern as the toolbar and bubble menu buttons).
export default function SlashMenu({ items, onPick, top, left }: {
  items: SlashItem[];
  onPick: (item: SlashItem) => void;
  top?: number;
  left?: number;
}) {
  if (items.length === 0) return null;
  return (
    <div
      className="edt-slash-menu"
      style={{ top, left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="edt-slash-list">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="edt-slash-item"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(item)}
          >
            <span className="edt-slash-title">{item.title}</span>
            <span className="edt-slash-hint">{item.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}