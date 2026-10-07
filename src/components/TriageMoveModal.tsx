import { useEffect, useRef, useState } from 'react';

// Move-note modal (P2 Task 4; PromptModal-shaped per the brief's behavior
// law): category draft re-seeds on every open and the preset chips fill the
// input without confirming; the rename draft defaults to the CURRENT title
// and is allowed to stay empty — the caller applies the keep-title fallback.
// Escape, Cancel and the backdrop close WITHOUT confirming; Confirm only
// REPORTS the values (closing stays the caller's job, so an async apply that
// fails can keep the dialog open).
export default function TriageMoveModal({ isOpen, onClose, onConfirm, presets, defaultCategory, defaultTitle }: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (category: string, newTitle: string) => void;
  presets: string[];
  defaultCategory?: string;
  defaultTitle?: string;
}) {
  const [category, setCategory] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const catRef = useRef<HTMLInputElement>(null);

  // Re-seed the drafts and focus the category input on every open.
  useEffect(() => {
    if (isOpen) {
      setCategory(defaultCategory ?? '');
      setNewTitle(defaultTitle ?? '');
      catRef.current?.focus();
    }
  }, [isOpen, defaultCategory, defaultTitle]);

  // Escape closes wherever the focus sits — listen on window (PromptModal law).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const confirm = () => { onConfirm(category, newTitle); };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Move note">
        <h2>Move note</h2>
        <input
          ref={catRef}
          autoFocus
          aria-label="Category"
          value={category}
          placeholder="Category"
          onChange={(e) => setCategory(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
        />
        <div className="triage-presets">
          {presets.map((p) => (
            <button key={p} type="button" className="triage-preset" onClick={() => setCategory(p)}>
              {p}
            </button>
          ))}
        </div>
        <input
          aria-label="Title"
          value={newTitle}
          placeholder="Title"
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
        />
        <div className="prompt-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" onClick={confirm}>Confirm</button>
        </div>
      </div>
    </div>
  );
}