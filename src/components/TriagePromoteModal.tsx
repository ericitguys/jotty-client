import { useEffect, useRef, useState } from 'react';
import Dropdown from './Dropdown';

// Promote-to-board modal (P2 Task 4; PromptModal-shaped per the brief's
// behavior law): drafts re-seed from the defaults and the card-text input
// focuses on every open; Escape, Cancel and the backdrop close WITHOUT
// confirming. Confirm (button or Enter) only REPORTS the values — closing
// stays the caller's job, so an async apply that fails can keep the dialog
// open and surface its error line; a no-boards state replaces the Dropdown
// with a placeholder and disables the confirm.
export default function TriagePromoteModal({ isOpen, onClose, onConfirm, boards, defaultText, defaultTitle, error }: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (boardId: string, cardText: string, newTitle: string) => void;
  boards: { id: string; title: string }[];
  defaultText?: string;
  defaultTitle?: string;
  error?: string;
}) {
  const [boardId, setBoardId] = useState('');
  const [cardText, setCardText] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const cardRef = useRef<HTMLInputElement>(null);

  // Re-seed the drafts and focus the card-text input on every open.
  useEffect(() => {
    if (isOpen) {
      setBoardId(boards[0]?.id ?? '');
      setCardText(defaultText ?? '');
      setNewTitle(defaultTitle ?? '');
      cardRef.current?.focus();
    }
  }, [isOpen, defaultText, defaultTitle, boards]);

  // Escape closes wherever the focus sits — listen on window (PromptModal law).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const hasBoards = boards.length > 0;
  const confirm = () => { if (hasBoards) onConfirm(boardId, cardText, newTitle); };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Promote to board">
        <h2>Promote to board</h2>
        {error && <div className="triage-error">{error}</div>}
        {hasBoards ? (
          <Dropdown
            value={boardId}
            options={boards.map((b) => ({ id: b.id, name: b.title }))}
            onChange={setBoardId}
            placeholder="Pick a board"
            ariaLabel="Board"
          />
        ) : (
          <p>No kanban boards yet</p>
        )}
        <input
          ref={cardRef}
          autoFocus
          aria-label="Card text"
          value={cardText}
          placeholder="Card text"
          onChange={(e) => setCardText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
        />
        <input
          aria-label="Card title"
          value={newTitle}
          placeholder="Card title"
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
        />
        <div className="prompt-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={!hasBoards} onClick={confirm}>Confirm</button>
        </div>
      </div>
    </div>
  );
}