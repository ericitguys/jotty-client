# Changelog

Release notes for jotty·desktop — newest first. Install commands and sha256 checksums for each release live on its GitHub release page.

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