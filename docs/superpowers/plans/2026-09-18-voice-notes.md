# Voice Notes (v0.10.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record voice memos in the desktop client, transcribe them through the user's self-hosted OpenWebUI (STT), optionally tidy with the same server's LLM, review/edit, and save as regular notes — audio kept as a local-only artifact, with offline-safe pending-transcription auto-retry.

**Architecture:** Two new Rust modules — `src-tauri/src/audio.rs` (capture pipeline: mono downmix → linear resample to 16 kHz → 16-bit WAV via hound, pure headless-testable core + thin cpal glue) and `src-tauri/src/voice_ai.rs` (OpenWebUI REST client: multipart transcriptions, models list, chat-completions tidy; dual-path `/api/v1` → `/api` fallback with suffix persistence) — plus `src-tauri/src/db/voice.rs` (staging-table helpers + startup sweep). A staging table `voice_recordings` carries the record→transcribe state machine; `voice_save_note` creates the note in ONE transaction (shared create-note inner + local-only `audio_path` columns + staging delete) so sync invariants are untouched. Twelve new Tauri commands. Frontend: `VoiceNoteReview` overlay (new/resume/retranscribe modes), NoteList mic badge + voice button, SettingsModal "AI server" section, NoteEditor voice panel.

**Tech Stack:** Tauri 2 + Rust (cpal 0.18, hound 3.5, reqwest 0.12 `multipart`, rusqlite) / React + TypeScript + zustand + vitest/RTL; wiremock for Rust HTTP tests.

**Spec:** `docs/superpowers/specs/2026-09-18-voice-notes-design.md` (design approved 2026-09-18) — the plan argues from the spec; executors read both. API facts live in the jotty-client skill reference `references/openwebui-api.md`.

**Prerequisite (user, one-time, needs sudo):** `sudo apt install -y libasound2-dev pkg-config` on the dev box — cpal 0.18 cannot compile without ALSA headers. Checked 2026-09-18: pkg-config present, libasound2-dev ABSENT, passwordless sudo ABSENT. Task 3 fails at build without it.

## Plan rulings (disclosed deviations from the spec)

1. **Timeouts.** Spec §4 says "30s timeout" (pattern-copied from JottyClient). Ruling: VoiceAiClient uses 30s for `models` but **180s for transcriptions and tidy** — an 8-minute WAV on local CPU faster-whisper routinely exceeds 30s; a 30s cap would systematically fail long memos into an endless retry loop. (RequestBuilder-level `.timeout()` override per request.)
2. **`voice_recordings.last_error` column** added (spec §5 omits it; spec §7 requires error text surfaced in the review view — mirrors `outbox.last_error`).
3. **`voice_save_note` gains `contentOverride: Option<String>`** (spec §5 signature is `(recordingId, title, category, useTidied)`). Spec §2 makes the flow "review/**edit** → save", so the user's final edited text must land in the note. When `None`, the spec's default applies (tidied if `useTidied` && exists, else raw). The frontend always sends the textarea text (byte-identical to raw/tidied when unedited).
4. **Startup sweep also resets stale `transcribing` rows** → `transcription_failed` with last_error "interrupted by restart" (spec §6 sweeps `recording` rows only). A restart mid-transcription leaves a stuck row with no live owner; nothing is deleted that wasn't already scheduled for deletion.
5. **Notes-list mic badge tooltip is generic** ("Pending transcription — retries after sync"); per-error text lives in the review overlay (saved notes have no staging row to carry an error string; an error column on `notes` would drift toward the sync engine).
6. **Two extra commands beyond spec §4's list:** `voice_transcribe_note` (NoteEditor re-transcribe — spec §4 requires the feature) and `voice_delete_note_audio` (NoteEditor delete-audio — ditto). `voice_tidy` takes `recordingId: Option<String>` so the retranscribe review (no staging row) can tidy too; when `Some`, the tidied text persists to the staging row (spec §5/§6 behavior).

## Global Constraints

(from the spec, verbatim values)

- Memo flow only — NO dictation-into-editor (spec §2.4).
- Audio is LOCAL-ONLY: `<app_data>/voice/<uuid>.wav`; never synced, never in outbox payloads; the transcript text is the synced artifact (spec §2.3, §5).
- `notes.audio_path` / `audio_duration_secs` are nullable LOCAL-ONLY columns — must NEVER reach the sync engine (spec §5). Verified 2026-09-18: zero `SELECT *` in src-tauri/src; sync payloads are built field-by-field (`create_note_inner`/`update_note_inner`). Task 1 adds a fence test.
- AI key ONLY in the OS keyring (service `jotty-desktop`, account `openwebui-key`); aiBaseUrl/aiModel/aiLanguageHint/apiPathSuffix are plain `sync_state` prefs (spec §2.5, §4).
- Recording cap 8 minutes → 16 kHz mono 16-bit ≈ 15.4 MB, safe margin under the 20 MB default-engine cap (spec §7).
- OpenWebUI API per `references/openwebui-api.md`; re-verify live via the env-gated integration test — NEVER fabricate a live run (spec §8).
- Saving a note is NEVER blocked by transcription state (spec §6). Tidy is never auto-applied (spec §6).
- Standing repo rules: TDD (failing test first); full gates after every task: `npx vitest run` (baseline 60), `npx tsc -p tsconfig.json --noEmit`, `cargo test` (baseline 91 passed + 1 ignored; re-run even for frontend-only changes after Cargo.toml bumps). Never run `cargo fmt` (repo is NOT rustfmt'd). Commit on main as zeus <zeus@local>, conventional messages. AGENTS.md is write-guarded — this plan makes NO AGENTS.md edits. Wiremock standing rules: every exercised op needs its OWN matching mock (unmatched → default 404 → silently misclassified); pin masked counters with surviving asserts.
- DB connection is `tokio::sync::Mutex<Connection>`; commands may hold it across awaits (do_sync precedent). Sync inners take `&mut Connection` when they open a transaction.

---

### Task 1: Schema v2 — voice_recordings + notes audio columns (Rust + TS types)

**Files:**
- Modify: `src-tauri/src/db/migrations.rs` (append v2 entry)
- Modify: `src-tauri/src/db/notes.rs` (NoteRow + COLS + row())
- Modify: `src-tauri/src/db/mod.rs` (test table list)
- Modify: `src-tauri/src/commands/dto.rs` (NoteDto)
- Modify: `src/api/types.ts` (NoteDto)
- Test: `src-tauri/src/db/mod.rs::tests`, `src-tauri/src/db/notes.rs::tests`

**Interfaces:**
- Produces: `notes` columns `audio_path TEXT NULL`, `audio_duration_secs REAL NULL`; table `voice_recordings(id TEXT PK, path TEXT NOT NULL, duration_secs REAL NOT NULL DEFAULT 0, raw_transcript TEXT, tidied_transcript TEXT, state TEXT NOT NULL DEFAULT 'recording', last_error TEXT, created_at TEXT NOT NULL)`; `notes::NoteRow { audio_path: Option<String>, audio_duration_secs: Option<f64> }`; `NoteDto { audioPath: Option<String>, audioDurationSecs: Option<f64> }`; TS `NoteDto.audioPath: string | null`, `NoteDto.audioDurationSecs: number | null`.

- [ ] **Step 1: Write failing migration tests** — in `src-tauri/src/db/mod.rs` tests mod, add `voice_recordings` to the `migrations_create_all_tables` expected list, and add:

```rust
    #[test]
    fn migration_v2_adds_voice_staging_and_note_audio_columns() {
        let (_d, conn) = tmp_db();
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(notes)").unwrap()
            .query_map([], |r| r.get::<_, String>(1)).unwrap()
            .map(Result::unwrap).collect();
        assert!(cols.iter().any(|c| c == "audio_path"), "notes.audio_path missing");
        assert!(cols.iter().any(|c| c == "audio_duration_secs"), "notes.audio_duration_secs missing");
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 2);
    }
```

- [ ] **Step 2: Run to verify RED** — `cargo test migration_v2` in src-tauri. Expected: FAIL (audio_path missing, user_version 1).

- [ ] **Step 3: Implement** — append to `MIGRATIONS` in `db/migrations.rs`:

```rust
    // v2 — voice notes (2026-09-18): staging table + local-only audio columns.
    // audio_path/audio_duration_secs are LOCAL-ONLY: they must never reach the
    // sync engine (spec §5). Sync code uses explicit column lists everywhere.
    r#"
    ALTER TABLE notes ADD COLUMN audio_path TEXT;
    ALTER TABLE notes ADD COLUMN audio_duration_secs REAL;
    CREATE TABLE voice_recordings (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        duration_secs REAL NOT NULL DEFAULT 0,
        raw_transcript TEXT,
        tidied_transcript TEXT,
        state TEXT NOT NULL DEFAULT 'recording',
        last_error TEXT,
        created_at TEXT NOT NULL
    );
    "#,
```

- [ ] **Step 4: Plumb the new columns** — `db/notes.rs`:

```rust
pub struct NoteRow {
    pub id: String,
    pub title: String,
    pub content: String,
    pub category: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub deleted_at: Option<String>,
    pub dirty: bool,
    pub audio_path: Option<String>,
    pub audio_duration_secs: Option<f64>,
}
```

`row()` gains `audio_path: r.get(8)?, audio_duration_secs: r.get(9)?,`; `COLS` becomes `"id, title, content, category, created_at, updated_at, deleted_at, dirty, audio_path, audio_duration_secs"`. `upsert_from_server` and `insert_local` are UNCHANGED (explicit column lists — audio columns stay NULL/preserved).

- [ ] **Step 5: Write the sync-invariant fence test (RED first)** — in `db/notes.rs` tests, BEFORE implementing Step 4, this test fails to compile (no field) — write it after Step 4's structs exist but before confirming behavior:

```rust
    #[test]
    fn upsert_from_server_never_touches_local_audio_columns() {
        let conn = db();
        let n = insert_local(&conn, &NewNote { title: "t".into(), content: "".into(), category: "Home".into() }).unwrap();
        conn.execute("UPDATE notes SET audio_path='/tmp/x.wav', audio_duration_secs=12.5 WHERE id=?1", [&n.id]).unwrap();
        // a NEWER server copy must win on LWW but must not clobber the local-only columns
        assert!(upsert_from_server(&conn, &server_note(&n.id, "theirs", "2099-01-01T00:00:00.000Z")).unwrap());
        let after = get(&conn, &n.id).unwrap().unwrap();
        assert_eq!(after.audio_path.as_deref(), Some("/tmp/x.wav"));
        assert_eq!(after.audio_duration_secs, Some(12.5));
        assert!(!after.dirty);
    }
```

- [ ] **Step 6: DTO + TS** — `commands/dto.rs` NoteDto gains `pub audio_path: Option<String>, pub audio_duration_secs: Option<f64>,` (+ From mapping). `src/api/types.ts` NoteDto gains:

```ts
  audioPath: string | null; audioDurationSecs: number | null;
```

(Existing test mocks construct NoteDto literals through the untyped `invoke` mock — they do NOT need updating; only new tests that exercise audio fields add the fields.)

- [ ] **Step 7: Gates** — `cargo test` (all green incl. new fence), `npx vitest run` (60/60), `npx tsc -p tsconfig.json --noEmit` clean.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(voice): schema v2 - voice_recordings staging + notes audio columns (local-only)"`.

---

### Task 2: Capture pipeline (audio.rs pure core) + hound + db/voice.rs staging helpers

**Files:**
- Create: `src-tauri/src/audio.rs` (pure parts only; cpal glue arrives in Task 3)
- Create: `src-tauri/src/db/voice.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod audio;`), `src-tauri/src/db/mod.rs` (`pub mod voice;`)
- Modify: `src-tauri/Cargo.toml` (`hound = "3.5"` under [dependencies])
- Test: inline `#[cfg(test)]` mods in both new files

**Interfaces:**
- Consumes: Task 1 schema.
- Produces: `audio::TARGET_RATE: u32 = 16_000`, `audio::MAX_SECS: f64 = 480.0`, `audio::voice_dir(db_path: &Path) -> PathBuf`, `audio::downmix(&[f32], u16) -> Vec<f32>`, `audio::Resampler::new(from: u32, to: u32)` + `.push(&[f32]) -> Vec<f32>`, `audio::Ctrl::{Samples(Vec<f32>), Stop}`, `audio::run_writer(mpsc::Receiver<Ctrl>, hound::WavWriter<BufWriter<File>>, from_rate: u32, channels: u16) -> f64`; `db::voice::{ST_RECORDING|ST_RECORDED|ST_TRANSCRIBING|ST_TRANSCRIBED|ST_FAILED|ST_FAILED_AUTH: &str, VoiceRecordingRow, create_staging(conn,id,path), get(conn,id) -> Option<Row>, list_unsaved(conn), list_failed(conn), mark_recorded(conn,id,dur), mark_transcribing(conn,id), set_transcript(conn,id,raw) [also sets state='transcribed'], set_tidied(conn,id,text), mark_failed(conn,id,auth,err), delete_staging(conn,id) -> bool, referenced_audio_paths(conn) -> HashSet<String>}`.

- [ ] **Step 1: Failing resampler tests** — create `src-tauri/src/audio.rs` with only `pub const TARGET_RATE: u32 = 16_000;` + `pub const MAX_SECS: f64 = 480.0;` + a tests mod containing:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_stereo_averages_frames() {
        let out = downmix(&[0.0, 1.0, 0.5, 0.5], 2);
        assert_eq!(out, vec![0.5, 0.5]);
    }

    #[test]
    fn resampler_identity_16k_to_16k_is_full_passthrough_across_chunks() {
        let mut r = Resampler::new(16_000, 16_000);
        let input: Vec<f32> = (0..100).map(|i| i as f32 / 100.0).collect();
        let mut out = r.push(&input[..50]);
        out.extend(r.push(&input[50..]));
        assert_eq!(out.len(), 100);
        for (got, want) in out.iter().zip(input.iter()) {
            assert!((got - want).abs() < 1e-6);
        }
    }

    #[test]
    fn resampler_upsample_8k_to_16k_doubles_sample_count() {
        let mut r = Resampler::new(8_000, 16_000);
        let mut out = Vec::new();
        for chunk in 0..4 {
            let half_sec = vec![0.25f32; 4_000];
            out.extend(r.push(&half_sec));
            let _ = chunk;
        }
        assert_eq!(out.len(), 16_000); // 2 s in -> 2 s at 16 kHz
        assert!(out.iter().all(|s| (s - 0.25).abs() < 1e-6));
    }

    #[test]
    fn resampler_downsample_48k_to_16k_keeps_one_third() {
        let mut r = Resampler::new(48_000, 16_000);
        let out = r.push(&vec![0.5f32; 48_000]);
        assert_eq!(out.len(), 16_000);
        assert!(out.iter().all(|s| (s - 0.5).abs() < 1e-6));
    }

    #[test]
    fn resampler_interpolates_ramp_across_seam() {
        let mut r = Resampler::new(2, 4);
        let mut out = r.push(&[0.0f32, 1.0]);
        out.extend(r.push(&[1.0f32, 1.0]));
        assert_eq!(out.len(), 5);
        let want = [0.0, 0.5, 1.0, 1.0, 1.0];
        for (g, w) in out.iter().zip(want.iter()) {
            assert!((g - w).abs() < 1e-6, "got {g} want {w}");
        }
    }

    #[test]
    fn resampler_chunk_split_matches_one_shot() {
        let input: Vec<f32> = (0..1_000).map(|i| (i % 37) as f32 / 37.0).collect();
        let mut a = Resampler::new(44_100, 16_000);
        let one_shot = a.push(&input);
        let mut b = Resampler::new(44_100, 16_000);
        let mut split = b.push(&input[..333]);
        split.extend(b.push(&input[333..666]));
        split.extend(b.push(&input[666..]));
        assert_eq!(one_shot.len(), split.len());
        for (x, y) in one_shot.iter().zip(split.iter()) {
            assert!((x - y).abs() < 1e-6);
        }
    }
}
```

- [ ] **Step 2: Run RED** — `cargo test resampler` → FAIL (Resampler/downmix undefined).

- [ ] **Step 3: Implement the pipeline core** — in `audio.rs` (no cpal yet):

```rust
//! Voice capture pipeline — pure, headless-testable core. The cpal stream glue
//! lives at the bottom (added with cpal in the recorder task); spec 2026-09-18 §4.
use std::io::BufWriter;
use std::sync::mpsc;

/// Captured audio is normalized to 16 kHz mono 16-bit (spec §7).
pub const TARGET_RATE: u32 = 16_000;
/// Recording cap: 8 min ≈ 15.4 MB at 16 kHz mono 16-bit — safe margin under the
/// OpenWebUI default-engine 20 MB upload cap (spec §7; 10 min would be 19.2 MB).
pub const MAX_SECS: f64 = 480.0;

pub fn voice_dir(db_path: &std::path::Path) -> std::path::PathBuf {
    db_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("voice")
}

/// Average all channels of an interleaved f32 buffer down to mono.
pub fn downmix(interleaved: &[f32], channels: u16) -> Vec<f32> {
    let ch = channels.max(1) as usize;
    if ch == 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks(ch)
        .map(|frame| frame.iter().sum::<f32>() / ch as f32)
        .collect()
}

/// Linear-interpolation resampler carrying state across arbitrary chunk
/// boundaries (audio callbacks deliver raggedly-sized chunks). Positions that
/// land exactly on an integer input index at a chunk seam emit without the
/// right neighbor (t == 0); non-dyadic rate ratios may therefore skip one seam
/// sample per chunk boundary — inaudible and deterministic.
pub struct Resampler {
    step: f64,     // input samples per output sample (from_rate / to_rate)
    next_out: f64, // absolute input-timeline position of the next output sample
    consumed: u64, // total input samples consumed so far
    prev: f32,     // last sample of the previous chunk (seam interpolation)
    have_prev: bool,
}

impl Resampler {
    pub fn new(from_rate: u32, to_rate: u32) -> Self {
        Self {
            step: f64::from(from_rate) / f64::from(to_rate),
            next_out: 0.0,
            consumed: 0,
            prev: 0.0,
            have_prev: false,
        }
    }

    pub fn push(&mut self, input: &[f32]) -> Vec<f32> {
        let mut out = Vec::new();
        let mut buf = Vec::with_capacity(input.len() + 1);
        // buf[i] holds the absolute sample (self.consumed - offset + i)
        let offset: i64 = if self.have_prev { 1 } else { 0 };
        if self.have_prev {
            buf.push(self.prev);
        }
        buf.extend_from_slice(input);
        loop {
            let local = self.next_out - f64::from(self.consumed as i64 - offset);
            if local < 0.0 {
                break;
            }
            let i0 = local as usize;
            let t = (local - local.floor()) as f32;
            if i0 + 1 < buf.len() {
                let a = buf[i0];
                let b = buf[i0 + 1];
                out.push(a + (b - a) * t);
            } else if i0 < buf.len() && t == 0.0 {
                out.push(buf[i0]);
            } else {
                break; // need more input to interpolate this position
            }
            self.next_out += self.step;
        }
        self.consumed += input.len() as u64;
        if let Some(last) = input.last() {
            self.prev = *last;
            self.have_prev = true;
        }
        out
    }
}

pub enum Ctrl {
    /// Interleaved f32 samples at the device's native rate/channels.
    Samples(Vec<f32>),
    Stop,
}

/// Drain the sample channel into a 16 kHz mono 16-bit WAV, enforcing the
/// 8-minute cap. Returns the recorded duration in seconds. Runs on the
/// recorder thread; `finalize` runs on every exit path, so a crash mid-recording
/// leaves a valid partial file (spec §4).
pub fn run_writer(
    rx: mpsc::Receiver<Ctrl>,
    mut writer: hound::WavWriter<BufWriter<std::fs::File>>,
    from_rate: u32,
    channels: u16,
) -> f64 {
    let mut res = Resampler::new(from_rate, TARGET_RATE);
    let cap = (MAX_SECS * f64::from(TARGET_RATE)) as usize;
    let mut written = 0usize;
    let mut stop_now = false;
    loop {
        match rx.recv() {
            Ok(Ctrl::Samples(chunk)) => {
                let mono = downmix(&chunk, channels);
                for s in res.push(&mono) {
                    if written >= cap {
                        break;
                    }
                    let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                    if writer.write_sample(v).is_err() {
                        break; // disk error: finalize what we have
                    }
                    written += 1;
                }
                if written >= cap {
                    stop_now = true;
                }
            }
            Ok(Ctrl::Stop) | Err(_) => break, // Err = sender dropped (recorder torn down)
        }
        if stop_now {
            break;
        }
    }
    let _ = writer.finalize();
    written as f64 / f64::from(TARGET_RATE)
}
```

- [ ] **Step 4: Failing WAV-writer tests (RED)** — append to the tests mod, run `cargo test run_writer` → FAIL (run_writer exists but hound not in Cargo.toml → compile error; add `hound = "3.5"` to [dependencies] first, then the tests run RED on assertions only if the impl is wrong):

```rust
    fn spec() -> hound::WavSpec {
        hound::WavSpec {
            channels: 1,
            sample_rate: TARGET_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        }
    }

    #[test]
    fn run_writer_writes_16k_mono_i16_and_returns_duration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.wav");
        let writer = hound::WavWriter::create(&path, spec()).unwrap();
        let (tx, rx) = mpsc::channel::<Ctrl>();
        // 0.5 s of a 440 Hz sine at 48 kHz stereo
        std::thread::spawn(move || {
            for i in 0..24_000 {
                let t = i as f32 / 48_000.0;
                let s = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.8;
                tx.send(Ctrl::Samples(vec![s, s])).unwrap();
            }
            tx.send(Ctrl::Stop).unwrap();
        });
        let dur = run_writer(rx, writer, 48_000, 2);
        assert!((dur - 0.5).abs() < 0.05, "dur {dur}");
        let reader = hound::WavReader::open(&path).unwrap();
        let s = reader.spec();
        assert_eq!(s.sample_rate, 16_000);
        assert_eq!(s.channels, 1);
        assert_eq!(s.bits_per_sample, 16);
        let n = reader.duration();
        assert!(((0.5 - 0.05) * 16_000.0) as u32 <= n && n <= (0.55 * 16_000.0) as u32);
    }

    #[test]
    fn run_writer_enforces_the_eight_minute_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cap.wav");
        let writer = hound::WavWriter::create(&path, spec()).unwrap();
        let (tx, rx) = mpsc::channel::<Ctrl>();
        // feed ~520 s worth in 1 s chunks at 16 kHz mono
        std::thread::spawn(move || {
            for _ in 0..520 {
                if tx.send(Ctrl::Samples(vec![0.3f32; 16_000])).is_err() {
                    break;
                }
            }
            let _ = tx.send(Ctrl::Stop);
        });
        let dur = run_writer(rx, writer, 16_000, 1);
        assert!((dur - MAX_SECS).abs() < 1.0, "cap not enforced: {dur}");
        let reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.duration(), (MAX_SECS * 16_000.0) as u32);
    }

    #[test]
    fn run_writer_finalizes_on_dropped_sender() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("drop.wav");
        let writer = hound::WavWriter::create(&path, spec()).unwrap();
        let (tx, rx) = mpsc::channel::<Ctrl>();
        tx.send(Ctrl::Samples(vec![0.1f32; 1_000])).unwrap();
        drop(tx); // no Stop: recorder torn down without signal
        let dur = run_writer(rx, writer, 16_000, 1);
        assert!((dur - 1_000.0 / 16_000.0).abs() < 1e-3);
        assert!(hound::WavReader::open(&path).is_ok()); // valid header despite no Stop
    }
```

- [ ] **Step 5: Failing db/voice.rs tests** — create `src-tauri/src/db/voice.rs` with the state consts + `VoiceRecordingRow` + a tests mod:

```rust
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

    #[test]
    fn staging_lifecycle_round_trip() {
        let conn = db();
        create_staging(&conn, "r1", "/tmp/r1.wav").unwrap();
        let rec = get(&conn, "r1").unwrap().unwrap();
        assert_eq!(rec.state, ST_RECORDING);
        assert_eq!(rec.duration_secs, 0.0);
        assert!(rec.raw_transcript.is_none());
        mark_recorded(&conn, "r1", 12.5).unwrap();
        mark_transcribing(&conn, "r1").unwrap();
        set_transcript(&conn, "r1", "hello world").unwrap();
        set_tidied(&conn, "r1", "Hello, world.").unwrap();
        let rec = get(&conn, "r1").unwrap().unwrap();
        assert_eq!(rec.state, ST_TRANSCRIBED);
        assert_eq!(rec.raw_transcript.as_deref(), Some("hello world"));
        assert_eq!(rec.tidied_transcript.as_deref(), Some("Hello, world."));
        assert_eq!(rec.duration_secs, 12.5);
        assert!(delete_staging(&conn, "r1").unwrap());
        assert!(get(&conn, "r1").unwrap().is_none());
        assert!(!delete_staging(&conn, "r1").unwrap());
    }

    #[test]
    fn mark_failed_distinguishes_auth_from_network() {
        let conn = db();
        create_staging(&conn, "r2", "/tmp/r2.wav").unwrap();
        mark_failed(&conn, "r2", false, "500 oops").unwrap();
        assert_eq!(get(&conn, "r2").unwrap().unwrap().state, ST_FAILED);
        mark_failed(&conn, "r2", true, "api error 401").unwrap();
        let rec = get(&conn, "r2").unwrap().unwrap();
        assert_eq!(rec.state, ST_FAILED_AUTH);
        assert_eq!(rec.last_error.as_deref(), Some("api error 401"));
    }

    #[test]
    fn list_unsaved_excludes_recording_state_and_orders_desc() {
        let conn = db();
        create_staging(&conn, "old", "/tmp/old.wav").unwrap();
        mark_recorded(&conn, "old", 3.0).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        create_staging(&conn, "new", "/tmp/new.wav").unwrap();
        set_transcript(&conn, "new", "text").unwrap();
        let rows = list_unsaved(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "new", "newest first");
        // an in-flight recording row is never surfaced
        create_staging(&conn, "live", "/tmp/live.wav").unwrap();
        assert_eq!(list_unsaved(&conn).unwrap().len(), 2);
    }

    #[test]
    fn referenced_paths_cover_staging_and_saved_notes() {
        let conn = db();
        create_staging(&conn, "r", "/tmp/voice/r.wav").unwrap();
        conn.execute(
            "INSERT INTO notes (id,title,content,category,created_at,updated_at,dirty,audio_path) VALUES ('n1','t','','Home','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',1,'/tmp/voice/n.wav')",
            [],
        ).unwrap();
        let refs = referenced_audio_paths(&conn).unwrap();
        assert!(refs.contains("/tmp/voice/r.wav"));
        assert!(refs.contains("/tmp/voice/n.wav"));
    }
}
```

- [ ] **Step 6: Implement db/voice.rs** (register `pub mod voice;` in `db/mod.rs`):

```rust
//! voice_recordings staging table (local-only, spec 2026-09-18 §5).
use crate::error::AppResult;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use std::collections::HashSet;

pub const ST_RECORDING: &str = "recording";
pub const ST_RECORDED: &str = "recorded";
pub const ST_TRANSCRIBING: &str = "transcribing";
pub const ST_TRANSCRIBED: &str = "transcribed";
pub const ST_FAILED: &str = "transcription_failed";
pub const ST_FAILED_AUTH: &str = "transcription_failed_auth";

#[derive(Debug, Clone, PartialEq)]
pub struct VoiceRecordingRow {
    pub id: String,
    pub path: String,
    pub duration_secs: f64,
    pub raw_transcript: Option<String>,
    pub tidied_transcript: Option<String>,
    pub state: String,
    pub last_error: Option<String>,
    pub created_at: String,
}

const COLS: &str = "id, path, duration_secs, raw_transcript, tidied_transcript, state, last_error, created_at";

fn row(r: &rusqlite::Row) -> rusqlite::Result<VoiceRecordingRow> {
    Ok(VoiceRecordingRow {
        id: r.get(0)?,
        path: r.get(1)?,
        duration_secs: r.get(2)?,
        raw_transcript: r.get(3)?,
        tidied_transcript: r.get(4)?,
        state: r.get(5)?,
        last_error: r.get(6)?,
        created_at: r.get(7)?,
    })
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn create_staging(conn: &Connection, id: &str, path: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO voice_recordings(id, path, duration_secs, state, created_at) VALUES (?1, ?2, 0, 'recording', ?3)",
        rusqlite::params![id, path, now()],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<VoiceRecordingRow>> {
    let sql = format!("SELECT {COLS} FROM voice_recordings WHERE id=?1");
    Ok(conn.query_row(&sql, [id], |r| row(r)).optional()?)
}

pub fn list_unsaved(conn: &Connection) -> AppResult<Vec<VoiceRecordingRow>> {
    let sql = format!(
        "SELECT {COLS} FROM voice_recordings WHERE state != '{}' ORDER BY created_at DESC, id",
        ST_RECORDING
    );
    let mut stmt = conn.prepare(&sql)?;
    Ok(stmt.query_map([], |r| row(r))?.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn list_failed(conn: &Connection) -> AppResult<Vec<VoiceRecordingRow>> {
    let sql = format!("SELECT {COLS} FROM voice_recordings WHERE state = '{}' ORDER BY created_at", ST_FAILED);
    let mut stmt = conn.prepare(&sql)?;
    Ok(stmt.query_map([], |r| row(r))?.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn mark_recorded(conn: &Connection, id: &str, duration_secs: f64) -> AppResult<()> {
    conn.execute(
        "UPDATE voice_recordings SET state='recorded', duration_secs=?2 WHERE id=?1",
        rusqlite::params![id, duration_secs],
    )?;
    Ok(())
}

pub fn mark_transcribing(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("UPDATE voice_recordings SET state='transcribing' WHERE id=?1", [id])?;
    Ok(())
}

/// Success also flips the state — one statement owns the transition.
pub fn set_transcript(conn: &Connection, id: &str, raw: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE voice_recordings SET state='transcribed', raw_transcript=?2 WHERE id=?1",
        rusqlite::params![id, raw],
    )?;
    Ok(())
}

pub fn set_tidied(conn: &Connection, id: &str, tidied: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE voice_recordings SET tidied_transcript=?2 WHERE id=?1",
        rusqlite::params![id, tidied],
    )?;
    Ok(())
}

pub fn mark_failed(conn: &Connection, id: &str, auth: bool, err: &str) -> AppResult<()> {
    let state = if auth { ST_FAILED_AUTH } else { ST_FAILED };
    conn.execute(
        "UPDATE voice_recordings SET state=?2, last_error=?3 WHERE id=?1",
        rusqlite::params![id, state, err],
    )?;
    Ok(())
}

pub fn delete_staging(conn: &Connection, id: &str) -> AppResult<bool> {
    let n = conn.execute("DELETE FROM voice_recordings WHERE id=?1", [id])?;
    Ok(n > 0)
}

pub fn referenced_audio_paths(conn: &Connection) -> AppResult<HashSet<String>> {
    let mut set = HashSet::new();
    let mut stmt = conn.prepare("SELECT path FROM voice_recordings")?;
    for p in stmt.query_map([], |r| r.get::<_, String>())? {
        set.insert(p?);
    }
    let mut stmt = conn.prepare("SELECT audio_path FROM notes WHERE audio_path IS NOT NULL")?;
    for p in stmt.query_map([], |r| r.get::<_, String>())? {
        set.insert(p?);
    }
    Ok(set)
}
```

- [ ] **Step 7: Gates** — `cargo test` (all new tests green; suite total grows by the new tests), `npx vitest run` (60/60 — untouched), `npx tsc --noEmit`.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(voice): capture pipeline (16k mono wav, 8-min cap) + staging helpers"`.

---

### Task 3: Recorder glue (cpal) + start/stop/delete commands + VoiceRecorder state

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `cpal = "0.18"`)
- Modify: `src-tauri/src/audio.rs` (append recorder section)
- Modify: `src-tauri/src/commands/mod.rs` (3 commands + inners)
- Modify: `src-tauri/src/commands/dto.rs` (VoiceRecordingDto)
- Modify: `src-tauri/src/lib.rs` (manage + register)
- Test: `src-tauri/src/commands/mod.rs` tests mod

**Interfaces:**
- Consumes: Task 2 (`audio::{Ctrl, run_writer, voice_dir, TARGET_RATE}`, `db::voice::*`).
- Produces: `audio::PreparedInput { config: cpal::StreamConfig, sample_format: cpal::SampleFormat, build: Box<dyn FnOnce(mpsc::Sender<Vec<f32>>) -> Result<cpal::Stream, String> + Send> }`, `audio::prepare_default_input() -> Result<PreparedInput, String>`, `audio::VoiceRecorder::default()` + `.active_id() -> Option<String>` + `.start(&self, id, path, PreparedInput, WavWriter) -> Result<(), String>` + `.stop(&self) -> Result<(String, f64), String>`; commands `voice_start_recording() -> VoiceRecordingDto`, `voice_stop_recording() -> VoiceRecordingDto`, `voice_delete_recording(recordingId) -> ()`; `commands::voice_start_recording_inner(conn, voice_dir, recorder, prepare) -> AppResult<VoiceRecordingDto>` (prepare injectable for tests); `dto::VoiceRecordingDto { id, path, durationSecs, rawTranscript, tidiedTranscript, state, lastError, createdAt }` (camelCase).

- [ ] **Step 1: Failing command-layer tests** — in `src-tauri/src/commands/mod.rs` tests mod, add (reuses the existing `db()` helper; add a `voice_rec()` helper if the file's tests use a shared constructor — match the file's existing helper names):

```rust
    #[test]
    fn voice_start_no_device_creates_no_partial_state() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        std::mem::forget(dir);
        let voice_dir = std::path::Path::new(dir.path()).join("voice");
        let recorder = crate::audio::VoiceRecorder::default();
        let err = voice_start_recording_inner(
            &conn,
            &voice_dir,
            &recorder,
            || Err("no microphone available".into()),
        ).unwrap_err();
        assert!(err.to_string().contains("no microphone"));
        // nothing created: no staging row, no file, no live session
        assert!(crate::db::voice::list_unsaved(&conn).unwrap().is_empty());
        assert!(recorder.active_id().is_none());
    }

    #[test]
    fn voice_start_stream_build_failure_cleans_up_row_and_file() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        std::mem::forget(dir);
        let voice_dir = std::path::Path::new(dir.path()).join("voice");
        let recorder = crate::audio::VoiceRecorder::default();
        let prepared = crate::audio::PreparedInput {
            config: cpal::StreamConfig {
                channels: 1,
                sample_rate: cpal::SampleRate(48_000),
                buffer_size: cpal::BufferSize::Default,
            },
            sample_format: cpal::SampleFormat::F32,
            build: Box::new(|_tx| Err("open mic stream: boom".into())),
        };
        let err = voice_start_recording_inner(&conn, &voice_dir, &recorder, || Ok(prepared)).unwrap_err();
        assert!(err.to_string().contains("boom"));
        let rows = crate::db::voice::list_unsaved(&conn).unwrap();
        let _ = rows; // row deleted below; also assert no file survived
        let files: Vec<_> = std::fs::read_dir(&voice_dir)
            .map(|rd| rd.filter_map(Result::ok).collect())
            .unwrap_or_default();
        assert!(files.is_empty(), "wav must be cleaned up");
        assert!(recorder.active_id().is_none());
        // the staging row was deleted too (list_unsaved excludes 'recording', so query directly)
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM voice_recordings", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn voice_stop_without_session_errors() {
        let conn = db();
        let recorder = crate::audio::VoiceRecorder::default();
        let err = voice_stop_recording_inner(&conn, &recorder).unwrap_err();
        assert!(err.to_string().contains("not recording"));
    }

    #[test]
    fn voice_delete_removes_row_and_file_and_stops_active_session() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        std::mem::forget(dir);
        let path = dir.path().join("r.wav");
        std::fs::write(&path, b"fake").unwrap();
        crate::db::voice::create_staging(&conn, "r1", path.to_string_lossy().as_ref()).unwrap();
        let recorder = crate::audio::VoiceRecorder::default();
        voice_delete_recording_inner(&conn, &recorder, "r1").unwrap();
        assert!(crate::db::voice::get(&conn, "r1").unwrap().is_none());
        assert!(!path.exists());
        // unknown id: no-op, no error
        voice_delete_recording_inner(&conn, &recorder, "gone").unwrap();
    }

    #[test]
    fn voice_recording_dto_serializes_camel_case() {
        let dto = crate::commands::dto::VoiceRecordingDto {
            id: "r1".into(),
            path: "/tmp/r1.wav".into(),
            duration_secs: 12.5,
            raw_transcript: Some("hi".into()),
            tidied_transcript: None,
            state: "transcribed".into(),
            last_error: None,
            created_at: "2026-09-18T00:00:00+00:00".into(),
        };
        let v = serde_json::to_value(&dto).unwrap();
        assert!(v.get("durationSecs").is_some());
        assert!(v.get("rawTranscript").is_some());
        assert!(v.get("tidiedTranscript").is_some());
        assert!(v.get("lastError").is_some());
        assert!(v.get("createdAt").is_some());
        assert!(v.get("duration_secs").is_none());
    }
```

- [ ] **Step 2: Run RED** — `cargo test voice_` → FAIL (inners undefined).

- [ ] **Step 3: Cargo + recorder glue** — add `cpal = "0.18"` to [dependencies]; append to `audio.rs`:

```rust
// --- recorder (cpal) --------------------------------------------------------
// Headless-untestable except the injected failure paths (spec §8: capture
// device access is gated). Real-mic capture is a MANUAL release smoke gate.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

pub struct PreparedInput {
    pub config: cpal::StreamConfig,
    pub sample_format: cpal::SampleFormat,
    /// Builds the input stream for this device; boxed so tests can inject
    /// a build failure and prove the cleanup path.
    pub build: Box<dyn FnOnce(mpsc::Sender<Vec<f32>>) -> Result<cpal::Stream, String> + Send>,
}

/// Probe the default input device and its best config. Device-native rate and
/// channel count are captured here; normalization to 16 kHz mono happens in
/// the writer thread (spec §4).
pub fn prepare_default_input() -> Result<PreparedInput, String> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or("no microphone available")?;
    let supported = device
        .supported_input_configs()
        .map_err(|e| format!("query microphone configs: {e}"))?
        .next()
        .ok_or("microphone exposes no input configuration")?
        .with_max_sample_rate();
    let config: cpal::StreamConfig = supported.clone().into();
    let sample_format = supported.sample_format();
    let dev = device.clone();
    let cfg = config.clone();
    Ok(PreparedInput {
        config,
        sample_format,
        build: Box::new(move |tx: mpsc::Sender<Vec<f32>>| {
            let err_fn = |e| log::warn!("audio input error: {e}");
            // manual conversion avoids depending on cpal sample-conversion traits
            let stream = match sample_format {
                cpal::SampleFormat::F32 => dev.build_input_stream(
                    &cfg,
                    move |d: &[f32], _: &cpal::InputCallbackInfo| { let _ = tx.send(d.to_vec()); },
                    err_fn,
                    None,
                ),
                cpal::SampleFormat::I16 => dev.build_input_stream(
                    &cfg,
                    move |d: &[i16], _: &cpal::InputCallbackInfo| {
                        let _ = tx.send(d.iter().map(|s| *s as f32 / 32768.0).collect());
                    },
                    err_fn,
                    None,
                ),
                cpal::SampleFormat::U16 => dev.build_input_stream(
                    &cfg,
                    move |d: &[u16], _: &cpal::InputCallbackInfo| {
                        let _ = tx.send(d.iter().map(|s| (*s as f32 - 32768.0) / 32768.0).collect());
                    },
                    err_fn,
                    None,
                ),
                other => return Err(format!("unsupported microphone sample format: {other:?}")),
            }
            .map_err(|e| format!("open mic stream: {e}"))?;
            stream.play().map_err(|e| format!("start mic stream: {e}"))?;
            Ok(stream)
        }),
    })
}

#[derive(Default)]
pub struct VoiceRecorder {
    session: std::sync::Mutex<Option<Session>>,
}

struct Session {
    recording_id: String,
    path: std::path::PathBuf,
    ctrl: mpsc::Sender<Ctrl>,
    handle: std::thread::JoinHandle<f64>,
}

impl VoiceRecorder {
    pub fn active_id(&self) -> Option<String> {
        self.session.lock().unwrap().as_ref().map(|s| s.recording_id.clone())
    }

    /// Begin capture: spawn the writer thread and hand over the stream.
    /// The stream lives on the recorder thread (its callback feeds `tx`), so
    /// cpal's Send-ness never crosses a thread boundary here.
    pub fn start(
        &self,
        recording_id: &str,
        path: std::path::PathBuf,
        prepared: PreparedInput,
        writer: hound::WavWriter<BufWriter<std::fs::File>>,
    ) -> Result<(), String> {
        let mut guard = self.session.lock().unwrap();
        if guard.is_some() {
            return Err("a recording is already active".into());
        }
        let PreparedInput { config, build, .. } = prepared;
        let (rate, channels) = (config.sample_rate.0, config.channels);
        let (tx, rx) = mpsc::channel::<Ctrl>();
        let stream = build(tx.clone())?;
        let handle = std::thread::spawn(move || {
            let _keepalive = stream; // dropping the stream ends the callback
            run_writer(rx, writer, rate, channels)
        });
        *guard = Some(Session {
            recording_id: recording_id.into(),
            path,
            ctrl: tx,
            handle,
        });
        Ok(())
    }

    /// Stop capture, wait for the writer to finalize, return (id, duration).
    /// Blocking join is fine here: the writer thread is parked in recv() and
    /// exits promptly on Ctrl::Stop.
    pub fn stop(&self) -> Result<(String, f64), String> {
        let mut guard = self.session.lock().unwrap();
        let Some(session) = guard.take() else {
            return Err("not recording".into());
        };
        let _ = session.ctrl.send(Ctrl::Stop);
        let duration = session
            .handle
            .join()
            .map_err(|_| "recorder thread crashed".to_string())?;
        Ok((session.recording_id, duration))
    }
}
```

- [ ] **Step 4: DTO** — `commands/dto.rs`:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRecordingDto {
    pub id: String,
    pub path: String,
    pub duration_secs: f64,
    pub raw_transcript: Option<String>,
    pub tidied_transcript: Option<String>,
    pub state: String,
    pub last_error: Option<String>,
    pub created_at: String,
}

impl From<crate::db::voice::VoiceRecordingRow> for VoiceRecordingDto {
    fn from(r: crate::db::voice::VoiceRecordingRow) -> Self {
        VoiceRecordingDto {
            id: r.id,
            path: r.path,
            duration_secs: r.duration_secs,
            raw_transcript: r.raw_transcript,
            tidied_transcript: r.tidied_transcript,
            state: r.state,
            last_error: r.last_error,
            created_at: r.created_at,
        }
    }
}
```

- [ ] **Step 5: Inners + commands** — in `commands/mod.rs` (imports: `crate::audio`, `crate::db::voice as db_voice` style consistent with file):

```rust
// ---- voice notes (spec 2026-09-18) -----------------------------------------

fn voice_dto(conn: &Connection, id: &str) -> AppResult<VoiceRecordingDto> {
    Ok(crate::db::voice::get(conn, id)?
        .ok_or_else(|| crate::error::AppError::Other("recording vanished".into()))?
        .into())
}

pub(crate) fn voice_start_recording_inner(
    conn: &Connection,
    voice_dir: &std::path::Path,
    recorder: &crate::audio::VoiceRecorder,
    prepare: impl FnOnce() -> Result<crate::audio::PreparedInput, String>,
) -> AppResult<VoiceRecordingDto> {
    // device probe FIRST: no partial state on failure (spec §7)
    let prepared = match prepare() {
        Ok(p) => p,
        Err(msg) => return Err(crate::error::AppError::Other(msg)),
    };
    std::fs::create_dir_all(voice_dir)
        .map_err(|e| crate::error::AppError::Other(format!("voice dir: {e}")))?;
    let id = uuid::Uuid::new_v4().to_string();
    let path = voice_dir.join(format!("{id}.wav"));
    crate::db::voice::create_staging(conn, &id, path.to_string_lossy().as_ref())?;
    // open the WAV now: the file exists from recording start, so a crash
    // leaves a valid partial file (spec §4)
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: crate::audio::TARGET_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let writer = match hound::WavWriter::create(&path, spec) {
        Ok(w) => w,
        Err(e) => {
            let _ = crate::db::voice::delete_staging(conn, &id);
            return Err(crate::error::AppError::Other(format!("open wav: {e}")));
        }
    };
    if let Err(msg) = recorder.start(&id, path.clone(), prepared, writer) {
        let _ = crate::db::voice::delete_staging(conn, &id);
        let _ = std::fs::remove_file(&path);
        return Err(crate::error::AppError::Other(msg));
    }
    voice_dto(conn, &id)
}

pub(crate) fn voice_stop_recording_inner(
    conn: &Connection,
    recorder: &crate::audio::VoiceRecorder,
) -> AppResult<VoiceRecordingDto> {
    let (id, duration) = recorder.stop().map_err(crate::error::AppError::Other)?;
    crate::db::voice::mark_recorded(conn, &id, duration)?;
    voice_dto(conn, &id)
}

pub(crate) fn voice_delete_recording_inner(
    conn: &Connection,
    recorder: &crate::audio::VoiceRecorder,
    recording_id: &str,
) -> AppResult<()> {
    // cancel-anytime: if this row owns the live session, stop it first (spec §6)
    if recorder.active_id().as_deref() == Some(recording_id) {
        let _ = recorder.stop(); // duration discarded — the row is being deleted
    }
    if let Some(rec) = crate::db::voice::get(conn, recording_id)? {
        let _ = std::fs::remove_file(&rec.path);
        crate::db::voice::delete_staging(conn, recording_id)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn voice_start_recording(
    state: tauri::State<'_, AppState>,
    recorder: tauri::State<'_, crate::audio::VoiceRecorder>,
) -> Result<VoiceRecordingDto, String> {
    let conn = state.db.lock().await;
    let dir = crate::audio::voice_dir(&state.db_path);
    voice_start_recording_inner(&conn, &dir, &recorder, crate::audio::prepare_default_input)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voice_stop_recording(
    state: tauri::State<'_, AppState>,
    recorder: tauri::State<'_, crate::audio::VoiceRecorder>,
) -> Result<VoiceRecordingDto, String> {
    let conn = state.db.lock().await;
    voice_stop_recording_inner(&conn, &recorder).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voice_delete_recording(
    state: tauri::State<'_, AppState>,
    recorder: tauri::State<'_, crate::audio::VoiceRecorder>,
    recording_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().await;
    voice_delete_recording_inner(&conn, &recorder, &recording_id).map_err(|e| e.to_string())
}
```

(`hound` and `uuid` are already referenced via `crate::`/direct — match the file's existing import style. If the tests' `db()` helper does not exist under that name, reuse the file's existing temp-db helper.)

- [ ] **Step 6: Wire up** — `lib.rs` setup, after `db::migrations::run(&conn)?;`:

```rust
            app.manage(crate::audio::VoiceRecorder::default());
```

and add to `generate_handler!`: `commands::voice_start_recording, commands::voice_stop_recording, commands::voice_delete_recording,`.

- [ ] **Step 7: Gates** — `cargo test` (PREREQUISITE: libasound2-dev installed — cpal will not compile otherwise), `npx vitest run`, `npx tsc --noEmit`.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(voice): cpal recorder + start/stop/delete commands"`.

---

### Task 4: voice_ai.rs — OpenWebUI client (transcribe/models/tidy, dual-path)

**Files:**
- Create: `src-tauri/src/voice_ai.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod voice_ai;`)
- Modify: `src-tauri/src/jotty/client.rs` (`fn is_local` → `pub(crate) fn is_local`)
- Modify: `src-tauri/Cargo.toml` (reqwest features: add `"multipart"`)
- Test: inline tests mod in `voice_ai.rs`

**Interfaces:**
- Produces: `voice_ai::Suffix { V1, Plain }` (+ `as_str()`, `from_storage(&str)`), `voice_ai::TIDY_SYSTEM_PROMPT`, `voice_ai::VoiceAiClient::new(base_url, api_key, Suffix) -> AppResult<Self>`, `.transcribe(&Path, Option<&str>) -> AppResult<(String, Suffix)>` (effective suffix for persistence), `.models() -> AppResult<(Vec<String>, Suffix)>`, `.tidy(model, raw) -> AppResult<(String, Suffix)>`, `voice_ai::is_auth_error(&AppError) -> bool`, `voice_ai::parse_text/parse_models/parse_choice` (private).

- [ ] **Step 1: Failing wiremock tests** — create `voice_ai.rs` with the type skeletons (structs/enums with `todo!()`-free but empty bodies NOT possible — instead write the FULL tests first and let compile failure be the RED):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    struct BodyContains(&'static [u8]);
    impl wiremock::Match for BodyContains {
        fn matches(&self, request: &wiremock::Request) -> bool {
            match &request.body {
                Some(b) => b.windows(self.0.len()).any(|w| w == self.0),
                None => false,
            }
        }
    }

    fn client(uri: &str) -> VoiceAiClient {
        VoiceAiClient::new(uri, "sk-test", Suffix::V1).unwrap()
    }

    async fn mount_ok(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/api/v1/audio/transcriptions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"text": "hello world", "filename": "x.wav"})),
            )
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn transcribe_sends_multipart_bearer_and_parses_text() {
        let s = MockServer::start().await;
        let v1 = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = v1.clone();
        Mock::given(method("POST"))
            .and(path("/api/v1/audio/transcriptions"))
            .and(header("authorization", "Bearer sk-test"))
            .and(BodyContains(b"name=\"file\""))
            .and(BodyContains(b"name=\"language\""))
            .and(BodyContains(b"audio/wav"))
            .respond_with(move |_req: &_| {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"text": "hello world", "filename": "x.wav"}))
            })
            .mount(&s)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("r.wav");
        std::fs::write(&wav, b"RIFF....WAVEfmt ").unwrap();
        let (text, sfx) = client(&s.uri()).transcribe(&wav, Some("en")).await.unwrap();
        assert_eq!(text, "hello world");
        assert_eq!(sfx, Suffix::V1);
        assert_eq!(v1.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn transcribe_falls_back_to_plain_path_on_404() {
        let s = MockServer::start().await;
        let v1 = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let plain = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let c = v1.clone();
            Mock::given(method("POST")).and(path("/api/v1/audio/transcriptions"))
                .respond_with(move |_: &_| {
                    c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    ResponseTemplate::new(404).set_body_string("not found")
                })
                .mount(&s).await;
        }
        {
            let c = plain.clone();
            Mock::given(method("POST")).and(path("/api/audio/transcriptions"))
                .respond_with(move |_: &_| {
                    c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    ResponseTemplate::new(200)
                        .set_body_json(serde_json::json!({"text": "fallback", "filename": "x.wav"}))
                })
                .mount(&s).await;
        }
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("r.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let (text, sfx) = client(&s.uri()).transcribe(&wav, None).await.unwrap();
        assert_eq!(text, "fallback");
        assert_eq!(sfx, Suffix::Plain, "caller persists the effective suffix");
        assert_eq!(v1.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(plain.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn transcribe_401_maps_to_auth_error() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/audio/transcriptions"))
            .respond_with(ResponseTemplate::new(401).set_body_string("bad key"))
            .mount(&s).await;
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("r.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let err = client(&s.uri()).transcribe(&wav, None).await.unwrap_err();
        assert!(is_auth_error(&err), "got {err}");
        assert!(err.to_string().contains("401"));
    }

    #[tokio::test]
    async fn transcribe_missing_file_is_retryable_error() {
        let err = client("http://127.0.0.1:9").transcribe(std::path::Path::new("/no/such.wav"), None).await.unwrap_err();
        assert!(!is_auth_error(&err));
    }

    #[tokio::test]
    async fn transcribe_malformed_response_is_error() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/audio/transcriptions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"foo": 1})))
            .mount(&s).await;
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("r.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        assert!(client(&s.uri()).transcribe(&wav, None).await.is_err());
    }

    #[tokio::test]
    async fn models_parses_data_array_and_bare_array() {
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/v1/models"))
            .respond_with(ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"data": [{"id": "llama3:latest"}, {"id": "qwen2.5:7b"}]})))
            .mount(&s).await;
        let (models, sfx) = client(&s.uri()).models().await.unwrap();
        assert_eq!(models, vec!["llama3:latest", "qwen2.5:7b"]);
        assert_eq!(sfx, Suffix::V1);
        let s2 = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!(["m1", "m2"])))
            .mount(&s2).await;
        let (models2, _) = client(&s2.uri()).models().await.unwrap();
        assert_eq!(models2, vec!["m1", "m2"]);
    }

    #[tokio::test]
    async fn models_404_falls_back_to_plain() {
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/v1/models"))
            .respond_with(ResponseTemplate::new(404)).mount(&s).await;
        Mock::given(method("GET")).and(path("/api/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [{"id": "m"}]})))
            .mount(&s).await;
        let (models, sfx) = client(&s.uri()).models().await.unwrap();
        assert_eq!(models, vec!["m"]);
        assert_eq!(sfx, Suffix::Plain);
    }

    #[tokio::test]
    async fn tidy_sends_model_system_and_user_and_parses_choice() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .and(wiremock::matchers::body_partial_json(serde_json::json!({
                "model": "llama3",
                "messages": [
                    {"role": "system", "content": TIDY_SYSTEM_PROMPT},
                    {"role": "user", "content": "raw memo text"}
                ]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"role": "assistant", "content": "Cleaned text."}}]
            })))
            .mount(&s).await;
        let (tidied, sfx) = client(&s.uri()).tidy("llama3", "raw memo text").await.unwrap();
        assert_eq!(tidied, "Cleaned text.");
        assert_eq!(sfx, Suffix::V1);
    }

    #[tokio::test]
    async fn tidy_404_falls_back_to_plain() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(404)).mount(&s).await;
        Mock::given(method("POST")).and(path("/api/chat/completions"))
            .respond_with(ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"choices": [{"message": {"content": "ok"}}]})))
            .mount(&s).await;
        let (tidied, sfx) = client(&s.uri()).tidy("m", "x").await.unwrap();
        assert_eq!(tidied, "ok");
        assert_eq!(sfx, Suffix::Plain);
    }

    #[test]
    fn suffix_storage_round_trip() {
        assert_eq!(Suffix::from_storage("plain"), Suffix::Plain);
        assert_eq!(Suffix::from_storage("v1"), Suffix::V1);
        assert_eq!(Suffix::from_storage("anything-else"), Suffix::V1);
        assert_eq!(Suffix::V1.as_str(), "v1");
        assert_eq!(Suffix::Plain.as_str(), "plain");
    }

    #[tokio::test]
    async fn client_rejects_non_local_http() {
        assert!(VoiceAiClient::new("http://example.com", "k", Suffix::V1).is_err());
        assert!(VoiceAiClient::new("https://example.com", "k", Suffix::V1).is_ok());
        assert!(VoiceAiClient::new("http://localhost:3000", "k", Suffix::V1).is_ok());
    }
}
```

- [ ] **Step 2: Run RED** — `cargo test transcribe_falls_back` → FAIL (module empty).

- [ ] **Step 3: Implement voice_ai.rs** (register `pub mod voice_ai;` in lib.rs; flip `is_local` to `pub(crate)` in jotty/client.rs; add `"multipart"` to reqwest features — after any Cargo.toml change the FULL cargo suite re-runs):

```rust
//! OpenWebUI client for voice notes (spec 2026-09-18 §3/§4). API facts per the
//! jotty-client skill reference openwebui-api.md — re-verify live via the
//! env-gated integration test (src-tauri/tests/voice_live.rs); never fabricate.
use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// Path-drift rule (spec §3): try /api/v1/... first; on 404 retry the
/// non-versioned path; the caller persists the effective suffix per instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Suffix {
    V1,
    Plain,
}

impl Suffix {
    pub fn as_str(&self) -> &'static str {
        match self {
            Suffix::V1 => "v1",
            Suffix::Plain => "plain",
        }
    }
    pub fn from_storage(s: &str) -> Suffix {
        if s == "plain" { Suffix::Plain } else { Suffix::V1 }
    }
}

/// 30 s for cheap probes; transcription/tidy of an 8-minute WAV on CPU
/// faster-whisper routinely exceeds 30 s (plan ruling 1).
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const LONG_TIMEOUT: Duration = Duration::from_secs(180);

pub const TIDY_SYSTEM_PROMPT: &str = "You tidy voice-memo transcripts. Fix punctuation, capitalization and paragraph breaks. Remove filler words and false starts. Fix obvious transcription slips only when the context makes them unambiguous. Structure the text with short headings or bullet points when the content warrants it. Never invent facts or add commentary. Reply with ONLY the cleaned text — no preamble, no quotes.";

#[derive(Debug, Clone)]
pub struct VoiceAiClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    suffix: Suffix,
}

pub fn is_auth_error(e: &AppError) -> bool {
    matches!(e, AppError::Api { status: 401 | 403, .. })
}

fn is_local(url: &reqwest::Url) -> bool {
    crate::jotty::client::is_local(url)
}

impl VoiceAiClient {
    pub fn new(base_url: &str, api_key: &str, suffix: Suffix) -> AppResult<Self> {
        let url = reqwest::Url::parse(base_url)
            .map_err(|e| AppError::InvalidConfig(format!("bad AI server url: {e}")))?;
        if url.scheme() != "https" && !is_local(&url) {
            return Err(AppError::InvalidConfig(
                "AI server url must be https (http only allowed for localhost)".into(),
            ));
        }
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(PROBE_TIMEOUT)
                .build()
                .map_err(|e| AppError::InvalidConfig(format!("http client: {e}")))?,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            suffix,
        })
    }

    fn base(&self, suffix: Suffix) -> String {
        match suffix {
            Suffix::V1 => format!("{}/api/v1", self.base_url),
            Suffix::Plain => format!("{}/api", self.base_url),
        }
    }

    fn other(&self) -> Suffix {
        if self.suffix == Suffix::V1 { Suffix::Plain } else { Suffix::V1 }
    }

    async fn finish(resp: reqwest::Response) -> AppResult<Value> {
        let status = resp.status();
        if !status.is_success() {
            let s = status.as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Api { status: s, body });
        }
        Ok(resp.json::<Value>().await?)
    }

    async fn transcribe_once(&self, suffix: Suffix, bytes: &[u8], language: Option<&str>) -> AppResult<Value> {
        let mut form = reqwest::multipart::Form::new().part(
            "file",
            reqwest::multipart::Part::bytes(bytes.to_vec())
                .file_name("recording.wav")
                .mime_str("audio/wav")?,
        );
        if let Some(lang) = language {
            form = form.text("language", lang.to_string());
        }
        let resp = self
            .http
            .post(format!("{}/audio/transcriptions", self.base(suffix)))
            .timeout(LONG_TIMEOUT)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .multipart(form)
            .send()
            .await?;
        Self::finish(resp).await
    }

    /// Returns (transcript, effective suffix) — the caller persists the suffix.
    pub async fn transcribe(&self, wav_path: &Path, language: Option<&str>) -> AppResult<(String, Suffix)> {
        let bytes = std::fs::read(wav_path).map_err(|e| AppError::Other(format!("read recording: {e}")))?;
        match self.transcribe_once(self.suffix, &bytes, language).await {
            Ok(v) => Ok((parse_text(&v)?, self.suffix)),
            Err(AppError::Api { status: 404, .. }) => {
                let other = self.other();
                let v = self.transcribe_once(other, &bytes, language).await?;
                Ok((parse_text(&v)?, other))
            }
            Err(e) => Err(e),
        }
    }

    async fn models_once(&self, suffix: Suffix) -> AppResult<Value> {
        let resp = self
            .http
            .get(format!("{}/models", self.base(suffix)))
            .timeout(PROBE_TIMEOUT)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .send()
            .await?;
        Self::finish(resp).await
    }

    pub async fn models(&self) -> AppResult<(Vec<String>, Suffix)> {
        match self.models_once(self.suffix).await {
            Ok(v) => Ok((parse_models(&v)?, self.suffix)),
            Err(AppError::Api { status: 404, .. }) => {
                let other = self.other();
                let v = self.models_once(other).await?;
                Ok((parse_models(&v)?, other))
            }
            Err(e) => Err(e),
        }
    }

    async fn chat_once(&self, suffix: Suffix, body: &Value) -> AppResult<Value> {
        let resp = self
            .http
            .post(format!("{}/chat/completions", self.base(suffix)))
            .timeout(LONG_TIMEOUT)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(body)
            .send()
            .await?;
        Self::finish(resp).await
    }

    pub async fn tidy(&self, model: &str, raw: &str) -> AppResult<(String, Suffix)> {
        let body = serde_json::json!({
            "model": model,
            "messages": [
                {"role": "system", "content": TIDY_SYSTEM_PROMPT},
                {"role": "user", "content": raw}
            ]
        });
        match self.chat_once(self.suffix, &body).await {
            Ok(v) => Ok((parse_choice(&v)?, self.suffix)),
            Err(AppError::Api { status: 404, .. }) => {
                let other = self.other();
                let v = self.chat_once(other, &body).await?;
                Ok((parse_choice(&v)?, other))
            }
            Err(e) => Err(e),
        }
    }
}

fn parse_text(v: &Value) -> AppResult<String> {
    v.get("text")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Other("transcription response missing text".into()))
}

/// OpenWebUI returns OpenAI-compatible {"data":[{"id":...}]}; a bare array is
/// accepted defensively.
fn parse_models(v: &Value) -> AppResult<Vec<String>> {
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| v.as_array())
        .ok_or_else(|| AppError::Other("models response missing data array".into()))?;
    Ok(arr
        .iter()
        .filter_map(|m| {
            if let Some(s) = m.as_str() {
                Some(s.to_string())
            } else {
                m.get("id").and_then(|i| i.as_str()).map(|s| s.to_string())
            }
        })
        .collect())
}

fn parse_choice(v: &Value) -> AppResult<String> {
    v.pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Other("chat response missing choices[0].message.content".into()))
}
```

(wiremock note: if your wiremock 0.6.x `Request.body` is a plain `Bytes` rather than `Option<Bytes>`, drop the Option guard in `BodyContains` — the custom-matcher shape stands.)

- [ ] **Step 4: Gates** — `cargo test` (all new + full suite; reqwest feature bump re-runs everything), `npx vitest run`, `npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(voice): openwebui client - multipart transcriptions, models, tidy, dual-path fallback"`.

---

### Task 5: AI keyring entry + AI settings commands + ai_get_models

**Files:**
- Modify: `src-tauri/src/keys.rs` (shared account helpers + `AiOsKeyStore`)
- Modify: `src-tauri/src/state.rs` (`AppState.ai_keystore` + `new()` param)
- Modify: `src-tauri/src/commands/mod.rs` (get_ai_settings / set_ai_settings / ai_get_models + prefs helpers + `build_ai_client`)
- Modify: `src-tauri/src/commands/dto.rs` (AiSettingsDto)
- Modify: `src-tauri/src/lib.rs` (AppState::new arg, command registration)
- Test: `keys.rs` tests, `commands/mod.rs` tests

**Interfaces:**
- Consumes: Task 4 (`VoiceAiClient`, `Suffix`, `.models()`).
- Produces: `keys::AI_ACCOUNT = "openwebui-key"`, `keys::AiOsKeyStore`; `AppState { ai_keystore: Box<dyn keys::KeyStore>, .. }` + `AppState::new(conn, keystore, ai_keystore)`; `commands::{ai_base_url(conn) -> AppResult<String>, ai_model(conn), ai_language_hint(conn), ai_suffix(conn) -> AppResult<Suffix>, persist_ai_suffix(conn, Suffix), kv_set(conn,key,value), build_ai_client(&State) -> AppResult<VoiceAiClient>, ai_models_core(&VoiceAiClient, &Connection) -> AppResult<Vec<String>>, get_ai_settings_inner(conn, &dyn KeyStore), set_ai_settings_inner(conn, &dyn KeyStore, Option<String>, Option<String>, Option<String>, Option<String>)}`; commands `get_ai_settings() -> AiSettingsDto`, `set_ai_settings(baseUrl, model, languageHint, apiKey) -> AiSettingsDto`, `ai_get_models() -> Vec<String>`; `dto::AiSettingsDto { baseUrl, model, languageHint, apiPathSuffix, hasKey }`.

- [ ] **Step 1: Failing tests** — commands tests mod:

```rust
    #[test]
    fn get_ai_settings_defaults_are_empty_and_unkeyed() {
        let conn = db();
        let ks = crate::keys::MockKeyStore::default();
        let s = get_ai_settings_inner(&conn, &ks).unwrap();
        assert_eq!(s.base_url, "");
        assert_eq!(s.model, "");
        assert_eq!(s.language_hint, "");
        assert_eq!(s.api_path_suffix, "v1");
        assert!(!s.has_key);
    }

    #[test]
    fn set_ai_settings_stores_prefs_and_key_round_trip() {
        let conn = db();
        let ks = crate::keys::MockKeyStore::default();
        let s = set_ai_settings_inner(
            &conn, &ks,
            Some("https://ai.example.com".into()),
            Some("llama3".into()),
            Some("en".into()),
            Some("sk-abc".into()),
        ).unwrap();
        assert_eq!(s.base_url, "https://ai.example.com");
        assert_eq!(s.model, "llama3");
        assert_eq!(s.language_hint, "en");
        assert!(s.has_key);
        assert_eq!(ks.get().unwrap().as_deref(), Some("sk-abc"));
        // empty key clears the keyring entry
        let s2 = set_ai_settings_inner(&conn, &ks, None, None, None, Some("".into())).unwrap();
        assert!(!s2.has_key);
        assert_eq!(ks.get().unwrap(), None);
    }

    #[test]
    fn set_ai_settings_rejects_non_local_http() {
        let conn = db();
        let ks = crate::keys::MockKeyStore::default();
        let err = set_ai_settings_inner(&conn, &ks, Some("http://example.com".into()), None, None, None).unwrap_err();
        assert!(err.to_string().contains("https"));
        // nothing persisted
        assert_eq!(ai_base_url(&conn).unwrap(), "");
    }

    #[test]
    fn ai_suffix_defaults_to_v1_and_persists_effective() {
        let conn = db();
        assert_eq!(ai_suffix(&conn).unwrap(), crate::voice_ai::Suffix::V1);
        persist_ai_suffix(&conn, crate::voice_ai::Suffix::Plain).unwrap();
        assert_eq!(ai_suffix(&conn).unwrap(), crate::voice_ai::Suffix::Plain);
        persist_ai_suffix(&conn, crate::voice_ai::Suffix::Plain).unwrap(); // idempotent
        let v: String = conn.query_row("SELECT value FROM sync_state WHERE key='ai_api_suffix'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "plain");
    }

    #[tokio::test]
    async fn ai_models_core_returns_models_and_persists_fallback_suffix() {
        let s = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/api/v1/models"))
            .respond_with(wiremock::ResponseTemplate::new(404))
            .mount(&s).await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/api/models"))
            .respond_with(wiremock::ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"data": [{"id": "m1"}]})))
            .mount(&s).await;
        let conn = db();
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk", crate::voice_ai::Suffix::V1).unwrap();
        let models = ai_models_core(&ai, &conn).await.unwrap();
        assert_eq!(models, vec!["m1"]);
        assert_eq!(ai_suffix(&conn).unwrap(), crate::voice_ai::Suffix::Plain);
    }

    #[test]
    fn app_state_holds_two_keystores() {
        let conn = db();
        let state = AppState::new(conn, Box::new(crate::keys::MockKeyStore::default()), Box::new(crate::keys::MockKeyStore::default())).unwrap();
        state.ai_keystore.set("sk-1").unwrap();
        state.keystore.set("ck-1").unwrap();
        assert_eq!(state.ai_keystore.get().unwrap().as_deref(), Some("sk-1"));
        assert_eq!(state.keystore.get().unwrap().as_deref(), Some("ck-1"));
    }
```

(Adapt the `db()` helper name to the file's existing one. Update ALL existing `AppState::new(conn, Box::new(MockKeyStore::default()))` call sites — there are 6 in this file — to pass a second `Box::new(MockKeyStore::default())`.)

- [ ] **Step 2: Run RED** — compile errors (no ai_keystore/inners).

- [ ] **Step 3: Implement keys.rs** — refactor OsKeyStore to shared account-parameterized helpers and add AiOsKeyStore:

```rust
pub const AI_ACCOUNT: &str = "openwebui-key";

fn entry(account: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, account).map_err(|e| AppError::Keyring(e.to_string()))
}

fn get_for(account: &str) -> AppResult<Option<String>> {
    match entry(account)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}

fn set_for(account: &str, key: &str) -> AppResult<()> {
    entry(account)?.set_password(key).map_err(|e| AppError::Keyring(e.to_string()))
}

fn delete_for(account: &str) -> AppResult<()> {
    match entry(account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}

impl KeyStore for OsKeyStore {
    fn get(&self) -> AppResult<Option<String>> { get_for(ACCOUNT) }
    fn set(&self, key: &str) -> AppResult<()> { set_for(ACCOUNT, key) }
    fn delete(&self) -> AppResult<()> { delete_for(ACCOUNT) }
}

/// Same service, AI account (spec §4: jotty-desktop / openwebui-key).
/// Untestable headlessly — desktop smoke check remains a release gate.
pub struct AiOsKeyStore;

impl KeyStore for AiOsKeyStore {
    fn get(&self) -> AppResult<Option<String>> { get_for(AI_ACCOUNT) }
    fn set(&self, key: &str) -> AppResult<()> { set_for(AI_ACCOUNT, key) }
    fn delete(&self) -> AppResult<()> { delete_for(AI_ACCOUNT) }
}
```

- [ ] **Step 4: Implement state.rs** — add `pub ai_keystore: Box<dyn keys::KeyStore>,` to the struct and the `new()` signature/initializer.

- [ ] **Step 5: Implement lib.rs** — `AppState::new(conn, Box::new(keys::OsKeyStore), Box::new(keys::AiOsKeyStore))?;` and register the three commands.

- [ ] **Step 6: Implement dto.rs**:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsDto {
    pub base_url: String,
    pub model: String,
    pub language_hint: String,
    pub api_path_suffix: String,
    pub has_key: bool,
}
```

- [ ] **Step 7: Implement commands** (in `commands/mod.rs`):

```rust
// ---- AI server settings (voice notes, spec §2.5/§4) ------------------------
// Key ONLY in the keyring; everything else is a plain sync_state pref.

pub(crate) fn kv_set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sync_state(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

fn kv_get_or(conn: &Connection, key: &str, default: &str) -> AppResult<String> {
    let v: Option<String> = conn
        .query_row("SELECT value FROM sync_state WHERE key=?1", [key], |r| r.get(0))
        .optional()?;
    Ok(v.unwrap_or_else(|| default.to_string()))
}

pub(crate) fn ai_base_url(conn: &Connection) -> AppResult<String> { kv_get_or(conn, "ai_base_url", "") }
pub(crate) fn ai_model(conn: &Connection) -> AppResult<String> { kv_get_or(conn, "ai_model", "") }
pub(crate) fn ai_language_hint(conn: &Connection) -> AppResult<String> { kv_get_or(conn, "ai_language_hint", "") }
pub(crate) fn ai_suffix(conn: &Connection) -> AppResult<crate::voice_ai::Suffix> {
    Ok(crate::voice_ai::Suffix::from_storage(&kv_get_or(conn, "ai_api_suffix", "v1")?))
}
pub(crate) fn persist_ai_suffix(conn: &Connection, effective: crate::voice_ai::Suffix) -> AppResult<()> {
    if ai_suffix(conn)? != effective {
        kv_set(conn, "ai_api_suffix", effective.as_str())?;
    }
    Ok(())
}

pub(crate) async fn build_ai_client(state: &tauri::State<'_, AppState>) -> AppResult<crate::voice_ai::VoiceAiClient> {
    let (base, suffix) = {
        let conn = state.db.lock().await;
        (ai_base_url(&conn)?, ai_suffix(&conn)?)
    };
    if base.trim().is_empty() {
        return Err(crate::error::AppError::Other("AI server not configured".into()));
    }
    let key = state
        .ai_keystore
        .get()?
        .ok_or_else(|| crate::error::AppError::Other("AI server API key not set".into()))?;
    crate::voice_ai::VoiceAiClient::new(&base, &key, suffix)
}

pub(crate) fn get_ai_settings_inner(conn: &Connection, ai_keystore: &dyn crate::keys::KeyStore) -> AppResult<AiSettingsDto> {
    Ok(AiSettingsDto {
        base_url: ai_base_url(conn)?,
        model: ai_model(conn)?,
        language_hint: ai_language_hint(conn)?,
        api_path_suffix: ai_suffix(conn)?.as_str().into(),
        has_key: ai_keystore.get()?.is_some(),
    })
}

pub(crate) fn set_ai_settings_inner(
    conn: &Connection,
    ai_keystore: &dyn crate::keys::KeyStore,
    base_url: Option<String>,
    model: Option<String>,
    language_hint: Option<String>,
    api_key: Option<String>,
) -> AppResult<AiSettingsDto> {
    if let Some(u) = base_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // validate with the same rule the client enforces (https, or http on localhost)
        let _ = crate::voice_ai::VoiceAiClient::new(u, "unused", crate::voice_ai::Suffix::V1)?;
        kv_set(conn, "ai_base_url", u)?;
    }
    if let Some(m) = model.as_deref().map(str::trim) {
        kv_set(conn, "ai_model", m)?; // empty clears
    }
    if let Some(l) = language_hint.as_deref().map(str::trim) {
        kv_set(conn, "ai_language_hint", l)?; // empty clears
    }
    if let Some(k) = api_key.as_deref().map(str::trim) {
        if k.is_empty() {
            ai_keystore.delete()?;
        } else {
            ai_keystore.set(k)?;
        }
    }
    get_ai_settings_inner(conn, ai_keystore)
}

pub(crate) async fn ai_models_core(
    ai: &crate::voice_ai::VoiceAiClient,
    conn: &Connection,
) -> AppResult<Vec<String>> {
    let (models, sfx) = ai.models().await?;
    persist_ai_suffix(conn, sfx)?;
    Ok(models)
}

#[tauri::command]
pub async fn get_ai_settings(state: tauri::State<'_, AppState>) -> Result<AiSettingsDto, String> {
    let conn = state.db.lock().await;
    get_ai_settings_inner(&conn, state.ai_keystore.as_ref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_ai_settings(
    state: tauri::State<'_, AppState>,
    base_url: Option<String>,
    model: Option<String>,
    language_hint: Option<String>,
    api_key: Option<String>,
) -> Result<AiSettingsDto, String> {
    let conn = state.db.lock().await;
    set_ai_settings_inner(&conn, state.ai_keystore.as_ref(), base_url, model, language_hint, api_key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_get_models(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let ai = build_ai_client(&state).await.map_err(|e| e.to_string())?;
    let conn = state.db.lock().await;
    ai_models_core(&ai, &conn).await.map_err(|e| e.to_string())
}
```

- [ ] **Step 8: Gates** — `cargo test` (all call sites updated, suite green), `npx vitest run`, `npx tsc --noEmit`.

- [ ] **Step 9: Commit** — `git add -A && git commit -m "feat(voice): AI settings + keyring entry (openwebui-key) + ai_get_models"`.

---

### Task 6: Transcribe + tidy commands (state machine) + voice_list_unsaved

**Files:**
- Modify: `src-tauri/src/commands/mod.rs` (voice_transcribe / voice_tidy / voice_list_unsaved + inners)
- Modify: `src-tauri/src/commands/dto.rs` (TidyDto)
- Modify: `src-tauri/src/lib.rs` (register)
- Test: `commands/mod.rs` tests

**Interfaces:**
- Consumes: Task 4 client, Task 5 `build_ai_client`/`persist_ai_suffix`/`ai_language_hint`/`ai_model`, Task 2 staging helpers.
- Produces: commands `voice_transcribe(recordingId) -> VoiceRecordingDto`, `voice_tidy(recordingId: Option<String>, raw: String) -> TidyDto { tidied }`, `voice_list_unsaved() -> Vec<VoiceRecordingDto>`; `commands::voice_transcribe_inner(&mut Connection, &VoiceAiClient, Option<&str>, &str) -> AppResult<VoiceRecordingDto>` (async), `commands::voice_tidy_inner(&mut Connection, &VoiceAiClient, &str, Option<&str>, &str) -> AppResult<TidyDto>` (async); `dto::TidyDto { tidied: String }`.

- [ ] **Step 1: Failing tests** — commands tests:

```rust
    fn staged(conn: &Connection, id: &str, state: &str, raw: Option<&str>, tidied: Option<&str>) {
        crate::db::voice::create_staging(conn, id, "/tmp/t.wav").unwrap();
        if state == crate::db::voice::ST_RECORDED {
            crate::db::voice::mark_recorded(conn, id, 3.0).unwrap();
        }
        if state == crate::db::voice::ST_TRANSCRIBING { crate::db::voice::mark_transcribing(conn, id).unwrap(); }
        if let Some(r) = raw { crate::db::voice::set_transcript(conn, id, r).unwrap(); }
        if let Some(t) = tidied { crate::db::voice::set_tidied(conn, id, t).unwrap(); }
    }

    fn ai_mock_ok_text(text: &str) -> crate::voice_ai::VoiceAiClient {
        // built against a live MockServer by the caller — helper below keeps
        // call sites short; the mock is mounted per test
        crate::voice_ai::VoiceAiClient::new("http://127.0.0.1:1", "sk", crate::voice_ai::Suffix::V1).unwrap()
    }

    #[tokio::test]
    async fn transcribe_success_sets_transcribed_with_raw() {
        let s = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/v1/audio/transcriptions"))
            .respond_with(wiremock::ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"text": "the transcript", "filename": "x.wav"})))
            .mount(&s).await;
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("t.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let conn = db();
        crate::db::voice::create_staging(&conn, "r1", wav.to_string_lossy().as_ref()).unwrap();
        crate::db::voice::mark_recorded(&conn, "r1", 2.0).unwrap();
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk", crate::voice_ai::Suffix::V1).unwrap();
        let dto = voice_transcribe_inner(&mut conn.clone(), &ai, None, "r1").await.unwrap();
        assert_eq!(dto.state, crate::db::voice::ST_TRANSCRIBED);
        assert_eq!(dto.raw_transcript.as_deref(), Some("the transcript"));
        assert!(dto.last_error.is_none());
    }

    #[tokio::test]
    async fn transcribe_500_marks_retryable_failed_with_error_text() {
        let s = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/v1/audio/transcriptions"))
            .respond_with(wiremock::ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&s).await;
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("t.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let mut conn = db();
        crate::db::voice::create_staging(&conn, "r1", wav.to_string_lossy().as_ref()).unwrap();
        crate::db::voice::mark_recorded(&conn, "r1", 2.0).unwrap();
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk", crate::voice_ai::Suffix::V1).unwrap();
        let dto = voice_transcribe_inner(&mut conn, &ai, None, "r1").await.unwrap(); // Ok(dto), failed state
        assert_eq!(dto.state, crate::db::voice::ST_FAILED);
        assert!(dto.last_error.as_deref().unwrap().contains("boom"));
    }

    #[tokio::test]
    async fn transcribe_401_marks_failed_auth_distinctly() {
        let s = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/v1/audio/transcriptions"))
            .respond_with(wiremock::ResponseTemplate::new(401).set_body_string("bad key"))
            .mount(&s).await;
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("t.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let mut conn = db();
        crate::db::voice::create_staging(&conn, "r1", wav.to_string_lossy().as_ref()).unwrap();
        crate::db::voice::mark_recorded(&conn, "r1", 2.0).unwrap();
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk", crate::voice_ai::Suffix::V1).unwrap();
        let dto = voice_transcribe_inner(&mut conn, &ai, None, "r1").await.unwrap();
        assert_eq!(dto.state, crate::db::voice::ST_FAILED_AUTH);
        // retry hook only picks up ST_FAILED — this row is excluded there
        assert!(crate::db::voice::list_failed(&conn).unwrap().is_empty());
    }

    #[tokio::test]
    async fn transcribe_fallback_persists_plain_suffix() {
        let s = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/v1/audio/transcriptions"))
            .respond_with(wiremock::ResponseTemplate::new(404)).mount(&s).await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/audio/transcriptions"))
            .respond_with(wiremock::ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"text": "via plain", "filename": "x.wav"})))
            .mount(&s).await;
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("t.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let mut conn = db();
        crate::db::voice::create_staging(&conn, "r1", wav.to_string_lossy().as_ref()).unwrap();
        crate::db::voice::mark_recorded(&conn, "r1", 2.0).unwrap();
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk", crate::voice_ai::Suffix::V1).unwrap();
        voice_transcribe_inner(&mut conn, &ai, None, "r1").await.unwrap();
        assert_eq!(ai_suffix(&conn).unwrap(), crate::voice_ai::Suffix::Plain);
    }

    #[tokio::test]
    async fn transcribe_while_recording_is_rejected_and_transcribed_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("t.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let mut conn = db();
        let ai = ai_mock_ok_text("");
        crate::db::voice::create_staging(&conn, "r1", wav.to_string_lossy().as_ref()).unwrap();
        assert!(voice_transcribe_inner(&mut conn, &ai, None, "r1").await.is_err(), "still recording");
        crate::db::voice::mark_recorded(&conn, "r1", 1.0).unwrap();
        crate::db::voice::set_transcript(&conn, "r1", "done").unwrap();
        let dto = voice_transcribe_inner(&mut conn, &ai, None, "r1").await.unwrap();
        assert_eq!(dto.state, crate::db::voice::ST_TRANSCRIBED); // no second request (no server running)
    }

    #[tokio::test]
    async fn tidy_persists_to_row_only_when_id_given() {
        let s = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/v1/chat/completions"))
            .respond_with(wiremock::ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"choices": [{"message": {"content": "Tidied."}}]})))
            .mount(&s).await;
        let mut conn = db();
        staged(&conn, "r1", crate::db::voice::ST_TRANSCRIBED, Some("raw"), None);
        kv_set(&conn, "ai_model", "llama3").unwrap();
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk", crate::voice_ai::Suffix::V1).unwrap();
        let dto = voice_tidy_inner(&mut conn, &ai, "llama3", Some("r1"), "raw").await.unwrap();
        assert_eq!(dto.tidied, "Tidied.");
        assert_eq!(crate::db::voice::get(&conn, "r1").unwrap().unwrap().tidied_transcript.as_deref(), Some("Tidied."));
        // raw untouched
        assert_eq!(crate::db::voice::get(&conn, "r1").unwrap().unwrap().raw_transcript.as_deref(), Some("raw"));
        // no id: returned only, nothing persisted
        let dto2 = voice_tidy_inner(&mut conn, &ai, "llama3", None, "raw2").await.unwrap();
        assert_eq!(dto2.tidied, "Tidied.");
        assert!(crate::db::voice::list_unsaved(&conn).unwrap().iter().all(|r| r.tidied_transcript.is_none() || r.id != "r9"));
    }

    #[tokio::test]
    async fn tidy_failure_returns_err_and_leaves_row_untouched() {
        let mut conn = db();
        staged(&conn, "r1", crate::db::voice::ST_TRANSCRIBED, Some("raw"), None);
        let ai = ai_mock_ok_text(""); // unreachable server
        assert!(voice_tidy_inner(&mut conn, &ai, "llama3", Some("r1"), "raw").await.is_err());
        assert!(crate::db::voice::get(&conn, "r1").unwrap().unwrap().tidied_transcript.is_none());
    }

    #[tokio::test]
    async fn tidy_requires_a_model() {
        let mut conn = db();
        let ai = ai_mock_ok_text("");
        assert!(voice_tidy_inner(&mut conn, &ai, "", None, "raw").await.is_err());
    }

    #[test]
    fn list_unsaved_maps_rows_to_dtos() {
        let conn = db();
        staged(&conn, "r1", crate::db::voice::ST_TRANSCRIBED, Some("raw"), Some("tid"));
        let rows = voice_list_unsaved_inner(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "r1");
        assert_eq!(rows[0].state, crate::db::voice::ST_TRANSCRIBED);
    }
```

(Remove the unused `staged` state-branch lines the executor finds dead — keep the helper minimal but functional. The `ai_mock_ok_text` helper intentionally returns an unreachable client for failure-path tests; success-path tests build their own client against a MockServer.)

- [ ] **Step 2: Run RED** — `cargo test transcribe_500` etc. FAIL (inners undefined).

- [ ] **Step 3: Implement** — commands + dto:

```rust
// dto.rs
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TidyDto {
    pub tidied: String,
}
```

```rust
// commands/mod.rs
pub(crate) async fn voice_transcribe_inner(
    conn: &mut Connection,
    ai: &crate::voice_ai::VoiceAiClient,
    language: Option<&str>,
    recording_id: &str,
) -> AppResult<VoiceRecordingDto> {
    let rec = crate::db::voice::get(conn, recording_id)?
        .ok_or_else(|| crate::error::AppError::Other(format!("recording {recording_id} not found")))?;
    if rec.state == crate::db::voice::ST_RECORDING {
        return Err(crate::error::AppError::Other("recording still in progress".into()));
    }
    if rec.state == crate::db::voice::ST_TRANSCRIBED {
        return Ok(rec.into()); // idempotent: no second request
    }
    // 'recorded' | 'transcribing' (stale after restart) | failed states are all retryable
    crate::db::voice::mark_transcribing(conn, recording_id)?;
    match ai.transcribe(std::path::Path::new(&rec.path), language).await {
        Ok((text, sfx)) => {
            persist_ai_suffix(conn, sfx)?;
            crate::db::voice::set_transcript(conn, recording_id, &text)?;
        }
        Err(e) => {
            crate::db::voice::mark_failed(conn, recording_id, crate::voice_ai::is_auth_error(&e), &e.to_string())?;
        }
    }
    voice_dto(conn, recording_id)
}

#[tauri::command]
pub async fn voice_transcribe(
    state: tauri::State<'_, AppState>,
    recording_id: String,
) -> Result<VoiceRecordingDto, String> {
    let ai = build_ai_client(&state).await.map_err(|e| e.to_string())?;
    let hint = { let conn = state.db.lock().await; ai_language_hint(&conn).map_err(|e| e.to_string())? };
    let language = if hint.trim().is_empty() { None } else { Some(hint.trim().to_string()) };
    let mut conn = state.db.lock().await;
    voice_transcribe_inner(&mut conn, &ai, language.as_deref(), &recording_id)
        .await
        .map_err(|e| e.to_string())
}

pub(crate) async fn voice_tidy_inner(
    conn: &mut Connection,
    ai: &crate::voice_ai::VoiceAiClient,
    model: &str,
    recording_id: Option<&str>,
    raw: &str,
) -> AppResult<TidyDto> {
    if model.trim().is_empty() {
        return Err(crate::error::AppError::Other("tidy model not configured — pick one in Settings".into()));
    }
    let (tidied, sfx) = ai.tidy(model, raw).await?;
    persist_ai_suffix(conn, sfx)?;
    if let Some(id) = recording_id {
        crate::db::voice::set_tidied(conn, id, &tidied)?;
    }
    Ok(TidyDto { tidied })
}

#[tauri::command]
pub async fn voice_tidy(
    state: tauri::State<'_, AppState>,
    recording_id: Option<String>,
    raw: String,
) -> Result<TidyDto, String> {
    let ai = build_ai_client(&state).await.map_err(|e| e.to_string())?;
    let model = { let conn = state.db.lock().await; ai_model(&conn).map_err(|e| e.to_string())? };
    let mut conn = state.db.lock().await;
    voice_tidy_inner(&mut conn, &ai, &model, recording_id.as_deref(), &raw)
        .await
        .map_err(|e| e.to_string())
}

fn voice_list_unsaved_inner(conn: &Connection) -> AppResult<Vec<VoiceRecordingDto>> {
    Ok(crate::db::voice::list_unsaved(conn)?.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn voice_list_unsaved(state: tauri::State<'_, AppState>) -> Result<Vec<VoiceRecordingDto>, String> {
    let conn = state.db.lock().await;
    voice_list_unsaved_inner(&conn).map_err(|e| e.to_string())
}
```

Register all three in lib.rs `generate_handler!`.

- [ ] **Step 4: Gates** — `cargo test`, `npx vitest run`, `npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(voice): transcribe + tidy commands with staging state machine"`.

---

### Task 7: voice_save_note (single tx, shared create-note inner) + note-level transcribe/delete-audio

**Files:**
- Modify: `src-tauri/src/commands/mod.rs` (extract `create_note_tx`, voice_save_note, voice_transcribe_note, voice_delete_note_audio)
- Modify: `src-tauri/src/commands/dto.rs` (NoteTranscribeDto)
- Modify: `src-tauri/src/lib.rs` (register)
- Test: `commands/mod.rs` tests

**Interfaces:**
- Consumes: Task 2 staging helpers, Task 4 client, Task 5 suffix helpers.
- Produces: `commands::create_note_tx(tx: &rusqlite::Transaction, title, content, category) -> AppResult<notes::NoteRow>` (behavior-identical refactor of create_note_inner's body); commands `voice_save_note(recordingId, title, category, useTidied, contentOverride: Option<String>) -> NoteDto`, `voice_transcribe_note(noteId) -> NoteTranscribeDto { text }`, `voice_delete_note_audio(noteId) -> NoteDto`; `dto::NoteTranscribeDto { text: String }`.

- [ ] **Step 1: Failing tests**:

```rust
    #[test]
    fn create_note_inner_behavior_unchanged_after_tx_refactor() {
        // byte-equivalence fence: refactor must not alter create-note invariants
        let mut conn = db();
        let dto = create_note_inner(&mut conn, "T", "Home").unwrap();
        let ops = crate::db::outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "create");
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(payload["temp_id"], dto.id);
        assert_eq!(payload["content"], "");
        let note = crate::db::notes::get(&conn, &dto.id).unwrap().unwrap();
        assert!(note.dirty);
        assert_eq!(note.content, "");
    }

    fn stage_transcribed_with_file(dir: &tempfile::TempDir, conn: &Connection, id: &str, raw: Option<&str>, tidied: Option<&str>, duration: f64) -> String {
        let wav = dir.path().join(format!("{id}.wav"));
        std::fs::write(&wav, b"RIFF").unwrap();
        crate::db::voice::create_staging(conn, id, wav.to_string_lossy().as_ref()).unwrap();
        crate::db::voice::mark_recorded(conn, id, duration).unwrap();
        if let Some(r) = raw { crate::db::voice::set_transcript(conn, id, r).unwrap(); }
        if let Some(t) = tidied { crate::db::voice::set_tidied(conn, id, t).unwrap(); }
        wav.to_string_lossy().into_owned()
    }

    #[test]
    fn voice_save_note_one_tx_note_audio_outbox_staging_delete() {
        let mut conn = db();
        let dir = tempfile::tempdir().unwrap();
        let path = stage_transcribed_with_file(&dir, &conn, "r1", Some("hello memo"), None, 12.5);
        let note = voice_save_note_inner(&mut conn, "r1", "My Memo", "Home", false, None).unwrap();
        // note created with raw content + audio columns
        assert_eq!(note.content, "hello memo");
        assert_eq!(note.audio_path.as_deref(), Some(path.as_str()));
        assert_eq!(note.audio_duration_secs, Some(12.5));
        // exactly ONE outbox op: create with temp_id + content
        let ops = crate::db::outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "create");
        let payload: serde_json::Value = serde_json::from_str(&ops[0].payload).unwrap();
        assert_eq!(payload["temp_id"], note.id);
        assert_eq!(payload["content"], "hello memo");
        // staging row deleted; file kept on disk
        assert!(crate::db::voice::get(&conn, "r1").unwrap().is_none());
        assert!(std::path::Path::new(&path).exists());
        // FTS: transcript is searchable (spec §5)
        let hits: Vec<String> = conn
            .prepare("SELECT id FROM notes_fts WHERE notes_fts MATCH 'memo'").unwrap()
            .query_map([], |r| r.get(0)).unwrap()
            .map(Result::unwrap).collect();
        assert_eq!(hits, vec![note.id]);
    }

    #[test]
    fn voice_save_note_tidied_and_override_rules() {
        let mut conn = db();
        let dir = tempfile::tempdir().unwrap();
        let _ = stage_transcribed_with_file(&dir, &conn, "r2", Some("raw text"), Some("Raw, tidied."), 3.0);
        let a = voice_save_note_inner(&mut conn, "r2", "t", "Home", true, None).unwrap();
        assert_eq!(a.content, "Raw, tidied.");
        let mut conn2 = db();
        let _ = stage_transcribed_with_file(&dir, &conn2, "r3", Some("raw text"), Some("Tidied!"), 3.0);
        // useTidied but no tidied stored -> raw fallback (spec §6)
        let b = voice_save_note_inner(&mut conn2, "r3", "t", "Home", true, None).unwrap();
        assert_eq!(b.content, "raw text");
        // override wins over both (spec §2 review/edit -> save; plan ruling 3)
        let c = voice_save_note_inner(&mut conn2, "r3", "t", "Home", false, Some("user edited text".into())).unwrap();
        assert_eq!(c.content, "user edited text");
    }

    #[test]
    fn voice_save_note_empty_transcript_saves_with_pending_state() {
        let mut conn = db();
        let dir = tempfile::tempdir().unwrap();
        let _ = stage_transcribed_with_file(&dir, &conn, "r4", None, None, 5.0);
        let note = voice_save_note_inner(&mut conn, "r4", "t", "Home", false, None).unwrap();
        assert_eq!(note.content, "");
        assert!(note.audio_path.is_some()); // retry hook will fill content later
    }

    #[test]
    fn voice_save_note_unknown_or_recording_row_errors_rolls_back() {
        let mut conn = db();
        assert!(voice_save_note_inner(&mut conn, "nope", "t", "Home", false, None).is_err());
        let dir = tempfile::tempdir().unwrap();
        crate::db::voice::create_staging(&conn, "live", dir.path().join("l.wav").to_string_lossy().as_ref()).unwrap();
        assert!(voice_save_note_inner(&mut conn, "live", "t", "Home", false, None).is_err());
        // nothing half-saved
        assert_eq!(crate::db::outbox::next_batch(&conn, 10).unwrap().len(), 0);
        assert_eq!(crate::db::notes::list(&conn, true).unwrap().len(), 0);
    }

    #[tokio::test]
    async fn voice_transcribe_note_requires_audio_and_transcribes() {
        let s = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/api/v1/audio/transcriptions"))
            .respond_with(wiremock::ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"text": "note transcript", "filename": "x.wav"})))
            .mount(&s).await;
        let mut conn = db();
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("n.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        conn.execute(
            "INSERT INTO notes (id,title,content,category,created_at,updated_at,dirty,audio_path) VALUES ('n1','t','','Home','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',1,?1)",
            rusqlite::params![wav.to_string_lossy().as_ref()],
        ).unwrap();
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk", crate::voice_ai::Suffix::V1).unwrap();
        let res = voice_transcribe_note_inner(&mut conn, &ai, None, "n1").await.unwrap();
        assert_eq!(res.text, "note transcript");
        // note without audio errors; unknown note errors
        conn.execute("UPDATE notes SET audio_path=NULL WHERE id='n1'", []).unwrap();
        assert!(voice_transcribe_note_inner(&mut conn, &ai, None, "n1").await.is_err());
        assert!(voice_transcribe_note_inner(&mut conn, &ai, None, "ghost").await.is_err());
    }

    #[test]
    fn voice_delete_note_audio_is_local_only() {
        let mut conn = db();
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("n.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        conn.execute(
            "INSERT INTO notes (id,title,content,category,created_at,updated_at,dirty,audio_path,audio_duration_secs) VALUES ('n1','t','keep text','Home','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',1,?1,9.0)",
            rusqlite::params![wav.to_string_lossy().as_ref()],
        ).unwrap();
        let note = voice_delete_note_audio_inner(&mut conn, "n1").unwrap();
        assert!(note.audio_path.is_none());
        assert_eq!(note.content, "keep text");
        assert!(!wav.exists(), "file removed");
        // LOCAL-ONLY: no outbox op, no dirty flag (sync must never see this)
        assert_eq!(crate::db::outbox::next_batch(&conn, 10).unwrap().len(), 0);
        let row = crate::db::notes::get(&conn, "n1").unwrap().unwrap();
        assert!(!row.dirty);
        assert_eq!(row.audio_duration_secs, None);
    }
```

- [ ] **Step 2: Run RED** — `cargo test voice_save_note` FAIL.

- [ ] **Step 3: Implement** — refactor + three inners + commands:

```rust
// commands/mod.rs — create_note_inner becomes:
pub(crate) fn create_note_inner(conn: &mut Connection, title: &str, category: &str) -> AppResult<NoteDto> {
    let tx = conn.transaction()?;
    let row = create_note_tx(&tx, title, "", category)?;
    tx.commit()?;
    Ok(NoteDto::from(row))
}

/// Single source of truth for note creation (entity + outbox create op with
/// temp_id). Used by create_note_inner and voice_save_note so the sync
/// invariants stay untouched (spec §5). BEHAVIOR-IDENTICAL refactor.
pub(crate) fn create_note_tx(
    tx: &rusqlite::Transaction,
    title: &str,
    content: &str,
    category: &str,
) -> AppResult<crate::db::notes::NoteRow> {
    let row = crate::db::notes::insert_local(tx, &crate::db::notes::NewNote {
        title: title.into(),
        content: content.into(),
        category: category.into(),
    })?;
    // Ruling E: note create payload = {temp_id (REQUIRED — push remaps via it), title, content, category}.
    crate::db::outbox::enqueue(tx, "create", "note", &row.id, &serde_json::json!({
        "temp_id": &row.id, "title": &row.title, "content": &row.content, "category": &row.category
    }))?;
    Ok(row)
}

pub(crate) fn voice_save_note_inner(
    conn: &mut Connection,
    recording_id: &str,
    title: &str,
    category: &str,
    use_tidied: bool,
    content_override: Option<String>,
) -> AppResult<NoteDto> {
    let tx = conn.transaction()?;
    let rec = crate::db::voice::get(&tx, recording_id)?
        .ok_or_else(|| crate::error::AppError::Other(format!("recording {recording_id} not found")))?;
    if rec.state == crate::db::voice::ST_RECORDING {
        return Err(crate::error::AppError::Other("recording still in progress".into()));
    }
    // Content = tidied if useTidied && exists, else raw (spec §6); an explicit
    // override (review/edit -> save, spec §2) wins over both (plan ruling 3).
    let content = content_override.unwrap_or_else(|| {
        if use_tidied {
            rec.tidied_transcript.clone().unwrap_or_else(|| rec.raw_transcript.clone().unwrap_or_default())
        } else {
            rec.raw_transcript.clone().unwrap_or_default()
        }
    });
    let row = create_note_tx(&tx, title, &content, category)?;
    tx.execute(
        "UPDATE notes SET audio_path=?2, audio_duration_secs=?3 WHERE id=?1",
        rusqlite::params![row.id, rec.path, rec.duration_secs],
    )?;
    crate::db::voice::delete_staging(&tx, recording_id)?;
    tx.commit()?;
    // re-read so the DTO carries the audio columns
    let saved = crate::db::notes::get(conn, &row.id)?
        .ok_or_else(|| crate::error::AppError::Other("saved note vanished".into()))?;
    Ok(NoteDto::from(saved))
}

#[tauri::command]
pub async fn voice_save_note(
    state: tauri::State<'_, AppState>,
    recording_id: String,
    title: String,
    category: String,
    use_tidied: bool,
    content_override: Option<String>,
) -> Result<NoteDto, String> {
    let mut conn = state.db.lock().await;
    voice_save_note_inner(&mut conn, &recording_id, &title, &category, use_tidied, content_override)
        .map_err(|e| e.to_string())
}

// dto.rs
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTranscribeDto {
    pub text: String,
}

pub(crate) async fn voice_transcribe_note_inner(
    conn: &mut Connection,
    ai: &crate::voice_ai::VoiceAiClient,
    language: Option<&str>,
    note_id: &str,
) -> AppResult<NoteTranscribeDto> {
    let note = crate::db::notes::get(conn, note_id)?
        .ok_or_else(|| crate::error::AppError::Other(format!("note {note_id} not found")))?;
    let path = note
        .audio_path
        .ok_or_else(|| crate::error::AppError::Other("note has no audio recording".into()))?;
    let (text, sfx) = ai.transcribe(std::path::Path::new(&path), language).await?;
    persist_ai_suffix(conn, sfx)?;
    Ok(NoteTranscribeDto { text })
}

#[tauri::command]
pub async fn voice_transcribe_note(
    state: tauri::State<'_, AppState>,
    note_id: String,
) -> Result<NoteTranscribeDto, String> {
    let ai = build_ai_client(&state).await.map_err(|e| e.to_string())?;
    let hint = { let conn = state.db.lock().await; ai_language_hint(&conn).map_err(|e| e.to_string())? };
    let language = if hint.trim().is_empty() { None } else { Some(hint.trim().to_string()) };
    let mut conn = state.db.lock().await;
    voice_transcribe_note_inner(&mut conn, &ai, language.as_deref(), &note_id)
        .await
        .map_err(|e| e.to_string())
}

pub(crate) fn voice_delete_note_audio_inner(conn: &mut Connection, note_id: &str) -> AppResult<NoteDto> {
    let note = crate::db::notes::get(conn, note_id)?
        .ok_or_else(|| crate::error::AppError::Other(format!("note {note_id} not found")))?;
    if let Some(p) = &note.audio_path {
        let _ = std::fs::remove_file(p); // best-effort
    }
    // LOCAL-ONLY metadata: no dirty flag, NO outbox op — sync must never see it
    conn.execute(
        "UPDATE notes SET audio_path=NULL, audio_duration_secs=NULL WHERE id=?1",
        [note_id],
    )?;
    let updated = crate::db::notes::get(conn, note_id)?
        .ok_or_else(|| crate::error::AppError::Other("note vanished".into()))?;
    Ok(NoteDto::from(updated))
}

#[tauri::command]
pub async fn voice_delete_note_audio(
    state: tauri::State<'_, AppState>,
    note_id: String,
) -> Result<NoteDto, String> {
    let mut conn = state.db.lock().await;
    voice_delete_note_audio_inner(&mut conn, &note_id).map_err(|e| e.to_string())
}
```

Register all three commands in lib.rs.

- [ ] **Step 4: Gates** — `cargo test` (the EXISTING create-note tests must stay green byte-identically — this is the refactor fence), `npx vitest run`, `npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(voice): voice_save_note single-tx + note re-transcribe/delete-audio"`.

---

### Task 8: Retry pass (after successful do_sync) + voice-updated event

**Files:**
- Modify: `src-tauri/src/voice_ai.rs` (append `RetryStats`, `retry_pending`, `transcribe_file`, `maybe_retry`)
- Modify: `src-tauri/src/sync/mod.rs` (do_sync hook)
- Test: `voice_ai.rs` tests

**Interfaces:**
- Consumes: Task 4 client, Task 2 staging helpers, Task 5 suffix/hint readers, Task 7 `update_note_inner` (pub(crate)).
- Produces: `voice_ai::RetryStats { staging_retried, staging_succeeded, notes_filled }`, `voice_ai::retry_pending(&mut Connection, &VoiceAiClient, Option<&str>) -> AppResult<RetryStats>`, `voice_ai::maybe_retry(AppHandle)` (glue: settings+key → client → retry → emit "voice-updated"), do_sync spawns `maybe_retry` after a SUCCESSFUL sync.

- [ ] **Step 1: Failing tests** — append to `voice_ai.rs` tests:

```rust
    fn client_at(uri: &str) -> VoiceAiClient {
        VoiceAiClient::new(uri, "sk", Suffix::V1).unwrap()
    }

    fn transcribe_ok_mock() -> (MockServer, String) {
        // built lazily per test — returns the server uri
        unimplemented!() // replaced below; see note
    }

    #[tokio::test]
    async fn retry_pending_retries_failed_staging_rows() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/audio/transcriptions"))
            .respond_with(ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"text": "retried text", "filename": "x.wav"})))
            .mount(&s).await;
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("r.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let mut conn = db_conn();
        crate::db::voice::create_staging(&conn, "r1", wav.to_string_lossy().as_ref()).unwrap();
        crate::db::voice::mark_recorded(&conn, "r1", 2.0).unwrap();
        crate::db::voice::mark_failed(&conn, "r1", false, "earlier").unwrap();
        let stats = retry_pending(&mut conn, &client_at(&s.uri()), None).await.unwrap();
        assert_eq!(stats.staging_retried, 1);
        assert_eq!(stats.staging_succeeded, 1);
        let rec = crate::db::voice::get(&conn, "r1").unwrap().unwrap();
        assert_eq!(rec.state, crate::db::voice::ST_TRANSCRIBED);
        assert_eq!(rec.raw_transcript.as_deref(), Some("retried text"));
    }

    #[tokio::test]
    async fn retry_pending_skips_auth_failed_rows() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("r.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let mut conn = db_conn();
        crate::db::voice::create_staging(&conn, "r1", wav.to_string_lossy().as_ref()).unwrap();
        crate::db::voice::mark_recorded(&conn, "r1", 2.0).unwrap();
        crate::db::voice::mark_failed(&conn, "r1", true, "api error 401").unwrap();
        let stats = retry_pending(&mut conn, &client_at("http://127.0.0.1:1"), None).await.unwrap();
        assert_eq!(stats.staging_retried, 0, "401/403 never consume the retry loop (spec §7)");
        assert_eq!(crate::db::voice::get(&conn, "r1").unwrap().unwrap().state, crate::db::voice::ST_FAILED_AUTH);
    }

    #[tokio::test]
    async fn retry_pending_fills_saved_notes_via_the_normal_outbox_path() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/audio/transcriptions"))
            .respond_with(ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"text": "filled text", "filename": "x.wav"})))
            .mount(&s).await;
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("n.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let mut conn = db_conn();
        conn.execute(
            "INSERT INTO notes (id,title,content,category,created_at,updated_at,dirty,audio_path) VALUES ('n1','t','','Home','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',1,?1)",
            rusqlite::params![wav.to_string_lossy().as_ref()],
        ).unwrap();
        let stats = retry_pending(&mut conn, &client_at(&s.uri()), None).await.unwrap();
        assert_eq!(stats.notes_filled, 1);
        let note = crate::db::notes::get(&conn, "n1").unwrap().unwrap();
        assert_eq!(note.content, "filled text");
        assert!(note.dirty);
        // normal update_note path: exactly one update op enqueued
        let ops = crate::db::outbox::next_batch(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].op_type, "update");
    }

    #[tokio::test]
    async fn retry_pending_never_touches_notes_with_content() {
        let mut conn = db_conn();
        conn.execute(
            "INSERT INTO notes (id,title,content,category,created_at,updated_at,dirty,audio_path) VALUES ('n1','t','already written','Home','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',0,'/tmp/x.wav')",
            [],
        ).unwrap();
        let stats = retry_pending(&mut conn, &client_at("http://127.0.0.1:1"), None).await.unwrap();
        assert_eq!(stats.notes_filled, 0);
        assert_eq!(crate::db::notes::get(&conn, "n1").unwrap().unwrap().content, "already written");
    }

    #[tokio::test]
    async fn retry_pending_missing_file_marks_staging_row_failed() {
        let mut conn = db_conn();
        crate::db::voice::create_staging(&conn, "r1", "/no/such/file.wav").unwrap();
        crate::db::voice::mark_recorded(&conn, "r1", 2.0).unwrap();
        crate::db::voice::mark_failed(&conn, "r1", false, "earlier").unwrap();
        let stats = retry_pending(&mut conn, &client_at("http://127.0.0.1:1"), None).await.unwrap();
        assert_eq!(stats.staging_retried, 1);
        assert_eq!(stats.staging_succeeded, 0);
        let rec = crate::db::voice::get(&conn, "r1").unwrap().unwrap();
        assert_eq!(rec.state, crate::db::voice::ST_FAILED);
        assert!(rec.last_error.as_deref().unwrap().contains("read recording"));
    }
```

NOTE (executor): the `transcribe_ok_mock` sketch above must be DELETED — write only the four real tests, each mounting its own MockServer (wiremock standing rule: every op has its own mock). `db_conn()` = the file's temp-db helper (create `db_conn()` in the tests mod if the module has none: tempdir + open + migrations::run, same shape as db/notes.rs tests).

- [ ] **Step 2: Run RED** — `cargo test retry_pending` FAIL (undefined).

- [ ] **Step 3: Implement** — append to voice_ai.rs:

```rust
#[derive(Debug, Default, Clone)]
pub struct RetryStats {
    pub staging_retried: usize,
    pub staging_succeeded: usize,
    pub notes_filled: usize,
}

/// Auto-retry pass (spec §6): staging rows in transcription_failed (NOT
/// failed_auth — 401/403 waits for the user to fix the key, spec §7), then
/// saved notes whose audio_path is set and content is still empty. Runs after
/// every SUCCESSFUL do_sync. Tidy is never auto-applied (spec §6).
pub async fn retry_pending(
    conn: &mut rusqlite::Connection,
    ai: &VoiceAiClient,
    language: Option<&str>,
) -> AppResult<RetryStats> {
    use crate::db::voice;
    let mut stats = RetryStats::default();
    for rec in voice::list_failed(conn)? {
        stats.staging_retried += 1;
        voice::mark_transcribing(conn, &rec.id)?;
        match transcribe_file(ai, std::path::Path::new(&rec.path), language).await {
            Ok(text) => {
                voice::set_transcript(conn, &rec.id, &text)?;
                stats.staging_succeeded += 1;
            }
            Err(e) => voice::mark_failed(conn, &rec.id, is_auth_error(&e), &e.to_string())?,
        }
    }
    let pending: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, audio_path FROM notes WHERE audio_path IS NOT NULL AND content='' AND deleted_at IS NULL",
        )?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, path) in pending {
        if let Ok(text) = transcribe_file(ai, std::path::Path::new(&path), language).await {
            crate::commands::update_note_inner(conn, &id, None, Some(text), None)?;
            stats.notes_filled += 1;
        }
    }
    Ok(stats)
}

pub async fn transcribe_file(ai: &VoiceAiClient, path: &Path, language: Option<&str>) -> AppResult<String> {
    ai.transcribe(path, language).await.map(|(t, _)| t)
}

/// Glue after a successful sync (thin by design — each piece is tested; the
/// composition mirrors do_sync's own app-level glue, untestable headlessly):
/// read AI settings + key, build the client, run the retry pass, emit
/// "voice-updated" so the UI refreshes the mic badges.
pub async fn maybe_retry(app: tauri::AppHandle) {
    use crate::commands::{ai_base_url, ai_language_hint, ai_suffix};
    let state = app.state::<crate::state::AppState>();
    let (base, suffix, hint) = {
        let conn = state.db.lock().await;
        (
            ai_base_url(&conn).unwrap_or_default(),
            ai_suffix(&conn).unwrap_or(Suffix::V1),
            ai_language_hint(&conn).unwrap_or_default(),
        )
    };
    if base.trim().is_empty() {
        return;
    }
    let key = match state.ai_keystore.get() {
        Ok(Some(k)) => k,
        _ => return,
    };
    let Ok(ai) = VoiceAiClient::new(&base, &key, suffix) else { return };
    let lang = if hint.trim().is_empty() { None } else { Some(hint.trim().to_string()) };
    let mut conn = state.db.lock().await;
    match retry_pending(&mut conn, &ai, lang.as_deref()).await {
        Ok(stats) => {
            if stats.staging_retried + stats.notes_filled > 0 {
                log::info!("voice retry: {stats:?}");
            }
        }
        Err(e) => log::warn!("voice retry failed: {e}"),
    }
    drop(conn);
    use tauri::Emitter;
    let _ = app.emit("voice-updated", ());
}
```

- [ ] **Step 4: do_sync hook** — in `sync/mod.rs` `do_sync`, after the existing `if let Ok(report) = &result { ... emit("sync-updated" ...) }` block:

```rust
    // Voice-notes retry (spec §6): after a SUCCESSFUL sync the jotty server is
    // reachable — give the AI transcription queue a chance. Spawned: do_sync's
    // callers (scheduler + manual trigger) must not block on AI latency.
    if result.is_ok() {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move { crate::voice_ai::maybe_retry(app2).await });
    }
```

- [ ] **Step 5: Gates** — `cargo test` (existing `push_runs_before_pull` fence stays green), `npx vitest run`, `npx tsc --noEmit`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(voice): pending-transcription retry after successful sync + voice-updated event"`.

---

### Task 9: Startup sweep (stale rows + orphan wavs) wired into lib.rs

**Files:**
- Modify: `src-tauri/src/db/voice.rs` (`SweepStats` + `sweep_startup`)
- Modify: `src-tauri/src/lib.rs` (call sweep in setup)
- Test: `db/voice.rs` tests

**Interfaces:**
- Consumes: Task 2 helpers.
- Produces: `db::voice::SweepStats { stale_transcribing_reset, recording_rows_deleted, orphan_files_deleted }`, `db::voice::sweep_startup(conn: &Connection, voice_dir: &Path) -> AppResult<SweepStats>`.

- [ ] **Step 1: Failing tests** — append to `db/voice.rs` tests:

```rust
    #[test]
    fn sweep_deletes_recording_rows_and_their_files() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("live.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        create_staging(&conn, "live", wav.to_string_lossy().as_ref()).unwrap();
        let stats = sweep_startup(&conn, dir.path()).unwrap();
        assert_eq!(stats.recording_rows_deleted, 1);
        assert!(!wav.exists());
        assert!(get(&conn, "live").unwrap().is_none());
    }

    #[test]
    fn sweep_resets_stale_transcribing_to_failed() {
        let conn = db();
        create_staging(&conn, "stuck", "/tmp/stuck.wav").unwrap();
        mark_transcribing(&conn, "stuck").unwrap();
        let stats = sweep_startup(&conn, std::path::Path::new("/tmp")).unwrap();
        assert_eq!(stats.stale_transcribing_reset, 1);
        let rec = get(&conn, "stuck").unwrap().unwrap();
        assert_eq!(rec.state, ST_FAILED);
        assert_eq!(rec.last_error.as_deref(), Some("interrupted by restart"));
    }

    #[test]
    fn sweep_deletes_orphan_wavs_but_keeps_referenced_ones() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        let staging_wav = dir.path().join("staging.wav");
        let note_wav = dir.path().join("note.wav");
        let orphan_wav = dir.path().join("orphan.wav");
        let stray_txt = dir.path().join("keep.txt");
        for f in [&staging_wav, &note_wav, &orphan_wav, &stray_txt] {
            std::fs::write(f, b"x").unwrap();
        }
        create_staging(&conn, "r", staging_wav.to_string_lossy().as_ref()).unwrap();
        set_transcript(&conn, "r", "t").unwrap(); // not recording state
        conn.execute(
            "INSERT INTO notes (id,title,content,category,created_at,updated_at,dirty,audio_path) VALUES ('n1','t','','Home','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',0,?1)",
            rusqlite::params![note_wav.to_string_lossy().as_ref()],
        ).unwrap();
        let stats = sweep_startup(&conn, dir.path()).unwrap();
        assert_eq!(stats.orphan_files_deleted, 1);
        assert!(staging_wav.exists());
        assert!(note_wav.exists());
        assert!(!orphan_wav.exists());
        assert!(stray_txt.exists(), "non-wav files untouched");
    }

    #[test]
    fn sweep_on_empty_dir_and_db_is_ok() {
        let conn = db();
        let dir = tempfile::tempdir().unwrap();
        let stats = sweep_startup(&conn, dir.path()).unwrap();
        assert_eq!(
            stats.stale_transcribing_reset + stats.recording_rows_deleted + stats.orphan_files_deleted,
            0
        );
    }
```

- [ ] **Step 2: Run RED** — `cargo test sweep` FAIL.

- [ ] **Step 3: Implement** — append to `db/voice.rs`:

```rust
#[derive(Debug, Default, Clone, PartialEq)]
pub struct SweepStats {
    pub stale_transcribing_reset: usize,
    pub recording_rows_deleted: usize,
    pub orphan_files_deleted: usize,
}

/// Startup sweep (spec §6, plan ruling 4). Order matters:
/// (a) stale `transcribing` rows (restart left no live owner) reset to
///     `transcription_failed` so the retry path owns them — nothing deleted;
/// (b) `recording` rows: no live owner after a restart — delete row + file;
/// (c) orphan wavs in the voice dir referenced by NOTHING (staging row or
///     saved note) are deleted; non-wav files are never touched.
/// Unsaved non-recording staging rows SURVIVE (resume prompt, spec §6).
pub fn sweep_startup(conn: &Connection, voice_dir: &std::path::Path) -> AppResult<SweepStats> {
    let reset = conn.execute(
        "UPDATE voice_recordings SET state='transcription_failed', last_error='interrupted by restart' WHERE state='transcribing'",
        [],
    )? as usize;
    let mut stmt = conn.prepare("SELECT id, path FROM voice_recordings WHERE state='recording'")?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut deleted = 0usize;
    for (id, path) in rows {
        let _ = std::fs::remove_file(&path);
        delete_staging(conn, &id)?;
        deleted += 1;
    }
    let referenced = referenced_audio_paths(conn)?;
    let mut orphans = 0usize;
    if let Ok(entries) = std::fs::read_dir(voice_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            let is_wav = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("wav"))
                .unwrap_or(false);
            if !is_wav {
                continue;
            }
            let as_str = p.to_string_lossy().into_owned();
            if !referenced.contains(&as_str) && std::fs::remove_file(&p).is_ok() {
                orphans += 1;
            }
        }
    }
    Ok(SweepStats {
        stale_transcribing_reset: reset,
        recording_rows_deleted: deleted,
        orphan_files_deleted: orphans,
    })
}
```

- [ ] **Step 4: Wire into lib.rs setup** — right after `db::migrations::run(&conn)?;` (BEFORE the resume prompt can list anything):

```rust
            let voice_dir = db_dir.join("voice");
            if let Err(e) = db::voice::sweep_startup(&conn, &voice_dir) {
                log::warn!("voice startup sweep failed (non-fatal): {e}");
            }
```

- [ ] **Step 5: Gates** — `cargo test`, `npx vitest run`, `npx tsc --noEmit`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(voice): startup sweep - stale rows, recording rows, orphan wavs"`.

---

### Task 10: Frontend API surface — voice fns, AI settings, types, audioSrc

**Files:**
- Modify: `src/api/types.ts` (VoiceRecordingDto, AiSettingsDto)
- Modify: `src/api/client.ts` (12 invoke wrappers + `audioSrc`)
- Test: covered via component tests in Tasks 11-14; gate = tsc + existing suite.

**Interfaces:**
- Consumes: Task 3-7 command DTOs (camelCase wire shapes).
- Produces: `api.voiceStartRecording/voiceStopRecording/voiceTranscribe/voiceTidy/voiceDeleteRecording/voiceSaveNote/voiceListUnsaved/voiceTranscribeNote/voiceDeleteNoteAudio/aiGetModels/getAiSettings/setAiSettings`, `api.audioSrc(path)`; types `VoiceRecordingDto`, `AiSettingsDto` (+ Task 1's NoteDto audio fields).

- [ ] **Step 1: types.ts additions:**

```ts
export interface VoiceRecordingDto {
  id: string; path: string; durationSecs: number;
  rawTranscript: string | null; tidiedTranscript: string | null;
  state: 'recording' | 'recorded' | 'transcribing' | 'transcribed' | 'transcription_failed' | 'transcription_failed_auth';
  lastError: string | null; createdAt: string;
}
export interface AiSettingsDto {
  baseUrl: string; model: string; languageHint: string; apiPathSuffix: string; hasKey: boolean;
}
```

- [ ] **Step 2: client.ts additions** (extend the existing `convertFileSrc` import):

```ts
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
...
export const voiceStartRecording = () => invoke<T.VoiceRecordingDto>('voice_start_recording');
export const voiceStopRecording = () => invoke<T.VoiceRecordingDto>('voice_stop_recording');
export const voiceTranscribe = (recordingId: string) => invoke<T.VoiceRecordingDto>('voice_transcribe', { recordingId });
export const voiceTidy = (recordingId: string | null, raw: string) => invoke<{ tidied: string }>('voice_tidy', { recordingId, raw });
export const voiceDeleteRecording = (recordingId: string) => invoke<void>('voice_delete_recording', { recordingId });
export const voiceSaveNote = (recordingId: string, title: string, category: string, useTidied: boolean, contentOverride: string | null) =>
  invoke<T.NoteDto>('voice_save_note', { recordingId, title, category, useTidied, contentOverride });
export const voiceListUnsaved = () => invoke<T.VoiceRecordingDto[]>('voice_list_unsaved');
export const voiceTranscribeNote = (noteId: string) => invoke<{ text: string }>('voice_transcribe_note', { noteId });
export const voiceDeleteNoteAudio = (noteId: string) => invoke<T.NoteDto>('voice_delete_note_audio', { noteId });
export const aiGetModels = () => invoke<string[]>('ai_get_models');
export const getAiSettings = () => invoke<T.AiSettingsDto>('get_ai_settings');
export const setAiSettings = (baseUrl: string | null, model: string | null, languageHint: string | null, apiKey: string | null) =>
  invoke<T.AiSettingsDto>('set_ai_settings', { baseUrl, model, languageHint, apiKey });
// Tauri asset-protocol URL for a local audio file; the try/catch keeps jsdom
// tests honest (no __TAURI_INTERNALS__ there) — audioSrc falls back to the
// raw path, which component tests assert on.
export const audioSrc = (path: string): string => {
  try { return convertFileSrc(path); } catch { return path; }
};
```

- [ ] **Step 3: Gates** — `npx tsc -p tsconfig.json --noEmit` clean, `npx vitest run` (60/60).

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(voice): frontend api surface for voice notes + ai settings"`.

---

### Task 11: VoiceNoteReview overlay component

**Files:**
- Create: `src/components/VoiceNoteReview.tsx`
- Create: `src/components/VoiceNoteReview.test.tsx`
- Modify: `src/styles.css` (review overlay styles)

**Interfaces:**
- Consumes: Task 10 api fns; Task 6 DTO states.
- Produces: `<VoiceNoteReview mode="new" | "resume" | "retranscribe" recording?: VoiceRecordingDto | null noteId?: string onClose: () => void onSaved?: (noteId: string) => void />`; exported `titleFromTranscript(text: string): string` (first sentence, ≤60 chars, empty → 'Voice note').

- [ ] **Step 1: Failing component tests** — `VoiceNoteReview.test.tsx` (same invoke-mock pattern as NoteEditor.test):

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import VoiceNoteReview, { titleFromTranscript } from './VoiceNoteReview';

const recordedRow = {
  id: 'r1', path: '/data/voice/r1.wav', durationSecs: 4.2,
  rawTranscript: null, tidiedTranscript: null, state: 'recorded', lastError: null, createdAt: '2026-09-18T00:00:00Z',
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'voice_start_recording') return Promise.resolve(recordedRow);
    if (cmd === 'voice_stop_recording') return Promise.resolve(recordedRow);
    if (cmd === 'voice_transcribe') return Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'Hello world. Second sentence.', lastError: null });
    if (cmd === 'voice_tidy') return Promise.resolve({ tidied: 'Hello, world.' });
    if (cmd === 'voice_save_note') return Promise.resolve({ id: 'n9', title: 'Hello world. Second sentence.', content: 'x', category: 'Uncategorized', audioPath: '/data/voice/r1.wav', audioDurationSecs: 4.2, createdAt: null, updatedAt: null, deletedAt: null, dirty: true });
    if (cmd === 'get_note') return Promise.resolve({ id: 'n1', title: 'T', content: '<p>old</p>', category: 'Home', audioPath: '/data/voice/n1.wav', audioDurationSecs: 3, createdAt: null, updatedAt: null, deletedAt: null, dirty: false });
    if (cmd === 'voice_transcribe_note') return Promise.resolve({ text: 'New transcript.' });
    if (cmd === 'update_note') return Promise.resolve({});
    if (cmd === 'voice_delete_recording') return Promise.resolve(null);
    return Promise.resolve(null);
  });
});

describe('VoiceNoteReview', () => {
  it('new mode: renders recording phase with a live timer, stop transcribes and prefills the title', async () => {
    vi.useFakeTimers();
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText(/Recording/)).toBeInTheDocument();
    vi.advanceTimersByTime(2100);
    expect(screen.getByText('0:02')).toBeInTheDocument();
    vi.useRealTimers();
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByPlaceholderText('Title')).toHaveValue('Hello world.'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_transcribe', { recordingId: 'r1' }));
  });

  it('failed transcription shows the retry button and error text, retry re-calls', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_start_recording') return Promise.resolve(recordedRow);
      if (cmd === 'voice_stop_recording') return Promise.resolve(recordedRow);
      if (cmd === 'voice_transcribe') return Promise.resolve({ ...recordedRow, state: 'transcription_failed', rawTranscript: null, lastError: '500 boom' });
      return Promise.resolve(null);
    });
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByText(/500 boom/)).toBeInTheDocument());
    expect(screen.getByText('Retry transcription')).toBeInTheDocument();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_transcribe') return Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'now it works' });
      if (cmd === 'voice_start_recording') return Promise.resolve(recordedRow);
      if (cmd === 'voice_stop_recording') return Promise.resolve(recordedRow);
      return Promise.resolve(null);
    });
    fireEvent.click(screen.getByText('Retry transcription'));
    await waitFor(() => expect(screen.getByDisplayValue('now it works')).toBeInTheDocument());
  });

  it('tidy stores both texts, switches to the tidied view, raw toggle returns', async () => {
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByText('Tidy transcript')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Tidy transcript'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_tidy', { recordingId: 'r1', raw: 'Hello world. Second sentence.' }));
    expect(screen.getByDisplayValue('Hello, world.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Raw'));
    expect(screen.getByDisplayValue('Hello world. Second sentence.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Tidied'));
    expect(screen.getByDisplayValue('Hello, world.')).toBeInTheDocument();
  });

  it('tidy failure keeps the raw transcript and shows a notice', async () => {
    render(<VoiceNoteReview mode="new" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByText('Tidy transcript')).toBeInTheDocument());
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'voice_tidy') return Promise.reject(new Error('server down'));
      if (cmd === 'voice_transcribe') return Promise.resolve({ ...recordedRow, state: 'transcribed', rawTranscript: 'raw text' });
      if (cmd === 'voice_start_recording') return Promise.resolve(recordedRow);
      if (cmd === 'voice_stop_recording') return Promise.resolve(recordedRow);
      return Promise.resolve(null);
    });
    fireEvent.click(screen.getByText('Tidy transcript'));
    await waitFor(() => expect(screen.getByText(/Tidy failed/)).toBeInTheDocument());
    expect(screen.getByDisplayValue('raw text')).toBeInTheDocument();
  });

  it('save calls voice_save_note with the edited text and reports the saved note', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<VoiceNoteReview mode="new" onClose={onClose} onSaved={onSaved} />);
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByPlaceholderText('Title')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('Title'), { target: { value: 'My memo' } });
    fireEvent.change(screen.getByPlaceholderText('Transcript'), { target: { value: 'edited by me' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('n9'));
    expect(onClose).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('voice_save_note', {
      recordingId: 'r1', title: 'My memo', category: 'Uncategorized', useTidied: false, contentOverride: 'edited by me',
    });
  });

  it('retranscribe mode transcribes the note and saves via update_note', async () => {
    const onSaved = vi.fn();
    render(<VoiceNoteReview mode="retranscribe" noteId="n1" onClose={() => {}} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByDisplayValue('New transcript.')).toBeInTheDocument());
    expect(screen.getByDisplayValue('T')).toBeInTheDocument(); // title prefilled from the note
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_note', { id: 'n1', title: 'T', content: 'New transcript.', category: 'Home' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('n1'));
  });

  it('resume mode enters review from the stored row and cancel deletes the recording', async () => {
    const onClose = vi.fn();
    render(<VoiceNoteReview mode="resume" recording={{ ...recordedRow, state: 'transcribed', rawTranscript: 'resumed text' }} onClose={onClose} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByDisplayValue('resumed text')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_delete_recording', { recordingId: 'r1' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('cancel during recording deletes the recording and closes', async () => {
    const onClose = vi.fn();
    render(<VoiceNoteReview mode="new" onClose={onClose} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Recording/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_delete_recording', { recordingId: 'r1' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('titleFromTranscript: first sentence, truncation, empty fallback', () => {
    expect(titleFromTranscript('One two three. Four.')).toBe('One two three.');
    expect(titleFromTranscript('x'.repeat(100) + '. rest')).toBe('x'.repeat(57) + '…');
    expect(titleFromTranscript('   ')).toBe('Voice note');
    expect(titleFromTranscript('no punctuation here')).toBe('no punctuation here');
  });
});
```

(If the fake-timer test trips the RTL waitFor rule (T16 ruling Q — waitFor NEVER resolves under fake timers), restructure it exactly per that precedent: assertions on the timer text happen WITHOUT any RTL async wrapper, and the Stop click part runs after `vi.useRealTimers()`.)

- [ ] **Step 2: Run RED** — `npx vitest run VoiceNoteReview` FAIL (module missing).

- [ ] **Step 3: Implement** — `src/components/VoiceNoteReview.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import type { VoiceRecordingDto } from '../api/types';

export const CAP_SECS = 480; // 8-minute cap, mirrors audio::MAX_SECS (spec §7)

export function titleFromTranscript(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'Voice note';
  const sentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  const t = sentence.trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

const fmt = (e: string) => String(e).replace(/^.*Error: /, '');

type Phase = 'recording' | 'transcribing' | 'review' | 'failed-start';

export default function VoiceNoteReview({ mode, recording, noteId, onClose, onSaved }: {
  mode: 'new' | 'resume' | 'retranscribe';
  recording?: VoiceRecordingDto | null;
  noteId?: string;
  onClose: () => void;
  onSaved?: (noteId: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>(mode === 'new' ? 'recording' : 'review');
  const [rec, setRec] = useState<VoiceRecordingDto | null>(recording ?? null);
  const [elapsed, setElapsed] = useState(0);
  const [rawText, setRawText] = useState('');
  const [tidiedText, setTidiedText] = useState<string | null>(null);
  const [view, setView] = useState<'raw' | 'tidied'>('raw');
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Uncategorized');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [atCap, setAtCap] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const enterReview = (row: VoiceRecordingDto) => {
    const raw = row.rawTranscript ?? '';
    setRawText(raw);
    setTidiedText(row.tidiedTranscript);
    setView(row.tidiedTranscript ? 'tidied' : 'raw');
    setTitle(titleFromTranscript(raw));
    setCategory('Uncategorized');
    setAudioPath(row.path);
    setPhase('review');
  };

  useEffect(() => {
    if (mode === 'new') {
      let cancelled = false;
      (async () => {
        try {
          const row = await api.voiceStartRecording();
          if (cancelled) return;
          setRec(row);
          setPhase('recording');
        } catch (e) {
          if (cancelled) return;
          setError(fmt(e));
          setPhase('failed-start');
        }
      })();
      return () => { cancelled = true; };
    }
    if (mode === 'resume' && recording) {
      enterReview(recording); // stale 'transcribing'/failed rows land in review w/ retry
    }
    if (mode === 'retranscribe' && noteId) {
      let cancelled = false;
      (async () => {
        try {
          const note = await api.getNote(noteId);
          const res = await api.voiceTranscribeNote(noteId);
          if (cancelled) return;
          setTitle(note.title);
          setCategory(note.category);
          setRawText(res.text);
          setTidiedText(null);
          setView('raw');
          setAudioPath(note.audioPath);
          setPhase('review');
        } catch (e) {
          if (cancelled) return;
          setError(fmt(e));
          setPhase('failed-start');
        }
      })();
      return () => { cancelled = true; };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // recording timer; auto-stop at the cap (spec §7)
  useEffect(() => {
    if (phase !== 'recording') return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);
  const stopRef = useRef<(atCap?: boolean) => Promise<void>>(async () => {});
  useEffect(() => {
    if (phase === 'recording' && elapsed >= CAP_SECS) void stopRef.current(true);
  }, [elapsed, phase]);

  const stopRecording = async (atCap = false) => {
    setPhase('transcribing');
    setAtCap(atCap);
    try {
      const row = await api.voiceStopRecording();
      setRec(row);
      const done = await api.voiceTranscribe(row.id);
      if (!mounted.current) return;
      setRec(done);
      enterReview(done);
    } catch (e) {
      if (!mounted.current) return;
      setError(fmt(e));
      setPhase('review');
    }
  };
  stopRef.current = stopRecording;

  const retryTranscribe = async () => {
    if (!rec) return;
    setPhase('transcribing');
    setError(null);
    try {
      const done = await api.voiceTranscribe(rec.id);
      if (!mounted.current) return;
      setRec(done);
      enterReview(done);
    } catch (e) {
      if (!mounted.current) return;
      setError(fmt(e));
      setPhase('review');
    }
  };

  const currentText = () => (view === 'tidied' && tidiedText != null ? tidiedText : rawText);

  const tidy = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.voiceTidy(mode === 'retranscribe' ? null : rec?.id ?? null, currentText());
      if (!mounted.current) return;
      setTidiedText(res.tidied);
      setView('tidied');
    } catch (e) {
      if (!mounted.current) return;
      setNotice(`Tidy failed — keeping the transcript as is. ${fmt(e)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const text = currentText();
      if (mode === 'retranscribe' && noteId) {
        await api.updateNote(noteId, title, text, category);
        if (!mounted.current) return;
        onSaved?.(noteId);
      } else if (rec) {
        const note = await api.voiceSaveNote(rec.id, title, category, view === 'tidied' && tidiedText != null, text);
        if (!mounted.current) return;
        onSaved?.(note.id);
      }
      onClose();
    } catch (e) {
      if (!mounted.current) return;
      setError(fmt(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const deleteRecording = async () => {
    if (rec) {
      try { await api.voiceDeleteRecording(rec.id); } catch { /* best-effort */ }
    }
    onClose();
  };

  const failed = rec?.state === 'transcription_failed' || rec?.state === 'transcription_failed_auth';
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal voice-modal" onClick={(e) => e.stopPropagation()}>
        {phase === 'recording' && (
          <>
            <h2>🎙 Recording… {mmss}</h2>
            <p className="voice-hint">Auto-stops at 8 minutes.</p>
            <div className="voice-actions">
              <button className="primary" onClick={() => void stopRecording(false)}>Stop</button>
              <button onClick={deleteRecording}>Cancel</button>
            </div>
          </>
        )}
        {phase === 'transcribing' && <h2>Transcribing…</h2>}
        {phase === 'failed-start' && (
          <>
            <h2>Voice note</h2>
            <p className="error">{error}</p>
            <div className="voice-actions"><button onClick={onClose}>Close</button></div>
          </>
        )}
        {phase === 'review' && (
          <>
            <h2>Review voice note</h2>
            {atCap && <p className="voice-hint">Stopped at the 8-minute cap.</p>}
            {audioPath && <audio controls src={api.audioSrc(audioPath)} data-testid="voice-audio" />}
            <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <input placeholder="Category" value={category} onChange={(e) => setCategory(e.target.value)} />
            <div className="voice-toggle">
              <button className={view === 'raw' ? 'selected' : ''} onClick={() => setView('raw')}>Raw</button>
              <button className={view === 'tidied' ? 'selected' : ''} onClick={() => setView('tidied')} disabled={tidiedText == null}>Tidied</button>
              <button onClick={tidy} disabled={busy || !rawText.trim()}>Tidy transcript</button>
            </div>
            {failed && (
              <p className="error">
                {rec?.state === 'transcription_failed_auth'
                  ? `Transcription failed — check the AI server API key in Settings. ${rec?.lastError ?? ''}`
                  : `Transcription failed — will retry after the next sync. ${rec?.lastError ?? ''}`}
              </p>
            )}
            {notice && <p className="voice-hint">{notice}</p>}
            {error && <p className="error">{error}</p>}
            <textarea
              placeholder="Transcript"
              value={currentText()}
              onChange={(e) => (view === 'tidied' ? setTidiedText(e.target.value) : setRawText(e.target.value))}
              rows={10}
            />
            <div className="voice-actions">
              <button className="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
              {mode !== 'retranscribe' && <button onClick={deleteRecording}>Delete</button>}
              {failed && <button onClick={retryTranscribe}>Retry transcription</button>}
              <button onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: styles.css additions:**

```css
.voice-modal textarea { width: 100%; margin: 8px 0; font-family: inherit; }
.voice-toggle { display: flex; gap: 6px; margin: 8px 0; }
.voice-toggle .selected { background: var(--primary, #9d5ffe); color: #fff; }
.voice-actions { display: flex; gap: 8px; margin-top: 8px; }
.voice-actions .primary { background: var(--primary, #9d5ffe); color: #fff; }
.voice-hint { color: var(--muted-fg, #a39caf); font-size: 0.9em; }
```

- [ ] **Step 5: Gates** — `npx vitest run` (all green), `npx tsc --noEmit`, `cargo test` (unchanged but re-cited).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(voice): VoiceNoteReview overlay - record/timer, transcribe, tidy toggle, review/edit/save"`.

---

### Task 12: NoteList voice button + mic badge + App orchestration (new flow, resume prompt, retranscribe)

**Files:**
- Modify: `src/components/NoteList.tsx` (props + button + badge)
- Modify: `src/components/NoteList.test.tsx`
- Modify: `src/App.tsx` (voice flow state, startVoiceNote probe, resume prompt, VoiceNoteReview mount, voice-updated listener, NoteEditor remount key)
- Modify: `src/components/NoteEditor.tsx` (accept `onRetranscribe` prop — minimal, full panel in Task 14)
- Modify: `src/App.test.tsx` (invoke map + new tests)
- Modify: `src/styles.css` (.mic-badge, .head-actions)

**Interfaces:**
- Consumes: Task 10 api fns, Task 11 VoiceNoteReview.
- Produces: `NoteList { notes, onStartVoiceNote: () => void, onOpenSettings: () => void }`; App `VoiceFlow = { mode: 'new' } | { mode: 'resume'; recording: VoiceRecordingDto } | { mode: 'retranscribe'; noteId: string }` internal state; App-level `startVoiceNote()` probe (unconfigured AI → opens Settings, spec §4); resume prompt on mount when `voice_list_unsaved` returns rows.

- [ ] **Step 1: Failing tests** — NoteList.test.tsx (update the two existing tests to pass the new required props) + App.test.tsx additions:

```tsx
// NoteList.test.tsx — new tests (existing ones updated with vi.fn() props):
  it('voice note button calls onStartVoiceNote', () => {
    const onStart = vi.fn();
    render(<NoteList notes={[]} onStartVoiceNote={onStart} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByText('🎙 New voice note'));
    expect(onStart).toHaveBeenCalled();
  });

  it('mic badge shows only for notes with audio and empty content', () => {
    const notes = [
      { id: 'n1', title: 'Pending', content: '', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, audioPath: '/data/voice/a.wav', audioDurationSecs: 3 },
      { id: 'n2', title: 'Done', content: 'text', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, audioPath: '/data/voice/b.wav', audioDurationSecs: 3 },
      { id: 'n3', title: 'Plain', content: 'text', category: 'Home', createdAt: null, updatedAt: null, deletedAt: null, dirty: false, audioPath: null, audioDurationSecs: null },
    ];
    render(<NoteList notes={notes as never[]} onStartVoiceNote={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByTitle('Pending transcription — retries after sync')).toBeInTheDocument();
    expect(screen.getAllByTitle('Pending transcription — retries after sync')).toHaveLength(1);
  });
```

```tsx
// App.test.tsx — beforeEach invoke map gains (defense per lesson AA):
    if (cmd === 'voice_list_unsaved') return Promise.resolve([]);
    if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: 'https://ai.example.com', model: 'm', languageHint: '', apiPathSuffix: 'v1', hasKey: true });
    if (cmd === 'ai_get_models') return Promise.resolve([]);
// new tests:
  it('new voice note opens the review overlay when the AI server is configured', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('🎙 New voice note'));
    await waitFor(() => expect(screen.getByText(/Recording/)).toBeInTheDocument());
  });

  it('new voice note opens Settings when the AI server is unconfigured', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
      if (cmd === 'list_notes') return Promise.resolve([{ id: 'n1', title: 'Groceries', content: 'milk', category: 'Home', updatedAt: '2026-01-01T00:00:00.000Z', dirty: false }]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false });
      if (cmd === 'voice_list_unsaved') return Promise.resolve([]);
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: '', model: '', languageHint: '', apiPathSuffix: 'v1', hasKey: false });
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    fireEvent.click(screen.getByText('🎙 New voice note'));
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
  });

  it('resume prompt offers resume/discard when unsaved voice drafts exist', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
      if (cmd === 'list_notes') return Promise.resolve([]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false });
      if (cmd === 'voice_list_unsaved') return Promise.resolve([
        { id: 'r1', path: '/data/voice/r1.wav', durationSecs: 3, rawTranscript: 'draft', tidiedTranscript: null, state: 'transcribed', lastError: null, createdAt: '2026-09-18T00:00:00Z' },
      ]);
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: 'https://ai', model: 'm', languageHint: '', apiPathSuffix: 'v1', hasKey: true });
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Unfinished voice note')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Resume review'));
    await waitFor(() => expect(screen.getByDisplayValue('draft')).toBeInTheDocument());
  });

  it('resume prompt discard deletes the recordings', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_connection') return Promise.resolve({ instance_url: 'http://localhost:1122', version: '1.22.0' });
      if (cmd === 'list_notes') return Promise.resolve([]);
      if (cmd === 'list_checklists') return Promise.resolve([]);
      if (cmd === 'list_categories') return Promise.resolve({ notes: [], checklists: [] });
      if (cmd === 'sync_status') return Promise.resolve({ pending: 0, last_sync_at: null, syncing: false });
      if (cmd === 'voice_list_unsaved') return Promise.resolve([
        { id: 'r1', path: '/data/voice/r1.wav', durationSecs: 3, rawTranscript: null, tidiedTranscript: null, state: 'transcription_failed', lastError: null, createdAt: '2026-09-18T00:00:00Z' },
      ]);
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: '', model: '', languageHint: '', apiPathSuffix: 'v1', hasKey: false });
      return Promise.resolve(null);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Unfinished voice note')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Discard'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_delete_recording', { recordingId: 'r1' }));
  });
```

- [ ] **Step 2: Run RED** — `npx vitest run NoteList App` FAIL.

- [ ] **Step 3: Implement NoteList.tsx:**

```tsx
import type { NoteDto } from '../api/types';
import { useStore } from '../stores/store';

export default function NoteList({ notes, onStartVoiceNote, onOpenSettings }: {
  notes: NoteDto[];
  onStartVoiceNote: () => void;
  onOpenSettings: () => void;
}) {
  const { selectedNoteId, selectNote, createNote } = useStore();
  void onOpenSettings; // the probe lives in App (single source); kept for future inline prompting
  return (
    <section id="notes">
      <div className="section-head">
        <h2>Notes</h2>
        <div className="head-actions">
          <button className="new-btn voice-btn" onClick={onStartVoiceNote}>🎙 New voice note</button>
          <button className="new-btn" onClick={() => createNote('Untitled note', 'Uncategorized')}>+ New note</button>
        </div>
      </div>
      <ul>
        {notes.map((n) => (
          <li key={n.id} className={n.id === selectedNoteId ? 'selected' : ''} onClick={() => selectNote(n.id)}>
            <span className="item-title">{n.title}{n.dirty ? ' •' : ''}</span>
            {n.audioPath && n.content === '' && (
              <span className="mic-badge" title="Pending transcription — retries after sync">🎙️</span>
            )}
            <span className="chip">{n.category}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

(If `void onOpenSettings` offends the linter, drop the prop entirely and keep the probe fully in App — the spec only requires the PROMPT behavior, which App implements. Choose one and keep NoteList.test consistent.)

- [ ] **Step 4: Implement App.tsx wiring:**

```tsx
// new imports
import * as api from './api/client';
import VoiceNoteReview from './components/VoiceNoteReview';
import type { VoiceRecordingDto } from './api/types';

type VoiceFlow =
  | { mode: 'new' }
  | { mode: 'resume'; recording: VoiceRecordingDto }
  | { mode: 'retranscribe'; noteId: string };

// inside App():
  const [voice, setVoice] = useState<VoiceFlow | null>(null);
  const [resumeRows, setResumeRows] = useState<VoiceRecordingDto[] | null>(null);
  const [contentNonce, setContentNonce] = useState(0); // remounts NoteEditor after a retranscribe save

  useEffect(() => {
    refreshAll();
    refreshUpdate();
    // resume prompt (spec §6): unsaved non-recording drafts survive restart
    api.voiceListUnsaved().then((rows) => {
      if (Array.isArray(rows) && rows.length > 0) setResumeRows(rows);
    }).catch(() => {});
    const un = listen('sync-updated', () => refreshAll());
    const uv = listen('voice-updated', () => refreshAll());
    return () => { un.then((f) => f()); uv.then((f) => f()); };
  }, [refreshAll, refreshUpdate]);

  const startVoiceNote = async () => {
    // unconfigured AI server -> prompt to open Settings (spec §4)
    try {
      const s = await api.getAiSettings();
      if (!s.baseUrl || !s.hasKey) { setShowSettings(true); return; }
    } catch { setShowSettings(true); return; }
    setVoice({ mode: 'new' });
  };

  const noteSaved = (noteId: string) => {
    setVoice(null);
    setContentNonce((n) => n + 1); // retranscribe saves change content under an open editor
    selectNote(noteId);
    refreshAll();
  };

// render — NoteList gains props; NoteEditor a remount key + retranscribe hook;
// overlays after the existing modals:
      {listMode === 'notes'
        ? <NoteList notes={visibleNotes} onStartVoiceNote={startVoiceNote} onOpenSettings={() => setShowSettings(true)} />
        : <ChecklistList checklists={visibleChecklists} />}
        {selectedNoteId ? <NoteEditor key={`${selectedNoteId}-${contentNonce}`} noteId={selectedNoteId} onRetranscribe={(id) => setVoice({ mode: 'retranscribe', noteId: id })}/> : selectedChecklistId ? <ChecklistView checklistId={selectedChecklistId}/> : null}
      {resumeRows && (
        <div className="modal-backdrop" onClick={() => setResumeRows(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Unfinished voice note</h2>
            <p>You have a voice recording that was never saved.</p>
            <div className="voice-actions">
              <button className="primary" onClick={() => { setVoice({ mode: 'resume', recording: resumeRows[0] }); setResumeRows(null); }}>Resume review</button>
              <button onClick={async () => {
                for (const r of resumeRows) {
                  try { await api.voiceDeleteRecording(r.id); } catch { /* best-effort */ }
                }
                setResumeRows(null);
              }}>Discard</button>
            </div>
          </div>
        </div>
      )}
      {voice?.mode === 'new' && (
        <VoiceNoteReview mode="new" onClose={() => setVoice(null)} onSaved={noteSaved} />
      )}
      {voice?.mode === 'resume' && (
        <VoiceNoteReview mode="resume" recording={voice.recording} onClose={() => setVoice(null)} onSaved={noteSaved} />
      )}
      {voice?.mode === 'retranscribe' && (
        <VoiceNoteReview mode="retranscribe" noteId={voice.noteId} onClose={() => setVoice(null)} onSaved={noteSaved} />
      )}
```

(NoteEditor in this task only gains the optional `onRetranscribe?: (noteId: string) => void` prop signature — accepted and ignored until Task 14 wires the button.)

- [ ] **Step 5: styles.css:**

```css
.head-actions { display: flex; gap: 6px; align-items: center; }
.mic-badge { margin: 0 6px; }
```

- [ ] **Step 6: Gates** — `npx vitest run`, `npx tsc --noEmit`, `cargo test` (cite baseline).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(voice): note list voice button + mic badge + app voice flow orchestration"`.

---

### Task 13: SettingsModal "AI server" section

**Files:**
- Modify: `src/components/SettingsModal.tsx`
- Modify: `src/components/SettingsModal.test.tsx`
- Modify: `src/App.test.tsx` (map defaults only if missing)
- Modify: `src/styles.css` (.ai-settings)

**Interfaces:**
- Consumes: Task 10 api (`getAiSettings`, `setAiSettings`, `aiGetModels`).
- Produces: settings-mode UI — base URL input, API key password input (placeholder shows stored state), tidy model input with `<datalist>` dropdown populated by `ai_get_models`, language hint input, Save + "Test connection" buttons, status line. Test connection persists the current fields first, then probes models (the probe needs a stored key).

- [ ] **Step 1: Failing tests** — append to SettingsModal.test.tsx (existing 2 tests stay green):

```tsx
  it('AI section loads stored settings and saves trimmed values', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 });
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: 'https://ai.example.com', model: 'llama3', languageHint: 'en', apiPathSuffix: 'v1', hasKey: true });
      if (cmd === 'set_ai_settings') return Promise.resolve({ baseUrl: 'https://ai.example.com', model: 'llama3', languageHint: 'en', apiPathSuffix: 'v1', hasKey: true });
      return Promise.resolve(null);
    });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByPlaceholderText('https://ai.example.com')).toHaveValue('https://ai.example.com'));
    expect(screen.getByPlaceholderText('API key stored')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_ai_settings', {
      baseUrl: 'https://ai.example.com', model: 'llama3', languageHint: 'en', apiKey: null,
    }));
    await waitFor(() => expect(screen.getByText('AI settings saved.')).toBeInTheDocument());
  });

  it('AI test connection reports model count and populates the model dropdown', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 });
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: 'https://ai.example.com', model: '', languageHint: '', apiPathSuffix: 'v1', hasKey: false });
      if (cmd === 'set_ai_settings') return Promise.resolve({ baseUrl: 'https://ai.example.com', model: '', languageHint: '', apiPathSuffix: 'v1', hasKey: true });
      if (cmd === 'ai_get_models') return Promise.resolve(['llama3', 'qwen2.5:7b']);
      return Promise.resolve(null);
    });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Test connection')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Test connection'));
    await waitFor(() => expect(screen.getByText('Connected — 2 model(s) available.')).toBeInTheDocument());
    expect(document.querySelector('#ai-model-list option[value="llama3"]')).not.toBeNull();
  });

  it('AI test connection failure surfaces the error', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_settings') return Promise.resolve({ instanceUrl: 'http://x', syncIntervalMinutes: 5 });
      if (cmd === 'get_ai_settings') return Promise.resolve({ baseUrl: '', model: '', languageHint: '', apiPathSuffix: 'v1', hasKey: false });
      if (cmd === 'set_ai_settings') return Promise.resolve({ baseUrl: '', model: '', languageHint: '', apiPathSuffix: 'v1', hasKey: false });
      if (cmd === 'ai_get_models') return Promise.reject(new Error('AI server not configured'));
      return Promise.resolve(null);
    });
    render(<SettingsModal mode="settings" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Test connection')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Test connection'));
    await waitFor(() => expect(screen.getByText(/AI server not configured/)).toBeInTheDocument());
  });
```

- [ ] **Step 2: Run RED** — `npx vitest run SettingsModal` FAIL.

- [ ] **Step 3: Implement** — in SettingsModal.tsx (settings mode only), after the interval/disconnect block and before `.updater`:

```tsx
// state
  const [aiBase, setAiBase] = useState('');
  const [aiKey, setAiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiLang, setAiLang] = useState('');
  const [aiHas, setAiHas] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

// load (extend the existing mode==='settings' effect):
    api.getAiSettings().then((s) => {
      setAiBase(s.baseUrl); setAiModel(s.model); setAiLang(s.languageHint); setAiHas(s.hasKey);
      if (s.baseUrl && s.hasKey) {
        api.aiGetModels().then((m) => { if (Array.isArray(m)) setModels(m); }).catch(() => {});
      }
    }).catch(() => {});

  const fmtErr = (e: string) => String(e).replace(/^.*Error: /, '');

  const persistAi = async () => {
    const s = await api.setAiSettings(aiBase.trim() || null, aiModel.trim() || null, aiLang.trim() || null, aiKey.trim() || null);
    setAiHas(s.hasKey); setAiKey('');
    return s;
  };

  const saveAi = async () => {
    setAiBusy(true); setError(null); setAiMsg(null);
    try { await persistAi(); setAiMsg('AI settings saved.'); }
    catch (e) { setError(fmtErr(e)); }
    finally { setAiBusy(false); }
  };

  const testAi = async () => {
    setAiBusy(true); setError(null); setAiMsg(null);
    try {
      await persistAi(); // the probe reads stored settings
      const m = await api.aiGetModels();
      setModels(Array.isArray(m) ? m : []);
      setAiMsg(`Connected — ${m.length} model(s) available.`);
    } catch (e) { setError(fmtErr(e)); }
    finally { setAiBusy(false); }
  };

// JSX (settings mode):
            <div className="ai-settings">
              <h3>AI server (OpenWebUI)</h3>
              <input placeholder="https://ai.example.com" value={aiBase} onChange={(e) => setAiBase(e.target.value)} />
              <input placeholder={aiHas ? 'API key stored' : 'sk-...'} value={aiKey} onChange={(e) => setAiKey(e.target.value)} type="password" />
              <input list="ai-model-list" placeholder="Tidy model" value={aiModel} onChange={(e) => setAiModel(e.target.value)} />
              <datalist id="ai-model-list">{models.map((m) => <option key={m} value={m} />)}</datalist>
              <input placeholder="Language hint (optional, e.g. en)" value={aiLang} onChange={(e) => setAiLang(e.target.value)} />
              <div className="voice-actions">
                <button onClick={saveAi} disabled={aiBusy}>{aiBusy ? 'Working…' : 'Save'}</button>
                <button onClick={testAi} disabled={aiBusy}>Test connection</button>
              </div>
              {aiMsg && <p className="voice-hint">{aiMsg}</p>}
            </div>
```

- [ ] **Step 4: styles.css:**

```css
.ai-settings { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
.ai-settings h3 { margin: 4px 0; font-size: 1em; }
```

- [ ] **Step 5: Gates** — `npx vitest run`, `npx tsc --noEmit`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(voice): settings AI server section with model dropdown and test connection"`.

---

### Task 14: NoteEditor voice panel (playback, re-transcribe, delete audio)

**Files:**
- Modify: `src/components/NoteEditor.tsx`
- Modify: `src/components/NoteEditor.test.tsx`
- Modify: `src/styles.css` (.voice-panel)

**Interfaces:**
- Consumes: Task 10 api (`audioSrc`, `voiceDeleteNoteAudio`), Task 12 `onRetranscribe` prop.
- Produces: when the loaded note has `audioPath`, a `.voice-panel` with `<audio controls src={api.audioSrc(path)}>`, formatted duration, Re-transcribe button (`onRetranscribe(loadedId)`), Delete audio button (clears the panel, local-only).

- [ ] **Step 1: Failing tests** — NoteEditor.test.tsx additions (mock `get_note` gains audio fields where needed):

```tsx
  it('shows the voice panel with playback and duration when the note has audio', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_note') return Promise.resolve({ id: 'n1', title: 'T', content: '<p>hi</p>', category: 'Home', audioPath: '/data/voice/n1.wav', audioDurationSecs: 65, createdAt: null, updatedAt: null, deletedAt: null, dirty: false });
      if (cmd === 'update_note') return Promise.resolve({});
      return Promise.resolve(null);
    });
    render(<NoteEditor noteId="n1" />);
    await waitFor(() => expect(document.querySelector('.voice-panel')).not.toBeNull());
    const audio = document.querySelector('.voice-panel audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('src')).toContain('/data/voice/n1.wav');
    expect(document.querySelector('.voice-panel')?.textContent).toContain('1:05');
  });

  it('no audio_path means no voice panel', async () => {
    render(<NoteEditor noteId="n1" />);
    await waitFor(() => expect(screen.getByDisplayValue('T')).toBeInTheDocument());
    expect(document.querySelector('.voice-panel')).toBeNull();
  });

  it('delete audio clears the panel without touching content', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_note') return Promise.resolve({ id: 'n1', title: 'T', content: '<p>hi</p>', category: 'Home', audioPath: '/data/voice/n1.wav', audioDurationSecs: 65, createdAt: null, updatedAt: null, deletedAt: null, dirty: false });
      if (cmd === 'voice_delete_note_audio') return Promise.resolve({ id: 'n1', title: 'T', content: '<p>hi</p>', category: 'Home', audioPath: null, audioDurationSecs: null, createdAt: null, updatedAt: null, deletedAt: null, dirty: false });
      if (cmd === 'update_note') return Promise.resolve({});
      return Promise.resolve(null);
    });
    render(<NoteEditor noteId="n1" />);
    await waitFor(() => expect(document.querySelector('.voice-panel')).not.toBeNull());
    fireEvent.click(screen.getByText('Delete audio'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice_delete_note_audio', { noteId: 'n1' }));
    await waitFor(() => expect(document.querySelector('.voice-panel')).toBeNull());
  });

  it('re-transcribe button calls onRetranscribe with the note id', async () => {
    const onRetranscribe = vi.fn();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_note') return Promise.resolve({ id: 'n1', title: 'T', content: '<p>hi</p>', category: 'Home', audioPath: '/data/voice/n1.wav', audioDurationSecs: 65, createdAt: null, updatedAt: null, deletedAt: null, dirty: false });
      if (cmd === 'update_note') return Promise.resolve({});
      return Promise.resolve(null);
    });
    render(<NoteEditor noteId="n1" onRetranscribe={onRetranscribe} />);
    await waitFor(() => expect(document.querySelector('.voice-panel')).not.toBeNull());
    fireEvent.click(screen.getByText('Re-transcribe'));
    expect(onRetranscribe).toHaveBeenCalledWith('n1');
  });
```

- [ ] **Step 2: Run RED** — `npx vitest run NoteEditor` FAIL.

- [ ] **Step 3: Implement** — NoteEditor.tsx changes:

```tsx
// props
export default function NoteEditor({ noteId, onRetranscribe }: { noteId: string; onRetranscribe?: (noteId: string) => void }) {
...
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [audioDur, setAudioDur] = useState<number | null>(null);

// in the load effect, after setCategory:
      setAudioPath(note.audioPath);
      setAudioDur(note.audioDurationSecs);

// helper
  const fmtDuration = (s: number | null): string => {
    if (s == null) return '';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };

  const deleteAudio = async () => {
    if (!loadedId) return;
    try {
      const updated = await api.voiceDeleteNoteAudio(loadedId);
      setAudioPath(updated.audioPath);
      setAudioDur(updated.audioDurationSecs);
      await refreshAll();
    } catch { /* surfaced by the store on next refresh */ }
  };

// JSX — between the category input and <EditorContent>:
      {audioPath && (
        <div className="voice-panel">
          <audio controls src={api.audioSrc(audioPath)} />
          <span className="voice-duration">{fmtDuration(audioDur)}</span>
          <button className="voice-retranscribe" onClick={() => loadedId && onRetranscribe?.(loadedId)}>Re-transcribe</button>
          <button className="voice-delete-audio" onClick={deleteAudio}>Delete audio</button>
        </div>
      )}
```

- [ ] **Step 4: styles.css:**

```css
.voice-panel { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
.voice-duration { color: var(--muted-fg, #a39caf); font-size: 0.9em; }
```

- [ ] **Step 5: Gates** — `npx vitest run`, `npx tsc --noEmit`, `cargo test` (cite baseline).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(voice): note editor voice panel - playback, duration, re-transcribe, delete audio"`.

---

### Task 15: Live integration test (env-gated) + full gates

**Files:**
- Create: `src-tauri/tests/voice_live.rs`

**Interfaces:**
- Consumes: Task 4 VoiceAiClient. Env: `JOTTY_TEST_OWEBUI_URL`, `JOTTY_TEST_OWEBUI_KEY` (spec §8 — NEVER fabricate a run; skipped by default).

- [ ] **Step 1: Write the env-gated test:**

```rust
//! Live OpenWebUI integration (spec §8). SKIPPED unless
//! JOTTY_TEST_OWEBUI_URL + JOTTY_TEST_OWEBUI_KEY are set — never fabricated.
use jotty_client_lib::voice_ai::{Suffix, VoiceAiClient};

fn client() -> Option<VoiceAiClient> {
    let url = std::env::var("JOTTY_TEST_OWEBUI_URL").ok()?;
    let key = std::env::var("JOTTY_TEST_OWEBUI_KEY").ok()?;
    Some(VoiceAiClient::new(&url, &key, Suffix::V1).expect("client"))
}

fn tiny_wav(path: &std::path::Path) {
    let spec = hound::WavSpec {
        sample_format: hound::SampleFormat::Int,
        sample_rate: 16_000,
        channels: 1,
        bits_per_sample: 16,
    };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..16_000 {
        let t = i as f32 / 16_000.0;
        let s = 0.3 * (2.0 * std::f32::consts::PI * 440.0 * t).sin();
        w.write_sample((s * 32767.0) as i16).unwrap();
    }
    w.finalize().unwrap();
}

#[tokio::test]
#[ignore = "live OpenWebUI: requires JOTTY_TEST_OWEBUI_URL/KEY — never fabricated"]
async fn live_transcriptions_round_trip() {
    let Some(ai) = client() else {
        eprintln!("env unset — skipped");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let wav = dir.path().join("t.wav");
    tiny_wav(&wav);
    let (text, _sfx) = ai.transcribe(&wav, None).await.expect("live transcribe");
    assert!(!text.trim().is_empty(), "empty transcript");
}

#[tokio::test]
#[ignore = "live OpenWebUI: requires JOTTY_TEST_OWEBUI_URL/KEY — never fabricated"]
async fn live_models_list() {
    let Some(ai) = client() else {
        eprintln!("env unset — skipped");
        return;
    };
    let (models, _sfx) = ai.models().await.expect("live models");
    assert!(!models.is_empty(), "instance exposes no chat models");
    eprintln!("models: {models:?}");
}

#[tokio::test]
#[ignore = "live OpenWebUI: requires JOTTY_TEST_OWEBUI_URL/KEY — never fabricated"]
async fn live_tidy_round_trip() {
    let Some(ai) = client() else {
        eprintln!("env unset — skipped");
        return;
    };
    let (models, _) = ai.models().await.expect("live models");
    let (tidied, _) = ai.tidy(&models[0], "test memo without any punctuation at all").await.expect("live tidy");
    assert!(!tidied.trim().is_empty());
}
```

- [ ] **Step 2: Gates** — `cargo test` (default run: all unit tests green + 4 ignored: 1 pre-existing integration_real + 3 new voice_live), `npx vitest run`, `npx tsc --noEmit`, `docker compose -f dev/docker-compose.yml config` (parse-only, unchanged).

- [ ] **Step 3: Commit** — `git add -A && git commit -m "test(voice): env-gated live openwebui integration (transcribe/models/tidy)"`.

---

### Task 16: Ship v0.10.0 (standing ship procedure)

**Files:**
- Modify: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (0.9.2 → 0.10.0), both lockfiles
- Release artifacts: deb + rpm + appimage

- [ ] **Step 1: Full gates** — `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`, `cargo test`. Record the totals (baseline: vitest 60 / cargo 91+1i — expect meaningful growth; cite exact numbers in the release notes).
- [ ] **Step 2: Version bump** — 0.10.0 in `package.json` + `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml`; then `npm install --package-lock-only` and `cargo update -p jotty-client`.
- [ ] **Step 3: Commit** — conventional message, body explains behavior + test deltas: `git commit -m "feat(voice): voice notes via self-hosted OpenWebUI (v0.10.0)"`.
- [ ] **Step 4: Push** — `git push`, verify `git ls-remote origin main` == local HEAD.
- [ ] **Step 5: Build** — `npx tauri build` (deb + rpm + appimage; BUILD_EXIT:0; linuxdeploy download failure → deb-only fallback per T19 precedent, disclosed).
- [ ] **Step 6: Tag + release** — `git tag -a v0.10.0 -m ...` + push tag; `~/.local/bin/gh release create v0.10.0 <rpm> <deb> <appimage> --title v0.10.0 --notes-file <notes>`. Notes include: changelog (voice notes pipeline), install commands, COMPUTED sha256 of all three bundles (never eyeballed).
- [ ] **Step 7: Verify release** — `gh release view --json assets` state=uploaded; download one asset back and re-hash against the local build (checksums are the truth).
- [ ] **Step 8: Manual release gates (user desktop):** (a) real-mic record → playback → save round trip (cpal stream path is untestable headlessly — spec §8); (b) keyring AI-key set/get roundtrip in the packaged app (release-gate convention); (c) server prerequisites per spec §11 (API-keys master switch ON, STT engine configured, ≥1 chat model).
- [ ] **Step 9: Ledger** — update the jotty-client skill status entry + memory (neutral auth phrasing; voice feature summary, plan rulings, suite counts, v0.10.0 tag).

---

## Self-review (controller, run at plan-finalization)

1. **Spec coverage:** §2 pipeline (T3/T6/T11/T7) ✓; §2.2 tidy fallback (T6/T11) ✓; §2.3 local audio (T2/T3/T7/T9 + T1 invariant test) ✓; §2.4 memo flow only (T11/T12) ✓; §2.5 one config surface (T5/T13) ✓; §2.6 offline capture + pending retry (T3/T8/T12) ✓; §3 API facts + drift rule (T4/T15) ✓; §4 architecture/modules/commands (T3-T7, T10-T14) ✓; §5 data model + single-tx + FTS (T1/T7) ✓; §6 flows incl. resume prompt + sweep (T9/T11/T12) ✓; §7 limits (cap T2+T11, no-mic T3, auth-vs-network T4/T6, malformed T4, tidy-failure T6) ✓; §8 testing matrix (T2-T15) ✓; §9 crates + ship (T2/T3/T16) ✓; §10 non-goals respected (no dictation/TTS/level meter) ✓; §11 user prerequisites (T16 step 8) ✓.
2. **Placeholder scan:** one deliberate executor note in Task 8 Step 1 (`transcribe_ok_mock` sketch marked DELETE-THIS — the real tests are self-contained); Task 6 `staged()` helper flagged for dead-branch cleanup; both are instructions WITH exact code, not missing content. No TBDs.
3. **Type consistency:** `Suffix` (V1/Plain ↔ 'v1'/'plain') across T4/T5/T6/T8 ✓; `VoiceRecordingRow` fields ↔ `VoiceRecordingDto` ↔ TS `VoiceRecordingDto` ✓; `AiSettingsDto` ↔ T13 UI ✓; `create_note_tx` signature T7 (used by T7 inners only) ✓; `audioSrc` T10 ↔ T11/T14 ✓; `onRetranscribe` T12 ↔ T14 ✓; command arg casing camelCase on the TS side (`recordingId`, `noteId`, `useTidied`, `contentOverride`, `baseUrl`, `languageHint`, `apiKey`) matching Tauri's arg-name translation of the Rust snake_case params ✓.