import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// Shared action-menu dropdown for the P3 toolbar dropdowns (Diagrams /
// FontFamily / Extra — portal ToolbarDropdown.tsx port). Mirrors the open/
// close behavior of the shared Dropdown (outside mousedown + Escape close)
// but renders a custom glyph+caret trigger (portal Button parity — hugeicons
// are portal-only, so text glyphs stand in) and arbitrary menu children.
export default function ToolbarDropdown({ glyph, ariaLabel, active = false, disabled = false, menuClassName = '', children }: {
  glyph: ReactNode;
  ariaLabel: string;
  /** Portal trigger variant: "secondary" while a related shape is active. */
  active?: boolean;
  disabled?: boolean;
  menuClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="jotty-dropdown edt-dd" ref={ref}>
      <button
        type="button"
        className={`jotty-dropdown-button edt-btn${active ? ' active' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { if (!disabled) setOpen(!open); }}
      >
        <span aria-hidden="true">{glyph}</span>
        <span className={`jotty-dropdown-chevron${open ? ' open' : ''}`} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          className={`jotty-dropdown-menu edt-dd-menu ${menuClassName}`.trim()}
          // Portal dropdowns close after any item click; the FontFamily search
          // input (non-button) must keep the menu open while focused/clicked.
          onClick={(e) => { if ((e.target as HTMLElement).closest('button')) setOpen(false); }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// One menu row (portal DiagramsDropdown item shape: glyph + title +
// description; the Extra dropdown rows carry a shortcut hint instead).
export function ToolbarDropdownItem({ glyph, label, desc, shortcut, active = false, disabled = false, title, onClick }: {
  glyph?: ReactNode;
  label: string;
  desc?: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`edt-dd-item${active ? ' active' : ''}`}
      disabled={disabled || undefined}
      title={title || undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => { if (!disabled) onClick(); }}
    >
      {glyph && <span className="edt-dd-glyph" aria-hidden="true">{glyph}</span>}
      <span className="edt-dd-item-text">
        <span className="edt-dd-title">{label}</span>
        {desc && <span className="edt-dd-desc">{desc}</span>}
      </span>
      {shortcut && <span className="edt-dd-shortcut">{shortcut}</span>}
    </button>
  );
}