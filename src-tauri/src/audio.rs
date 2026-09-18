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
            let local = self.next_out - (self.consumed as i64 - offset) as f64;
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
        assert_eq!(out.len(), 31_999); // 2 s in -> 2 s at 16 kHz: 2x16_000 minus the one
                                       // final half-position the seam rule cannot emit
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
        out.extend(r.push(&[1.0f32])); // single trailing sample: want pins the seam emit set
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
}

// --- recorder (cpal) --------------------------------------------------------
// Headless-untestable except the injected failure paths (spec §8: capture
// device access is gated). Real-mic capture is a MANUAL release smoke gate.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

pub struct PreparedInput {
    pub config: cpal::StreamConfig,
    pub sample_format: cpal::SampleFormat,
    /// Builds the input stream for this device; boxed so tests can inject
    /// a build failure and prove the cleanup path.
    pub build: Box<dyn FnOnce(mpsc::Sender<Ctrl>) -> Result<cpal::Stream, String> + Send>,
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
        build: Box::new(move |tx: mpsc::Sender<Ctrl>| {
            let err_fn = |e| log::warn!("audio input error: {e}");
            // manual conversion avoids depending on cpal sample-conversion traits
            let stream = match sample_format {
                cpal::SampleFormat::F32 => dev.build_input_stream(
                    cfg,
                    move |d: &[f32], _: &cpal::InputCallbackInfo| { let _ = tx.send(Ctrl::Samples(d.to_vec())); },
                    err_fn,
                    None,
                ),
                cpal::SampleFormat::I16 => dev.build_input_stream(
                    cfg,
                    move |d: &[i16], _: &cpal::InputCallbackInfo| {
                        let _ = tx.send(Ctrl::Samples(d.iter().map(|s| *s as f32 / 32768.0).collect()));
                    },
                    err_fn,
                    None,
                ),
                cpal::SampleFormat::U16 => dev.build_input_stream(
                    cfg,
                    move |d: &[u16], _: &cpal::InputCallbackInfo| {
                        let _ = tx.send(Ctrl::Samples(d.iter().map(|s| (*s as f32 - 32768.0) / 32768.0).collect()));
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
        prepared: PreparedInput,
        writer: hound::WavWriter<BufWriter<std::fs::File>>,
    ) -> Result<(), String> {
        let mut guard = self.session.lock().unwrap();
        if guard.is_some() {
            return Err("a recording is already active".into());
        }
        let PreparedInput { config, build, .. } = prepared;
        let (rate, channels) = (config.sample_rate, config.channels);
        let (tx, rx) = mpsc::channel::<Ctrl>();
        let stream = build(tx.clone())?;
        let handle = std::thread::spawn(move || {
            let _keepalive = stream; // dropping the stream ends the callback
            run_writer(rx, writer, rate, channels)
        });
        *guard = Some(Session {
            recording_id: recording_id.into(),
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