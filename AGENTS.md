# AGENTS.md — jotty·desktop

- Rust core in `src-tauri/src`, React UI in `src`. Spec: docs/superpowers/specs/, plan: docs/superpowers/plans/.
- Fresh clone: `npm install && npm run build` (creates dist/ needed by tauri macros) BEFORE `cargo test`.
- Tests: `cargo test` (Rust, wiremock-based), `npm test` (vitest). Green tests before every commit.
- Sync invariants (see spec): push-then-pull; entity write + outbox enqueue in ONE transaction; API key only in OS keyring; item ops resolve index paths at replay time; reorder replays as rebuild.
- API is stock jotty REST only (x-api-key header). Never modify server assumptions without re-checking upstream howto/API.md.