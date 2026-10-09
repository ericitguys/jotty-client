# Spec — P10: Android system Keystore backend (replace plaintext fallback)

**Date:** 2026-10-09 · **Roadmap:** Plane CAPTUREPIP #10 · **Status:** DESIGN LOCKED (user-clarified 2026-10-09)
**Scope:** Android cfg path only. Desktop keyring path byte-untouched. NO package build / release (user order "dont build the package") — ship rides a later staged release.

## Problem

Since v0.10.0 the Android build stores both secrets (api-key + openwebui-key) as
**plaintext files** in the app-private data dir (`JOTTY_APP_DATA/jotty-desktop-<account>.key`),
disclosed as a preview tradeoff (keys.rs TODO(android-v2)). The OS sandbox is the
only barrier; device-root or ADB-backup access reads them.

## Locked design (user answer: option 1 + option 1)

- **Mechanism: `android-keyring` 0.2.0** — a keyring-v3 compatible
  `CredentialBuilder`. JNI via `ndk-context` (Tauri Mobile supplies the JVM +
  app context — no Java code, nothing in `gen/`). It holds the AES encryption
  key inside the **system AndroidKeyStore** and encrypts the credential blob at
  rest in app-private storage. Chosen over `android-native-keyring-store`
  1.0.0 (maintainer's newer crate but targets the keyring-core v4 line = dep
  surgery) and over waiting on upstream keyring Android.
- **Migration: auto on first run.** For each legacy plaintext file: if the
  keystore entry is empty, set → then delete the plaintext file. If the
  keystore already holds the key, the plaintext file is redundant → delete it
  too (stale-copy hygiene). No re-login on the phone.

## Mechanics

1. `Cargo.toml` (target-scoped, android only):
   `[target.'cfg(target_os = "android")'.dependencies]` += `android-keyring = { version = "0.2", features = ["ndk-context"] }`
2. `lib.rs` setup, android cfg, FIRST (before any keyring Entry exists):
   `android_keyring::set_android_keyring_credential_builder()` — log::error +
   continue on Err (no silent plaintext fallback after migration: failures
   surface loudly at key access with AppError::Keyring).
3. `keys.rs`: delete the plaintext `mobile_store` module + the android
   get_for/set_for/delete_for arms — android then rides the SAME `entry()` /
   keyring path as desktop (service `jotty-desktop`, accounts `api-key`,
   `openwebui-key`). The single remaining android-cfg piece is the migration
   call + the dir resolution it already owns (JOTTY_APP_DATA set at lib.rs:29).
4. Migration lives as a headless-testable pure fn in keys.rs (NOT cfg-hidden):
   takes the legacy dir + the KeyStore for an account. RED-tested with
   MockKeyStore: migrate-empty (set+delete file), migrate-stale (keystore
   already set → file deleted, no overwrite), no-file no-op, idempotent second
   run. Android wiring calls it once per account at startup, after builder
   init, before AppState::new (so restore_connection reads migrated keys).

## Failure posture

- Builder init failure ⇒ logged error; first Entry access errors with the
  underlying cause (load-bearing: NO plaintext fallback reappears).
- Keystore set/get failure during migration ⇒ log::warn, KEEP the plaintext
  file (data preservation wins; retry next startup) — migration is
  best-effort-per-run, never blocks startup, never deletes without a
  successful set-or-confirmed-existing.

## Testing (TDD law, RED first)

- Desktop suite fences the migration fn (all four branches above).
- One source-shape fence: lib.rs android block registers the builder BEFORE
  AppState::new and wires both accounts' migration (grep-based, cfg(test),
  comment-stripped literals — repo precedent).
- Android-cfg compile check WITHOUT packaging:
  `cargo check --all-targets --target aarch64-linux-android` (rust target
  installed on the dev box; check ≠ link ≠ bundle).
- Gates: cargo test --lib (full), census Δ0 (baseline 18), tsc clean,
  vitest re-run for the letter of the gate (636/636 across 54 files expected —
  frontend untouched).
- On-device smoke (set/set/delete through AndroidKeyStore + migration from a
  real v0.29 install) happens at package time — deferred with the no-build
  order, disclosed in the ship notes later.

## Out of scope

Desktop keyring behavior, version bump/tag/release, CI changes, item #3
(global hotkey), any other roadmap entry.