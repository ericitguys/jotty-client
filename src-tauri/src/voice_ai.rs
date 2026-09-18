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

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    struct BodyContains(&'static [u8]);
    impl wiremock::Match for BodyContains {
        fn matches(&self, request: &wiremock::Request) -> bool {
            // wiremock 0.6.5 Request.body is a plain Vec<u8> (not Option<Bytes>).
            request.body.windows(self.0.len()).any(|w| w == self.0)
        }
    }

    fn client(uri: &str) -> VoiceAiClient {
        VoiceAiClient::new(uri, "sk-test", Suffix::V1).unwrap()
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