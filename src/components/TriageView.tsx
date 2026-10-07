import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api/client';
import type { NoteDto } from '../api/types';
import { isCaptureZone, useStore } from '../stores/store';
import { relativeAge } from '../util/relativeTime';
import { TRIAGE_MOVE_PRESET } from '../triage/routes';
import { titleFromText } from '../triage/titles';
import ConfirmModal from './modals/ConfirmModal';
import TriageMoveModal from './TriageMoveModal';
import TriagePromoteModal from './TriagePromoteModal';

// Single action mapping (plan T3 interface): the three buttons AND the a/m/x
// keys already route every entry point through here. Task 4 wired the bodies:
// promote = TriagePromoteModal → promote_note_to_board; move = TriageMoveModal
// → update_note (originalCategory attached Rust-side when it changes);
// discard = ConfirmModal (destructive) → store deleteNote (refreshes itself).
// The keyboard/button plumbing stays byte-stable.
export type TriageAction = 'promote' | 'move' | 'discard';

// Error-line text (facts §16 strip style — mirrors VoiceNoteReview.tsx / fmt):
// tauri rejections carry the inner error text; an Error object's class wrapper
// is stripped so the line reads like the Rust message.
const fmtError = (e: unknown): string => String(e).replace(/^.*Error: /, '');

// Promote card-text default: first non-empty line of the content, hard-capped
// at 120 chars (plan Task 4 interface, verbatim).
const firstCardTextLine = (content: string): string =>
  content.split('\n').map((s) => s.trim()).find(Boolean)?.slice(0, 120) ?? '';

// Snippet: content squashed to one line, hard-capped at 160 chars (plan T3).
const squash = (content: string): string =>
  content.replace(/\s+/g, ' ').trim().slice(0, 160);

// Internal sort: createdAt desc with id tiebreak on a COPY (never mutate props).
const sortByCreatedDesc = (notes: NoteDto[]): NoteDto[] =>
  [...notes].sort((a, b) => {
    const ka = a.createdAt ?? '';
    const kb = b.createdAt ?? '';
    if (ka !== kb) return ka < kb ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });

export default function TriageView({ notes }: { notes: NoteDto[] }) {
  // Defensive zone filter (plan T3 interface): App passes only capture-zone
  // notes, but the view owns its own gate so no future caller can leak
  // non-capture rows into triage.
  const cards = useMemo(
    () => sortByCreatedDesc(notes).filter((n) => isCaptureZone(n.category)),
    [notes],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  // Wired action state (Task 4): the open dialog's route + the note it works
  // on + the last apply's error line. modalOpen is DERIVED (never stored) so
  // modalOpenRef can stay a plain per-render mirror.
  const [modal, setModal] = useState<TriageAction | null>(null);
  const [activeNote, setActiveNote] = useState<NoteDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const activeNoteRef = useRef<NoteDto | null>(null);
  // Single-invoke law: re-entry while an apply is awaiting is ignored, so a
  // double-Confirm click cannot enqueue a op twice.
  const busyRef = useRef(false);

  const checklists = useStore((s) => s.checklists);
  // Promote picker (brief): checklists filtered to the BOARD types, mapped to
  // {id,title}, sorted title asc. STOP-CONTRACT verified: ChecklistDto
  // listType values in-repo are 'kanban' + the deprecated 'task' alias
  // (push.rs is_kanban gate; 'simple' = plain checklists).
  const boardsForPicker = useMemo(
    () => (checklists ?? [])
      .filter((c) => c.listType === 'kanban' || c.listType === 'task')
      .map((c) => ({ id: c.id, title: c.title }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    [checklists],
  );

  const onAction = (action: TriageAction, note: NoteDto): void => {
    // Defensive double-guard (brief): the Rust apply revalidates server-side
    // ("stale: note no longer exists" → zero enqueues); the view additionally
    // refuses to open ANY modal when the note is already gone from the live
    // catalog — clear the selection instead.
    if (!(useStore.getState().notes ?? []).some((m) => m.id === note.id)) {
      setActiveIndex(-1);
      return;
    }
    setErr(null);
    setActiveNote(note);
    setModal(action);
  };

  const closeModal = (): void => {
    setModal(null);
    setActiveNote(null);
    setErr(null);
  };

  const clearAfterApply = closeModal;

  const applyPromote = async (boardId: string, cardText: string, newTitle: string): Promise<void> => {
    const note = activeNoteRef.current;
    if (!note || busyRef.current) return;
    busyRef.current = true;
    try {
      await api.promoteNoteToBoard(note.id, boardId, cardText, newTitle);
      await useStore.getState().refreshAll();
      clearAfterApply();
    } catch (e) {
      setErr(fmtError(e));
    } finally {
      busyRef.current = false;
    }
  };

  const applyMove = async (newCategory: string, newTitle: string): Promise<void> => {
    const note = activeNoteRef.current;
    if (!note || busyRef.current) return;
    busyRef.current = true;
    try {
      // Rename-input fallback per brief: blank keeps the current title.
      // updateNote stays the 4-key wire primitive; the Rust attach layer adds
      // originalCategory when (and only when) the category actually changes.
      await api.updateNote(note.id, newTitle.trim() || note.title, note.content, newCategory.trim());
      await useStore.getState().refreshAll();
      clearAfterApply();
    } catch (e) {
      // Close-on-failure (task-4 review F2 rider): TriageMoveModal carries no
      // in-dialog error affordance, so a failure leaves the dialog and lets
      // the section-level .triage-error line surface — same accepted asymmetry
      // as discard (ConfirmModal self-closes). setErr AFTER closeModal, whose
      // own reset would swallow it otherwise.
      closeModal();
      setErr(fmtError(e));
    } finally {
      busyRef.current = false;
    }
  };

  const applyDiscard = async (): Promise<void> => {
    const note = activeNoteRef.current;
    if (!note || busyRef.current) return;
    busyRef.current = true;
    try {
      // deleteNote already refreshes all (store law) — NO extra refresh here.
      await useStore.getState().deleteNote(note.id);
      clearAfterApply();
    } catch (e) {
      setErr(fmtError(e));
    } finally {
      busyRef.current = false;
    }
  };

  // Keep the selected card visible after j/k. jsdom has no scrollIntoView —
  // guard before calling (plan test conventions).
  const selectedRef = useRef<HTMLLIElement | null>(null);

  // Stale-closure law (facts §10, App window-listener precedent): the keydown
  // listener below registers ONCE with empty deps, so every value it reads is
  // mirrored into a ref on every render — including the CURRENT mapping.
  const cardsRef = useRef(cards);
  const activeIndexRef = useRef(activeIndex);
  const modalOpenRef = useRef(modal !== null);
  const actionRef = useRef(onAction);
  const selectedIdxRef = useRef(selectedRef);
  cardsRef.current = cards;
  activeIndexRef.current = activeIndex;
  modalOpenRef.current = modal !== null;
  actionRef.current = onAction;
  selectedIdxRef.current = selectedRef;
  activeNoteRef.current = activeNote;

  useEffect(() => {
    const el = selectedRef.current;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  // After any successful apply (or a background refresh) the list can shrink:
  // clamp the active index onto the new list length (brief law; a -1 "cleared"
  // selection from the stale-guard is left alone).
  useEffect(() => {
    if (activeIndex > cards.length - 1) {
      setActiveIndex(Math.max(cards.length - 1, 0));
    }
  }, [cards.length, activeIndex]);

  // Window keydown (facts §10): guards in order — skip events another surface
  // already consumed (e.g. App's capture hotkey preventDefaults), skip text
  // fields (input/textarea/contenteditable — Review Focus 5), skip while a
  // modal is open, then j/k clamp+select and a/m/x route through the mapping.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      if (modalOpenRef.current) return;
      const list = cardsRef.current;
      if (list.length === 0) return;
      const idx = activeIndexRef.current;
      if (e.key === 'j') {
        setActiveIndex(Math.min(idx + 1, list.length - 1));
        return;
      }
      if (e.key === 'k') {
        setActiveIndex(Math.max(idx - 1, 0));
        return;
      }
      const selected = list[idx];
      if (!selected) return;
      // THE mapping call (brief): onAction is mirrored to stay current despite
      // empty deps.
      if (e.key === 'a') actionRef.current('promote', selected);
      else if (e.key === 'm') actionRef.current('move', selected);
      else if (e.key === 'x') actionRef.current('discard', selected);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // THE mapping call lives in the listener above (mirrored actionRef);
  // buttons call the current-render onAction directly.

  return (
    <section id="triage">
      <div className="section-head">
        <h2>Triage</h2>
        <span className="triage-count">{cards.length}</span>
      </div>
      <ul className="triage-list">
        {cards.length === 0 && <li className="triage-empty">Inbox is empty 🎉</li>}
        {cards.map((n, i) => (
          <li
            key={n.id}
            ref={i === activeIndex ? selectedRef : undefined}
            className={i === activeIndex ? 'triage-card selected' : 'triage-card'}
          >
            <div className="triage-head">
              <span className="triage-title">{n.title}</span>
              <span className="triage-date">{relativeAge(n.createdAt)}</span>
            </div>
            <p className="triage-snippet">{squash(n.content)}</p>
            <div className="triage-actions">
              <button onClick={() => onAction('promote', n)}>Promote</button>
              <button onClick={() => onAction('move', n)}>Move…</button>
              <button onClick={() => onAction('discard', n)}>Discard</button>
            </div>
          </li>
        ))}
      </ul>
      {err && modal !== 'promote' && <div className="triage-error">{err}</div>}
      {modal === 'promote' && activeNote && (
        <TriagePromoteModal
          isOpen
          onClose={closeModal}
          onConfirm={applyPromote}
          boards={boardsForPicker}
          defaultText={firstCardTextLine(activeNote.content)}
          defaultTitle={titleFromText(activeNote.content)}
          error={err ?? undefined}
        />
      )}
      {modal === 'move' && activeNote && (
        <TriageMoveModal
          isOpen
          onClose={closeModal}
          onConfirm={applyMove}
          presets={[TRIAGE_MOVE_PRESET.COMMANDS, TRIAGE_MOVE_PRESET.DOCS]}
          defaultCategory={activeNote.category ?? ''}
          defaultTitle={activeNote.title}
        />
      )}
      {modal === 'discard' && activeNote && (
        <ConfirmModal
          isOpen
          onClose={closeModal}
          onConfirm={applyDiscard}
          title="Discard capture"
          message={`Are you sure you want to discard "${activeNote.title}"?`}
          confirmText="Discard"
          destructive
        />
      )}
    </section>
  );
}