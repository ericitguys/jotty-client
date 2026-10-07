import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteDto } from '../api/types';
import { isCaptureZone } from '../stores/store';
import { relativeAge } from '../util/relativeTime';

// Single action mapping (plan T3 interface): the three buttons AND the a/m/x
// keys already route every entry point through here. Task 4 replaces ONLY this
// body (promote/move modals + discard confirm); the keyboard/button plumbing
// stays byte-stable.
export type TriageAction = 'promote' | 'move' | 'discard';

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
  // Modal-open guard stays false in Task 3 (no modals yet); Task 4 drives the
  // real modal state + this setter around its mounts.
  const [modalOpen] = useState(false);

  // Placeholder action mapping (brief): Task 4 (promote/move/discard flows)
  // rewires ONLY this body; the buttons and a/m/x keys already converge here.
  const onAction = (action: TriageAction, note: NoteDto): void => {
    void action;
    void note;
  };

  // Stale-closure law (facts §10, App window-listener precedent): the keydown
  // listener below registers ONCE with empty deps, so every value it reads is
  // mirrored into a ref on every render — including the CURRENT mapping.
  const cardsRef = useRef(cards);
  const activeIndexRef = useRef(activeIndex);
  const modalOpenRef = useRef(modalOpen);
  const actionRef = useRef(onAction);
  cardsRef.current = cards;
  activeIndexRef.current = activeIndex;
  modalOpenRef.current = modalOpen;
  actionRef.current = onAction;

  // Keep the selected card visible after j/k. jsdom has no scrollIntoView —
  // guard before calling (plan test conventions).
  const selectedRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    const el = selectedRef.current;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

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
      // THE mapping call (brief): Task 4 changes the mapping body, never this
      // listener — onAction is mirrored to stay current despite empty deps.
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
    </section>
  );
}