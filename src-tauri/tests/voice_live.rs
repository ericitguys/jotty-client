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