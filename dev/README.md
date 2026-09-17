# Dev harness

1. `docker compose up -d` (from dev/)
2. Open http://localhost:1122 — first run creates the admin user (browser only).
3. Profile → Settings → API Key → Generate; copy the ck_... key.
4. Real-instance tests (env-gated, skipped unless both vars set):
   JOTTY_TEST_URL=http://localhost:1122 JOTTY_TEST_API_KEY=*** cargo test --test integration_real -- --ignored