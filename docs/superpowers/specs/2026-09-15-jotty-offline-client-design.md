# Jotty Fat Offline Client — Design

Date: 2026-09-15
Status: Approved design (pre-plan)
Project: `/coding/jotty`
Upstream: https://github.com/fccview/jotty (AGPL-3.0, self-hosted notes + checklists)

## 1. Problem

jotty·page is a self-hosted, file-based notes/checklists app. It has no native
client and its PWA offers read-only offline caching only — there is no offline
CRUD anywhere in the ecosystem (upstream author confirmed; upstream issue #281
shipped read-only caching and closed). The goal is a **fat offline client**: a
desktop app that holds a full local copy of your jotty data, works completely
offline with local writes, and syncs to the stock jotty server whenever a
connection is available.

Design-driving facts about the stock jotty REST API (verified against
`howto/API.md` at upstream v1.22.0):

- Auth: permanent per-user API keys via `x-api-key: ck_...` header. No OIDC/MFA
  flows needed for API access (keys are generated in the web UI).
- Notes: full CRUD by UUID. Clean sync target.
- Checklists: list-level CRUD by UUID, but **item mutations are addressed by
  0-based index paths** (`items/0.1/check`) with no stable server-side item IDs
  for mutation. Index drift during offline operation is the main correctness
  hazard; the sync engine must re-resolve indices at replay time.
- No delta/sync endpoints (`updatedSince` etc.), no webhooks. Change detection
  is full-catalog pull + `updatedAt` comparison. At personal scale (upstream
  tests ~500 markdown files) full pulls are cheap and correct.
- Task/Kanban endpoints exist but are out of scope for v1 (see Non-goals).

## 2. Decisions

- **Form:** Tauri 2 desktop app (Rust core + system webview), one codebase for
  Linux/Windows/macOS. Small binary, no bundled Chromium.
- **Scope v1:** notes editor + simple checklists + categories + full-text
  search. Kanban boards, time tracking, PGP-encrypted notes, and multi-account
  stay out (v2 candidates; architecture must not preclude them).
- **Relationship to server:** pure API client. Zero server-side changes; works
  against any stock jotty instance and survives upstream upgrades. Forking the
  server to add delta endpoints is explicitly rejected for v1.
- **Local data architecture:** SQLite + outbox queue (chosen over files-on-disk
  mirror and CRDT frameworks — rejected: double parser work with fragile
  checklist markdown dialect; and CRDTs buy nothing when the server merges via
  REST anyway).

## 3. Architecture

```
┌────────────────────────────────────────────────────┐
│ Webview UI (React + TypeScript + Vite)             │
│  - TipTap note editor (same editor jotty uses)     │
│  - Checklist view, sidebar, search, settings       │
└──────────────△─────────────────────────────────────┘
               │ Tauri commands (invoke) / events (progress)
┌──────────────▽─────────────────────────────────────┐
│ Rust core (src-tauri)                              │
│  - jotty_client: REST wrapper (reqwest, x-api-key) │
│  - db: SQLite (rusqlite, WAL) + migrations + FTS5  │
│  - sync: pull / push(outbox replay) / scheduler    │
└──────────────△─────────────────────────────────────┘
               │ HTTPS
        ┌──────▽──────┐
        │ jotty server │  stock instance, REST API only
        └─────────────┘
```

### Components (Rust)

- `jotty_client` — thin typed REST client: `GET /api/health`,
  checklists/notes CRUD, `GET /api/categories`. Owns the API key handle.
- `db` — SQLite access layer, schema migrations, FTS5 index maintenance.
- `sync` — the engine (Section 5): pull, push (outbox replay), scheduler.
- Tauri commands — UI-facing operations (read/write through `db`, enqueue
  outbox ops, trigger sync); events — sync status/progress/pending counts.

### Frontend

- React + TypeScript + Vite. TipTap for the note editor so markdown rendering
  matches what jotty's web UI produces. State via a small store (zustand).
- Sync status surface: status dot (synced / pending / offline / conflict),
  pending-op count, last-synced time.

## 4. Local data model (SQLite)

```sql
notes(
  id TEXT PRIMARY KEY,        -- jotty UUID once known; temp local id until first push
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Uncategorized',
  created_at TEXT, updated_at TEXT,          -- server timestamps when known
  deleted_at TEXT,            -- tombstone
  dirty INTEGER NOT NULL DEFAULT 0
)

checklists(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Uncategorized',
  type TEXT NOT NULL DEFAULT 'simple',
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT,
  dirty INTEGER NOT NULL DEFAULT 0
)

checklist_items(
  local_id TEXT PRIMARY KEY,  -- client-generated surrogate ID (stable forever)
  checklist_id TEXT NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  parent_id TEXT,             -- local surrogate of parent (nested items)
  text TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,  -- order; index-path resolution uses this + text
  dirty INTEGER NOT NULL DEFAULT 0
)

outbox(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,  -- FIFO replay order
  op_type TEXT NOT NULL,      -- create|update|delete|item_create|item_update|
                              -- item_check|item_uncheck|item_delete|item_reorder
  entity TEXT NOT NULL,       -- note|checklist|checklist_item
  entity_id TEXT NOT NULL,    -- local id at enqueue time
  payload TEXT NOT NULL,      -- JSON op body
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  state TEXT NOT NULL DEFAULT 'pending'  -- pending|conflict|done
)

sync_state(key TEXT PRIMARY KEY, value TEXT NOT NULL)
-- keys: instance_url, username, last_sync_at, sync_interval_minutes
```

API key is stored in the **OS keyring** (keyring crate), never in the DB or a
file. The outbox enqueue happens in the **same SQLite transaction** as the
entity write — a mutation is either fully local+queued or not applied at all
(crash-safe). WAL mode throughout.

FTS5 virtual tables index note titles+content and checklist/item text for
full-text search, rebuilt/updated on writes.

## 5. Sync engine

### Pull (server → local)

- **Ordering within a sync run: push first, then pull.** Pending local ops
  reach the server before any remote state is merged, which is what makes the
  LWW window small (see Conflicts).
- Full pull: `GET /api/checklists`, `GET /api/notes`, `GET /api/categories`.
- Upsert by UUID when server `updatedAt` > local `updatedAt`, or entity missing
  locally. Server copy wins only per-LWW rule below; entities with pending
  local ops (dirty or in outbox) are never clobbered by pull.
- Tombstones: entities absent from the server snapshot that are neither dirty
  nor referenced by pending outbox ops are marked `deleted_at` (deleted
  remotely).
- First run: local DB is empty → clean import; instance URL + username recorded
  in `sync_state`.

### Push (local → server, FIFO outbox replay)

- Notes: create → `POST /api/notes` (map temp local ID → server UUID and
  rewrite local rows + outbox references), update → `PUT /api/notes/{id}`,
  delete → `DELETE /api/notes/{id}`.
- Checklists: create → `POST /api/checklists`; title/category update →
  `PUT /api/checklists/{id}`; delete → `DELETE /api/checklists/{id}`.
- Item ops — the index-drift defense: before replaying a checklist's queued
  item ops, **re-fetch that checklist** from the server and resolve each
  local surrogate ID to its current index path (match by `position`, text as
  tiebreaker; parent paths composed in dot notation). Apply ops against the
  fresh indices; after the checklist's ops are replayed, re-pull that
  checklist to reconcile local positions with server state.
- New local items created offline get a server ID from the create response
  where available; otherwise they are matched on re-pull by text+position.

### Conflicts

- Note/checklist level: **last-write-wins by `updatedAt`** (personal-scale,
  single-user assumption). Because pending ops push before pull, a remote edit
  only wins if its `updatedAt` is newer than ours at the moment of
  reconciliation; the older write is the one that loses.
- Item level: an op whose target cannot be resolved on the re-fetched checklist
  (deleted remotely, or moved beyond text+position recognition) → op and item
  marked `state='conflict'`; UI offers keep-mine / take-server. Nothing is
  silently dropped: unresolved ops stay in the outbox until resolved.

### Triggers

App launch, network regain (OS connectivity events), window focus, manual
button, periodic timer (default 5 min, configurable in settings). Sync never
blocks UI use; offline launch is fully functional.

## 6. Error handling

- Network failure mid-sync: ops remain in outbox; exponential backoff per op;
  pending count surfaces in UI.
- 401 (invalid/revoked key): sync pauses, prompt to re-enter API key.
- 404/409 during replay (target deleted remotely, etc.): route to conflict flow.
- Malformed/unexpected API responses: op stays pending with `last_error`
  recorded; sync continues with other entities.
- DB corruption: WAL + checkpointing; outbox and entities share transactions
  so a crash never half-applies a mutation.

## 7. Onboarding / auth

First-run wizard: enter instance URL + API key (generated in jotty web UI:
Profile → Settings → API Key → Generate). Client verifies with
`GET /api/health` plus one authenticated call (`GET /api/categories`), then
performs the initial full pull. Key stored in OS keyring; URL + username in
`sync_state`. Key rotation = re-enter in settings (old key revoked web-side).

## 8. UI (v1)

- Sidebar: categories (notes + checklists), item counts, search box.
- Notes list + TipTap editor with autosave (debounced writes to SQLite +
  outbox enqueue on content/title/category change).
- Checklist view: checkboxes, add/edit/delete items, drag & drop reorder
  (local `position` updates + reorder ops enqueued).
- Sync indicator: dot state, pending count, last-synced age, manual sync button.
- Settings: instance URL, API key entry, sync interval, dark/light theme.
- Command palette (Ctrl+K) over FTS5 search results.

## 9. Security

- API key only in OS keyring; memory held for session duration.
- HTTPS enforced for instance URL (http allowed only for localhost instances).
- No telemetry, no external calls other than the configured instance.
- Upstream is AGPL-3.0; this client talks REST only and does not redistribute
  upstream code (licensing note for later publishing decision).

## 10. Testing

- **Rust unit/integration:** sync engine against wiremock: fresh pull, upsert,
  tombstones, FIFO replay order, index-path re-resolution (drift simulation),
  conflict cases, 401, malformed responses.
- **Real-instance integration:** docker compose with the stock jotty image in
  `dev/`, seeded via API; run push/pull round-trips against it (same pattern as
  the user's other projects: docker-first verification).
- **Frontend:** vitest — autosave → outbox enqueue, checklist ops, search
  behavior, conflict UI states.

## 11. Repo layout

```
/coding/jotty
├── src/            # React + TS frontend
├── src-tauri/      # Rust core: commands, db, jotty_client, sync
├── dev/            # docker compose + seed scripts for test jotty instance
├── docs/superpowers/specs/   # this design doc
└── AGENTS.md
```

## 12. Non-goals (v1)

Kanban task boards, time tracking, PGP encrypted notes, sharing with other
users, multi-account/multi-instance, OIDC login, live WebSocket push (v2
option: poll or reuse jotty's WS with a session-based login), mobile builds.

## 13. v2 options (documented, not built)

- Live updates via jotty's WebSocket (needs session-cookie login; API-key-only
  clients can't use it today — upstream may add key-auth'd WS).
- Delta protocol via upstream contribution (`updatedSince`, stable item IDs).
- Kanban + time tracking (endpoints already mapped).
- Encrypted notes (PGP decrypt locally, re-encrypt on push).
- Markdown export folder (Obsidian-style mirror of the SQLite store).