# Technical Specification: High-Velocity Capture + AI-Augmented Triage (Jotty Client)

**Version:** 3.0 (Consolidated — probe-informed)  
**Date:** 2026-10-06  
**Status:** Design locked for review — awaiting implementation go  
**Target:** jotty-desktop client (Tauri) + stock jotty API 1.28.0+ + jotty-companion jobs  
**Supersedes:** the 2026-10-06 "High-Velocity Atomic Capture" v2 draft + "AI-Augmented Triage" §1-2 draft (chat thread)

---

## 1. Problem Statement

Busy-moment capture must never involve structure decisions, may happen on any surface (terminal, phone, desktop), offline included — and must NEVER be silently lost. Triage (structure, organization, deletion) belongs to calm time and must be cheap enough that raw capture feels safe.

**Two measured upstream facts govern the design** (probe-proven 2026-10-06, dev 1.28.0 — see Appendix):

1. **Note filenames are title-derived.** Concurrent same-title creates race on the file path (check-then-write) and the loser capture is **silently destroyed** (reproduced 40/40; both POSTs return success). Sequential same-title is safe (server suffixes `-1`, `-2`).
2. **`uuidv4()` is stamped in frontmatter per file** — not title-derived; the "Duplicate uuid" warning class is a different mode (two files claiming one uuid) that API creates cannot produce.

Therefore: **capture titles are machine-generated and unique per capture. This is load-bearing, not cosmetic.**

## 2. Zone Model (path-based, via categories)

| Zone | Category | Purpose | Rules |
|---|---|---|---|
| Buffer | `!INBOX` | raw capture landing | no manual notes; entropy titles only |
| Storage | `LIBRARY/*` (Commands, Topology, Docs — implicit children) | permanent knowledge | moves rename + relocate in one PUT |
| Action | — (boards, see §4) | tasks | kanban boards are the TODO surface |
| Settled | `PROCESSED` (+ `PROCESSED/Archive/YYYY-MM`) | consumed-note references + aged captures | provenance line required |

Wire notes: create = `POST /api/notes {title, content, category}` (**no `path` field**); nested categories are implicit; `!` survives; categories are case-sensitive; move/rename = `PUT /api/notes/{id}` with `originalCategory` (verified primitive); no single-note GET — verify via list + id filter.

## 3. Capture (R1) — local-first everywhere

- **Phone/desktop (jotty-client):** quick-capture input + global hotkey (desktop; Tauri `global-shortcut` plugin — check capabilities grant, ACL silent-denial class). Creates the note **locally** (SQLite) and enqueues via the existing outbox — persistence ≈ instant, works offline; replay is serialized FIFO (one writer at a time per client).
- **Terminal (`jot` CLI, lives in jotty-companion repo):** `jot "text"` → direct `POST /api/notes`; **mean persistence < 300 ms online**; key from its own config; same entropy-title helper.
- **Title format: `cap_<epochms>_<rand4>`** (epoch-ms replaces the v2 `20231027_1405` format — TZ-unambiguous and chrono-sortable). The LLM may later propose a human title at triage.
- **Never** create a same-titled note from two surfaces concurrently (probe rule). Entropy titles make this a non-event by construction.
- Inbox counter surfaced client-side (`Inbox (N)`); the card-wall and search **exclude `!INBOX` by default** (isolation — hundreds of `cap_*` notes must not flood normal views).

## 4. TODO zone = kanban boards

Statuses already exist (boards: pending/in-progress/completed columns, shipped v0.11.0; voice→kanban task creation v0.12/0.13 is the proven "text → board item" path). New boards created under this workflow use category `TODO` by convention; existing boards anywhere remain valid targets. Promote-to-TODO creates an **item on a board** — it is not a note move.

## 5. Triage View (R2) + AI-Augmented Triage

The triage view lists `!INBOX` notes (chronological, newest-first) as actionable cards; aggregation makes them *feel* like one stream. Each card batch-runs through the existing OpenWebUI client (`voice_ai.rs` chat/completions with v1→plain fallback) to render **suggestion badges**:

1. **Route** — closed enum, validated client-side: `{TODO, COMMANDS, DOCS, NOISE}` (map: TODO→board item; COMMANDS/DOCS→`LIBRARY/Commands|Docs` move; NOISE→suggest discard). An out-of-enum or hallucinated value fails validation → card falls back to manual. Prompt-only enforcement is not enforcement.
2. **Board suggestion** — prompt carries the user's real board names; response `suggested_board` is validated against that list; invalid → apply-time picker. **AI suggests the board; user applies.**
3. **Title normalization** — entropy title → human title (applied on move).
4. **Tags** — seeded vocabulary `#todo #cmd #incident #research`, **curated as it grows**: AI-proposed new tags render as "new tag?" chips; one approval joins the vocabulary (persisted client-side); unapproved suggestions never auto-apply.
5. **Confidence** — LLM-reported, treated as an uncalibrated **sort/filter heuristic** (default threshold 0.70, tunable in settings; below → manual queue). Calibrate on real usage later.
6. **Dedup** — within-chunk semantic similarity only in v1; cross-queue dedupe explicitly deferred.

**Pipeline rules:** chunk cap **20-25 notes/request**; per-chunk JSON validation with **one retry** on parse failure; a failed chunk degrades to manual, never aborts the batch (reuse `extract_tasks` strict-parse precedent: tolerate code fences, reject malformed); results render per chunk as they arrive (inference is 10-60 s — async UI); **stale-guard**: revalidate a note still exists before applying anything.

**Human-in-the-loop:** AI suggests, the user validates. **Apply all** = one confirmation of a rendered batch of suggestions; per-item override always available. Keyboard-first (j/k navigate, a apply, x discard).

## 6. Lifecycle on promotion

- **TODO (`Promote`)**: create item on suggested board (existing voice→kanban flow) → original note moves to `PROCESSED`, renamed to the human title, provenance line appended: `↳ 2026-10-06T14:02Z → Board "Maintenance" / item "Fix Nginx SSL"` (greppable, survives sync).
- **LIBRARY**: the note **is** the destination — move + rename (no duplicate copy).
- **NOISE/Discard**: user-confirmed delete only. **AI never autonomously deletes or moves anything.**

## 7. Retention (companion-owned nightly job — no client dependency)

- **`!INBOX` > 15 days** → auto-move to `PROCESSED`, content marker line appended (`#aged`, with date). **Nothing is ever auto-deleted** — aging relocates, it does not destroy.
- **`PROCESSED` > 30 days** (default) → daily job relocates to `PROCESSED/Archive/YYYY-MM` (implicit child categories, verified wire behavior).
- Engine: jotty-companion on server2 (adjacent to the instance, already runs scheduled work); API-based, outbox-agnostic.
- **Volume:** unknown by design ("we shall see") — track capture rate + inbox depth client-side; re-measure sync cost (catalog = full pull) after real data exists. No fixed ceiling in v1.

## 8. KPIs

1. **Zero silent capture loss** — guaranteed structurally by unique entropy titles (probe: 40/40 same-title pairs lose vs 0/40 entropy).
2. **Capture latency** — local (phone/desktop): instant local write; CLI: < 300 ms mean online.
3. **Triage** — typical batch = one Apply-all confirmation; ≤ 1 action per item for manual overrides.

## 9. Roadmap (SDD-ready)

- [ ] **P1 — Capture foundation:** entropy title gen; quick-capture UI + global hotkey (desktop; Android = in-app quick action, global hotkeys are OS-limited); local create + outbox; `Inbox (N)` surface + card-wall/search isolation; `jot` CLI in jotty-companion.
- [ ] **P2 — Triage view:** card list, validated route enum, move/promote primitives (PUT+originalCategory), stale-guard, keyboard-first.
- [ ] **P3 — AI layer:** batched OpenWebUI pipeline (chunk cap/retry/schema), board suggestions, tag curation flow, confidence threshold setting.
- [ ] **P4 — Retention jobs:** companion nightly aged/archive moves (+ optional ntfy nudge reuse).

Each phase ships per the standing staged platform release order (APK → Linux → Windows).

## 10. Explicit out-list (not in this design)

- No server fork, no upstream API changes required (pure stock 1.28.0 — the 2026-09-15 lock holds).
- **No auto-delete of user content anywhere** (aging = relocation).
- No cross-queue semantic dedupe in v1 (within-chunk only).
- No new mobile app; capture rides the existing client.
- No same-titled concurrent creates anywhere — the convention itself forbids it.
- AI never executes destructive operations autonomously.
- Upstream issue filing about the title-collision race: separate explicit decision (public post on fccview/jotty) — not bundled here.

## Appendix — Probe evidence (2026-10-06, dev instance 1.28.0, scripts /tmp/jotty-probe/)

- Concurrent same-title creates: **40/40 rounds → capture lost** (both `success:true`, distinct uuids, one file on disk). Entropy titles: **0/40 anomalies**. Sequential same-title: safe (`-1` suffix files observed).
- Categories wire: create `{title, content, category}`; `!` round-trips; `?category=%21INBOX` filter works; case-sensitive; implicit nesting (`LIBRARY/Commands` auto-creates both levels); `PUT /api/notes/{id}` + `originalCategory` = verified move+rename; single-note GET does not exist; upstream `uuid-keeper.ts` dropClashes warns on two-files-one-uuid (copy mode, not API-create mode).