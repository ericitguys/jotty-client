import { useEffect, useRef, useState } from 'react';

// PromptModal (P2 task 4, portal parity): minimal controlled prompt-style
// dialog. Backdrop click, Cancel and Escape all close without confirming;
// Confirm (or Enter) reports the typed value via onConfirm(value) and then
// closes. The value re-seeds from defaultValue every time isOpen flips true,
// so the current link href is pre-filled on each open (portal semantics:
// upstream PromptModal.tsx:33-38). Tokens only — .modal-backdrop/.modal-card.
export default function PromptModal({ isOpen, onClose, onConfirm, title, message, placeholder, defaultValue, confirmText = 'Confirm' }: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (value: string) => void;
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-seed the draft value and focus the input on every open.
  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue ?? '');
      inputRef.current?.focus();
    }
  }, [isOpen, defaultValue]);

  // Escape closes wherever the focus sits — listen on window, like the
  // bubble menu's Escape handling.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const confirm = () => { onConfirm(value); onClose(); };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {message && <p>{message}</p>}
        <input
          ref={inputRef}
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
        />
        <div className="prompt-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" onClick={confirm}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}