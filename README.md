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