# AGENTS.md — jotty·desktop

- Rust core in `src-tauri/src`, React UI in `src`. Spec: docs/superpowers/specs/, plan: docs/superpowers/plans/.
- Fresh clone: `npm install && npm run build` (creates dist/ needed by tauri macros) BEFORE `cargo test`.
- Tests: `cargo test` (Rust, wiremock-based), `npm test` (vitest). Green tests before every commit.
- Sync invariants (see spec): push-then-pull; entity write + outbox enqueue in ONE transaction; API key only in OS keyring; item ops resolve index paths at replay time; reorder replays as rebuild.
- API is stock jotty REST only (x-api-key header). Never modify server assumptions without re-checking upstream howto/API.md.
- Frontend: React+TS under src/, tests colocated (*.test.tsx), run `npm test`.
- Sync engine: src-tauri/src/sync/ — pull.rs, push.rs (FIFO outbox replay),
  resolve.rs (index-path resolution). Invariant: push→pull order; item ops
  re-resolve index paths at replay; reorder = rebuild.
- Real-instance tests: dev/ harness, env-gated (JOTTY_TEST_URL/JOTTY_TEST_API_KEY),
  `cargo test --test integration_real -- --ignored`.
