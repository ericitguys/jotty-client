import { useEffect, useRef, useState } from 'react';
import { dateLabel, monthLabel, monthMatrix, parseYmd, todayYmd, weekdayLabels, ymd } from './calendarGrid';

// Pure-DOM date picker (v0.22.2, WebKitGTK eradication): the desktop webview's
// native <input type=date> calendar popup commits a day-pick but NEVER closes
// and keeps grabbing pointer+keyboard (probed 2026-09-29) — the user gets
// trapped with no way out. This replaces every native date input with the
// same shell the time Dropdown uses (jotty-dropdown trigger + menu): closes
// on pick / outside-click / Escape, saves in the exact 'YYYY-MM-DD' format
// the native .value carried, so all save paths are byte-identical.
export default function DateDropdown({ value, onChange, placeholder, ariaLabel = 'Date', className = '', showClear = false }: {
  value: string;
  onChange: (ymd: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  /** Only where '' is a real clearable state (Set date). The reminder editor's
   * only clear path stays the menu's Clear reminder row (never a half-save). */
  showClear?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [viewYM, setViewYM] = useState<{ y: number; m: number } | null>(null);
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

  const openMonth = (ymdStr: string) => {
    const d = parseYmd(ymdStr);
    const b = d ?? new Date();
    setViewYM({ y: b.getFullYear(), m: b.getMonth() });
    setOpen(true);
  };

  const shiftMonth = (delta: number) => {
    setViewYM((v) => {
      if (!v) return v;
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  };

  const view = viewYM ?? { y: new Date().getFullYear(), m: new Date().getMonth() };
  const matrix = monthMatrix(view.y, view.m);
  const today = todayYmd();
  const weekdays = weekdayLabels();

  return (
    <div className={`jotty-dropdown ${className}`.trim()} ref={ref}>
      <button
        type="button"
        className="jotty-dropdown-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openMonth(value))}
      >
        <span className="jotty-dropdown-label">{dateLabel(value) || placeholder}</span>
        <span className={`jotty-dropdown-chevron${open ? ' open' : ''}`} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="jotty-dropdown-menu jotty-date-menu" role="dialog" aria-label={ariaLabel}>
          <div className="jotty-date-header">
            <button type="button" aria-label="Previous month" onClick={() => shiftMonth(-1)}>‹</button>
            <span>{monthLabel(view.y, view.m)}</span>
            <button type="button" aria-label="Next month" onClick={() => shiftMonth(1)}>›</button>
          </div>
          <div className="jotty-date-weekdays" aria-hidden="true">
            {weekdays.map((wd) => (
              <span key={wd} className="jotty-date-wd">{wd}</span>
            ))}
          </div>
          <div className="jotty-date-grid">
            {matrix.weeks.flat().map((cell, i) => (
              <button
                key={cell.date + i}
                type="button"
                aria-label={cell.date}
                className={`jotty-date-day${cell.inMonth ? '' : ' dim'}${cell.date === value ? ' selected' : ''}${cell.date === today ? ' jotty-date-today' : ''}`}
                onClick={() => { onChange(cell.date); setOpen(false); }}
              >
                {Number(cell.date.slice(8, 10))}
              </button>
            ))}
          </div>
          <div className="jotty-date-actions">
            <button type="button" onClick={() => { onChange(today); setOpen(false); }}>Today</button>
            {showClear && (
              <button type="button" onClick={() => { onChange(''); setOpen(false); }}>Clear</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}