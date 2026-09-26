import { useEffect, useState } from 'react';

// TableInsertModal (P2 task 5, portal parity): the ONE rows/cols insert
// surface for both table entry points (R13) — the EditorToolbar Table button
// and the slash /table item both open it; the browser's native prompt
// dialog flow is gone.
// Confirm reports (rows, cols, withHeaderRow) via onInsert and then closes;
// Cancel, Escape and a backdrop click close without inserting. Defaults are
// 3/3 with the header row on; number inputs clamp to 1..8 at insert time.
// Same controlled-card shape as PromptModal — tokens only (.modal-backdrop/
// .modal-card/.prompt-actions).
export default function TableInsertModal({ isOpen, onClose, onInsert }: {
  isOpen: boolean;
  onClose: () => void;
  onInsert: (rows: number, cols: number, withHeaderRow: boolean) => void;
}) {
  const [rows, setRows] = useState('3');
  const [cols, setCols] = useState('3');
  const [header, setHeader] = useState(true);

  // Re-seed the defaults on every open (portal semantics — the modal never
  // remembers the previous note's grid).
  useEffect(() => {
    if (isOpen) {
      setRows('3');
      setCols('3');
      setHeader(true);
    }
  }, [isOpen]);

  // Escape closes wherever the focus sits — window listener, like PromptModal.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Non-numeric (cleared input) and < 1 clamp to 1; > 8 clamps to 8.
  const clamp = (v: string): number => Math.min(8, Math.max(1, Number.parseInt(v, 10) || 1));
  const insert = () => { onInsert(clamp(rows), clamp(cols), header); onClose(); };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Insert table">
        <h2>Insert table</h2>
        <div className="table-insert-grid">
          <label>
            Rows
            <input
              type="number"
              min={1}
              max={8}
              value={rows}
              onChange={(e) => setRows(e.target.value)}
            />
          </label>
          <label>
            Columns
            <input
              type="number"
              min={1}
              max={8}
              value={cols}
              onChange={(e) => setCols(e.target.value)}
            />
          </label>
        </div>
        <label className="table-insert-header">
          <input
            type="checkbox"
            checked={header}
            onChange={(e) => setHeader(e.target.checked)}
          />
          Header row
        </label>
        <div className="prompt-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" onClick={insert}>Insert</button>
        </div>
      </div>
    </div>
  );
}