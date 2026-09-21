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

pub const EXTRACT_SYSTEM_PROMPT: &str = "You extract actionable tasks from a voice-memo transcript. Reply with ONLY a JSON array of strings — no prose, no Markdown, no code fences. Each element is one short imperative task title in the transcript's language. Merge duplicates and drop pure small talk. Never invent facts that are not in the transcript. If the transcript contains no tasks, reply with [].";

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

    /// Returns (task titles, effective suffix) — the caller persists the suffix.
    pub async fn extract_tasks(&self, model: &str, text: &str) -> AppResult<(Vec<String>, Suffix)> {
        let body = serde_json::json!({
            "model": model,
            "messages": [
                {"role": "system", "content": EXTRACT_SYSTEM_PROMPT},
                {"role": "user", "content": text}
            ]
        });
        match self.chat_once(self.suffix, &body).await {
            Ok(v) => Ok((parse_tasks(&parse_choice(&v)?)?, self.suffix)),
            Err(AppError::Api { status: 404, .. }) => {
                let other = self.other();
                let v = self.chat_once(other, &body).await?;
                Ok((parse_tasks(&parse_choice(&v)?)?, other))
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

/// Tolerant extraction parse: trim, strip code fences, take the first `[` to
/// the last `]`; string items pass, numbers stringify, anything else → Err
/// (never a fabricated list).
fn parse_tasks(content: &str) -> AppResult<Vec<String>> {
    let trimmed = content.trim();
    let stripped = if trimmed.starts_with("```") {
        let inner = trimmed.trim_start_matches("```").trim_start_matches("json").trim();
        inner.trim_end_matches("```").trim()
    } else {
        trimmed
    };
    let start = stripped.find('[').ok_or_else(|| AppError::Other("extraction reply contains no JSON array".into()))?;
    let end = stripped.rfind(']').ok_or_else(|| AppError::Other("extraction reply has no closing bracket".into()))?;
    if end < start {
        return Err(AppError::Other("extraction reply has malformed array".into()));
    }
    let arr = serde_json::from_str::<Vec<serde_json::Value>>(&stripped[start..=end])
        .map_err(|e| AppError::Other(format!("extraction reply is not a JSON array: {e}")))?;
    arr.into_iter()
        .map(|v| match v {
            serde_json::Value::String(s) => Ok(s),
            serde_json::Value::Number(n) => Ok(n.to_string()),
            _ => Err(AppError::Other("extraction reply contains a non-string task".into())),
        })
        .collect()
}

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
        // Local binding (not a trailing expression): the MappedRows temporary
        // borrows `stmt` and must drop before it leaves scope (E0597).
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
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
    use tauri::Manager;
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

    #[tokio::test]
    async fn extract_tasks_sends_prompt_and_parses_plain_array() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .and(wiremock::matchers::body_partial_json(serde_json::json!({
                "model": "llama3",
                "messages": [
                    {"role": "system", "content": EXTRACT_SYSTEM_PROMPT},
                    {"role": "user", "content": "memo text"}
                ]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"role": "assistant", "content": "[\"Buy milk\",\"Call dentist\"]"}}]
            })))
            .mount(&s).await;
        let (tasks, sfx) = client(&s.uri()).extract_tasks("llama3", "memo text").await.unwrap();
        assert_eq!(tasks, vec!["Buy milk", "Call dentist"]);
        assert_eq!(sfx, Suffix::V1);
    }

    #[tokio::test]
    async fn extract_tasks_tolerates_code_fenced_array() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "```json\n[\"Task A\", \"Task B\"]\n```"}}]
            })))
            .mount(&s).await;
        let (tasks, _) = client(&s.uri()).extract_tasks("llama3", "memo").await.unwrap();
        assert_eq!(tasks, vec!["Task A", "Task B"]);
    }

    #[tokio::test]
    async fn extract_tasks_stringifies_numbers_and_errors_on_objects() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "[1, 2]"}}]
            })))
            .mount(&s).await;
        let (tasks, _) = client(&s.uri()).extract_tasks("llama3", "memo").await.unwrap();
        assert_eq!(tasks, vec!["1", "2"]);
        // object item → error, never a fabricated list
        let s2 = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "[{\"title\": \"x\"}]"}}]
            })))
            .mount(&s2).await;
        assert!(client(&s2.uri()).extract_tasks("llama3", "memo").await.is_err());
    }

    #[tokio::test]
    async fn extract_tasks_empty_array_is_ok_and_no_array_is_err() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "[]"}}]
            })))
            .mount(&s).await;
        let (tasks, _) = client(&s.uri()).extract_tasks("llama3", "memo").await.unwrap();
        assert!(tasks.is_empty());
        // prose reply (no parseable array) → Err
        let s2 = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "I found some tasks in your memo."}}]
            })))
            .mount(&s2).await;
        assert!(client(&s2.uri()).extract_tasks("llama3", "memo").await.is_err());
    }

    #[tokio::test]
    async fn extract_tasks_404_falls_back_to_plain() {
        let s = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(404)).mount(&s).await;
        Mock::given(method("POST")).and(path("/api/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"content": "[\"T\"]"}}]
            })))
            .mount(&s).await;
        let (tasks, sfx) = client(&s.uri()).extract_tasks("llama3", "memo").await.unwrap();
        assert_eq!(tasks, vec!["T"]);
        assert_eq!(sfx, Suffix::Plain);
    }

    #[test]
    fn parse_tasks_strips_fences_and_takes_first_array() {
        assert_eq!(parse_tasks("[\"a\",\"b\"]").unwrap(), vec!["a", "b"]);
        assert_eq!(parse_tasks("```json\n[\"a\"]\n```").unwrap(), vec!["a"]);
        assert_eq!(parse_tasks("Sure! [\"a\"] hope this helps").unwrap(), vec!["a"]);
        assert_eq!(parse_tasks("[]").unwrap(), Vec::<String>::new());
        assert!(parse_tasks("no array here").is_err());
        assert!(parse_tasks("[{\"a\":1}]").is_err());
    }

    #[tokio::test]
    #[ignore] // env-gated live run: JOTTY_TEST_OWEBUI_URL / JOTTY_TEST_OWEBUI_KEY — never fabricated
    async fn live_extract_tasks_roundtrip() {
        let url = std::env::var("JOTTY_TEST_OWEBUI_URL").expect("set JOTTY_TEST_OWEBUI_URL");
        let key = std::env::var("JOTTY_TEST_OWEBUI_KEY").expect("set JOTTY_TEST_OWEBUI_KEY");
        let ai = crate::voice_ai::VoiceAiClient::new(&url, &key, crate::voice_ai::Suffix::V1).unwrap();
        let (tasks, _) = ai.extract_tasks("gemma3", "I need to buy milk tomorrow and email the dentist about my cleaning.").await.unwrap();
        println!("{tasks:?}");
        assert!(!tasks.is_empty());
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

    fn db_conn() -> rusqlite::Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    fn client_at(uri: &str) -> VoiceAiClient {
        VoiceAiClient::new(uri, "sk", Suffix::V1).unwrap()
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
}