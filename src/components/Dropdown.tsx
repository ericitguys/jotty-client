import { useEffect, useRef, useState } from 'react';

export interface DropdownOption {
  id: string;
  name: string;
  /** Theme-identity colors (preview chip) — describes the TARGET theme, not the current UI. */
  swatch?: { bg: string; primary: string };
}

// Mirrors upstream jotty's Dropdown (app/_components/GlobalComponents/Dropdowns/Dropdown.tsx):
// full-width trigger (p-3, rounded, border-border) + absolute menu (bg-card, border, shadow)
// with hover/selected rows — restyled to this app's CSS tokens instead of Tailwind.
export default function Dropdown({ value, options, onChange, placeholder, ariaLabel = 'Theme', className = '' }: {
  value: string;
  options: DropdownOption[];
  onChange: (id: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
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

  const selected = options.find((o) => o.id === value);

  return (
    <div className={`jotty-dropdown ${className}`.trim()} ref={ref}>
      <button
        type="button"
        className="jotty-dropdown-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen(!open)}
      >
        <span className="jotty-dropdown-label">
          {selected?.swatch && (
            <span
              className="jotty-dropdown-swatch"
              style={{ background: selected.swatch.bg, borderColor: selected.swatch.primary }}
            />
          )}
          {selected?.name ?? placeholder}
        </span>
        <span className={`jotty-dropdown-chevron${open ? ' open' : ''}`} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="jotty-dropdown-menu" role="listbox">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={o.id === value}
              className={`jotty-dropdown-option${o.id === value ? ' selected' : ''}`}
              onClick={() => { onChange(o.id); setOpen(false); }}
            >
              {o.swatch && (
                <span
                  className="jotty-dropdown-swatch"
                  style={{ background: o.swatch.bg, borderColor: o.swatch.primary }}
                />
              )}
              <span>{o.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}