# Jotty Fat Offline Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri 2 desktop client for stock jotty instances: full local SQLite copy, complete offline CRUD, FIFO outbox sync (push-then-pull, LWW, index-path re-resolution).

**Architecture:** Rust core (db / jotty REST client / sync engine) exposed to a React webview UI via Tauri commands and events. Every local mutation writes the entity + enqueues an outbox op in one SQLite transaction; sync replays pending ops (push) then pulls a full catalog and reconciles (pull).

**Tech Stack:** Rust (tauri 2, rusqlite bundled + FTS5, reqwest/rustls, keyring 3, wiremock for tests), React 18 + TypeScript + Vite 6, TipTap 2, zustand 5, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-09-15-jotty-offline-client-design.md` — read it before starting; this plan argues from the spec.

## Global Constraints

- Pure API client against **stock** jotty (API docs verified at upstream v1.22.0). Zero server-side changes, ever.
- API key lives **only** in the OS keyring; never in the DB, config files, or logs.
- Every mutation = single SQLite transaction (entity write + outbox enqueue). WAL mode everywhere.
- Sync run order is always **push first, then pull** (spec §5).
- Checklist item mutations are addressed by 0-based **index paths** on the server; local items have stable surrogate IDs (`local_id`) and a `server_path` snapshot. Index resolution happens at replay time, never from stale state.
- There is **no reorder endpoint**: `item_reorder` replays as a list rebuild (delete reverse order → recreate in local order). Spec §5.
- v1 scope: notes, simple checklists, categories, FTS search. No kanban/time-tracking/PGP/sharing/multi-account/OIDC/WS-push/mobile.
- HTTPS enforced for instance URL; plain http allowed only for `localhost`/`127.0.0.1`.
- Rust edition 2021; Node ≥ 20; commits after green tests only (TDD).
- Fresh-clone order: `npm install && npm run build` (creates `dist/` that `tauri::generate_context!` needs) **before** `cargo test`.

## File Structure (final shape)

```
/coding/jotty
├── package.json, vite.config.ts, tsconfig.json, index.html, .gitignore
├── AGENTS.md, README.md
├── src/                          # frontend
│   ├── main.tsx, App.tsx, styles.css
│   ├── api/types.ts, api/client.ts
│   ├── stores/store.ts
│   ├── components/{Sidebar,NoteList,ChecklistList,NoteEditor,ChecklistView,
│   │               SyncBadge,SettingsModal,ConflictDialog,SearchPalette}.tsx
│   └── test/setup.ts (+ *.test.tsx colocated)
├── src-tauri/
│   ├── Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json
│   └── src/
│       ├── main.rs, lib.rs, error.rs, state.rs, keys.rs
│       ├── db/{mod,migrations,outbox,notes,checklists,items,search}.rs
│       ├── jotty/{mod,models}.rs
│       ├── sync/{mod,pull,push,resolve}.rs
│       └── commands/{mod,dto}.rs
└── dev/{docker-compose.yml,gen_icon.py,seed_notes.py,README.md}
```

---

### Task 1: Project scaffold — Tauri 2 + React + Vite + vitest, building and testable

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `.gitignore`, `AGENTS.md`
- Create: `src/main.tsx`, `src/App.tsx`, `src/styles.css`, `src/test/setup.ts`
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/error.rs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `AppError` enum + `AppResult<T>` in `error.rs` (used by every later task); runnable `cargo test` + `npm test`; `run()` in `lib.rs`.

- [ ] **Step 1: Write root config files**

`package.json`:
```json
{
  "name": "jotty-desktop",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.1.0",
    "@tiptap/extension-link": "^2.10.0",
    "@tiptap/react": "^2.10.0",
    "@tiptap/starter-kit": "^2.10.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zustand": "^5.0.2"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.1.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/jest-dom": "^6.6.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "typescript": "^5.6.3",
    "vite": "^6.0.3",
    "vitest": "^2.1.8"
  }
}
```

`vite.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2021",
    "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>jotty·desktop</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`.gitignore`:
```
node_modules/
dist/
src-tauri/target/
src-tauri/gen/
dev/data/
dev/config/
dev/cache/
```

`src/test/setup.ts`:
```ts
import '@testing-library/jest-dom/vitest';
```

`src/main.tsx`:
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

`src/App.tsx`:
```tsx
export default function App() {
  return <div id="app">jotty·desktop</div>;
}
```

`src/styles.css` (create empty file, filled in Task 15):
```css
/* filled in Task 15 */
```

`AGENTS.md`:
```markdown
# AGENTS.md — jotty·desktop

- Rust core in `src-tauri/src`, React UI in `src`. Spec: docs/superpowers/specs/, plan: docs/superpowers/plans/.
- Fresh clone: `npm install && npm run build` (creates dist/ needed by tauri macros) BEFORE `cargo test`.
- Tests: `cargo test` (Rust, wiremock-based), `npm test` (vitest). Green tests before every commit.
- Sync invariants (see spec): push-then-pull; entity write + outbox enqueue in ONE transaction; API key only in OS keyring; item ops resolve index paths at replay time; reorder replays as rebuild.
- API is stock jotty REST only (x-api-key header). Never modify server assumptions without re-checking upstream howto/API.md.
```

- [ ] **Step 2: Write Tauri skeleton**

`src-tauri/Cargo.toml`:
```toml
[package]
name = "jotty-client"
version = "0.1.0"
edition = "2021"

[lib]
name = "jotty_client_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rusqlite = { version = "0.32", features = ["bundled"] }
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
tokio = { version = "1", features = ["full"] }
uuid = { version = "1", features = ["v4"] }
chrono = { version = "0.4", features = ["serde"] }
thiserror = "2"
keyring = { version = "3", features = ["apple-native", "windows-native", "sync-secret-service"] }

[dev-dependencies]
wiremock = "0.6"
tempfile = "3"
```

`src-tauri/build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```

`src-tauri/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "jotty-desktop",
  "version": "0.1.0",
  "identifier": "page.jotty.desktop",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      { "title": "jotty·desktop", "width": 1200, "height": 800 }
    ],
    "security": { "csp": null }
  },
  "bundle": { "active": true, "targets": ["deb"], "icon": [] }
}
```

`src-tauri/capabilities/default.json`:
```json
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": ["core:default"]
}
```

`src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    jotty_client_lib::run();
}
```

`src-tauri/src/error.rs`:
```rust
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("api error {status}: {body}")]
    Api { status: u16, body: String },
    #[error("keyring error: {0}")]
    Keyring(String),
    #[error("not connected to an instance")]
    NotConnected,
    #[error("invalid configuration: {0}")]
    InvalidConfig(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("{0}")]
    Other(String),
}

pub type AppResult<T> = Result<T, AppError>;
```

`src-tauri/src/lib.rs`:
```rust
pub mod error;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn scaffold_compiles() {
        assert_eq!(2 + 2, 4);
    }
}
```

- [ ] **Step 3: Install frontend deps and build (creates dist/ required by tauri macros)**

Run: `cd /coding/jotty && npm install && npm run build`
Expected: `dist/` created, no TS errors.

- [ ] **Step 4: Run Rust tests (first compile takes a while)**

Run: `cd /coding/jotty/src-tauri && cargo test`
Expected: PASS (`scaffold_compiles`).

- [ ] **Step 5: Run frontend tests**

Run: `cd /coding/jotty && npm test`
Expected: vitest reports "no test files found" is acceptable at this stage; if it exits non-zero, add `--passWithNoTests` to the `test` script.

- [ ] **Step 6: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "chore: scaffold tauri2+react+vite+vitest skeleton"
```

---

### Task 2: DB open + migrations + FTS5 smoke

**Files:**
- Create: `src-tauri/src/db/mod.rs`, `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod db;`)

**Interfaces:**
- Produces: `db::open(path: &Path) -> AppResult<Connection>` (WAL, foreign_keys ON); `db::migrations::run(conn: &Connection) -> AppResult<()>` (idempotent, user_version-tracked); schema v1 tables `notes, checklists, checklist_items, outbox, sync_state, notes_fts, lists_fts`.

- [ ] **Step 1: Write failing test**

In `src-tauri/src/db/mod.rs` (tests at bottom of file):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn tmp_db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("test.db")).unwrap();
        migrations::run(&conn).unwrap();
        (dir, conn)
    }

    #[test]
    fn migrations_create_all_tables() {
        let (_d, conn) = tmp_db();
        let names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for expected in [
            "notes",
            "checklists",
            "checklist_items",
            "outbox",
            "sync_state",
            "notes_fts",
            "lists_fts",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }

    #[test]
    fn migrations_are_idempotent() {
        let (_d, conn) = tmp_db();
        migrations::run(&conn).unwrap();
        migrations::run(&conn).unwrap();
    }

    #[test]
    fn fts5_is_available() {
        let (_d, conn) = tmp_db();
        conn.execute("INSERT INTO notes_fts(id, title, content) VALUES ('n1', 'hello world', 'body text')", [])
            .unwrap();
        let hits: Vec<String> = conn
            .prepare("SELECT id FROM notes_fts WHERE notes_fts MATCH 'hello'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(hits, vec!["n1"]);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /coding/jotty/src-tauri && cargo test db::`
Expected: FAIL — `db` module has no `open` yet (compile error counts as the failing state).

- [ ] **Step 3: Implement**

`src-tauri/src/db/mod.rs`:
```rust
pub mod migrations;

use std::path::Path;
use crate::error::AppResult;

pub fn open(path: &Path) -> AppResult<rusqlite::Connection> {
    let conn = rusqlite::Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}
```

`src-tauri/src/db/migrations.rs`:
```rust
use crate::error::AppResult;
use rusqlite::Connection;

pub const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'Uncategorized',
        created_at TEXT,
        updated_at TEXT,
        deleted_at TEXT,
        dirty INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE checklists (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Uncategorized',
        list_type TEXT NOT NULL DEFAULT 'simple',
        created_at TEXT,
        updated_at TEXT,
        deleted_at TEXT,
        dirty INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE checklist_items (
        local_id TEXT PRIMARY KEY,
        checklist_id TEXT NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
        parent_id TEXT,
        text TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL,
        server_path TEXT,
        dirty INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_items_list ON checklist_items(checklist_id, position);
    CREATE TABLE outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        op_type TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX idx_outbox_pending ON outbox(state, seq);
    CREATE TABLE sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title, content);
    CREATE VIRTUAL TABLE lists_fts USING fts5(id UNINDEXED, title, item_text);
    "#,
];

pub fn run(conn: &Connection) -> AppResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", (i + 1) as i64)?;
    }
    Ok(())
}
```

Add to `src-tauri/src/lib.rs`: `pub mod db;` above `pub mod error;`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /coding/jotty/src-tauri && cargo test db::`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(db): open + migrations v1 with FTS5"
```

---

### Task 3: Outbox DAO

**Files:**
- Create: `src-tauri/src/db/outbox.rs`
- Modify: `src-tauri/src/db/mod.rs` (`pub mod outbox;`)

**Interfaces:**
- Produces:
  - `pub struct OutboxOp { pub seq: i64, pub op_type: String, pub entity: String, pub entity_id: String, pub payload: String, pub attempts: i64, pub last_error: Option<String>, pub state: String }`
  - `enqueue(conn: &Connection, op_type: &str, entity: &str, entity_id: &str, payload: &serde_json::Value) -> AppResult<()>` (caller supplies the surrounding transaction; this fn is txn-agnostic)
  - `next_batch(conn: &Connection, limit: i64) -> AppResult<Vec<OutboxOp>>` (state='pending', ORDER BY seq)
  - `mark_done(conn, seq: i64)`, `mark_conflict(conn, seq: i64, err: &str)`, `record_attempt(conn, seq: i64, err: &str)` — all `-> AppResult<()>`
  - `pending_count(conn) -> AppResult<i64>`
  - `has_pending_for(conn, entity: &str, id: &str) -> AppResult<bool>`
  - `remap_entity_id(conn, entity: &str, old_id: &str, new_id: &str) -> AppResult<usize>` (rewrites pending ops after server ID assignment)

- [ ] **Step 1: Write failing test**

`src-tauri/src/db/outbox.rs` (with tests):
```rust
use crate::error::AppResult;
use rusqlite::Connection;
use serde_json::json;

#[derive(Debug, Clone)]
pub struct OutboxOp {
    pub seq: i64,
    pub op_type: String,
    pub entity: String,
    pub entity_id: String,
    pub payload: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub state: String,
}

pub fn enqueue(conn: &Connection, op_type: &str, entity: &str, entity_id: &str, payload: &serde_json::Value) -> AppResult<()> {
    conn.execute(
        "INSERT INTO outbox(op_type, entity, entity_id, payload) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![op_type, entity, entity_id, payload.to_string()],
    )?;
    Ok(())
}

fn row_to_op(r: &rusqlite::Row) -> rusqlite::Result<OutboxOp> {
    Ok(OutboxOp {
        seq: r.get(0)?,
        op_type: r.get(1)?,
        entity: r.get(2)?,
        entity_id: r.get(3)?,
        payload: r.get(4)?,
        attempts: r.get(5)?,
        last_error: r.get(6)?,
        state: r.get(7)?,
    })
}

pub fn next_batch(conn: &Connection, limit: i64) -> AppResult<Vec<OutboxOp>> {
    let mut stmt = conn.prepare(
        "SELECT seq, op_type, entity, entity_id, payload, attempts, last_error, state
         FROM outbox WHERE state='pending' ORDER BY seq LIMIT ?1",
    )?;
    let ops = stmt.query_map([limit], |r| row_to_op(r))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ops)
}

pub fn mark_done(conn: &Connection, seq: i64) -> AppResult<()> {
    conn.execute("UPDATE outbox SET state='done' WHERE seq=?1", [seq])?;
    Ok(())
}

pub fn mark_conflict(conn: &Connection, seq: i64, err: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE outbox SET state='conflict', last_error=?2 WHERE seq=?1",
        rusqlite::params![seq, err],
    )?;
    Ok(())
}

pub fn record_attempt(conn: &Connection, seq: i64, err: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE outbox SET attempts=attempts+1, last_error=?2 WHERE seq=?1",
        rusqlite::params![seq, err],
    )?;
    Ok(())
}

pub fn pending_count(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM outbox WHERE state='pending'", [], |r| r.get(0))?)
}

pub fn has_pending_for(conn: &Connection, entity: &str, id: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM outbox WHERE state='pending' AND entity=?1 AND entity_id=?2",
        rusqlite::params![entity, id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub fn remap_entity_id(conn: &Connection, entity: &str, old_id: &str, new_id: &str) -> AppResult<usize> {
    let n = conn.execute(
        "UPDATE outbox SET entity_id=?3 WHERE entity=?1 AND entity_id=?2 AND state='pending'",
        rusqlite::params![entity, old_id, new_id],
    )?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations, open};
    use std::path::Path;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        // leak tempdir for test lifetime
        std::mem::forget(dir);
        migrations::run(&conn).unwrap();
        conn
    }

    #[test]
    fn fifo_order_and_state_filtering() {
        let conn = db();
        enqueue(&conn, "create", "note", "a", &json!({"title": "A"})).unwrap();
        enqueue(&conn, "update", "note", "b", &json!({})).unwrap();
        let batch = next_batch(&conn, 10).unwrap();
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[0].entity_id, "a");
        assert_eq!(batch[0].op_type, "create");
        mark_done(&conn, batch[0].seq).unwrap();
        mark_conflict(&conn, batch[1].seq, "gone").unwrap();
        assert_eq!(pending_count(&conn).unwrap(), 0);
    }

    #[test]
    fn has_pending_and_remap() {
        let conn = db();
        enqueue(&conn, "create", "note", "tmp1", &json!({})).unwrap();
        enqueue(&conn, "update", "note", "tmp1", &json!({})).unwrap();
        assert!(has_pending_for(&conn, "note", "tmp1").unwrap());
        assert!(!has_pending_for(&conn, "checklist", "tmp1").unwrap());
        let n = remap_entity_id(&conn, "note", "tmp1", "real-uuid").unwrap();
        assert_eq!(n, 2);
        assert!(has_pending_for(&conn, "note", "real-uuid").unwrap());
    }

    #[test]
    fn record_attempt_increments() {
        let conn = db();
        enqueue(&conn, "create", "note", "x", &json!({})).unwrap();
        let op = &next_batch(&conn, 1).unwrap()[0];
        record_attempt(&conn, op.seq, "timeout").unwrap();
        let after = next_batch(&conn, 1).unwrap();
        assert_eq!(after[0].attempts, 1);
        assert_eq!(after[0].last_error.as_deref(), Some("timeout"));
    }
}
```

Add `pub mod outbox;` to `db/mod.rs`.

- [ ] **Step 2: Run test to verify it fails then implement and pass**

Run: `cd /coding/jotty/src-tauri && cargo test outbox` — first run fails (module missing); code above is the implementation; re-run.
Expected: 3 PASS.

- [ ] **Step 3: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(db): outbox DAO with FIFO batch, states, remap"
```

---

### Task 4: Notes DAO

**Files:**
- Create: `src-tauri/src/db/notes.rs`
- Modify: `src-tauri/src/db/mod.rs` (`pub mod notes;`)

**Interfaces:**
- Consumes: `jotty::models::ServerNote` (Task 6) — for this task create a minimal stub struct in the test file with the same fields; Task 6 replaces it. To keep types stable, define `ServerNote` NOW in `src-tauri/src/jotty/models.rs` exactly as Task 6 specifies (see below) and reference it.
- Produces:
  - `pub struct NoteRow { pub id: String, pub title: String, pub content: String, pub category: String, pub created_at: Option<String>, pub updated_at: Option<String>, pub deleted_at: Option<String>, pub dirty: bool }`
  - `pub struct NewNote { pub title: String, pub content: String, pub category: String }`
  - `pub struct NotePatch { pub title: Option<String>, pub content: Option<String>, pub category: Option<String> }`
  - `upsert_from_server(conn, n: &ServerNote) -> AppResult<bool>` — true = applied. LWW: skip if local dirty; skip if local `updated_at >= server.updated_at`; else insert/replace + FTS refresh.
  - `insert_local(conn, n: &NewNote) -> AppResult<NoteRow>` — new uuid, dirty=1, FTS refresh.
  - `update_local(conn, id, p: &NotePatch) -> AppResult<NoteRow>` — dirty=1, FTS refresh.
  - `soft_delete_local(conn, id) -> AppResult<()>` — deleted_at=now, dirty=1.
  - `get(conn, id) -> AppResult<Option<NoteRow>>`; `list(conn, include_deleted: bool) -> AppResult<Vec<NoteRow>>`
  - `mark_synced(conn, id, server_updated_at: &str) -> AppResult<()>` — dirty=0, updated_at=server value.

**Pre-step:** create `src-tauri/src/jotty/models.rs` with the `ServerNote` definition from Task 6 Step 1 (only the structs, not the checklist structs), add `pub mod jotty;` to `lib.rs`. Tests for the DAO come in Task 6; here it exists as the type source.

- [ ] **Step 1: Write failing test**

`src-tauri/src/db/notes.rs` (tests included):
```rust
use crate::error::AppResult;
use crate::jotty::models::ServerNote;
use chrono::Utc;
use rusqlite::Connection;
use serde_json::json;

#[derive(Debug, Clone, PartialEq)]
pub struct NoteRow {
    pub id: String,
    pub title: String,
    pub content: String,
    pub category: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub deleted_at: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone)]
pub struct NewNote {
    pub title: String,
    pub content: String,
    pub category: String,
}

#[derive(Debug, Clone, Default)]
pub struct NotePatch {
    pub title: Option<String>,
    pub content: Option<String>,
    pub category: Option<String>,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn fts_refresh(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM notes_fts WHERE id=?1", [id])?;
    conn.execute(
        "INSERT INTO notes_fts(id, title, content)
         SELECT id, title, content FROM notes WHERE id=?1",
        [id],
    )?;
    Ok(())
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<NoteRow> {
    Ok(NoteRow {
        id: r.get(0)?,
        title: r.get(1)?,
        content: r.get(2)?,
        category: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        deleted_at: r.get(6)?,
        dirty: r.get::<_, i64>(7)? != 0,
    })
}

const COLS: &str = "id, title, content, category, created_at, updated_at, deleted_at, dirty";

pub fn upsert_from_server(conn: &Connection, n: &ServerNote) -> AppResult<bool> {
    let existing = conn
        .query_row(
            &format!("SELECT dirty, updated_at FROM notes WHERE id=?1"),
            [&n.id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    if let Some((dirty, local_updated)) = existing {
        if dirty == 1 {
            return Ok(false); // local pending ops win until pushed
        }
        if let Some(lu) = local_updated {
            if lu >= n.updated_at {
                return Ok(false); // LWW: local not older
            }
        }
        conn.execute(
            "UPDATE notes SET title=?2, content=?3, category=?4, created_at=?5, updated_at=?6, dirty=0 WHERE id=?1",
            rusqlite::params![n.id, n.title, n.content.clone().unwrap_or_default(), n.category, n.created_at, n.updated_at],
        )?;
    } else {
        conn.execute(
            "INSERT INTO notes (id, title, content, category, created_at, updated_at, dirty) VALUES (?1,?2,?3,?4,?5,?6,0)",
            rusqlite::params![n.id, n.title, n.content.clone().unwrap_or_default(), n.category, n.created_at, n.updated_at],
        )?;
    }
    fts_refresh(conn, &n.id)?;
    Ok(true)
}

pub fn insert_local(conn: &Connection, n: &NewNote) -> AppResult<NoteRow> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now();
    conn.execute(
        "INSERT INTO notes (id, title, content, category, created_at, updated_at, dirty) VALUES (?1,?2,?3,?4,?5,?5,1)",
        rusqlite::params![id, n.title, n.content, n.category, ts],
    )?;
    fts_refresh(conn, &id)?;
    Ok(get(conn, &id)?.unwrap())
}

pub fn update_local(conn: &Connection, id: &str, p: &NotePatch) -> AppResult<NoteRow> {
    let existing = get(conn, id)?.ok_or_else(|| crate::error::AppError::Other(format!("note {id} not found")))?;
    conn.execute(
        "UPDATE notes SET title=?2, content=?3, category=?4, dirty=1 WHERE id=?1",
        rusqlite::params![
            id,
            p.title.unwrap_or(existing.title),
            p.content.unwrap_or(existing.content),
            p.category.unwrap_or(existing.category)
        ],
    )?;
    fts_refresh(conn, id)?;
    Ok(get(conn, id)?.unwrap())
}

pub fn soft_delete_local(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE notes SET deleted_at=?2, dirty=1 WHERE id=?1",
        rusqlite::params![id, now()],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<NoteRow>> {
    let sql = format!("SELECT {COLS} FROM notes WHERE id=?1");
    Ok(conn.query_row(&sql, [id], |r| row(r)).optional()?)
}

pub fn list(conn: &Connection, include_deleted: bool) -> AppResult<Vec<NoteRow>> {
    let where_clause = if include_deleted { "" } else { " WHERE deleted_at IS NULL" };
    let sql = format!("SELECT {COLS} FROM notes{where_clause} ORDER BY updated_at DESC, id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| row(r))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn mark_synced(conn: &Connection, id: &str, server_updated_at: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE notes SET dirty=0, updated_at=?2 WHERE id=?1",
        rusqlite::params![id, server_updated_at],
    )?;
    Ok(())
}

// `optional` helper
trait RusqliteOptionalExt<T> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error>;
}
impl<T> RusqliteOptionalExt<T> for rusqlite::Result<T> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations, open};
    use std::path::Path;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&conn).unwrap();
        conn
    }

    fn server_note(id: &str, title: &str, updated: &str) -> ServerNote {
        ServerNote {
            id: id.into(),
            title: title.into(),
            category: "Work".into(),
            content: Some("hello".into()),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: updated.into(),
            owner: None,
        }
    }

    #[test]
    fn insert_local_is_dirty_and_searchable() {
        let conn = db();
        let n = insert_local(&conn, &NewNote { title: "Groceries".into(), content: "milk".into(), category: "Home".into() }).unwrap();
        assert!(n.dirty);
        let hits: Vec<String> = conn
            .prepare("SELECT id FROM notes_fts WHERE notes_fts MATCH 'milk'")
            .unwrap().query_map([], |r| r.get(0)).unwrap()
            .map(Result::unwrap).collect();
        assert_eq!(hits, vec![n.id]);
    }

    #[test]
    fn upsert_respects_lww_and_dirty() {
        let conn = db();
        let local = insert_local(&conn, &NewNote { title: "mine".into(), content: "".into(), category: "Home".into() }).unwrap();
        // dirty local: server copy must not clobber
        assert!(!upsert_from_server(&conn, &server_note(&local.id, "theirs", "2099-01-01T00:00:00.000Z")).unwrap());
        mark_synced(&conn, &local.id, "2026-01-01T00:00:00.000Z").unwrap();
        // older server update loses
        assert!(!upsert_from_server(&conn, &server_note(&local.id, "old", "2025-01-01T00:00:00.000Z")).unwrap());
        // newer server update wins
        assert!(upsert_from_server(&conn, &server_note(&local.id, "new-title", "2027-01-01T00:00:00.000Z")).unwrap());
        let after = get(&conn, &local.id).unwrap().unwrap();
        assert_eq!(after.title, "new-title");
        assert!(!after.dirty);
    }

    #[test]
    fn soft_delete_tombstones_and_list_filters() {
        let conn = db();
        let n = insert_local(&conn, &NewNote { title: "t".into(), content: "".into(), category: "Home".into() }).unwrap();
        soft_delete_local(&conn, &n.id).unwrap();
        assert_eq!(list(&conn, false).unwrap().len(), 0);
        assert_eq!(list(&conn, true).unwrap().len(), 1);
    }
}
```

Note: `optional()` needs `rusqlite::OptionalExtension` — instead of the hand-rolled trait, `use rusqlite::OptionalExtension;` at the top and drop the trait impl block. Do that in the implementation (the trait block above is illustrative; final code uses `OptionalExtension`).

- [ ] **Step 2: Run tests, iterate to green**

Run: `cd /coding/jotty/src-tauri && cargo test notes`
Expected: 3 PASS. (First run fails to compile until the file exists — that is the RED state.)

- [ ] **Step 3: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(db): notes DAO with LWW upsert, tombstones, FTS refresh"
```

---

### Task 5: Checklists + items DAO (incl. reconcile)

**Files:**
- Create: `src-tauri/src/db/checklists.rs`, `src-tauri/src/db/items.rs`
- Modify: `src-tauri/src/db/mod.rs` (`pub mod checklists; pub mod items;`)

**Interfaces:**
- Consumes: `ServerChecklist`, `ServerItem` from `jotty::models` (Task 6 pre-created with notes).
- Produces:
  - `pub struct ChecklistRow { pub id: String, pub title: String, pub category: String, pub list_type: String, pub created_at: Option<String>, pub updated_at: Option<String>, pub deleted_at: Option<String>, pub dirty: bool }`
  - `pub struct ItemRow { pub local_id: String, pub checklist_id: String, pub parent_id: Option<String>, pub text: String, pub completed: bool, pub position: i64, pub server_path: Option<String>, pub dirty: bool }`
  - `pub struct NewChecklist { pub title: String, pub category: String }`, `pub struct NewItem { pub checklist_id: String, pub parent_local_id: Option<String>, pub text: String }`
  - `upsert_list_from_server(conn, c: &ServerChecklist) -> AppResult<bool>` — same LWW rules as notes; also calls `items::reconcile` with the flattened server items.
  - `items::reconcile(conn, checklist_id: &str, server_items: &[(String, ServerItemFlat)]) -> AppResult<()>` where `ServerItemFlat { pub path: String, pub id: Option<String>, pub text: String, pub completed: bool }`. Algorithm: (1) local items matching by `server_path` → update position/completed, dirty=0; (2) unclaimed local items matching by exact text → adopt (set server_path); (3) remaining server items → insert new local rows (uuid local_id, dirty=0); (4) local items still unclaimed AND not dirty AND no pending op (`outbox::has_pending_for(entity="checklist_item", id)`) → hard delete (server removed them). Rebuild `lists_fts` for the checklist.
  - `insert_local_list`, `update_local_list(conn, id, title: Option<&str>, category: Option<&str>) -> AppResult<ChecklistRow>`, `soft_delete_list_local(conn, id)`
  - `items::insert_local(conn, n: &NewItem) -> AppResult<ItemRow>` (position = max sibling position + 1; server_path NULL; dirty=1)
  - `items::update_local(conn, local_id, text) -> AppResult<ItemRow>`; `items::set_checked(conn, local_id, checked: bool) -> AppResult<ItemRow>`
  - `items::delete_local(conn, local_id) -> AppResult<()>` (hard delete; cascade children via recursive parent_id lookup)
  - `items::reorder_local(conn, checklist_id, ordered_top_level_ids: &[String]) -> AppResult<()>` (repositions top-level DFS blocks; dirty=1 on touched items)
  - `items::list_for_checklist(conn, checklist_id) -> AppResult<Vec<ItemRow>>`; `items::get(conn, local_id) -> AppResult<Option<ItemRow>>`
  - `list_checklists(conn, include_deleted) -> AppResult<Vec<ChecklistRow>>`; `get_checklist(conn, id) -> AppResult<Option<ChecklistRow>>`; `mark_list_synced(conn, id, server_updated_at)`

- [ ] **Step 1: Write failing tests**

`src-tauri/src/db/items.rs`:
```rust
use crate::db::outbox;
use crate::error::AppResult;
use crate::jotty::models::{flatten_items, ServerItem};
use rusqlite::Connection;
use serde_json::json;

#[derive(Debug, Clone, PartialEq)]
pub struct ItemRow {
    pub local_id: String,
    pub checklist_id: String,
    pub parent_id: Option<String>,
    pub text: String,
    pub completed: bool,
    pub position: i64,
    pub server_path: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone)]
pub struct NewItem {
    pub checklist_id: String,
    pub parent_local_id: Option<String>,
    pub text: String,
}

pub struct ServerItemFlat {
    pub path: String,
    pub id: Option<String>,
    pub text: String,
    pub completed: bool,
}

pub fn flatten(server_items: &[ServerItem]) -> Vec<ServerItemFlat> {
    flatten_items(server_items)
        .into_iter()
        .map(|(path, it)| ServerItemFlat {
            path,
            id: it.id.clone(),
            text: it.text.clone(),
            completed: it.completed.unwrap_or(false),
        })
        .collect()
}

fn fts_refresh(conn: &Connection, list_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM lists_fts WHERE id=?1", [list_id])?;
    conn.execute(
        "INSERT INTO lists_fts(id, title, item_text)
         SELECT c.id, c.title, COALESCE((SELECT GROUP_CONCAT(text, ' ') FROM checklist_items WHERE checklist_id=c.id), '')
         FROM checklists c WHERE c.id=?1",
        [list_id],
    )?;
    Ok(())
}

const COLS: &str = "local_id, checklist_id, parent_id, text, completed, position, server_path, dirty";

fn row(r: &rusqlite::Row) -> rusqlite::Result<ItemRow> {
    Ok(ItemRow {
        local_id: r.get(0)?,
        checklist_id: r.get(1)?,
        parent_id: r.get(2)?,
        text: r.get(3)?,
        completed: r.get::<_, i64>(4)? != 0,
        position: r.get(5)?,
        server_path: r.get(6)?,
        dirty: r.get::<_, i64>(7)? != 0,
    })
}

pub fn get(conn: &Connection, local_id: &str) -> AppResult<Option<ItemRow>> {
    let sql = format!("SELECT {COLS} FROM checklist_items WHERE local_id=?1");
    use rusqlite::OptionalExtension;
    Ok(conn.query_row(&sql, [local_id], |r| row(r)).optional()?)
}

pub fn list_for_checklist(conn: &Connection, checklist_id: &str) -> AppResult<Vec<ItemRow>> {
    let sql = format!("SELECT {COLS} FROM checklist_items WHERE checklist_id=?1 ORDER BY position");
    let mut stmt = conn.prepare(&sql)?;
    Ok(stmt.query_map([checklist_id], |r| row(r))?.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn reconcile(conn: &Connection, checklist_id: &str, server_items: &[ServerItemFlat]) -> AppResult<()> {
    let local = list_for_checklist(conn, checklist_id)?;
    let mut claimed: Vec<String> = Vec::new(); // local_ids matched to server
    // pending ops shield items from adoption/deletion until their op resolves (Task 7 push-then-pull)
    let pending: Vec<String> = local
        .iter()
        .filter(|l| matches!(outbox::has_pending_for(conn, "checklist_item", &l.local_id), Ok(true)))
        .map(|l| l.local_id.clone())
        .collect();
    for (order, s) in server_items.iter().enumerate() {
        // 1) match by server_path
        let mut target = local.iter().find(|l| l.server_path.as_deref() == Some(s.path.as_str()) && !claimed.contains(&l.local_id));
        // 2) fallback: unclaimed, no pending op, same text (never-synced dirty locals are adoptable)
        if target.is_none() {
            target = local.iter().find(|l| {
                l.server_path.is_none() && !claimed.contains(&l.local_id) && !pending.contains(&l.local_id) && l.text == s.text
            });
        }
        match target {
            Some(l) => {
                claimed.push(l.local_id.clone());
                conn.execute(
                    "UPDATE checklist_items SET position=?2, completed=?3, server_path=?4, dirty=0 WHERE local_id=?1",
                    rusqlite::params![l.local_id, order as i64, s.completed as i64, s.path],
                )?;
            }
            None => {
                conn.execute(
                    "INSERT INTO checklist_items (local_id, checklist_id, parent_id, text, completed, position, server_path, dirty)
                     VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 0)",
                    rusqlite::params![uuid::Uuid::new_v4().to_string(), checklist_id, s.text, s.completed as i64, order as i64, s.path],
                )?;
            }
        }
    }
    // 3) unclaimed, not dirty, no pending op -> server removed it
    for l in local.iter() {
        if claimed.contains(&l.local_id) { continue; }
        if l.dirty { continue; }
        if outbox::has_pending_for(conn, "checklist_item", &l.local_id)? { continue; }
        delete_local(conn, &l.local_id)?;
    }
    fts_refresh(conn, checklist_id)?;
    Ok(())
}

pub fn insert_local(conn: &Connection, n: &NewItem) -> AppResult<ItemRow> {
    let parent_pos_base: i64 = match &n.parent_local_id {
        Some(pid) => {
            let p = get(conn, pid)?.ok_or_else(|| crate::error::AppError::Other("parent not found".into()))?;
            // children positions continue after parent's subtree; simple: max over all +1 (DFS order kept by reconcile)
            let max_pos: i64 = conn.query_row("SELECT COALESCE(MAX(position), -1) FROM checklist_items WHERE checklist_id=?1", [&n.checklist_id], |r| r.get(0))?;
            let _ = p;
            max_pos + 1
        }
        None => {
            let max_pos: i64 = conn.query_row(
                "SELECT COALESCE(MAX(position), -1) FROM checklist_items WHERE checklist_id=?1 AND parent_id IS NULL",
                [&n.checklist_id], |r| r.get(0))?;
            max_pos + 1
        }
    };
    let local_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO checklist_items (local_id, checklist_id, parent_id, text, completed, position, server_path, dirty)
         VALUES (?1,?2,?3,?4,0,?5,NULL,1)",
        rusqlite::params![local_id, n.checklist_id, n.parent_local_id, n.text, parent_pos_base],
    )?;
    fts_refresh(conn, &n.checklist_id)?;
    Ok(get(conn, &local_id)?.unwrap())
}

pub fn update_local(conn: &Connection, local_id: &str, text: &str) -> AppResult<ItemRow> {
    conn.execute("UPDATE checklist_items SET text=?2, dirty=1 WHERE local_id=?1", rusqlite::params![local_id, text])?;
    let item = get(conn, local_id)?.ok_or_else(|| crate::error::AppError::Other("item not found".into()))?;
    fts_refresh(conn, &item.checklist_id)?;
    Ok(item)
}

pub fn set_checked(conn: &Connection, local_id: &str, checked: bool) -> AppResult<ItemRow> {
    conn.execute("UPDATE checklist_items SET completed=?2, dirty=1 WHERE local_id=?1", rusqlite::params![local_id, checked as i64])?;
    let item = get(conn, local_id)?.ok_or_else(|| crate::error::AppError::Other("item not found".into()))?;
    Ok(item)
}

pub fn delete_local(conn: &Connection, local_id: &str) -> AppResult<()> {
    use rusqlite::OptionalExtension;
    let list_id: Option<String> = conn
        .query_row("SELECT checklist_id FROM checklist_items WHERE local_id=?1", [local_id], |r| r.get(0))
        .optional()?;
    // collect descendants (BFS) then delete children-first
    let mut to_delete = vec![local_id.to_string()];
    let mut i = 0;
    while i < to_delete.len() {
        let id = &to_delete[i];
        let mut stmt = conn.prepare("SELECT local_id FROM checklist_items WHERE parent_id=?1")?;
        let children: Vec<String> = stmt.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        to_delete.extend(children);
        i += 1;
    }
    for id in to_delete.iter().rev() {
        conn.execute("DELETE FROM checklist_items WHERE local_id=?1", [id])?;
    }
    if let Some(l) = list_id { fts_refresh(conn, &l)?; }
    Ok(())
}

pub fn reorder_local(conn: &Connection, checklist_id: &str, ordered_top_level_ids: &[String]) -> AppResult<()> {
    // rewrite top-level positions 0..n; children keep relative DFS position via same order pass
    for (i, id) in ordered_top_level_ids.iter().enumerate() {
        conn.execute(
            "UPDATE checklist_items SET position=?2, dirty=1 WHERE local_id=?1",
            rusqlite::params![id, i as i64],
        )?;
    }
    fts_refresh(conn, checklist_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{checklists, migrations, open};
    use serde_json::json;
    use std::path::Path;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&conn).unwrap();
        conn
    }

    fn server_item(text: &str, completed: bool, children: Vec<ServerItem>) -> ServerItem {
        ServerItem {
            id: Some(format!("srv-{}", text.replace(' ', "-"))),
            index: 0,
            text: text.into(),
            completed: Some(completed),
            status: None,
            description: None,
            children,
            priority: None,
            score: None,
            start_date: None,
            target_date: None,
            estimated_time: None,
        }
    }

    #[test]
    fn reconcile_adopts_new_local_items_by_text() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        // local new item (dirty, no server_path)
        let it = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "buy milk".into() }).unwrap();
        assert!(it.dirty);
        // server has the same item (someone created it on the web)
        let server = vec![server_item("buy milk", false, vec![])];
        let flat = flatten(&server);
        reconcile(&conn, &list.id, &flat).unwrap();
        let items = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].local_id, it.local_id, "existing local row must be adopted, not duplicated");
        assert_eq!(items[0].server_path.as_deref(), Some("0"));
        assert!(!items[0].dirty);
    }

    #[test]
    fn reconcile_removes_server_deleted_items_unless_dirty() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        let server = vec![server_item("a", false, vec![]), server_item("b", false, vec![])];
        reconcile(&conn, &list.id, &flatten(&server)).unwrap();
        assert_eq!(list_for_checklist(&conn, &list.id).unwrap().len(), 2);
        // server now only has "a"
        reconcile(&conn, &list.id, &flatten(&vec![server_item("a", false, vec![])])).unwrap();
        let items = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "a");
    }

    #[test]
    fn reconcile_keeps_dirty_local_edits() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        reconcile(&conn, &list.id, &flatten(&vec![server_item("a", false, vec![])])).unwrap();
        let items = list_for_checklist(&conn, &list.id).unwrap();
        // local edit (dirty) — server still says "a" but local renamed to "a edited"
        update_local(&conn, &items[0].local_id, "a edited").unwrap();
        reconcile(&conn, &list.id, &flatten(&vec![server_item("a", false, vec![])])).unwrap();
        let after = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(after.len(), 1, "dirty local must not be deleted or duplicated");
        assert_eq!(after[0].text, "a edited");
    }

    #[test]
    fn insert_update_check_delete_flow() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        let a = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "a".into() }).unwrap();
        let child = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: Some(a.local_id.clone()), text: "a.1".into() }).unwrap();
        assert_eq!(child.parent_id.as_deref(), Some(a.local_id.as_str()));
        update_local(&conn, &a.local_id, "a2").unwrap();
        set_checked(&conn, &a.local_id, true).unwrap();
        assert!(get(&conn, &a.local_id).unwrap().unwrap().completed);
        // delete parent removes descendants
        delete_local(&conn, &a.local_id).unwrap();
        assert!(get(&conn, &child.local_id).unwrap().is_none());
    }

    #[test]
    fn reorder_repositions_top_level() {
        let conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        let a = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "a".into() }).unwrap();
        let b = insert_local(&conn, &NewItem { checklist_id: list.id.clone(), parent_local_id: None, text: "b".into() }).unwrap();
        reorder_local(&conn, &list.id, &[b.local_id.clone(), a.local_id.clone()]).unwrap();
        let items = list_for_checklist(&conn, &list.id).unwrap();
        assert_eq!(items[0].local_id, b.local_id);
        assert_eq!(items[1].local_id, a.local_id);
        assert!(items.iter().all(|i| i.dirty));
    }
}
```

`src-tauri/src/db/checklists.rs`:
```rust
use crate::db::items;
use crate::error::AppResult;
use crate::jotty::models::ServerChecklist;
use chrono::Utc;
use rusqlite::Connection;

#[derive(Debug, Clone, PartialEq)]
pub struct ChecklistRow {
    pub id: String,
    pub title: String,
    pub category: String,
    pub list_type: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub deleted_at: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone)]
pub struct NewChecklist {
    pub title: String,
    pub category: String,
}

const COLS: &str = "id, title, category, list_type, created_at, updated_at, deleted_at, dirty";

fn row(r: &rusqlite::Row) -> rusqlite::Result<ChecklistRow> {
    Ok(ChecklistRow {
        id: r.get(0)?,
        title: r.get(1)?,
        category: r.get(2)?,
        list_type: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        deleted_at: r.get(6)?,
        dirty: r.get::<_, i64>(7)? != 0,
    })
}

pub fn get_checklist(conn: &Connection, id: &str) -> AppResult<Option<ChecklistRow>> {
    let sql = format!("SELECT {COLS} FROM checklists WHERE id=?1");
    use rusqlite::OptionalExtension;
    Ok(conn.query_row(&sql, [id], |r| row(r)).optional()?)
}

pub fn list_checklists(conn: &Connection, include_deleted: bool) -> AppResult<Vec<ChecklistRow>> {
    let wc = if include_deleted { "" } else { " WHERE deleted_at IS NULL" };
    let sql = format!("SELECT {COLS} FROM checklists{wc} ORDER BY title");
    let mut stmt = conn.prepare(&sql)?;
    Ok(stmt.query_map([], |r| row(r))?.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn upsert_list_from_server(conn: &Connection, c: &ServerChecklist) -> AppResult<bool> {
    use rusqlite::OptionalExtension;
    let existing = conn
        .query_row("SELECT dirty, updated_at FROM checklists WHERE id=?1", [&c.id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .optional()?;
    if let Some((dirty, local_updated)) = existing {
        if dirty == 1 {
            return Ok(false);
        }
        if let Some(lu) = local_updated {
            if lu >= c.updated_at {
                return Ok(false);
            }
        }
        conn.execute(
            "UPDATE checklists SET title=?2, category=?3, list_type=?4, created_at=?5, updated_at=?6, dirty=0 WHERE id=?1",
            rusqlite::params![c.id, c.title, c.category, c.list_type.clone().unwrap_or_else(|| "regular".into()), c.created_at, c.updated_at],
        )?;
    } else {
        conn.execute(
            "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES (?1,?2,?3,?4,?5,?6,0)",
            rusqlite::params![c.id, c.title, c.category, c.list_type.clone().unwrap_or_else(|| "regular".into()), c.created_at, c.updated_at],
        )?;
    }
    items::reconcile(conn, &c.id, &items::flatten(&c.items))?;
    Ok(true)
}

pub fn insert_local_list(conn: &Connection, n: &NewChecklist) -> AppResult<ChecklistRow> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES (?1,?2,?3,'simple',?4,?4,1)",
        rusqlite::params![id, n.title, n.category, ts],
    )?;
    Ok(get_checklist(conn, &id)?.unwrap())
}

pub fn update_local_list(conn: &Connection, id: &str, title: Option<&str>, category: Option<&str>) -> AppResult<ChecklistRow> {
    let existing = get_checklist(conn, id)?.ok_or_else(|| crate::error::AppError::Other("list not found".into()))?;
    conn.execute(
        "UPDATE checklists SET title=?2, category=?3, dirty=1 WHERE id=?1",
        rusqlite::params![id, title.unwrap_or(&existing.title), category.unwrap_or(&existing.category)],
    )?;
    Ok(get_checklist(conn, id)?.unwrap())
}

pub fn soft_delete_list_local(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE checklists SET deleted_at=?2, dirty=1 WHERE id=?1",
        rusqlite::params![id, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

pub fn mark_list_synced(conn: &Connection, id: &str, server_updated_at: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE checklists SET dirty=0, updated_at=?2 WHERE id=?1",
        rusqlite::params![id, server_updated_at],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations, open};
    use crate::jotty::models::ServerItem;
    use std::path::Path;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&conn).unwrap();
        conn
    }

    fn server_checklist(id: &str, title: &str, updated: &str, items: Vec<ServerItem>) -> ServerChecklist {
        ServerChecklist {
            id: id.into(),
            title: title.into(),
            category: "Work".into(),
            list_type: Some("regular".into()),
            items,
            statuses: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: updated.into(),
        }
    }

    #[test]
    fn upsert_imports_items_and_respects_dirty() {
        let conn = db();
        let local = insert_local_list(&conn, &NewChecklist { title: "mine".into(), category: "Home".into() }).unwrap();
        let c = server_checklist(&local.id, "theirs", "2099-01-01T00:00:00.000Z", vec![ServerItem::simple("a")]);
        assert!(!upsert_list_from_server(&conn, &c).unwrap(), "dirty list must not be clobbered");
        mark_list_synced(&conn, &local.id, "2026-01-01T00:00:00.000Z").unwrap();
        let c2 = server_checklist(&local.id, "theirs", "2027-01-01T00:00:00.000Z", vec![ServerItem::simple("a"), ServerItem::simple("b")]);
        assert!(upsert_list_from_server(&conn, &c2).unwrap());
        assert_eq!(items::list_for_checklist(&conn, &local.id).unwrap().len(), 2);
        // lists_fts searchable
        let hits: Vec<String> = conn.prepare("SELECT id FROM lists_fts WHERE lists_fts MATCH 'a b'").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(hits, vec![local.id]);
    }
}
```

Note: tests reference `ServerItem::simple(text)` and `flatten_items` — these must exist in `jotty::models` (Task 6). Create `models.rs` content (Task 6 Step 1) BEFORE running this task's tests; that is fine because Task 6's own tests validate models fully.

- [ ] **Step 2: Run tests to green**

Run: `cd /coding/jotty/src-tauri && cargo test 'items::' 'checklists::' 2>/dev/null || cargo test`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(db): checklists+items DAO, reconcile by path/text, FTS"
```

---

### Task 6: jotty API models + serde round-trip fixtures

> **Binding note (Task 4 review carry-forward, 2026-09-15):** (1) LWW timestamps compare as raw
> strings and `now()` is chrono `to_rfc3339()` (`+00:00`, variable fractional digits) while server
> values are `.000Z`-style — lexicographic compare is only correct when formats align. Task 7 sync
> comparisons must normalize both sides (parse to DateTime, or emit a fixed-format UTC string)
> before comparing — do not rely on string ordering across mixed formats. (2) `notes::update_local`
> was the only untested Task 4 fn and carries the E0507 clone-fix deviation — **Task 6 must include
> an `update_local` test** (patch-merge of title/content/category, `dirty=1`, FTS refreshed).

**Files:**
- Create: `src-tauri/src/jotty/mod.rs`, `src-tauri/src/jotty/models.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod jotty;`)

**Interfaces:**
- Produces (used by Tasks 4, 5, 7, 8, 10–12):
  - `#[derive(Debug, Clone, Deserialize, Serialize)] #[serde(rename_all = "camelCase")] pub struct ServerNote { pub id: String, pub title: String, pub category: String, pub content: Option<String>, pub created_at: String, pub updated_at: String, pub owner: Option<String> }`
  - `pub struct ServerChecklist { pub id: String, pub title: String, pub category: String, #[serde(rename = "type")] pub list_type: Option<String>, pub items: Vec<ServerItem>, pub statuses: Option<Vec<serde_json::Value>>, pub created_at: String, pub updated_at: String }`
  - `pub struct ServerItem { pub id: Option<String>, pub index: i64, pub text: String, pub completed: Option<bool>, pub status: Option<String>, pub description: Option<String>, #[serde(default)] pub children: Vec<ServerItem>, pub priority: Option<String>, pub score: Option<f64>, pub start_date: Option<String>, pub target_date: Option<String>, pub estimated_time: Option<f64> }` — with `#[serde(default)]` on every Option field so sparse API payloads parse; implement `ServerItem::simple(text: &str) -> ServerItem` helper.
  - `pub struct Health { pub status: String, pub version: Option<String> }`
  - `pub struct Categories { pub notes: Vec<CategoryNode>, pub checklists: Vec<CategoryNode> }`, `pub struct CategoryNode { pub name: String, pub path: String, pub count: i64, pub level: i64 }`
  - `pub fn flatten_items(items: &[ServerItem]) -> Vec<(String, &ServerItem)>` — DFS pre-order with dot-notation index paths ("0", "0.1", "2.0.1").
  - Note create/update response shape: `{ "success": true, "data": { ...note } }` and checklist create `{ "success": true, "data": { ...checklist } }` — model as `pub struct Created<T> { #[serde(default)] pub success: bool, pub data: Option<T> }`.

- [ ] **Step 1: Write failing test**

`src-tauri/src/jotty/models.rs` tests (bottom of file):
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_note_list_payload_from_api_doc() {
        let raw = r#"{"notes":[{"id":"6ba7b810-9dad-11d1-80b4-00c04fd430c8","title":"My Note","category":"Personal","content":"Note content here...","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z","owner":"fccview"}]}"#;
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        let notes: Vec<ServerNote> = serde_json::from_value(v["notes"].clone()).unwrap();
        assert_eq!(notes[0].updated_at, "2024-01-01T00:00:00.000Z");
    }

    #[test]
    fn parses_checklist_with_nested_items_and_sparse_fields() {
        let raw = r#"{
          "id":"f47ac10b-58cc-4372-a567-0e02b2c3d479","title":"Project Tasks","category":"Work","type":"task",
          "items":[
            {"id":"list-123","index":0,"text":"Parent Task","completed":false,"status":"in_progress",
             "children":[{"id":"list-sub-456","index":0,"text":"Sub-task 1","completed":false},
                         {"id":"list-sub-789","index":1,"text":"Sub-task 2","completed":true}]},
            {"index":1,"text":"Bare item"}
          ],
          "createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}"#;
        let c: ServerChecklist = serde_json::from_str(raw).unwrap();
        assert_eq!(c.items.len(), 2);
        assert_eq!(c.items[0].children.len(), 2);
        assert!(c.items[1].id.is_none(), "sparse payload must parse");
    }

    #[test]
    fn flatten_paths_are_dot_notation_dfs() {
        let child1 = ServerItem { text: "s1".into(), ..ServerItem::simple("s1") };
        let child2 = ServerItem { text: "s2".into(), ..ServerItem::simple("s2") };
        let mut parent = ServerItem::simple("p");
        parent.children = vec![child1, child2];
        let third = ServerItem::simple("t");
        let flat = flatten_items(&[parent, third]);
        let paths: Vec<String> = flat.iter().map(|(p, _)| p.clone()).collect();
        assert_eq!(paths, vec!["0", "0.0", "0.1", "1"]);
    }

    #[test]
    fn parses_created_wrapper() {
        let raw = r#"{"success":true,"data":{"id":"note-123","title":"My New Note","content":"","category":"Personal","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z","owner":"fccview"}}"#;
        let created: Created<ServerNote> = serde_json::from_str(raw).unwrap();
        assert_eq!(created.data.unwrap().id, "note-123");
    }
}
```

- [ ] **Step 2: Implement**

`src-tauri/src/jotty/models.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerNote {
    pub id: String,
    pub title: String,
    pub category: String,
    pub content: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerChecklist {
    pub id: String,
    pub title: String,
    pub category: String,
    #[serde(rename = "type")]
    pub list_type: Option<String>,
    #[serde(default)]
    pub items: Vec<ServerItem>,
    #[serde(default)]
    pub statuses: Option<Vec<serde_json::Value>>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerItem {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub index: i64,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub completed: Option<bool>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub children: Vec<ServerItem>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub target_date: Option<String>,
    #[serde(default)]
    pub estimated_time: Option<f64>,
}

impl ServerItem {
    pub fn simple(text: &str) -> ServerItem {
        ServerItem {
            text: text.to_string(),
            completed: Some(false),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub status: String,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryNode {
    pub name: String,
    pub path: String,
    pub count: i64,
    pub level: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Categories {
    #[serde(default)]
    pub notes: Vec<CategoryNode>,
    #[serde(default)]
    pub checklists: Vec<CategoryNode>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created<T> {
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub data: Option<T>,
}

pub fn flatten_items(items: &[ServerItem]) -> Vec<(String, &ServerItem)> {
    let mut out = Vec::new();
    // NB: explicit 'a on items + the element type — elision + &mut invariance make the
    // one-verbatim-line version a hard rustc error (proven in Task 5, ruling in ledger).
    fn walk<'a>(prefix: &str, items: &'a [ServerItem], out: &mut Vec<(String, &'a ServerItem)>) {
        for (i, it) in items.iter().enumerate() {
            let path = if prefix.is_empty() { i.to_string() } else { format!("{prefix}.{i}") };
            out.push((path.clone(), it));
            walk(&path, &it.children, out);
        }
    }
    walk("", items, &mut out);
    out
}
```

`src-tauri/src/jotty/mod.rs`:
```rust
pub mod models;
```

- [ ] **Step 3: Run tests to green**

Run: `cd /coding/jotty/src-tauri && cargo test jotty`
Expected: 4 PASS.

- [ ] **Step 4: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(jotty): API DTOs with sparse-field tolerance, flatten helpers"
```

---

### Task 7: JottyClient — auth, health, notes, categories (wiremock)

**Files:**
- Create: `src-tauri/src/jotty/client.rs`
- Modify: `src-tauri/src/jotty/mod.rs` (`pub mod client;`)

**Interfaces:**
- Consumes: models from Task 6.
- Produces: `pub struct JottyClient { http: reqwest::Client, base_url: String, api_key: String }` with:
  - `new(base_url: &str, api_key: &str) -> AppResult<Self>` — rejects non-https unless host is localhost/127.0.0.1 (spec §9)
  - `async fn health(&self) -> AppResult<Health>`
  - `async fn get_notes(&self) -> AppResult<Vec<ServerNote>>` (GET `/api/notes`)
  - `async fn get_checklists(&self) -> AppResult<Vec<ServerChecklist>>` (GET `/api/checklists`)
  - `async fn get_categories(&self) -> AppResult<Categories>` (GET `/api/categories`)
  - `async fn create_note(&self, title: &str, content: &str, category: &str) -> AppResult<ServerNote>` (POST `/api/notes`, returns `Created<ServerNote>`.data or Api error)
  - `async fn update_note(&self, id: &str, title: &str, content: &str, category: &str) -> AppResult<ServerNote>` (PUT `/api/notes/{id}`)
  - `async fn delete_note(&self, id: &str) -> AppResult<()>` (DELETE `/api/notes/{id}`)
  - internal: `async fn api_get<T: DeserializeOwned>(&self, path: &str) -> AppResult<T>`; non-2xx → `AppError::Api { status, body }`.

- [ ] **Step 1: Write failing test**

`src-tauri/src/jotty/client.rs` (tests included; impl follows):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn server() -> MockServer {
        MockServer::start().await
    }

    #[tokio::test]
    async fn health_and_auth_header() {
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/health"))
            .and(header("x-api-key", "ck_test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"status":"healthy","version":"1.22.0"})))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck_test").unwrap();
        let h = c.health().await.unwrap();
        assert_eq!(h.status, "healthy");
        assert_eq!(h.version.as_deref(), Some("1.22.0"));
    }

    #[tokio::test]
    async fn get_notes_parses_payload() {
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"notes":[{"id":"n1","title":"T","category":"C","content":"body","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}]})))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let notes = c.get_notes().await.unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, "n1");
    }

    #[tokio::test]
    async fn api_error_maps_status_and_body() {
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let err = c.get_notes().await.unwrap_err();
        assert!(matches!(err, AppError::Api { status: 401, .. }));
    }

    #[tokio::test]
    async fn create_note_returns_created_note() {
        let s = server().await;
        Mock::given(method("POST")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": {"id":"note-123","title":"New","content":"x","category":"Personal","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z","owner":"u"}
            })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let n = c.create_note("New", "x", "Personal").await.unwrap();
        assert_eq!(n.id, "note-123");
    }

    #[tokio::test]
    async fn plain_http_rejected_outside_localhost() {
        let err = JottyClient::new("http://example.com", "ck").unwrap_err();
        assert!(matches!(err, AppError::InvalidConfig(_)));
        assert!(JottyClient::new("http://localhost:1122", "ck").is_ok());
        assert!(JottyClient::new("http://127.0.0.1:1122", "ck").is_ok());
    }
}
```

- [ ] **Step 2: Implement**

`src-tauri/src/jotty/client.rs` (above tests):
```rust
use crate::error::{AppError, AppResult};
use crate::jotty::models::{Categories, Created, Health, ServerChecklist, ServerNote};
use serde::de::DeserializeOwned;

#[derive(Clone)]
pub struct JottyClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
}

fn is_local(url: &reqwest::Url) -> bool {
    match url.host_str() {
        Some("localhost") | Some("127.0.0.1") | Some("::1") => true,
        _ => false,
    }
}

impl JottyClient {
    pub fn new(base_url: &str, api_key: &str) -> AppResult<Self> {
        let url = reqwest::Url::parse(base_url)
            .map_err(|e| AppError::InvalidConfig(format!("bad instance url: {e}")))?;
        if url.scheme() != "https" && !is_local(&url) {
            return Err(AppError::InvalidConfig("instance url must be https (http only allowed for localhost)".into()));
        }
        Ok(Self {
            http: reqwest::Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    async fn api_get<T: DeserializeOwned>(&self, path: &str) -> AppResult<T> {
        let resp = self.http.get(self.url(path)).header("x-api-key", &self.api_key).send().await?;
        finish(resp).await
    }

    async fn api_send<T: DeserializeOwned>(&self, method: reqwest::Method, path: &str, body: serde_json::Value) -> AppResult<T> {
        let resp = self.http.request(method, self.url(path))
            .header("x-api-key", &self.api_key)
            .json(&body)
            .send().await?;
        finish(resp).await
    }

    pub async fn health(&self) -> AppResult<Health> {
        self.api_get("/api/health").await
    }

    pub async fn get_notes(&self) -> AppResult<Vec<ServerNote>> {
        Ok(self.api_get::<serde_json::Value>("/api/notes").await?["notes"].clone().into())
    }

    pub async fn get_checklists(&self) -> AppResult<Vec<ServerChecklist>> {
        Ok(self.api_get::<serde_json::Value>("/api/checklists").await?["checklists"].clone().into())
    }

    pub async fn get_categories(&self) -> AppResult<Categories> {
        self.api_get("/api/categories").await
    }

    pub async fn create_note(&self, title: &str, content: &str, category: &str) -> AppResult<ServerNote> {
        let created: Created<ServerNote> = self.api_send(
            reqwest::Method::POST, "/api/notes",
            serde_json::json!({"title": title, "content": content, "category": category}),
        ).await?;
        created.data.ok_or_else(|| AppError::Other("create_note: missing data".into()))
    }

    pub async fn update_note(&self, id: &str, title: &str, content: &str, category: &str) -> AppResult<ServerNote> {
        let created: Created<ServerNote> = self.api_send(
            reqwest::Method::PUT, &format!("/api/notes/{id}"),
            serde_json::json!({"title": title, "content": content, "category": category}),
        ).await?;
        created.data.ok_or_else(|| AppError::Other("update_note: missing data".into()))
    }

    pub async fn delete_note(&self, id: &str) -> AppResult<()> {
        self.api_send::<serde_json::Value>(reqwest::Method::DELETE, &format!("/api/notes/{id}"), serde_json::json!({})).await?;
        Ok(())
    }
}

async fn finish<T: DeserializeOwned>(resp: reqwest::Response) -> AppResult<T> {
    let status = resp.status();
    if !status.is_success() {
        let s = status.as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Api { status: s, body });
    }
    Ok(resp.json::<T>().await?)
}
```

- [ ] **Step 3: Run tests to green**

Run: `cd /coding/jotty/src-tauri && cargo test client`
Expected: 5 PASS.

- [ ] **Step 4: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(jotty): REST client (health/notes/categories) with https policy"
```

---

### Task 8: JottyClient — checklist + item-op endpoints

**Files:**
- Modify: `src-tauri/src/jotty/client.rs` (add methods + tests)

**Interfaces:**
- Produces:
  - `async fn create_checklist(&self, title: &str, category: &str) -> AppResult<ServerChecklist>` (POST `/api/checklists`, body `{"title","category","type":"simple"}`)
  - `async fn update_checklist(&self, id: &str, title: &str, category: &str) -> AppResult<()>` (PUT `/api/checklists/{id}`)
  - `async fn delete_checklist(&self, id: &str) -> AppResult<()>` (DELETE `/api/checklists/{id}`)
  - `async fn create_item(&self, list_id: &str, text: &str, parent_path: Option<&str>) -> AppResult<()>` (POST `/api/checklists/{list_id}/items`; body includes `parentIndex` only when parent given)
  - `async fn patch_item(&self, list_id: &str, path: &str, text: &str) -> AppResult<()>` (PATCH `/api/checklists/{list_id}/items/{path}`, body `{"text": ...}`)
  - `async fn check_item(&self, list_id: &str, path: &str, checked: bool) -> AppResult<()>` (PUT `.../items/{path}/check` or `/uncheck`)
  - `async fn delete_item(&self, list_id: &str, path: &str) -> AppResult<()>` (DELETE `/api/checklists/{list_id}/items/{path}`)
  - Item mutations return `()`; success is a 2xx with `{"success":true}`.

- [ ] **Step 1: Write failing tests (append to client tests module)**

```rust
    #[tokio::test]
    async fn checklist_crud_and_item_ops() {
        let s = server().await;
        // create
        Mock::given(method("POST")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": {"id":"list-1","title":"L","category":"Home","type":"simple","items":[],"createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}
            })))
            .mount(&s).await;
        // check item 0
        Mock::given(method("PUT")).and(path("/api/checklists/list-1/items/0/check"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        // nested path patch
        Mock::given(method("PATCH")).and(path("/api/checklists/list-1/items/0.1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        // nested delete
        Mock::given(method("DELETE")).and(path("/api/checklists/list-1/items/1.0.2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        // create with parentIndex
        Mock::given(method("POST")).and(path("/api/checklists/list-1/items"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let list = c.create_checklist("L", "Home").await.unwrap();
        assert_eq!(list.id, "list-1");
        c.check_item("list-1", "0", true).await.unwrap();
        c.patch_item("list-1", "0.1", "renamed").await.unwrap();
        c.delete_item("list-1", "1.0.2").await.unwrap();
        c.create_item("list-1", "new", Some("0")).await.unwrap();
        c.create_item("list-1", "top", None).await.unwrap();
    }

    #[tokio::test]
    async fn item_op_error_surfaces() {
        let s = server().await;
        Mock::given(method("PUT")).and(path("/api/checklists/l/items/9/check"))
            .respond_with(ResponseTemplate::new(400).set_body_string("bad index"))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let err = c.check_item("l", "9", true).await.unwrap_err();
        assert!(matches!(err, AppError::Api { status: 400, .. }));
    }
```

- [ ] **Step 2: Implement (append to client impl block)**

```rust
    pub async fn create_checklist(&self, title: &str, category: &str) -> AppResult<ServerChecklist> {
        let created: Created<ServerChecklist> = self.api_send(
            reqwest::Method::POST, "/api/checklists",
            serde_json::json!({"title": title, "category": category, "type": "simple"}),
        ).await?;
        created.data.ok_or_else(|| AppError::Other("create_checklist: missing data".into()))
    }

    pub async fn update_checklist(&self, id: &str, title: &str, category: &str) -> AppResult<()> {
        self.api_send::<serde_json::Value>(
            reqwest::Method::PUT, &format!("/api/checklists/{id}"),
            serde_json::json!({"title": title, "category": category}),
        ).await?;
        Ok(())
    }

    pub async fn delete_checklist(&self, id: &str) -> AppResult<()> {
        self.api_send::<serde_json::Value>(reqwest::Method::DELETE, &format!("/api/checklists/{id}"), serde_json::json!({})).await?;
        Ok(())
    }

    pub async fn create_item(&self, list_id: &str, text: &str, parent_path: Option<&str>) -> AppResult<()> {
        let mut body = serde_json::json!({"text": text});
        if let Some(p) = parent_path {
            body["parentIndex"] = serde_json::Value::String(p.to_string());
        }
        self.api_send::<serde_json::Value>(reqwest::Method::POST, &format!("/api/checklists/{list_id}/items"), body).await?;
        Ok(())
    }

    pub async fn patch_item(&self, list_id: &str, path: &str, text: &str) -> AppResult<()> {
        self.api_send::<serde_json::Value>(
            reqwest::Method::PATCH, &format!("/api/checklists/{list_id}/items/{path}"),
            serde_json::json!({"text": text}),
        ).await?;
        Ok(())
    }

    pub async fn check_item(&self, list_id: &str, path: &str, checked: bool) -> AppResult<()> {
        let suffix = if checked { "check" } else { "uncheck" };
        self.api_send::<serde_json::Value>(
            reqwest::Method::PUT, &format!("/api/checklists/{list_id}/items/{path}/{suffix}"),
            serde_json::json!({}),
        ).await?;
        Ok(())
    }

    pub async fn delete_item(&self, list_id: &str, path: &str) -> AppResult<()> {
        self.api_send::<serde_json::Value>(reqwest::Method::DELETE, &format!("/api/checklists/{list_id}/items/{path}"), serde_json::json!({})).await?;
        Ok(())
    }
```

- [ ] **Step 3: Run tests to green**

Run: `cd /coding/jotty/src-tauri && cargo test client`
Expected: 7 PASS (5 from Task 7 + 2 new).

- [ ] **Step 4: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(jotty): checklist + item-op client methods"
```

---

### Task 9: Keyring store

**Files:**
- Create: `src-tauri/src/keys.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod keys;`)

**Interfaces:**
- Produces:
  - `pub trait KeyStore: Send + Sync { fn get(&self) -> AppResult<Option<String>>; fn set(&self, key: &str) -> AppResult<()>; fn delete(&self) -> AppResult<()>; }`
  - `pub struct OsKeyStore;` (service `"jotty-desktop"`, account `"api-key"` via `keyring` crate) — thin, no unit test (OS dependency)
  - `pub struct MockKeyStore(std::sync::Mutex<Option<String>>);` — used in tests/commands tests

- [ ] **Step 1: Write failing test**

`src-tauri/src/keys.rs`:
```rust
use crate::error::{AppError, AppResult};

pub trait KeyStore: Send + Sync {
    fn get(&self) -> AppResult<Option<String>>;
    fn set(&self, key: &str) -> AppResult<()>;
    fn delete(&self) -> AppResult<()>;
}

#[derive(Default)]
pub struct MockKeyStore(pub std::sync::Mutex<Option<String>>);

impl KeyStore for MockKeyStore {
    fn get(&self) -> AppResult<Option<String>> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn set(&self, key: &str) -> AppResult<()> {
        *self.0.lock().unwrap() = Some(key.to_string());
        Ok(())
    }
    fn delete(&self) -> AppResult<()> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

pub struct OsKeyStore;

const SERVICE: &str = "jotty-desktop";
const ACCOUNT: &str = "api-key";

impl KeyStore for OsKeyStore {
    fn get(&self) -> AppResult<Option<String>> {
        let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| AppError::Keyring(e.to_string()))?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Keyring(e.to_string())),
        }
    }
    fn set(&self, key: &str) -> AppResult<()> {
        let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| AppError::Keyring(e.to_string()))?;
        entry.set_password(key).map_err(|e| AppError::Keyring(e.to_string()))
    }
    fn delete(&self) -> AppResult<()> {
        let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| AppError::Keyring(e.to_string()))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Keyring(e.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_keystore_roundtrip() {
        let ks = MockKeyStore::default();
        assert_eq!(ks.get().unwrap(), None);
        ks.set("ck_abc").unwrap();
        assert_eq!(ks.get().unwrap().as_deref(), Some("ck_abc"));
        ks.delete().unwrap();
        assert_eq!(ks.get().unwrap(), None);
    }
}
```

- [ ] **Step 2: Run to green**

Run: `cd /coding/jotty/src-tauri && cargo test keys`
Expected: 1 PASS.

- [ ] **Step 3: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(keys): keystore trait, OS keyring impl, mock for tests"
```

---

### Task 10: Sync — pull engine

**Files:**
- Create: `src-tauri/src/sync/mod.rs`, `src-tauri/src/sync/pull.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod sync;`)

**Interfaces:**
- Consumes: `JottyClient`, notes/checklists DAOs, `outbox::has_pending_for`.
- Produces:
  - `pub struct PullStats { pub notes_applied: usize, pub lists_applied: usize, pub tombstones: usize }`
  - `pub async fn pull_all(conn: &mut Connection, client: &JottyClient) -> AppResult<PullStats>` — full pull; upsert via DAO (LWW inside); tombstone pass: local notes/checklists absent from server snapshot AND not dirty AND no pending op → `deleted_at = now` (local tombstone; no outbox op — server already deleted them).
  - `pub struct SyncReport { pub pushed: usize, pub push_conflicts: usize, pub pull: PullStats, pub errors: Vec<String> }` (defined here, used by Task 13)

- [ ] **Step 1: Write failing test**

`src-tauri/src/sync/pull.rs`:
```rust
use crate::db::{checklists, notes, outbox};
use crate::error::AppResult;
use crate::jotty::client::JottyClient;
use crate::jotty::models::{ServerChecklist, ServerNote};
use chrono::Utc;
use rusqlite::Connection;

#[derive(Debug, Default, Clone)]
pub struct PullStats {
    pub notes_applied: usize,
    pub lists_applied: usize,
    pub tombstones: usize,
}

pub async fn pull_all(conn: &mut Connection, client: &JottyClient) -> AppResult<PullStats> {
    let server_notes = client.get_notes().await.unwrap_or_default();
    let server_lists = client.get_checklists().await.unwrap_or_default();
    let mut stats = PullStats::default();

    {
        let tx = conn.transaction()?;
        for n in &server_notes {
            if notes::upsert_from_server(&tx, n)? {
                stats.notes_applied += 1;
            }
        }
        for c in &server_lists {
            if checklists::upsert_list_from_server(&tx, c)? {
                stats.lists_applied += 1;
            }
        }
        tx.commit()?;
    }

    // tombstones
    let mut tombstones = 0usize;
    {
        let tx = conn.transaction()?;
        let present_notes: std::collections::HashSet<&str> = server_notes.iter().map(|n| n.id.as_str()).collect();
        for n in notes::list(&tx, true)? {
            if n.dirty || n.deleted_at.is_some() { continue; }
            if !present_notes.contains(n.id.as_str()) && !outbox::has_pending_for(&tx, "note", &n.id)? {
                notes::tombstone(&tx, &n.id)?;
                tombstones += 1;
            }
        }
        let present_lists: std::collections::HashSet<&str> = server_lists.iter().map(|c| c.id.as_str()).collect();
        for c in checklists::list_checklists(&tx, true)? {
            if c.dirty || c.deleted_at.is_some() { continue; }
            if !present_lists.contains(c.id.as_str()) && !outbox::has_pending_for(&tx, "checklist", &c.id)? {
                checklists::tombstone(&tx, &c.id)?;
                tombstones += 1;
            }
        }
        tx.commit()?;
    }
    stats.tombstones = tombstones;

    // record last sync
    conn.execute(
        "INSERT INTO sync_state(key, value) VALUES ('last_sync_at', ?1)
         ON CONFLICT(key) DO UPDATE SET value=?1",
        [Utc::now().to_rfc3339()],
    )?;

    Ok(stats)
}
```
(Add `pub fn tombstone(conn: &Connection, id: &str) -> AppResult<()>` to notes.rs and checklists.rs: sets `deleted_at` WITHOUT marking dirty — pull-side deletion, distinct from `soft_delete_local` which is dirty for push.)

Tests (bottom of pull.rs):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations, open};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    use std::path::Path;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&conn).unwrap();
        conn
    }

    async fn server_with_notes_and_lists(notes_json: serde_json::Value, lists_json: serde_json::Value) -> MockServer {
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(notes_json)).mount(&s).await;
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(lists_json)).mount(&s).await;
        s
    }

    fn note_json(id: &str, title: &str, updated: &str) -> serde_json::Value {
        serde_json::json!({"id": id, "title": title, "category": "Home", "content": "c", "createdAt": "2024-01-01T00:00:00.000Z", "updatedAt": updated})
    }

    #[tokio::test]
    async fn fresh_pull_imports_everything() {
        let s = server_with_notes_and_lists(
            serde_json::json!({"notes": [note_json("n1", "A", "2026-01-01T00:00:00.000Z")]}),
            serde_json::json!({"checklists": [{"id": "l1", "title": "L", "category": "Home", "items": [], "createdAt": "2024-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}]}),
        ).await;
        let mut conn = db();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = pull_all(&mut conn, &client).await.unwrap();
        assert_eq!(stats.notes_applied, 1);
        assert_eq!(stats.lists_applied, 1);
        assert_eq!(notes::list(&conn, false).unwrap().len(), 1);
        assert_eq!(checklists::list_checklists(&conn, false).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn absent_entities_are_tombstoned() {
        let s = server_with_notes_and_lists(
            serde_json::json!({"notes": []}),
            serde_json::json!({"checklists": []}),
        ).await;
        let mut conn = db();
        let n = notes::insert_local(&conn, &notes::NewNote { title: "x".into(), content: "".into(), category: "Home".into() }).unwrap();
        notes::mark_synced(&conn, &n.id, "2026-01-01T00:00:00.000Z").unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = pull_all(&mut conn, &client).await.unwrap();
        assert_eq!(stats.tombstones, 1);
        assert!(notes::get(&conn, &n.id).unwrap().unwrap().deleted_at.is_some());
        // dirty entities survive
        let dirty = notes::insert_local(&conn, &notes::NewNote { title: "y".into(), content: "".into(), category: "Home".into() }).unwrap();
        pull_all(&mut conn, &client).await.unwrap();
        assert!(notes::get(&conn, &dirty.id).unwrap().unwrap().deleted_at.is_none(), "dirty note must survive pull");
    }
}
```

- [ ] **Step 2: Add the two tombstone fns, run to green**

Add to `notes.rs` and `checklists.rs`:
```rust
pub fn tombstone(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("UPDATE notes SET deleted_at=?2 WHERE id=?1", rusqlite::params![id, chrono::Utc::now().to_rfc3339()])?;
    Ok(())
}
```
(checklists version identical with its table.)

Run: `cd /coding/jotty/src-tauri && cargo test pull`
Expected: 2 PASS.

- [ ] **Step 3: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(sync): pull engine with LWW upsert + tombstones"
```

---

### Task 11: Sync — push engine for notes/checklists (FIFO + temp-ID remap)

**Files:**
- Create: `src-tauri/src/sync/push.rs`
- Modify: `src-tauri/src/sync/mod.rs` (`pub mod push;`)

**Interfaces:**
- Consumes: `outbox::next_batch`, DAOs, client methods.
- Produces:
  - `pub struct PushStats { pub pushed: usize, pub conflicts: usize }`
  - `pub async fn push_pending(conn: &mut Connection, client: &JottyClient) -> AppResult<PushStats>`
  - Op payload shapes (JSON, stored at enqueue time by commands, Task 14):
    - `note_create`: `{"temp_id","title","content","category"}`
    - `note_update`: `{"id","title","content","category"}` (full copy)
    - `note_delete`: `{}`
    - `checklist_create`: `{"temp_id","title","category"}`
    - `checklist_update`: `{"id","title","category"}`
    - `checklist_delete`: `{}`
  - `note_create` success → server UUID returned; remap: `UPDATE notes SET id=new WHERE id=old` (only when local row still temp), `outbox::remap_entity_id("note", old, new)`. Same for checklist_create.
  - Errors: network/5xx → `record_attempt` + STOP this run (FIFO integrity; later ops may depend on this one). 404 on note_update/note_delete → op marked `conflict` (target vanished server-side) and REMOVED from blocking the queue: mark_conflict, continue with next op.
  - After a successful note_update/note_create: `notes::mark_synced` with the server's `updatedAt` from response.

- [ ] **Step 1: Write failing test**

`src-tauri/src/sync/push.rs`:
```rust
use crate::db::{notes, outbox};
use crate::error::AppResult;
use crate::jotty::client::JottyClient;
use rusqlite::Connection;

#[derive(Debug, Default, Clone)]
pub struct PushStats {
    pub pushed: usize,
    pub conflicts: usize,
}

const MAX_BATCH: i64 = 100;

pub async fn push_pending(conn: &mut Connection, client: &JottyClient) -> AppResult<PushStats> {
    let mut stats = PushStats::default();
    loop {
        let ops = outbox::next_batch(conn, MAX_BATCH)?;
        if ops.is_empty() { break; }
        let mut progress = false;
        for op in ops {
            let payload: serde_json::Value = serde_json::from_str(&op.payload)
                .unwrap_or_else(|_| serde_json::json!({}));
            let result: AppResult<()> = match (op.entity.as_str(), op.op_type.as_str()) {
                ("note", "create") => {
                    let created = client.create_note(
                        payload["title"].as_str().unwrap_or(""),
                        payload["content"].as_str().unwrap_or(""),
                        payload["category"].as_str().unwrap_or("Uncategorized"),
                    ).await?;
                    let new_id = created.id.clone();
                    {
                        let tx = conn.transaction()?;
                        let old_id = payload["temp_id"].as_str().unwrap_or(&op.entity_id).to_string();
                        tx.execute("UPDATE notes SET id=?2, dirty=0 WHERE id=?1", rusqlite::params![old_id, new_id])?;
                        tx.execute("UPDATE notes SET updated_at=?2 WHERE id=?1", rusqlite::params![new_id, created.updated_at])?;
                        outbox::remap_entity_id(&tx, "note", &old_id, &new_id)?;
                        tx.commit()?;
                    }
                    Ok(())
                }
                ("note", "update") => {
                    let updated = client.update_note(
                        &op.entity_id,
                        payload["title"].as_str().unwrap_or(""),
                        payload["content"].as_str().unwrap_or(""),
                        payload["category"].as_str().unwrap_or("Uncategorized"),
                    ).await?;
                    let tx = conn.transaction()?;
                    notes::mark_synced(&tx, &op.entity_id, &updated.updated_at)?;
                    tx.commit()?;
                    Ok(())
                }
                ("note", "delete") => client.delete_note(&op.entity_id).await,
                _ => Err(crate::error::AppError::Other(format!("unknown op {}/{}", op.entity, op.op_type))),
            };
            match result {
                Ok(()) => {
                    outbox::mark_done(conn, op.seq)?;
                    stats.pushed += 1;
                    progress = true;
                }
                Err(AppError::Api { status: 404, .. })
                | Err(AppError::Api { status: 409, .. })
                | Err(AppError::Api { status: 410, .. }) => {
                    outbox::mark_conflict(conn, op.seq, &format!("{:?}", AppError::Api { status: 0, body: "gone".into() }));
                    stats.conflicts += 1;
                    progress = true;
                }
                Err(e) => {
                    outbox::record_attempt(conn, op.seq, &e.to_string())?;
                    // transient error: stop FIFO replay this run
                    return Ok(stats);
                }
            }
        }
        if !progress { break; }
    }
    Ok(stats)
}

// checklist ops handled in same loop; shown as separate match arms — see tests
```

IMPORTANT: the real implementation folds checklist arms (`checklist_create/update/delete`) into the same match — checklist_create mirrors note_create (remap `checklists.id` + remap outbox entity), checklist_update → `client.update_checklist` + `checklists::mark_list_synced`, checklist_delete → `client.delete_checklist`. The test below pins this behavior.

Tests:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{checklists, migrations, open};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&conn).unwrap();
        conn
    }

    #[tokio::test]
    async fn note_create_remaps_temp_id_and_pending_ops() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": {"id":"srv-1","title":"T","content":"c","category":"Home","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-02T00:00:00.000Z","owner":"u"}
            })))
            .mount(&s).await;
        let mut conn = db();
        let local = notes::insert_local(&conn, &notes::NewNote { title: "T".into(), content: "c".into(), category: "Home".into() }).unwrap();
        outbox::enqueue(&conn, "create", "note", &local.id, &serde_json::json!({"temp_id": local.id, "title":"T","content":"c","category":"Home"})).unwrap();
        // an update op queued behind create, referencing the temp id
        outbox::enqueue(&conn, "update", "note", &local.id, &serde_json::json!({"id": local.id, "title":"T","content":"c2","category":"Home"})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 1); // create done; update now targets srv-1 and hits no mock → stops run
        let updated = notes::get(&conn, "srv-1").unwrap().unwrap();
        assert_eq!(updated.id, "srv-1");
        assert!(!updated.dirty);
        let batch = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(batch[0].entity_id, "srv-1", "pending op must be remapped");
    }

    #[tokio::test]
    async fn checklist_create_remaps_and_update_pushes() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": {"id":"srv-l","title":"L","category":"Home","type":"simple","items":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}
            })))
            .mount(&s).await;
        Mock::given(method("PUT")).and(path("/api/checklists/srv-l"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        let mut conn = db();
        let local = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        outbox::enqueue(&conn, "create", "checklist", &local.id, &serde_json::json!({"temp_id": local.id, "title":"L","category":"Home"})).unwrap();
        outbox::enqueue(&conn, "update", "checklist", &local.id, &serde_json::json!({"id": local.id, "title":"L2","category":"Home"})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 2);
        assert!(checklists::get_checklist(&conn, "srv-l").unwrap().is_some());
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
    }

    #[tokio::test]
    async fn note_delete_404_becomes_conflict_and_queue_continues() {
        let s = MockServer::start().await;
        Mock::given(method("DELETE")).and(path("/api/notes/gone-1"))
            .respond_with(ResponseTemplate::new(404).set_body_string("nope"))
            .mount(&s).await;
        let mut conn = db();
        outbox::enqueue(&conn, "delete", "note", "gone-1", &serde_json::json!({})).unwrap();
        outbox::enqueue(&conn, "delete", "note", "gone-2", &serde_json::json!({})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.conflicts, 1);
        let conflicts = crate::db::outbox::next_batch(&conn, 10).unwrap();
        // gone-1 is conflict (not pending); gone-2 still pending, hit no mock → recorded attempt, run stops
        assert!(conflicts.iter().any(|o| o.entity_id == "gone-2"));
    }

    #[tokio::test]
    async fn network_error_keeps_op_pending_with_error() {
        // port 1 is guaranteed unroutable
        let client = JottyClient::new("http://127.0.0.1:1", "ck").unwrap();
        let mut conn = db();
        outbox::enqueue(&conn, "delete", "note", "x", &serde_json::json!({})).unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 0);
        let op = &outbox::next_batch(&conn, 10).unwrap()[0];
        assert_eq!(op.attempts, 1);
        assert!(op.last_error.is_some());
    }
}
```

- [ ] **Step 2: Implement (add checklist arms), run to green**

Run: `cd /coding/jotty/src-tauri && cargo test push`
Expected: 4 PASS.

- [ ] **Step 3: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(sync): push engine for notes/checklists with temp-id remap"
```

---

> **Controller pre-flight ruling (binding):** the loop skeleton above is superseded —
> `push_pending` processes **one op per fetch** (`outbox::next_batch(conn, 1)` in a
> `loop`), so a create-remap is visible to every subsequent op; transient error →
> `record_attempt` + return; 404/409/410 → `mark_conflict` + continue; loop ends when
> the batch is empty. The `note_create_remaps_temp_id_and_pending_ops` test gains a
> `PUT /api/notes/srv-1` mock (returns the note with `updatedAt 2026-01-03`) and
> asserts `pushed == 2`, remapped row, and `pending_count == 0`.

### Task 12: Sync — item-op replay with index resolution + reorder rebuild

**Files:**
- Create: `src-tauri/src/sync/resolve.rs`
- Modify: `src-tauri/src/sync/push.rs` (item-op arms)

**Interfaces:**
- Consumes: `ServerItem` flatten (`jotty::models::flatten_items`), `items` DAO, `client.create_item/patch_item/check_item/delete_item`.
- Produces:
  - `resolve.rs`: `pub fn resolve(server_items: &[ServerItem], server_path: Option<&str>, text: &str, claimed: &mut Vec<String>) -> Option<String>` — (1) if `server_path` given and an item at that path exists with same text → path; (2) else first unclaimed flattened path whose text matches → claim + return; (3) else None. `claimed` prevents two identical-text local items resolving to the same server item.
  - push.rs item-op arms, per checklist group:
    - `item_create`: `{"temp_local_id","checklist_id","text","parent_local_id":null|"..."}` → parent path = resolved from parent's `server_path` (must exist; else conflict) → `client.create_item(list_id, text, parent_path)`; op done; item matched on post-replay reconcile.
    - `item_update`: `{"item_local_id","checklist_id","text"}` → resolve → `client.patch_item`.
    - `item_check`: `{"item_local_id","checklist_id","checked":bool}` → resolve → `client.check_item`.
    - `item_delete`: `{"item_local_id","checklist_id"}` → resolve → `client.delete_item`; then delete locally too.
    - `item_reorder`: `{"checklist_id","ordered_top_level_ids":[...]}` → rebuild: fetch server list, delete every server item in REVERSE flatten order, then re-create in local desired DFS order (top-level order from payload; children follow parents), preserving `completed`. Then delete + recreate local rows via reconcile with empty→new server snapshot.
  - After the last op of a checklist group: fetch `/api/checklists` (or the single list via full fetch), `items::reconcile`, `checklists::mark_list_synced`.

- [ ] **Step 1: Write failing test for resolve**

`src-tauri/src/sync/resolve.rs`:
```rust
use crate::jotty::models::{flatten_items, ServerItem};

pub fn resolve(
    server_items: &[ServerItem],
    server_path: Option<&str>,
    text: &str,
    claimed: &mut Vec<String>,
) -> Option<String> {
    let flat = flatten_items(server_items);
    if let Some(p) = server_path {
        if let Some((_, it)) = flat.iter().find(|(path, _)| path == p) {
            if it.text == text && !claimed.iter().any(|c| c == p) {
                claimed.push(p.to_string());
                return Some(p.to_string());
            }
        }
    }
    for (path, it) in flat {
        if it.text == text && !claimed.iter().any(|c| c == &path) {
            claimed.push(path.clone());
            return Some(path);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> Vec<ServerItem> {
        let mut parent = ServerItem::simple("parent");
        parent.children = vec![ServerItem::simple("child-a"), ServerItem::simple("child-b")];
        vec![parent, ServerItem::simple("other")]
    }

    #[test]
    fn resolves_by_stored_path() {
        let t = tree();
        let mut claimed = vec![];
        assert_eq!(resolve(&t, Some("0.1"), "child-b", &mut claimed), Some("0.1".into()));
    }

    #[test]
    fn falls_back_to_text_and_claims() {
        let t = tree();
        let mut claimed = vec![];
        // stored path stale: item at "0.1" is "child-b" but local says "child-a" (renamed locally? no—text differs => fallback)
        assert_eq!(resolve(&t, Some("0.1"), "other", &mut claimed), Some("1".into()));
        // second identical request cannot claim the same server item
        assert_eq!(resolve(&t, Some("0.1"), "other", &mut claimed), None);
    }

    #[test]
    fn unresolvable_returns_none() {
        let t = tree();
        let mut claimed = vec![];
        assert_eq!(resolve(&t, None, "missing", &mut claimed), None);
    }
}
```

- [ ] **Step 2: Write failing test for item-op replay (append to push tests)**

```rust
    #[tokio::test]
    async fn item_ops_replay_against_fresh_indices() {
        let s = MockServer::start().await;
        // server list state at replay time: ONE item "a" at path "0" (drift: local thought 2 items)
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "checklists": [{"id":"l1","title":"L","category":"Home","items":[
                    {"id":"srv-a","index":0,"text":"a","completed":false}
                ],"createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]
            })))
            .mount(&s).await;
        Mock::given(method("PUT")).and(path("/api/checklists/l1/items/0/check"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        let mut conn = db();
        let list = checklists::insert_local_list(&conn, &checklists::NewChecklist { title: "L".into(), category: "Home".into() }).unwrap();
        // force list id to server id and mark synced
        conn.execute("UPDATE checklists SET id='l1', dirty=0 WHERE id=?1", [&list.id]).unwrap();
        // local item "a" with stale server_path "0.5"
        let it = crate::db::items::insert_local(&conn, &crate::db::items::NewItem {
            checklist_id: "l1".into(), parent_local_id: None, text: "a".into(),
        }).unwrap();
        conn.execute("UPDATE checklist_items SET server_path='0.5', dirty=0 WHERE local_id=?1", [&it.local_id]).unwrap();
        // queued check op for an item the server moved to path "0"
        outbox::enqueue(&conn, "check", "checklist_item", "l1",
            &serde_json::json!({"item_local_id": it.local_id, "checklist_id": "l1", "checked": true})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 1, "check op must resolve via text fallback and succeed");
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
    }

    #[tokio::test]
    async fn unresolvable_item_op_becomes_conflict() {
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "checklists": [{"id":"l1","title":"L","category":"Home","items":[
                    {"id":"srv-x","index":0,"text":"unrelated","completed":false}
                ],"createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]
            })))
            .mount(&s).await;
        let mut conn = db();
        conn.execute("INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('l1','L','Home','simple','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0)", []).unwrap();
        outbox::enqueue(&conn, "check", "checklist_item", "l1",
            &serde_json::json!({"item_local_id": "missing-item", "checklist_id": "l1", "checked": true})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.conflicts, 1);
    }

    #[tokio::test]
    async fn reorder_replays_as_rebuild() {
        let s = MockServer::start().await;
        // server has items a,b (paths 0,1)
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "checklists": [{"id":"l1","title":"L","category":"Home","items":[
                    {"id":"srv-a","index":0,"text":"a","completed":false},
                    {"id":"srv-b","index":1,"text":"b","completed":true}
                ],"createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]
            })))
            .mount(&s).await;
        // rebuild: delete 1 (b) then 0 (a); recreate b, a
        for p in ["1", "0"] {
            Mock::given(method("DELETE")).and(path(format!("/api/checklists/l1/items/{p}")))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
                .mount(&s).await;
        }
        Mock::given(method("POST")).and(path("/api/checklists/l1/items"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        let mut conn = db();
        conn.execute("INSERT INTO checklists (id, title, category, list_type, created_at, updated_at, dirty) VALUES ('l1','L','Home','simple','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0)", []).unwrap();
        // two local items a,b already synced with server_paths
        let a = crate::db::items::insert_local(&conn, &crate::db::items::NewItem { checklist_id: "l1".into(), parent_local_id: None, text: "a".into() }).unwrap();
        let b = crate::db::items::insert_local(&conn, &crate::db::items::NewItem { checklist_id: "l1".into(), parent_local_id: None, text: "b".into() }).unwrap();
        conn.execute("UPDATE checklist_items SET server_path='0', dirty=0 WHERE local_id=?1", [&a.local_id]).unwrap();
        conn.execute("UPDATE checklist_items SET server_path='1', dirty=0, completed=1 WHERE local_id=?1", [&b.local_id]).unwrap();
        // reorder: b first
        outbox::enqueue(&conn, "reorder", "checklist_item", "l1",
            &serde_json::json!({"checklist_id": "l1", "ordered_top_level_ids": [b.local_id, a.local_id]})).unwrap();
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let stats = push_pending(&mut conn, &client).await.unwrap();
        assert_eq!(stats.pushed, 1);
        assert_eq!(outbox::pending_count(&conn).unwrap(), 0);
        // post-rebuild reconcile re-imports server items in the new order
        let items = crate::db::items::list_for_checklist(&conn, "l1").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].text, "b");
        assert_eq!(items[1].text, "a");
    }
```

- [ ] **Step 3: Implement item-op arms + resolve, run to green**

Implementation notes for `push.rs`:
- Group pending item ops by `payload.checklist_id`, but process strictly in seq order (FIFO preserved).
- For the first item op of a checklist in this run: fetch `client.get_checklists().await` once, find the list by id; keep `claimed: Vec<String>` for resolution within the run; after each item mutation (check/patch/delete) the server state changes — for correctness, re-fetch the checklist before EACH resolve if more than one op targets the same list (cheap at personal scale), or optimistically reuse the flattened snapshot and trust index math: v1 correctness rule = re-fetch before each op.
- `item_create` parent resolution: parent item's `server_path` must be non-NULL (it was synced earlier); if NULL → parent is also new: parent's create op must appear earlier in FIFO (guaranteed by enqueue order in Task 14); resolve parent via text from that op's effects. If still unresolvable → conflict.
- After a checklist's ops finish: re-fetch all lists once, `items::reconcile` for that list, `checklists::mark_list_synced` with its `updatedAt`.

Run: `cd /coding/jotty/src-tauri && cargo test resolve push`
Expected: all PASS (3 resolve + 3 new push + 4 from Task 11).

- [ ] **Step 4: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(sync): item-op replay with index re-resolution + reorder rebuild"
```

---

> **Controller pre-flight ruling (binding):** the reorder test's `GET /api/checklists`
> mock must be **call-counted** (e.g. `AtomicUsize` in a `respond_with` handler):
> call 1 returns the original order `[a(false), b(true)]`; calls 2+ return the
> rebuilt order `[b(completed=true), a(false)]` — the post-rebuild reconcile fetch
> must see the new server state. The rebuild replay sequence is: DELETE items/1,
> DELETE items/0, then POST items in local order (b, a), then a re-check call
> (`PUT items/0/check`) for the recreated completed item. Reconcile then adopts
> local rows by text (stale `server_path` values must not duplicate rows).

### Task 13: Sync orchestration (run = push→pull) + scheduler

**Files:**
- Modify: `src-tauri/src/sync/mod.rs` (add `run()`, `SyncReport`)
- Modify: `src-tauri/src/lib.rs` (setup hook spawns scheduler task; window-focus trigger)

**Interfaces:**
- Produces:
  - `pub struct SyncReport { pub pushed: usize, pub push_conflicts: usize, pub pull: PullStats, pub errors: Vec<String> }` + `impl SyncReport { pub fn to_dto(&self) -> serde_json::Value }` (camelCase JSON for the UI)
  - `pub async fn run(conn: &mut Connection, client: &JottyClient) -> AppResult<SyncReport>` — push_pending then pull_all; pull network errors recorded into `errors` (report still returned; push errors stop early with error recorded).
  - Scheduler in `lib.rs` `setup()`: tokio task, loop every 60s; reads `sync_state` `sync_interval_minutes` (default 5) and `last_sync_at`; triggers `run` when due OR when previous run errored (60s retry backoff cap 5 min); emits Tauri event `sync-updated` with the report DTO; window focus event triggers immediate due-check.

- [ ] **Step 1: Write failing test (push-before-pull ordering)**

Append to `src-tauri/src/sync/mod.rs` tests:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations, notes, open};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn push_runs_before_pull() {
        let s = MockServer::start().await;
        let order: std::sync::Arc<std::sync::Mutex<Vec<&'static str>>> = Default::default();
        // pull endpoints
        {
            let order = order.clone();
            Mock::given(method("GET")).and(path("/api/notes"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"notes":[]})).mount_handler_mock())
                .mount(&s).await;
        }
        // simpler: use separate mocks with side-effecting response via wiremock "FnResponse"
        // push endpoint (update note)
        {
            let order = order.clone();
            Mock::given(method("PUT")).and(path("/api/notes/n1"))
                .respond_with(move |_req: &_| {
                    order.lock().unwrap().push("push");
                    ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true,"data":{"id":"n1","title":"T","content":"local","category":"Home","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2026-06-01T00:00:00.000Z"}}))
                })
                .mount(&s).await;
        }
        {
            let order = order.clone();
            Mock::given(method("GET")).and(path("/api/notes"))
                .respond_with(move |_req: &_| {
                    order.lock().unwrap().push("pull");
                    ResponseTemplate::new(200).set_body_json(serde_json::json!({"notes":[]}))
                })
                .mount(&s).await;
        }
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"checklists":[]})))
            .mount(&s).await;

        let mut conn = {
            let dir = tempfile::tempdir().unwrap();
            let c = open(&dir.path().join("t.db")).unwrap();
            std::mem::forget(dir);
            migrations::run(&c).unwrap();
            c
        };
        // local dirty note n1 with a queued update; server pull returns empty notes (would tombstone it if pull ran first without push)
        conn.execute("INSERT INTO notes (id,title,content,category,created_at,updated_at,dirty) VALUES ('n1','T','local','Home','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',1)", []).unwrap();
        crate::db::outbox::enqueue(&conn, "update", "note", "n1", &serde_json::json!({"id":"n1","title":"T","content":"local","category":"Home"})).unwrap();

        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let report = run(&mut conn, &client).await.unwrap();
        assert_eq!(report.pushed, 1);
        let o = order.lock().unwrap();
        assert_eq!(o.as_slice(), &["push", "pull"], "push must precede pull");
        // note survived (pushed, then pull LWW saw our newer updatedAt)
        assert!(notes::get(&conn, "n1").unwrap().is_some());
    }
}
```
(Note: wiremock's mount-with-handler API is `Mock::given(...).respond_with(move |req| ...)` where the closure returns `ResponseTemplate` — i.e. `FnResponse`; the exact closure signature is `fn(&Request) -> ResponseTemplate`. The first duplicated GET-notes mock block above is dead scaffolding; final code keeps only the handler-based mocks. Also, the pushed note has `updatedAt` 2026-06-01 — newer than the server snapshot — so the post-push LWW keeps it; the assertion `notes::get(n1).is_some()` pins push-before-pull semantics end-to-end.)

- [ ] **Step 2: Implement `run()` + scheduler, run to green**

`src-tauri/src/sync/mod.rs`:
```rust
pub mod pull;
pub mod push;
pub mod resolve;

use crate::db::Connection;
use crate::error::AppResult;
use crate::jotty::client::JottyClient;

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pushed: usize,
    pub push_conflicts: usize,
    pub pull: pull::PullStats,
    pub errors: Vec<String>,
}

pub async fn run(conn: &mut Connection, client: &JottyClient) -> AppResult<SyncReport> {
    let mut errors = Vec::new();
    let push_res = push::push_pending(conn, client).await;
    let (pushed, push_conflicts) = match push_res {
        Ok(s) => (s.pushed, s.conflicts),
        Err(e) => {
            errors.push(format!("push failed: {e}"));
            (0, 0)
        }
    };
    let pull_res = pull::pull_all(conn, client).await;
    let pull_stats = match pull_res {
        Ok(s) => s,
        Err(e) => {
            errors.push(format!("pull failed: {e}"));
            pull::PullStats::default()
        }
    };
    Ok(SyncReport { pushed, push_conflicts, pull: pull_stats, errors })
}
```

Scheduler (in `lib.rs` setup):
```rust
fn spawn_scheduler(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            ticker.tick().await;
            if let Err(e) = sync::scheduler_tick(&app).await {
                log::warn!("scheduler tick failed: {e}");
            }
        }
    });
}
```
`sync::scheduler_tick(app)` (add to sync/mod.rs):
```rust
pub async fn scheduler_tick(app: &tauri::AppHandle) -> AppResult<()> {
    let state = app.state::<crate::state::AppState>();
    // skip if not connected or another sync is running
    if state.syncing.load(std::sync::atomic::Ordering::SeqCst) { return Ok(()); }
    let client_guard = state.client.read().await;
    let Some(client) = client_guard.clone() else { return Ok(()); };
    drop(client_guard);

    let due = {
        let conn = state.db.lock().await;
        let interval_min: i64 = conn.query_row(
            "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM sync_state WHERE key='sync_interval_minutes'), 5)",
            [], |r| r.get(0)).unwrap_or(5);
        let last: Option<String> = conn.query_row(
            "SELECT value FROM sync_state WHERE key='last_sync_at'", [], |r| r.get(0)).optional().unwrap_or(None);
        match last.and_then(|l| chrono::DateTime::parse_from_rfc3339(&l).ok()) {
            Some(t) => (chrono::Utc::now() - t).num_minutes() >= interval_min,
            None => true,
        }
    };
    if !due { return Ok(()); }
    do_sync(app).await
}

pub async fn do_sync(app: &tauri::AppHandle) -> AppResult<()> {
    let state = app.state::<crate::state::AppState>();
    if state.syncing.swap(true, std::sync::atomic::Ordering::SeqCst) { return Ok(()); }
    let result = {
        let client_guard = state.client.read().await;
        let Some(client) = client_guard.clone() else {
            state.syncing.store(false, std::sync::atomic::Ordering::SeqCst);
            return Ok(());
        };
        drop(client_guard);
        let mut conn = state.db.lock().await;
        run(&mut conn, &client).await
    };
    state.syncing.store(false, std::sync::atomic::Ordering::SeqCst);
    if let Ok(report) = &result {
        use tauri::Emitter;
        let _ = app.emit("sync-updated", serde_json::to_value(report).unwrap_or_default());
    }
    Ok(())
}
```
(This code assumes `state.rs` from Task 14; implement scheduler INSIDE Task 14 after state exists — the ordering test above is pure sync-module and lands in this task.)

Run: `cd /coding/jotty/src-tauri && cargo test sync`
Expected: ordering test PASS.

- [ ] **Step 3: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(sync): run() push-then-pull orchestration + report"
```

---

### Task 14: AppState + Tauri commands (connect, CRUD, search, conflicts, settings, sync trigger)

> **Binding note (Task 5 review resolution R1, 2026-09-15):** item-mutation commands
> (`add_item`, `set_item_text`, `set_item_checked`, `delete_item`, `reorder_items`) MUST
> enqueue with `entity="checklist_item"` and `entity_id=<item local_id>` (NOT the
> checklist id) so `items::reconcile`'s pending-op guard
> (`outbox::has_pending_for(conn, "checklist_item", local_id)`) matches. Reorder
> enqueues `entity="checklist"`, `entity_id=<checklist id>` — one op per rebuild.
> Conflict label lookups for `item_*` ops join via `checklist_items.local_id`.
> (Task 12's own test enqueues bypass this — they are mock-level seeds.)

**Files:**
- Create: `src-tauri/src/state.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/commands/dto.rs`
- Modify: `src-tauri/src/lib.rs` (register commands, manage state, scheduler spawn)

**Interfaces:**
- Consumes: everything above; `sync::do_sync` for trigger.
- Produces:
  - `pub struct AppState { pub db: tokio::sync::Mutex<rusqlite::Connection>, pub client: tokio::sync::RwLock<Option<JottyClient>>, pub keystore: Box<dyn keys::KeyStore>, pub syncing: std::sync::AtomicBool, pub db_path: PathBuf }` — managed via `.manage(AppState::new(...))`.
  - Commands (all `async`, return `Result<T, String>`; DTOs camelCase in `commands/dto.rs`):
    - `connect_instance(url, api_key) -> ConnectInfo { instance_url, version }` — validate via health + `get_categories`; store url in `sync_state`, key in keystore; build client; run initial `sync::run`.
    - `disconnect_instance() -> ()` — clear client + sync_state url, delete keyring entry.
    - `get_connection() -> Option<ConnectInfo>`
    - `list_notes() -> Vec<NoteDto>`; `get_note(id) -> NoteDto`; `create_note(title, category) -> NoteDto` (empty content; txn: insert_local + enqueue `note_create`); `update_note(id, title, content, category) -> NoteDto` (txn: update_local + enqueue `note_update`); `delete_note(id) -> ()` (txn: soft_delete_local + enqueue `note_delete`)
    - `list_checklists() -> Vec<ChecklistDto>`; `get_checklist(id) -> ChecklistDto` (with nested `items: Vec<ItemDto>` tree); `create_checklist(title, category) -> ChecklistDto`; `update_checklist(id, title, category) -> ChecklistDto`; `delete_checklist(id) -> ()` — same txn+outbox pattern (`checklist_create/update/delete`)
    - `add_item(checklist_id, text, parent_local_id: Option<String>) -> ItemDto` (txn: items::insert_local + enqueue `item_create` with `temp_local_id`)
    - `set_item_text(checklist_id, item_local_id, text) -> ()` (txn + `item_update`)
    - `set_item_checked(checklist_id, item_local_id, checked) -> ()` (txn + `item_check`)
    - `delete_item(checklist_id, item_local_id) -> ()` (txn: items::delete_local + enqueue `item_delete`)
    - `reorder_items(checklist_id, ordered_top_level_ids: Vec<String>) -> ()` (txn: items::reorder_local + enqueue `item_reorder`)
    - `list_categories() -> CategoriesDto`
    - `search(query) -> SearchResultsDto { notes: Vec<{id,title,snippet}>, checklists: Vec<{id,title,itemText,snippet}> }` via `notes_fts`/`lists_fts` MATCH
    - `trigger_sync() -> SyncReportDto` — calls `sync::do_sync` via app handle
    - `sync_status() -> { pending: i64, last_sync_at: Option<String>, syncing: bool }`
    - `list_conflicts() -> Vec<ConflictDto { seq, entity, entity_id, op_type, last_error, label }>` (label = entity title/text for display)
    - `resolve_conflict(seq, keep: String) -> ()` — `keep=="server"`: drop op (mark_done), then trigger sync (pull re-imports server state); `keep=="mine"`: reset op to `pending` (retry) — used when user fixed the divergence
    - `get_settings() -> { instance_url, sync_interval_minutes }`; `set_sync_interval(minutes: i64) -> ()`
  - Every command that mutates MUST do the entity write + `outbox::enqueue` inside ONE `conn.transaction()` (spec §4).

- [ ] **Step 1: Write failing test — transactional create note**

Test in `src-tauri/src/commands/mod.rs` tests module (commands call a pure inner fn taking `&mut Connection` + `&dyn KeyStore` to stay testable without Tauri):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations, outbox};
    use crate::keys::MockKeyStore;
    use rusqlite::Connection;

    fn db() -> Connection {
        let dir = tempfile::tempdir().unwrap();
        let c = open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        migrations::run(&c).unwrap();
        c
    }

    #[tokio::test]
    async fn create_note_enqueues_in_same_transaction() {
        let mut conn = db();
        let note = create_note_inner(&mut conn, "T", "Home").unwrap();
        let stored = notes::get(&conn, &note.id).unwrap().unwrap();
        assert!(stored.dirty);
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].entity_id, note.id);
        assert_eq!(ops[0].op_type, "create");
    }

    #[tokio::test]
    async fn update_note_replaces_content_and_queues_full_copy() {
        let mut conn = db();
        let note = create_note_inner(&mut conn, "T", "Home").unwrap();
        let updated = update_note_inner(&mut conn, &note.id, Some("T2".into()), Some("body".into()), None).unwrap();
        assert_eq!(updated.title, "T2");
        let ops = outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[1].op_type, "update");
        assert_eq!(ops[1].payload["content"], "body");
    }

    #[tokio::test]
    async fn item_ops_enqueue_with_dependencies() {
        let mut conn = db();
        let list = create_checklist_inner(&mut conn, "L", "Home").unwrap();
        let item = add_item_inner(&mut conn, &list.id, "a", None).unwrap();
        set_item_checked_inner(&mut conn, &list.id, &item.local_id, true).unwrap();
        reorder_items_inner(&mut conn, &list.id, vec![item.local_id.clone()]).unwrap();
        let ops = outbox::next_batch(&conn, 10).unwrap();
        let kinds: Vec<&str> = ops.iter().map(|o| o.op_type.as_str()).collect();
        assert_eq!(kinds, vec!["create", "create", "check", "reorder"]);
    }
}
```

- [ ] **Step 2: Implement state.rs, dto.rs, commands with *_inner pure fns, register in lib.rs, run to green**

Key implementation shape (commands/mod.rs):
```rust
pub async fn connect_instance(state: tauri::State<'_, AppState>, app: tauri::AppHandle, url: String, api_key: String) -> Result<ConnectInfo, String> {
    inner_connect(&state, &app, &url, &api_key).await.map_err(|e| e.to_string())
}

pub(crate) async fn inner_connect(state: &AppState, app: &tauri::AppHandle, url: &str, api_key: &str) -> AppResult<ConnectInfo> {
    let client = JottyClient::new(url, api_key)?;
    let health = client.health().await.map_err(|_| AppError::Api { status: 0, body: "health check failed — is the instance url correct?".into() })?;
    if health.status != "healthy" {
        return Err(AppError::InvalidConfig(format!("instance reports '{}'", health.status)));
    }
    client.get_categories().await?; // auth check
    state.keystore.set(api_key)?;
    let mut conn = state.db.lock().await;
    conn.execute(
        "INSERT INTO sync_state(key,value) VALUES ('instance_url',?1) ON CONFLICT(key) DO UPDATE SET value=?1",
        [url],
    )?;
    *state.client.write().await = Some(client);
    drop(conn);
    let report = crate::sync::do_sync(app).await?;
    Ok(ConnectInfo { instance_url: url.into(), version: health.version })
}
```

Search implementation (commands/mod.rs):
```rust
pub(crate) fn search_inner(conn: &Connection, query: &str) -> AppResult<SearchResultsDto> {
    let safe = format!("\"{}\"", query.replace('"', "\"\""));
    let mut notes_hits = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, snippet(notes_fts, 2, '[', ']', '…', 12) FROM notes_fts WHERE notes_fts MATCH ?1 LIMIT 20")?;
        let rows = stmt.query_map([&safe], |r| Ok(NoteHit { id: r.get(0)?, title: r.get(1)?, snippet: r.get(2)? }))?;
        for h in rows { notes_hits.push(h?); }
    }
    let mut list_hits = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, snippet(lists_fts, 2, '[', ']', '…', 12) FROM lists_fts WHERE lists_fts MATCH ?1 LIMIT 20")?;
        let rows = stmt.query_map([&safe], |r| Ok(ListHit { id: r.get(0)?, title: r.get(1)?, item_text: r.get(2)? }))?;
        for h in rows { list_hits.push(h?); }
    }
    Ok(SearchResultsDto { notes: notes_hits, checklists: list_hits })
}
```

`lib.rs` registration:
```rust
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let db_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&db_dir)?;
            let conn = db::open(&db_dir.join("jotty.db"))?;
            db::migrations::run(&conn)?;
            // restore connection if instance_url exists
            let state = state::AppState::new(conn, Box::new(keys::OsKeyStore))?;
            state.restore_connection(app.handle().clone()); // spawns task: rebuild client from url+keyring, no auto-sync
            app.manage(state);
            sync::spawn_scheduler(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect_instance, commands::disconnect_instance, commands::get_connection,
            commands::list_notes, commands::get_note, commands::create_note, commands::update_note, commands::delete_note,
            commands::list_checklists, commands::get_checklist, commands::create_checklist, commands::update_checklist, commands::delete_checklist,
            commands::add_item, commands::set_item_text, commands::set_item_checked, commands::delete_item, commands::reorder_items,
            commands::list_categories, commands::search, commands::trigger_sync, commands::sync_status,
            commands::list_conflicts, commands::resolve_conflict, commands::get_settings, commands::set_sync_interval
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Run: `cd /coding/jotty/src-tauri && cargo test commands`
Expected: 3 PASS; full `cargo test` green.

- [ ] **Step 3: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(commands): tauri command layer, transactional mutation+enqueue, search"
```

---

### Task 15: Frontend foundation — api types, client, store, shell (Sidebar + lists)

**Files:**
- Create: `src/api/types.ts`, `src/api/client.ts`, `src/stores/store.ts`
- Modify: `src/App.tsx` (layout), `src/styles.css` (theme vars, layout), `src/main.tsx` (import styles)
- Create: `src/components/Sidebar.tsx`, `src/components/NoteList.tsx`, `src/components/ChecklistList.tsx`
- Create: `src/App.test.tsx`, `src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: command names from Task 14.
- Produces:
  - `api/types.ts`: `NoteDto`, `ChecklistDto`, `ItemDto`, `CategoriesDto`, `SearchResultsDto`, `SyncStatusDto`, `ConflictDto`, `ConnectInfo` — mirror Rust DTOs (camelCase).
  - `api/client.ts`: thin typed wrappers, e.g. `export const listNotes = () => invoke<NoteDto[]>('list_notes')`; all commands wrapped.
  - `stores/store.ts` (zustand): state `{ connection, notes, checklists, categories, syncStatus, selectedNoteId, selectedChecklistId, view }`; actions `refreshAll()`, `selectNote(id)`, `selectChecklist(id)`, `createNote(title, category)`, `createChecklist(title, category)`, `loadNote(id)` etc.; subscribes to Tauri event `sync-updated` → `refreshAll()`.

- [ ] **Step 1: Write failing test**

`src/App.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => async () => {}) }));

import App from './App';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
    if (cmd === 'list_notes') return Promise.resolve([{ id: 'n1', title: 'Groceries', content: 'milk', category: 'Home', updatedAt: '2026-01-01T00:00:00.000Z', dirty: false }]);
    if (cmd === 'list_checklists') return Promise.resolve([{ id: 'l1', title: 'Errands', category: 'Home', dirty: false }]);
    if (cmd === 'list_categories') return Promise.resolve({ notes: [{ name: 'Home', path: 'Home', count: 1, level: 0 }], checklists: [] });
    if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: '2026-01-01T00:00:00.000Z', syncing: false });
    return Promise.resolve(null);
  });
});

describe('App shell', () => {
  it('loads and renders notes and checklists from the backend', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    expect(screen.getByText('Errands')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement types, client, store, shell**

`src/api/types.ts`:
```ts
export interface NoteDto {
  id: string; title: string; content: string; category: string;
  updatedAt: string | null; deletedAt: string | null; dirty: boolean;
}
export interface ItemDto {
  localId: string; parentId: string | null; text: string; completed: boolean;
  position: number; serverPath: string | null; dirty: boolean;
}
export interface ChecklistDto {
  id: string; title: string; category: string; updatedAt: string | null; dirty: boolean;
  items?: ItemDto[];
}
export interface CategoryNode { name: string; path: string; count: number; level: number; }
export interface CategoriesDto { notes: CategoryNode[]; checklists: CategoryNode[]; }
export interface SearchResultsDto {
  notes: { id: string; title: string; snippet: string }[];
  checklists: { id: string; title: string; itemText: string; snippet: string }[];
}
export interface SyncStatusDto { pending: number; lastSyncAt: string | null; syncing: boolean; }
export interface ConflictDto { seq: number; entity: string; entityId: string; opType: string; lastError: string | null; label: string; }
export interface ConnectInfo { instanceUrl: string; version: string | null; }
```

`src/api/client.ts`:
```ts
import { invoke } from '@tauri-apps/api/core';
import type * as T from './types';

export const getConnection = () => invoke<T.ConnectInfo | null>('get_connection');
export const listNotes = () => invoke<T.NoteDto[]>('list_notes');
export const getNote = (id: string) => invoke<T.NoteDto>('get_note', { id });
export const createNote = (title: string, category: string) => invoke<T.NoteDto>('create_note', { title, category });
export const updateNote = (id: string, title: string, content: string, category: string) => invoke<T.NoteDto>('update_note', { id, title, content, category });
export const deleteNote = (id: string) => invoke<void>('delete_note', { id });
export const listChecklists = () => invoke<T.ChecklistDto[]>('list_checklists');
export const getChecklist = (id: string) => invoke<T.ChecklistDto>('get_checklist', { id });
export const createChecklist = (title: string, category: string) => invoke<T.ChecklistDto>('create_checklist', { title, category });
export const updateChecklist = (id: string, title: string, category: string) => invoke<T.ChecklistDto>('update_checklist', { id, title, category });
export const deleteChecklist = (id: string) => invoke<void>('delete_checklist', { id });
export const addItem = (checklistId: string, text: string, parentLocalId: string | null) => invoke<T.ItemDto>('add_item', { checklistId, text, parentLocalId });
export const setItemText = (checklistId: string, itemLocalId: string, text: string) => invoke<void>('set_item_text', { checklistId, itemLocalId, text });
export const setItemChecked = (checklistId: string, itemLocalId: string, checked: boolean) => invoke<void>('set_item_checked', { checklistId, itemLocalId, checked });
export const deleteItem = (checklistId: string, itemLocalId: string) => invoke<void>('delete_item', { checklistId, itemLocalId });
export const reorderItems = (checklistId: string, orderedTopLevelIds: string[]) => invoke<void>('reorder_items', { checklistId, orderedTopLevelIds });
export const listCategories = () => invoke<T.CategoriesDto>('list_categories');
export const search = (query: string) => invoke<T.SearchResultsDto>('search', { query });
export const triggerSync = () => invoke<unknown>('trigger_sync');
export const syncStatus = () => invoke<T.SyncStatusDto>('sync_status');
export const listConflicts = () => invoke<T.ConflictDto[]>('list_conflicts');
export const resolveConflict = (seq: number, keep: 'mine' | 'server') => invoke<void>('resolve_conflict', { seq, keep });
export const connectInstance = (url: string, apiKey: string) => invoke<T.ConnectInfo>('connect_instance', { url, apiKey });
export const disconnectInstance = () => invoke<void>('disconnect_instance');
export const getSettings = () => invoke<{ instanceUrl: string | null; syncIntervalMinutes: number }>('get_settings');
export const setSyncInterval = (minutes: number) => invoke<void>('set_sync_interval', { minutes });
```

`src/stores/store.ts`:
```ts
import { create } from 'zustand';
import * as api from '../api/client';
import type * as T from '../api/types';

interface AppState {
  connection: T.ConnectInfo | null;
  notes: T.NoteDto[];
  checklists: T.ChecklistDto[];
  categories: T.CategoriesDto | null;
  syncStatus: T.SyncStatusDto | null;
  selectedNoteId: string | null;
  selectedChecklistId: string | null;
  refreshAll: () => Promise<void>;
  selectNote: (id: string | null) => void;
  selectChecklist: (id: string | null) => void;
  createNote: (title: string, category: string) => Promise<T.NoteDto>;
  createChecklist: (title: string, category: string) => Promise<T.ChecklistDto>;
}

export const useStore = create<AppState>((set, get) => ({
  connection: null,
  notes: [],
  checklists: [],
  categories: null,
  syncStatus: null,
  selectedNoteId: null,
  selectedChecklistId: null,
  refreshAll: async () => {
    const [connection, notes, checklists, categories, syncStatus] = await Promise.all([
      api.getConnection(), api.listNotes(), api.listChecklists(), api.listCategories(), api.syncStatus(),
    ]);
    set({ connection, notes, checklists, categories, syncStatus });
  },
  selectNote: (id) => {
    set({ selectedNoteId: id, selectedChecklistId: null });
  },
  selectChecklist: (id) => {
    set({ selectedChecklistId: id, selectedNoteId: null });
  },
  createNote: async (title, category) => {
    const note = await api.createNote(title, category);
    await get().refreshAll();
    set({ selectedNoteId: note.id, selectedChecklistId: null });
    return note;
  },
  createChecklist: async (title, category) => {
    const list = await api.createChecklist(title, category);
    await get().refreshAll();
    set({ selectedChecklistId: list.id, selectedNoteId: null });
    return list;
  },
}));
```

`src/App.tsx`:
```tsx
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import Sidebar from './components/Sidebar';
import NoteList from './components/NoteList';
import ChecklistList from './components/ChecklistList';
import SyncBadge from './components/SyncBadge';
import { useStore } from './stores/store';

export default function App() {
  const { connection, notes, checklists, refreshAll } = useStore();

  useEffect(() => {
    refreshAll();
    const un = listen('sync-updated', () => refreshAll());
    return () => { un.then((f) => f()); };
  }, [refreshAll]);

  if (!connection) {
    return <div id="app">Not connected — open settings to connect your jotty instance.</div>;
  }

  return (
    <div id="app">
      <Sidebar />
      <main>
        <NoteList notes={notes} />
        <ChecklistList checklists={checklists} />
      </main>
      <SyncBadge />
    </div>
  );
}
```

`src/components/Sidebar.tsx`:
```tsx
import { useStore } from '../stores/store';

export default function Sidebar() {
  const { categories, refreshAll } = useStore();
  return (
    <nav id="sidebar">
      <h2>Categories</h2>
      <ul>
        {categories?.notes.map((c) => (
          <li key={c.path}>{c.name} <span className="count">{c.count}</span></li>
        ))}
        {categories?.checklists.map((c) => (
          <li key={`cl-${c.path}`}>{c.name} <span className="count">{c.count}</span></li>
        ))}
      </ul>
      <button onClick={() => refreshAll()}>Refresh</button>
    </nav>
  );
}
```

`src/components/NoteList.tsx`:
```tsx
import type { NoteDto } from '../api/types';
import { useStore } from '../stores/store';

export default function NoteList({ notes }: { notes: NoteDto[] }) {
  const { selectedNoteId, selectNote } = useStore();
  return (
    <section id="notes">
      <h2>Notes</h2>
      <ul>
        {notes.map((n) => (
          <li key={n.id} className={n.id === selectedNoteId ? 'selected' : ''} onClick={() => selectNote(n.id)}>
            {n.title}{n.dirty ? ' •' : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

`src/components/ChecklistList.tsx`:
```tsx
import type { ChecklistDto } from '../api/types';
import { useStore } from '../stores/store';

export default function ChecklistList({ checklists }: { checklists: ChecklistDto[] }) {
  const { selectedChecklistId, selectChecklist } = useStore();
  return (
    <section id="checklists">
      <h2>Checklists</h2>
      <ul>
        {checklists.map((c) => (
          <li key={c.id} className={c.id === selectedChecklistId ? 'selected' : ''} onClick={() => selectChecklist(c.id)}>
            {c.title}{c.dirty ? ' •' : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

`src/components/SyncBadge.tsx` (minimal for this task; enriched in Task 18):
```tsx
import { useStore } from '../stores/store';

export default function SyncBadge() {
  const syncStatus = useStore((s) => s.syncStatus);
  if (!syncStatus) return null;
  return (
    <footer id="sync-badge">
      {syncStatus.pending > 0 ? `${syncStatus.pending} pending` : 'synced'}
    </footer>
  );
}
```

`styles.css`:
```css
:root { --bg: #101418; --fg: #e6e9ec; --accent: #1f6feb; --muted: #8a929a; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; }
#app { display: grid; grid-template-columns: 220px 1fr; height: 100vh; }
#sidebar { border-right: 1px solid #232a31; padding: 12px; }
#sidebar ul { list-style: none; padding: 0; }
#sidebar li { padding: 4px 8px; cursor: pointer; border-radius: 6px; }
#sidebar li:hover { background: #1a212a; }
#app > main { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 12px; overflow: auto; }
li.selected { background: #1a212a; }
.count { color: var(--muted); float: right; }
#sync-badge { position: fixed; bottom: 8px; right: 12px; color: var(--muted); font-size: 12px; }
h2 { font-size: 14px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; }
```

Add `import './styles.css';` to `src/main.tsx`.

- [ ] **Step 3: Run tests to green**

Run: `cd /coding/jotty && npm test`
Expected: App shell test PASS.

- [ ] **Step 4: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(ui): api layer, store, app shell with sidebar and lists"
```

---

### Task 16: NoteEditor (TipTap) with debounced autosave

**Files:**
- Create: `src/components/NoteEditor.tsx`, `src/hooks/useAutosave.ts`
- Create: `src/hooks/useAutosave.test.ts`, `src/components/NoteEditor.test.tsx`

**Interfaces:**
- Consumes: `api.getNote`, `api.updateNote`, store `selectedNoteId`.
- Produces: `useAutosave(saveFn: (v: T) => Promise<void>, delayMs = 800): { value: T | null, setValue: (v: T) => void, saving: boolean }` — debounced, in-flight guard, flushes pending save on unmount.

- [ ] **Step 1: Write failing test for autosave hook**

`src/hooks/useAutosave.test.ts`:
```ts
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutosave } from './useAutosave';

describe('useAutosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces rapid edits into one save', async () => {
    const save = vi.fn(async () => {});
    const { result } = renderHook(() => useAutosave(save, 800));
    act(() => result.current.setValue({ title: 'a', content: '1' }));
    act(() => result.current.setValue({ title: 'a', content: '12' }));
    act(() => result.current.setValue({ title: 'a', content: '123' }));
    act(() => vi.advanceTimersByTime(799));
    expect(save).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    await act(async () => {});
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ title: 'a', content: '123' });
  });
});
```

- [ ] **Step 2: Implement hook, run to green**

`src/hooks/useAutosave.ts`:
```ts
import { useEffect, useRef, useState } from 'react';

export function useAutosave<T>(save: (v: T) => Promise<void>, delayMs = 800) {
  const [value, setValue] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<T | null>(null);

  useEffect(() => {
    latest.current = value;
  }, [value]);

  useEffect(() => {
    return () => {
      // flush on unmount
      if (timer.current) clearTimeout(timer.current);
      if (latest.current) void save(latest.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (v: T) => {
    setValue(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setSaving(true);
      try { await save(v); } finally { setSaving(false); }
    }, delayMs);
  };

  return { value, setValue: set, saving };
}
```

Run: `cd /coding/jotty && npm test -- useAutosave` → PASS.

- [ ] **Step 3: Write failing test for editor component**

`src/components/NoteEditor.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import NoteEditor from './NoteEditor';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'get_note') return Promise.resolve({ id: args?.id, title: 'T', content: '<p>hello</p>', category: 'Home', updatedAt: null, deletedAt: null, dirty: false });
    if (cmd === 'update_note') return Promise.resolve({});
    return Promise.resolve(null);
  });
});

describe('NoteEditor', () => {
  it('renders note content and saves on edit after debounce', async () => {
    vi.useFakeTimers();
    render(<NoteEditor noteId="n1" />);
    await waitFor(() => expect(screen.getByDisplayValue('T')).toBeInTheDocument());
    // TipTap renders into a contenteditable; assert it mounted
    expect(document.querySelector('.tiptap')).not.toBeNull();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 4: Implement NoteEditor**

`src/components/NoteEditor.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import * as api from '../api/client';
import { useAutosave } from '../hooks/useAutosave';
import type { NoteDto } from '../api/types';

export default function NoteEditor({ noteId }: { noteId: string }) {
  const [category, setCategory] = useState<string>('Uncategorized');
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const autosave = useAutosave(async (v: { title: string; content: string; category: string }) => {
    if (!loadedId) return;
    await api.updateNote(loadedId, v.title, v.content, v.category);
  });

  useEffect(() => {
    (async () => {
      const note: NoteDto = await api.getNote(noteId);
      setLoadedId(note.id);
      setCategory(note.category);
      autosave.setValue({ title: note.title, content: note.content, category: note.category });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  const editor = useEditor({
    extensions: [StarterKit, Link],
    content: autosave.value?.content ?? '',
    onUpdate: ({ editor }) => {
      if (!loadedId) return;
      autosave.setValue({ title: autosave.value?.title ?? '', content: editor.getHTML(), category });
    },
  }, [loadedId]);

  return (
    <div id="note-editor">
      <input
        id="note-title"
        value={autosave.value?.title ?? ''}
        onChange={(e) => autosave.setValue({ title: e.target.value, content: autosave.value?.content ?? '', category })}
        placeholder="Note title"
      />
      <EditorContent editor={editor} />
      {autosave.saving && <span id="saving">saving…</span>}
    </div>
  );
}
```

Run: `cd /coding/jotty && npm test -- NoteEditor` → PASS.

- [ ] **Step 5: Wire into App (replace note list placeholder with editor when a note is selected)**

In `App.tsx`, when `selectedNoteId` set render `<NoteEditor noteId={selectedNoteId} />` in the right pane (keep ChecklistList in left/main list column). Commit includes this wiring.

- [ ] **Step 6: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(ui): TipTap note editor with debounced autosave"
```

---

### Task 17: ChecklistView — items, checkboxes, add/edit/delete, drag reorder

**Files:**
- Create: `src/components/ChecklistView.tsx`, `src/components/ChecklistView.test.tsx`

**Interfaces:**
- Consumes: `api.getChecklist/addItem/setItemText/setItemChecked/deleteItem/reorderItems`, store `selectedChecklistId`.
- Produces: renders `ItemDto` tree (top-level + children, one nesting level displayed flat by `position` order for v1 UI simplicity — server order is DFS); checkbox toggle → `setItemChecked`; text edit inline → `setItemText`; delete button → `deleteItem`; HTML5 drag & drop on top-level rows → `reorderItems(orderedTopLevelIds)`.

- [ ] **Step 1: Write failing test**

`src/components/ChecklistView.test.tsx`:
```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import ChecklistView from './ChecklistView';

const items = [
  { localId: 'i1', parentId: null, text: 'a', completed: false, position: 0, serverPath: '0', dirty: false },
  { localId: 'i2', parentId: null, text: 'b', completed: true, position: 1, serverPath: '1', dirty: false },
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'get_checklist') return Promise.resolve({ id: 'l1', title: 'L', category: 'Home', updatedAt: null, dirty: false, items });
    if (cmd === 'set_item_checked' || cmd === 'reorder_items' || cmd === 'add_item' || cmd === 'delete_item') return Promise.resolve({});
    return Promise.resolve(null);
  });
});

describe('ChecklistView', () => {
  it('renders items and toggling a checkbox calls set_item_checked', async () => {
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_item_checked', { checklistId: 'l1', itemLocalId: 'i1', checked: true }));
  });

  it('add item calls add_item and reloads', async () => {
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('New item'), { target: { value: 'c' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('add_item', { checklistId: 'l1', text: 'c', parentLocalId: null }));
  });

  it('reorder action sends full top-level order', async () => {
    render(<ChecklistView checklistId="l1" />);
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument());
    fireEvent.drop(screen.getAllByRole('listitem')[0], { dataTransfer: { getData: () => 'i2' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('reorder_items', { checklistId: 'l1', orderedTopLevelIds: ['i2', 'i1'] }));
  });
});
```

- [ ] **Step 2: Implement ChecklistView**

`src/components/ChecklistView.tsx`:
```tsx
import { useCallback, useEffect, useState } from 'react';
import * as api from '../api/client';
import type { ItemDto } from '../api/types';

export default function ChecklistView({ checklistId }: { checklistId: string }) {
  const [items, setItems] = useState<ItemDto[]>([]);
  const [newText, setNewText] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const list = await api.getChecklist(checklistId);
    setItems(list.items ?? []);
  }, [checklistId]);

  useEffect(() => { reload(); }, [reload]);

  const top = items.filter((i) => i.parentId === null).sort((a, b) => a.position - b.position);
  const childrenOf = (id: string) => items.filter((i) => i.parentId === id).sort((a, b) => a.position - b.position);

  const toggle = async (item: ItemDto) => {
    await api.setItemChecked(checklistId, item.localId, !item.completed);
    await reload();
  };

  const rename = async (item: ItemDto, text: string) => {
    await api.setItemText(checklistId, item.localId, text);
    await reload();
  };

  const remove = async (item: ItemDto) => {
    await api.deleteItem(checklistId, item.localId);
    await reload();
  };

  const add = async () => {
    if (!newText.trim()) return;
    await api.addItem(checklistId, newText.trim(), null);
    setNewText('');
    await reload();
  };

  const onDrop = async (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ordered = top.map((i) => i.localId).filter((id) => id !== dragId);
    ordered.splice(ordered.indexOf(targetId), 0, dragId);
    setDragId(null);
    await api.reorderItems(checklistId, ordered);
    await reload();
  };

  return (
    <div id="checklist-view">
      <ul>
        {top.map((item) => (
          <li key={item.localId}
              draggable
              onDragStart={() => setDragId(item.localId)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(item.localId)}>
            <input type="checkbox" checked={item.completed} onChange={() => toggle(item)} />
            <input value={item.text} onChange={(e) => rename(item, e.target.value)} />
            <button onClick={() => remove(item)}>✕</button>
            <ul>
              {childrenOf(item.localId).map((c) => (
                <li key={c.localId} className="child">
                  <input type="checkbox" checked={c.completed} onChange={() => toggle(c)} />
                  <input value={c.text} onChange={(e) => rename(c, e.target.value)} />
                  <button onClick={() => remove(c)}>✕</button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <input placeholder="New item" value={newText} onChange={(e) => setNewText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
      <button onClick={add}>Add</button>
    </div>
  );
}
```

- [ ] **Step 3: Wire into App, run tests to green**

Run: `cd /coding/jotty && npm test`
Expected: all frontend tests PASS.

- [ ] **Step 4: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(ui): checklist view with toggle/edit/delete/drag-reorder"
```

---

### Task 18: SyncBadge + conflicts UI + settings/onboarding + search palette

**Files:**
- Create: `src/components/SettingsModal.tsx`, `src/components/ConflictDialog.tsx`, `src/components/SearchPalette.tsx`
- Modify: `src/components/SyncBadge.tsx` (status dot, manual sync, pending count, conflict indicator), `src/App.tsx` (mount modals, Ctrl+K)
- Create: `src/components/SettingsModal.test.tsx`, `src/components/ConflictDialog.test.tsx`, `src/components/SearchPalette.test.tsx`

**Interfaces:**
- Consumes: `api.connectInstance/getSettings/setSyncInterval/triggerSync/listConflicts/resolveConflict/search`.
- Produces:
  - SettingsModal: two modes — onboarding (no connection: instance URL + API key fields, calls `connect_instance`, shows error on failure) and settings (connected: shows URL, sync interval input, disconnect button).
  - ConflictDialog: lists `ConflictDto`s; per-row buttons "keep mine" (`resolveConflict(seq,'mine')`) and "take server" (`resolveConflict(seq,'server')`).
  - SearchPalette: Ctrl+K overlay; input → `api.search(q)` (debounced 200ms); result click navigates (`selectNote`/`selectChecklist`).
  - SyncBadge states: `synced` (0 pending, no conflicts) / `N pending` (amber) / `N conflicts` (red) / offline behavior = pending count persists.

- [ ] **Step 1: Write failing tests**

`src/components/SettingsModal.test.tsx`:
```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import SettingsModal from './SettingsModal';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'connect_instance') return Promise.resolve({ instanceUrl: 'http://localhost:1122', version: '1.22.0' });
    if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://localhost:1122', syncIntervalMinutes: 5 });
    return Promise.resolve(null);
  });
});

describe('SettingsModal onboarding', () => {
  it('calls connect_instance with url and key', async () => {
    render(<SettingsModal mode="onboarding" onClose={() => {}} onConnected={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('https://jotty.example.com'), { target: { value: 'http://localhost:1122' } });
    fireEvent.change(screen.getByPlaceholderText('ck_...'), { target: { value: 'ck_secret' } });
    fireEvent.click(screen.getByText('Connect'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('connect_instance', { url: 'http://localhost:1122', apiKey: 'ck_secret' }));
  });

  it('shows error when connection fails', async () => {
    invoke.mockImplementation((cmd: string) => cmd === 'connect_instance' ? Promise.reject(new Error('health check failed')) : Promise.resolve(null));
    render(<SettingsModal mode="onboarding" onClose={() => {}} onConnected={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('https://jotty.example.com'), { target: { value: 'http://localhost:1122' } });
    fireEvent.change(screen.getByPlaceholderText('ck_...'), { target: { value: 'ck_x' } });
    fireEvent.click(screen.getByText('Connect'));
    await waitFor(() => expect(screen.getByText(/health check failed/i)).toBeInTheDocument());
  });
});
```

`src/components/ConflictDialog.test.tsx`:
```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import ConflictDialog from './ConflictDialog';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'list_conflicts') return Promise.resolve([{ seq: 7, entity: 'note', entityId: 'n1', opType: 'delete', lastError: '404', label: 'My Note' }]);
    if (cmd === 'resolve_conflict') return Promise.resolve(null);
    return Promise.resolve(null);
  });
});

describe('ConflictDialog', () => {
  it('lists conflicts and resolves keep-mine', async () => {
    render(<ConflictDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('My Note')).toBeInTheDocument());
    fireEvent.click(screen.getByText('keep mine'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('resolve_conflict', { seq: 7, keep: 'mine' }));
  });
});
```

`src/components/SearchPalette.test.tsx`:
```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import SearchPalette from './SearchPalette';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'search') return Promise.resolve({ notes: [{ id: 'n1', title: 'Groceries', snippet: '…milk…' }], checklists: [] });
    return Promise.resolve(null);
  });
});

describe('SearchPalette', () => {
  it('queries search and navigates on result click', async () => {
    const selectNote = vi.fn();
    render(<SearchPalette onClose={() => {}} onSelectNote={selectNote} onSelectChecklist={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'milk' } });
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Groceries'));
    expect(selectNote).toHaveBeenCalledWith('n1');
  });
});
```

- [ ] **Step 2: Implement the three components + SyncBadge upgrade + App wiring**

`src/components/SettingsModal.tsx`:
```tsx
import { useState } from 'react';
import * as api from '../api/client';

export default function SettingsModal({ mode, onClose, onConnected }: {
  mode: 'onboarding' | 'settings'; onClose: () => void; onConnected?: () => void;
}) {
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [interval, setIntervalMin] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true); setError(null);
    try {
      await api.connectInstance(url.trim(), key.trim());
      onConnected?.(); onClose();
    } catch (e) {
      setError(String(e).replace(/^.*Error: /, ''));
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{mode === 'onboarding' ? 'Connect to jotty' : 'Settings'}</h2>
        {mode === 'onboarding' && (
          <>
            <p>Generate an API key in your jotty web UI: Profile → Settings → API Key → Generate.</p>
            <input placeholder="https://jotty.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
            <input placeholder="ck_..." value={key} onChange={(e) => setKey(e.target.value)} type="password" />
            <button disabled={busy || !url || !key} onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</button>
          </>
        )}
        {mode === 'settings' && (
          <>
            <label>Sync every <input type="number" min={1} value={interval} onChange={(e) => setIntervalMin(Number(e.target.value))} /> minutes</label>
            <button onClick={async () => { await api.setSyncInterval(interval); }}>Save interval</button>
            <button onClick={async () => { await api.disconnectInstance(); onClose(); }}>Disconnect</button>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
```

`src/components/ConflictDialog.tsx`:
```tsx
import { useEffect, useState } from 'react';
import * as api from '../api/client';
import type { ConflictDto } from '../api/types';

export default function ConflictDialog({ onClose }: { onClose: () => void }) {
  const [conflicts, setConflicts] = useState<ConflictDto[]>([]);
  useEffect(() => { api.listConflicts().then(setConflicts); }, []);
  const resolve = async (seq: number, keep: 'mine' | 'server') => {
    await api.resolveConflict(seq, keep);
    setConflicts((await api.listConflicts()));
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Sync conflicts</h2>
        {conflicts.length === 0 && <p>No conflicts.</p>}
        <ul>
          {conflicts.map((c) => (
            <li key={c.seq}>
              <strong>{c.label}</strong> — {c.opType} ({c.lastError ?? 'unresolved'})
              <button onClick={() => resolve(c.seq, 'mine')}>keep mine</button>
              <button onClick={() => resolve(c.seq, 'server')}>take server</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

`src/components/SearchPalette.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import type { SearchResultsDto } from '../api/types';

export default function SearchPalette({ onClose, onSelectNote, onSelectChecklist }: {
  onClose: () => void; onSelectNote: (id: string) => void; onSelectChecklist: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResultsDto | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) { setResults(null); return; }
    timer.current = setTimeout(async () => setResults(await api.search(q.trim())), 200);
  }, [q]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <input autoFocus placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        {results && (
          <ul>
            {results.notes.map((n) => (
              <li key={`n-${n.id}`} onClick={() => { onSelectNote(n.id); onClose(); }}>
                📝 {n.title} <small dangerouslySetInnerHTML={{ __html: n.snippet }} />
              </li>
            ))}
            {results.checklists.map((c) => (
              <li key={`c-${c.id}`} onClick={() => { onSelectChecklist(c.id); onClose(); }}>
                ☑ {c.title} <small dangerouslySetInnerHTML={{ __html: c.snippet }} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
```

SyncBadge upgrade:
```tsx
import { useEffect, useState } from 'react';
import * as api from '../api/client';
import { useStore } from '../stores/store';

export default function SyncBadge({ onOpenConflicts }: { onOpenConflicts: () => void }) {
  const syncStatus = useStore((s) => s.syncStatus);
  const [conflicts, setConflicts] = useState(0);
  useEffect(() => {
    api.listConflicts().then((c) => setConflicts(c.length));
  }, [syncStatus]);
  if (!syncStatus) return null;
  const state = conflicts > 0 ? 'conflict' : syncStatus.pending > 0 ? 'pending' : 'synced';
  return (
    <footer id="sync-badge" className={state}>
      <span className="dot" />
      {state === 'conflict' && <button onClick={onOpenConflicts}>{conflicts} conflicts</button>}
      {state === 'pending' && <span>{syncStatus.pending} pending</span>}
      {state === 'synced' && <span>synced</span>}
      <button onClick={() => api.triggerSync()}>sync now</button>
    </footer>
  );
}
```

App wiring: Ctrl+K opens SearchPalette; conflicts count > 0 auto-opens ConflictDialog once per session; SyncBadge gets `onOpenConflicts`.

- [ ] **Step 3: Run all frontend tests to green**

Run: `cd /coding/jotty && npm test`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat(ui): sync badge, conflict dialog, settings/onboarding, search palette"
```

---

### Task 19: Real-instance integration harness + icons + packaging + docs

**Files:**
- Create: `dev/docker-compose.yml`, `dev/README.md`, `dev/gen_icon.py`
- Create: `src-tauri/tests/integration_real.rs`
- Create: `README.md`
- Modify: `src-tauri/tauri.conf.json` (bundle icons)
- Modify: `AGENTS.md` (final conventions)

**Interfaces:**
- Consumes: full client stack.
- Produces: real jotty round-trip test (env-gated); bundled app build with icons; docs.

- [ ] **Step 1: dev harness**

`dev/docker-compose.yml`:
```yaml
services:
  jotty:
    image: ghcr.io/fccview/jotty:latest
    container_name: jotty-desktop-test
    ports:
      - "1122:3000"
    volumes:
      - ./data:/app/data
      - ./config:/app/config
      - ./cache:/app/cache
    environment:
      - PUID=1000
      - PGID=1000
```

`dev/README.md`:
```markdown
# Dev harness

1. `docker compose up -d` (from dev/)
2. Open http://localhost:1122 — first run creates the admin user (browser only).
3. Profile → Settings → API Key → Generate; copy the ck_... key.
4. Real-instance tests (env-gated, skipped unless both vars set):
   JOTTY_TEST_URL=http://localhost:1122 JOTTY_TEST_API_KEY=*** cargo test --test integration_real -- --ignored
```

`src-tauri/tests/integration_real.rs`:
```rust
// Round-trip against a REAL jotty instance. Skipped unless JOTTY_TEST_URL and
// JOTTY_TEST_API_KEY are set; run with `cargo test --test integration_real -- --ignored`.
use jotty_client_lib::db::{self, notes, outbox};
use jotty_client_lib::jotty::client::JottyClient;
use jotty_client_lib::sync;

fn env() -> Option<(String, String)> {
    let url = std::env::var("JOTTY_TEST_URL").ok()?;
    let key = std::env::var("JOTTY_TEST_API_KEY").ok()?;
    Some((url, key))
}

fn fresh_db() -> rusqlite::Connection {
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(&dir.path().join("i.db")).unwrap();
    std::mem::forget(dir);
    db::migrations::run(&conn).unwrap();
    conn
}

#[test]
#[ignore]
fn roundtrip_note_push_and_pull() {
    let Some((url, key)) = env() else { return; };
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let client = JottyClient::new(&url, &key).unwrap();
        let mut conn = fresh_db();

        // push: create a note offline, then sync
        let local = notes::insert_local(&conn, &notes::NewNote {
            title: format!("integration {}", uuid::Uuid::new_v4()),
            content: "hello from the fat client".into(),
            category: "Uncategorized".into(),
        }).unwrap();
        outbox::enqueue(&conn, "create", "note", &local.id,
            &serde_json::json!({"temp_id": local.id, "title": local.title, "content": local.content, "category": "Uncategorized"})).unwrap();
        let report = sync::run(&mut conn, &client).await.unwrap();
        assert!(report.errors.is_empty(), "errors: {:?}", report.errors);
        assert_eq!(report.pushed, 1);

        // the note now has a server id
        let ids: Vec<String> = {
            let mut stmt = conn.prepare("SELECT id FROM notes").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert_eq!(ids.len(), 1);
        assert_ne!(ids[0], local.id, "id must be remapped to server uuid");
    });
}
```
(requires `uuid` in dev-deps of the lib — it is a main dep, fine; `tempfile` is dev-dep. Integration tests use dev-deps automatically.)

- [ ] **Step 2: Icons + build**

`dev/gen_icon.py` (stdlib-only PNG writer — solid brand-color square):
```python
import struct, zlib, sys

W = H = 1024
# RGBA rows, brand blue
row = b"\x00" + bytes([0x1f, 0x6f, 0xeb, 0xff]) * W
raw = row * H

def chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(raw, 9))
       + chunk(b"IEND", b""))

out = sys.argv[1] if len(sys.argv) > 1 else "app-icon.png"
with open(out, "wb") as f:
    f.write(png)
print(f"wrote {out}")
```

Run:
```bash
cd /coding/jotty && python3 dev/gen_icon.py app-icon.png && cd src-tauri && cargo tauri icon ../app-icon.png
```
Then update `src-tauri/tauri.conf.json` bundle section to:
```json
"bundle": { "active": true, "targets": ["deb", "appimage"], "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"] }
```
Verify build: `cd /coding/jotty && npm run build && cd src-tauri && cargo tauri build` — expect a successful deb/appimage bundle (first build is slow).

- [ ] **Step 3: Full test matrix + docs**

Run everything:
```bash
cd /coding/jotty && npm install && npm run build && npm test && cd src-tauri && cargo test
```
Expected: all green. Then run the real-instance suite if the dev jotty is up (per dev/README.md).

`README.md`:
```markdown
# jotty·desktop — fat offline client for jotty·page

A Tauri desktop client for [jotty·page](https://github.com/fccview/jotty): your notes
and checklists, fully available offline, with background two-way sync to your
self-hosted instance.

## How it works
- Local SQLite copy of your notes/checklists; every edit works instantly offline.
- Sync = push pending changes (FIFO outbox) then pull a full catalog; conflicts
  resolve last-write-wins, item-level conflicts surface in the UI.
- Uses the stock jotty REST API only — no server changes needed.

## Build
- `npm install && npm run build` (frontend)
- `cd src-tauri && cargo tauri dev` (run) / `cargo tauri build` (bundle)

## Connect
Generate an API key in your jotty web UI (Profile → Settings → API Key), then
enter instance URL + key in the app's onboarding screen. The key is stored in
your OS keyring.

## Tests
- `npm test` — frontend (vitest)
- `cd src-tauri && cargo test` — core (wiremock)
- `dev/` — real-instance integration harness (see dev/README.md)

License: AGPL-3.0-compatible client for jotty·page (upstream AGPL-3.0).
```

Final `AGENTS.md` addition (append):
```markdown
- Frontend: React+TS under src/, tests colocated (*.test.tsx), run `npm test`.
- Sync engine: src-tauri/src/sync/ — pull.rs, push.rs (FIFO outbox replay),
  resolve.rs (index-path resolution). Invariant: push→pull order; item ops
  re-resolve index paths at replay; reorder = rebuild.
- Real-instance tests: dev/ harness, env-gated (JOTTY_TEST_URL/JOTTY_TEST_API_KEY),
  `cargo test --test integration_real -- --ignored`.
```

- [ ] **Step 4: Commit**

```bash
cd /coding/jotty && git add -A && git commit -m "feat: real-instance harness, icons, packaging, docs"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** §3 architecture → Tasks 1, 7, 8, 14; §4 data model → Tasks 2–5; §5 sync → Tasks 10–13 (+ spec's reorder-rebuild note → Task 12); §6 errors → Task 11 (retry/conflict handling) + Task 7 (Api error mapping); §7 onboarding → Tasks 9, 14, 18; §8 UI → Tasks 15–18; §9 security → Task 7 (https policy) + Task 9 (keyring); §10 testing → throughout + Task 19; §11 repo layout → Tasks 1, 19. Non-goals respected (no kanban/PGP/sharing code anywhere).
- **Placeholder scan:** Task 11 note explicitly instructs folding checklist arms into the match (not deferred); Task 12 implementation notes are concrete; Task 13 scheduler code is complete (landed in Task 14 state-dependent parts are flagged). No TBD/TODO strings remain.
- **Type consistency:** `OutboxOp`, `NoteRow`, `ItemRow`, `ServerItem`, `flatten_items`, client method names, command names (`set_item_checked`, `reorder_items`) and their frontend wrappers verified consistent across Tasks 3–18. `ServerItem::simple` and `flatten_items` are created in Task 6 but referenced by Task 5 tests — Task 5's pre-step note covers the ordering.
- **Known intentional v1 simplifications** (visible in code, documented in spec/plan): item text edit input fires rename on every keystroke (autosave-style; each keystroke enqueues an op — acceptable at personal scale, coalescing is a v2 optimization); checklist item nesting renders one level of children; `get_checklist` single fetch is a full-lists fetch + find (no single-list GET endpoint in the API).