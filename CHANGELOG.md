## v0.13.0 — Voice → kanban: add cards to an existing board (2026-09-21)

The "kanban board" button on a voice note no longer has to create a new board.

### Added
- **Target picker in the task preview**: choose "New board (named after the note)" (default, unchanged) or any of your existing kanban boards. Chosen board receives the cards in its first column, and opens when you confirm.
- Cards added to an existing board go through the offline outbox like every card add — no live connection needed for that step (extraction still needs the AI server).

### Fixed
- Test setup: jsdom's `localStorage` shim no longer exists under Node ≥ 25 — the test setup now provides an in-memory fallback so the theme-override tests pass again.

## v0.12.2 — Back button returns to the right list (2026-09-21)

Field fix: pressing back from an open note landed on the checklists list instead of the notes list.

### Fixed
- **Back now returns to the list of what you were viewing**: closing a note shows the notes list; closing a checklist shows the checklists list. (The back button previously flipped every back press to the checklists section.)

## v0.12.1 — Tidy outcome made unmissable (2026-09-21)

Field fix: a voice note could be saved with the raw transcript even after tapping "Tidy transcript" — the tidy failure was only a small muted hint that was easy to miss, and Save (by design) saves exactly what the editor shows.

### Fixed
- **Tidy failures now show as a red error line**, not a muted hint.
- **A tidy that returns the text unchanged** (model echoed it) now says so instead of silently "succeeding".
- **The Save button labels what it writes** once a tidied text exists: "Save (tidied)" / "Save (raw)" — no more guessing which version lands in the note.

### For the record
The save path itself was verified correct: the note always stores exactly what's in the editor (the edited/tidied text always wins). This release makes it impossible to miss when the editor is NOT showing the tidied text.

# Changelog

Release notes for jotty·desktop — newest first. Install commands and sha256 checksums for each release live on its GitHub release page.

## v0.12.0 — Voice notes become kanban boards (2026-09-21)

Dictate a voice note, get a kanban board — the AI turns the transcript into tasks.

### New

- **🎤 Voice note → kanban board** — in the voice note review overlay, the AI extracts tasks from the transcript and shows an editable preview; confirming creates the board with one card per task in the first column. Uses the same AI server settings as tidy.
- **📱 Android preview carries kanban boards too** — installed previews jump 0.10.8 → 0.12.0 via the in-app updater.

## v0.11.0 — Kanban boards (2026-09-21)

Kanban boards for checklists, offline-first like everything else in jotty.

### New

- **📋 Kanban boards** — create boards with `+ New board`; lists get a board chip to switch between list and board views. Columns come from your server's statuses (or the default four-column layout when it doesn't expose any), and the board is cached offline-first: it opens instantly from cache and refreshes from the server when one answers.
- **🖱 Desktop drag-and-drop** — drag cards between columns to change their status; moves sync as ordinary status ops.
- **📱 Card menu moves** — the card ⋯ menu lists every column as a move target (the primary move path on mobile), with a backdrop tap to close.
- **➕ Per-column add** — each column adds cards straight into that column.
- **🏷 Card badges** — priority, target date, and subtask counts render as compact badges on every card.
- **Offline creates keep their column** — cards created while offline carry their chosen column through the sync replay instead of landing in the first column server-side.

### Fixed

- **Theme dropdown styling** — the Settings → Appearance theme picker ships with the styled dropdown (bordered button + chevron, color chips per theme, highlighted selection), folded in from the 0.10.8 Android preview where it was amended in place.
- **Board menu scroll fixes** — the card menu no longer clips inside the board on tall columns: the board no longer owns its own scroll boxes, long columns scroll with the main pane (horizontal scroll intact on mobile), and the full menu always paints hit-testable.

### Sync

Push replay now carries status moves (including the create-arm status carry above); plain-checklist sync flows are byte-identical — the only new ops are additive.