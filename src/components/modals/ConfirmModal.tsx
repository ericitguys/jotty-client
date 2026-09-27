import { useEffect, useRef } from 'react';

// ConfirmModal (portal parity — SidebarItem.tsx:324-332 destructive delete
// confirm): minimal controlled confirm dialog, PromptModal's sibling. Backdrop
// click, Cancel and Escape all close WITHOUT confirming; Confirm (or Enter on
// the focused button) reports via onConfirm and then closes. `destructive`
// marks the confirm button .danger (red). confirmRef lets the opener move
// focus (default: the confirm button gets it on open). Tokens only —
// .modal-backdrop/.modal-card/.prompt-actions + var(--danger).
export default function ConfirmModal({ isOpen, onClose, onConfirm, title, message, confirmText = 'Confirm', destructive = false, confirmRef }: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message?: string;
  confirmText?: string;
  destructive?: boolean;
  confirmRef?: { current: HTMLButtonElement | null };
}) {
  const innerRef = useRef<HTMLButtonElement | null>(null);
  const btnRef = confirmRef ?? innerRef;

  useEffect(() => {
    if (isOpen) btnRef.current?.focus();
  }, [isOpen, btnRef]);

  // Escape closes wherever the focus sits — listen on window, like PromptModal.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const confirm = () => { onConfirm(); onClose(); };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {message && <p>{message}</p>}
        <div className="prompt-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            ref={btnRef}
            className={destructive ? 'primary danger' : 'primary'}
            onClick={confirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}