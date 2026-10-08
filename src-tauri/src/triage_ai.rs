// AI-augmented triage (P3 Task 1): batched triage suggestions via OpenWebUI.
// Laws (plan Global Constraints): ONE batched chat request per chunk (never
// per note); strict validation both sides; ONE retry on parse failure; a
// failed chunk is the CALLER's problem to degrade (this fn returns Err).
// Advisory-only: suggestions are returned, never applied, never persisted.

use crate::error::{AppError, AppResult};

pub const TRIAGE_CHUNK_CAP: usize = 20;

// Prompt content cap: note content is truncated to this many CHARS
// (char-boundary-safe) before the note enters the user body (plan law).
// Cross-references the Rust>TS contract in src/triage/suggestions.ts.
pub const NOTE_CONTENT_CAP: usize = 2000;

// Route literals (spec §5) — case-SENSITIVE closed set; the TS side mirrors
// this via isTriageRoute (src/triage/routes.ts). The validator is the ONLY
// writer of the route field, so anything it admits is one of these literals.
pub const TRIAGE_ROUTES: [&str; 4] = ["TODO", "COMMANDS", "DOCS", "NOISE"];

#[derive(Debug, Clone)]
pub struct TriageNotePayload {
    pub id: String,
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct TriageSuggestion {
    pub note_id: String,
    pub route: String,
    pub suggested_board: Option<String>,
    pub suggested_title: Option<String>,
    pub suggested_tags: Vec<String>,
    pub confidence: f64,
}

// System prompt (plan Task 1 prompt contract): ONLY a JSON array, one element
// per input note, exact shape + literals; fences tolerated by the parser but
// not requested.
pub const TRIAGE_SYSTEM_PROMPT: &str = "You triage captured notes. Reply with ONLY a JSON array \
of objects — no prose, no Markdown, no code fences. One object per input note, same order. \
Each object: {\"note_id\": string (copy the given id), \"route\": \"TODO\"|\"COMMANDS\"|\"DOCS\"|\"NOISE\", \
\"suggested_board\": string|null (null unless one of the supplied board names fits; must be EXACTLY \
a supplied name), \"suggested_title\": string|null (a short cleaned-up title, or null), \
\"suggested_tags\": string[] (lowercase words, optional leading #, from the supplied vocabulary when \
possible), \"confidence\": number 0.0-1.0 (your calibrated certainty)}. Route meanings: \
TODO = actionable task; COMMANDS = commands/snippets to keep; DOCS = reference knowledge worth \
keeping; NOISE = everything else (not worth keeping, the user will likely discard). Never invent \
note ids, boards, or content.";

// User body (plan prompt contract): boards/tags echo the VALIDATED lists; note
// contents were pre-truncated caller-side (commands) to <=2000 chars.
pub fn triage_build_body(
    notes: &[TriageNotePayload],
    board_names: &[String],
    tag_vocab: &[String],
) -> serde_json::Value {
    serde_json::json!({
        "boards": board_names,
        "tags": tag_vocab,
        "notes": notes.iter().map(|n| serde_json::json!({
            "id": n.id, "title": n.title, "content": n.content
        })).collect::<Vec<_>>()
    })
}

// Tag normalization (plan validation law): trim, strip leading '#'s,
// lowercase; empty results are skipped by the caller-side filter.
fn triage_normalize_tag(t: &str) -> String {
    t.trim().trim_start_matches('#').to_lowercase()
}

// Strict parser + validator: reply Value (chat result) -> choices[0] content
// (voice parse_choice law) -> fence-tolerant slice -> per-element validation:
// route must be an EXACT literal (case-sensitive) else the element is DROPPED;
// note_id (`note_id` or `noteId`) must be in the request set else DROPPED;
// suggested_board not among board_names -> cleared to None (route kept);
// confidence absent/non-numeric -> 0.0 (item kept); tags normalized
// (trim, strip leading '#'s, lowercase, empties skipped).
pub fn triage_parse_reply(
    reply: &serde_json::Value,
    note_ids: &[String],
    board_names: &[String],
) -> AppResult<Vec<TriageSuggestion>> {
    let content = crate::voice_ai::parse_choice(reply)?;
    triage_parse_content(&content, note_ids, board_names)
}

fn triage_parse_content(
    content: &str,
    note_ids: &[String],
    board_names: &[String],
) -> AppResult<Vec<TriageSuggestion>> {
    let s = content.trim();
    // fence tolerance (parse_tasks law mirror, voice_ai:280-302)
    let s = if s.starts_with("```") {
        s.trim_start_matches("```")
            .trim_start_matches("json")
            .trim()
            .trim_end_matches("```")
            .trim()
    } else {
        s
    };
    let start = s.find('[').ok_or_else(|| {
        AppError::Other(format!("triage reply contains no JSON array: {}", &content[..content.len().min(80)]))
    })?;
    let end = s.rfind(']').ok_or_else(|| {
        AppError::Other("triage reply contains no JSON array".to_string())
    })?;
    if end < start {
        return Err(AppError::Other("triage reply contains no JSON array".to_string()));
    }
    let slice = &s[start..=end];
    let items: Vec<serde_json::Value> = serde_json::from_str(slice)
        .map_err(|e| AppError::Other(format!("triage reply is not a JSON array: {e}")))?;
    // Per-model-item validation first; input-order emission LAST (plan pin:
    // one suggestion per input note id in REQUEST order; a model item for an
    // unknown id drops; duplicate model items collapse to the first).
    let mut models: Vec<(&String, TriageSuggestion)> = Vec::new();
    let mut seen: std::collections::HashSet<&String> = std::collections::HashSet::new();
    for it in &items {
        let Some(obj) = it.as_object() else { continue };
        // note id: snake or camel (model tolerance), must belong to the request set
        let Some(id) = obj.get("note_id").or_else(|| obj.get("noteId")).and_then(|v| v.as_str()) else { continue };
        let Some(req_id) = note_ids.iter().find(|n| n.as_str() == id) else { continue };
        if !seen.insert(req_id) {
            continue; // duplicate model item for the same id: first wins
        }
        // route: exact literal, case-sensitive; anything else DROPS the element
        let Some(route) = obj.get("route").and_then(|v| v.as_str()) else { continue };
        if !TRIAGE_ROUTES.contains(&route) {
            continue;
        }
        // board: kept ONLY when it exactly matches a supplied board name
        let board = obj
            .get("suggested_board")
            .and_then(|v| v.as_str())
            .filter(|b| board_names.iter().any(|n| n == b))
            .map(|b| b.to_string());
        // title: null unless a non-empty string
        let title = obj
            .get("suggested_title")
            .and_then(|v| v.as_str())
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        // tags: normalize; empties skipped
        let tags: Vec<String> = obj
            .get("suggested_tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.as_str())
                    .map(triage_normalize_tag)
                    .filter(|t| !t.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let confidence = obj.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0);
        models.push((
            req_id,
            TriageSuggestion {
                note_id: req_id.clone(),
                route: route.to_string(),
                suggested_board: board,
                suggested_title: title,
                suggested_tags: tags,
                confidence,
            },
        ));
    }
    // INPUT-order emission: one slot per requested id that produced a VALID
    // reply item.
    let mut out = Vec::with_capacity(note_ids.len());
    for id in note_ids {
        if let Some((_, s)) = models.iter().find(|(k, _)| *k == id) {
            out.push(s.clone());
        }
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
pub async fn triage_suggest(
    ai: &crate::voice_ai::VoiceAiClient,
    model: &str,
    notes: &[TriageNotePayload],
    board_names: &[String],
    tag_vocab: &[String],
    start_suffix: crate::voice_ai::Suffix,
) -> AppResult<(Vec<TriageSuggestion>, crate::voice_ai::Suffix)> {
    let ids: Vec<String> = notes.iter().map(|n| n.id.clone()).collect();
    let user_body = serde_json::to_string(&triage_build_body(notes, board_names, tag_vocab))
        .map_err(|e| AppError::Other(format!("triage body serialize: {e}")))?;
    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": TRIAGE_SYSTEM_PROMPT},
            {"role": "user", "content": user_body}
        ]
    });
    // one chat-with-suffix-chain attempt (tidy law: 404 at the current suffix
    // -> one retry at the other; the EFFECTIVE suffix comes back)
    async fn chain(
        ai: &crate::voice_ai::VoiceAiClient,
        body: &serde_json::Value,
        sfx: crate::voice_ai::Suffix,
    ) -> AppResult<(serde_json::Value, crate::voice_ai::Suffix)> {
        match ai.chat_once(sfx, body).await {
            Ok(v) => Ok((v, sfx)),
            Err(AppError::Api { status: 404, .. }) => {
                let other = if matches!(sfx, crate::voice_ai::Suffix::V1) {
                    crate::voice_ai::Suffix::Plain
                } else {
                    crate::voice_ai::Suffix::V1
                };
                let v = ai.chat_once(other, body).await?;
                Ok((v, other))
            }
            Err(e) => Err(e),
        }
    }
    // strict parse; ONE retry of the SAME body on parse failure (spec §5);
    // HTTP/auth errors do NOT retry (they surface immediately).
    let mut sfx = start_suffix;
    for attempt in 0..2usize {
        let (reply, effective) = chain(ai, &body, sfx).await?;
        sfx = effective;
        match triage_parse_reply(&reply, &ids, board_names) {
            Ok(items) => return Ok((items, sfx)),
            Err(e) => {
                if attempt == 1 {
                    return Err(e); // twice failed = Err; the caller degrades this chunk to manual
                }
            }
        }
    }
    unreachable!("every loop arm returns")
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn note(id: &str, title: &str, content: &str) -> TriageNotePayload {
        TriageNotePayload { id: id.into(), title: title.into(), content: content.into() }
    }

    fn reply_with(content: serde_json::Value) -> serde_json::Value {
        serde_json::json!({"choices": [{"message": {"content": content}}]})
    }

    fn chat_reply(items: serde_json::Value) -> serde_json::Value {
        serde_json::json!({"choices": [{"message": {"content": serde_json::to_string(&items).unwrap()}}]})
    }

    fn ok_item(id: &str, route: &str) -> serde_json::Value {
        serde_json::json!({"note_id": id, "route": route, "suggested_board": serde_json::Value::Null,
            "suggested_title": serde_json::Value::Null, "suggested_tags": [], "confidence": 0.8})
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn boards(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    // ---- Step 1: parser/validator fences ----

    #[test]
    fn triage_parse_happy_path_orders_by_input() {
        let v = chat_reply(serde_json::json!([ok_item("b", "TODO"), ok_item("a", "NOISE")]));
        let out = triage_parse_reply(&v, &ids(&["a", "b"]), &[]).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].note_id, "a"); // input order, never model order
        assert_eq!(out[0].route, "NOISE");
        assert_eq!(out[1].note_id, "b");
        assert_eq!(out[1].route, "TODO");
    }

    #[test]
    fn triage_parse_strips_code_fences() {
        let content = "```json\n[{\"note_id\":\"a\",\"route\":\"TODO\",\"suggested_board\":null,\"suggested_title\":null,\"suggested_tags\":[],\"confidence\":0.9}]\n```";
        let v = reply_with(serde_json::Value::String(content.into()));
        let out = triage_parse_reply(&v, &ids(&["a"]), &[]).unwrap();
        assert_eq!(out.len(), 1); // fence law mirror (parse_tasks): sliced to first '[' ..= last ']'
        assert_eq!(out[0].route, "TODO");
        assert_eq!(out[0].confidence, 0.9);
    }

    #[test]
    fn triage_parse_drops_out_of_enum_route() {
        let v = chat_reply(serde_json::json!([
            ok_item("a", "TODO"),
            {"note_id": "b", "route": "todo", "suggested_board": serde_json::Value::Null,
             "suggested_title": serde_json::Value::Null, "suggested_tags": [], "confidence": 0.9},
            ok_item("c", "COMMANDS")
        ]));
        let out = triage_parse_reply(&v, &ids(&["a", "b", "c"]), &[]).unwrap();
        assert_eq!(out.len(), 2); // lowercase "todo" dropped case-sensitively
        assert_eq!(out[0].note_id, "a");
        assert_eq!(out[1].note_id, "c");
    }

    #[test]
    fn triage_parse_drops_unknown_note_id() {
        let v = chat_reply(serde_json::json!([ok_item("a", "TODO"), ok_item("hallucinated", "DOCS")]));
        let out = triage_parse_reply(&v, &ids(&["a"]), &[]).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].note_id, "a");
    }

    #[test]
    fn triage_parse_invalid_board_cleared() {
        let mut item = ok_item("a", "TODO");
        item["suggested_board"] = serde_json::json!("Not A Real Board");
        let v = chat_reply(serde_json::json!([item]));
        let out = triage_parse_reply(&v, &ids(&["a"]), &boards(&["Maintenance"])).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].suggested_board, None, "unvalidated board cleared");
        assert_eq!(out[0].route, "TODO", "route kept after board clear");
    }

    #[test]
    fn triage_parse_missing_confidence_zeroed() {
        let v = chat_reply(serde_json::json!([
            {"note_id": "a", "route": "TODO", "suggested_board": serde_json::Value::Null,
             "suggested_title": serde_json::Value::Null, "suggested_tags": []},
            {"note_id": "b", "route": "DOCS", "suggested_board": serde_json::Value::Null,
             "suggested_title": serde_json::Value::Null, "suggested_tags": [], "confidence": "high"}
        ]));
        let out = triage_parse_reply(&v, &ids(&["a", "b"]), &[]).unwrap();
        assert_eq!(out.len(), 2, "items are kept, never dropped for confidence");
        assert_eq!(out[0].confidence, 0.0, "absent confidence -> 0.0");
        assert_eq!(out[1].confidence, 0.0, "non-numeric confidence -> 0.0");
    }

    #[test]
    fn triage_note_id_snake_and_camel_boths_accepted() {
        let v = chat_reply(serde_json::json!([
            {"noteId": "a", "route": "TODO", "suggested_board": serde_json::Value::Null,
             "suggested_title": serde_json::Value::Null, "suggested_tags": [], "confidence": 0.5},
            ok_item("b", "DOCS")
        ]));
        let out = triage_parse_reply(&v, &ids(&["a", "b"]), &[]).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].note_id, "a");
        assert_eq!(out[1].note_id, "b");
    }

    #[test]
    fn triage_parse_rejects_non_array() {
        let a = ids(&["a"]);
        // prose without brackets -> Err
        assert!(triage_parse_reply(&reply_with("I think TODO is best".into()), &a, &[]).is_err());
        // a bare object (no '[' in the content) -> Err, never fabricated into an empty list
        assert!(triage_parse_reply(
            &reply_with(serde_json::json!({"note_id": "a", "route": "TODO"})),
            &a, &[]
        ).is_err());
        // model reply missing choices[0] -> the strict parse_choice Err
        assert!(triage_parse_reply(&serde_json::json!({"oops": 1}), &a, &[]).is_err());
        // an empty ARRAY is legal and yields no suggestions
        let out = triage_parse_reply(&chat_reply(serde_json::json!([])), &a, &[]).unwrap();
        assert_eq!(out.len(), 0);
    }

    // ---- Step 2: prompt contract ----

    #[test]
    fn triage_prompt_lists_routes_boards_vocab_and_notes() {
        let notes = vec![note("a", "Title A", "Content A"), note("b", "Title B", "Content B")];
        let b = boards(&["Maintenance"]);
        let tags = vec!["todo".to_string(), "cmd".to_string()];
        for literal in TRIAGE_ROUTES {
            assert!(TRIAGE_SYSTEM_PROMPT.contains(literal), "prompt carries route literal {literal}");
        }
        let body = triage_build_body(&notes, &b, &tags);
        assert_eq!(body["boards"], serde_json::json!(["Maintenance"]));
        assert_eq!(body["tags"], serde_json::json!(["todo", "cmd"]));
        let sent = body["notes"].as_array().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0]["id"], "a");
        assert_eq!(sent[0]["title"], "Title A");
        assert_eq!(sent[0]["content"], "Content A");
        assert_eq!(sent[1]["content"], "Content B");
    }

    // ---- Step 3: wiremock (chat seam: parse retry + suffix chain) ----

    fn valid_items() -> serde_json::Value {
        serde_json::json!([ok_item("a", "TODO")])
    }

    #[tokio::test]
    async fn triage_batch_retries_once_after_parse_failure() {
        let s = MockServer::start().await;
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c = hits.clone();
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .respond_with(move |_req: &_| {
                let n = c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if n == 0 {
                    // 1st attempt: parse-failing content (prose, no array)
                    ResponseTemplate::new(200).set_body_json(
                        serde_json::json!({"choices": [{"message": {"content": "not a json array"}}]})
                    )
                } else {
                    ResponseTemplate::new(200).set_body_json(chat_reply(valid_items()))
                }
            })
            .mount(&s)
            .await;
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk-test", crate::voice_ai::Suffix::V1).unwrap();
        let (out, sfx) = triage_suggest(&ai, "m", &[note("a", "T", "C")], &[], &[], crate::voice_ai::Suffix::V1).await.unwrap();
        assert_eq!(out.len(), 1); // the valid 2nd attempt parsed
        assert_eq!(out[0].note_id, "a");
        assert_eq!(out[0].route, "TODO");
        assert_eq!(sfx, crate::voice_ai::Suffix::V1);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2, "exactly ONE parse retry: 2 calls");
    }

    #[tokio::test]
    async fn triage_batch_second_failure_surfaces_err() {
        let s = MockServer::start().await;
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c = hits.clone();
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .respond_with(move |_req: &_| {
                c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ResponseTemplate::new(200).set_body_json(
                    serde_json::json!({"choices": [{"message": {"content": "still not a json array"}}]})
                )
            })
            .mount(&s)
            .await;
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk-test", crate::voice_ai::Suffix::V1).unwrap();
        let res = triage_suggest(&ai, "m", &[note("a", "T", "C")], &[], &[], crate::voice_ai::Suffix::V1).await;
        assert!(res.is_err(), "a twice-failed chunk is an Err (caller degrades to manual)");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2, "never a 3rd attempt");
    }

    #[tokio::test]
    async fn triage_batch_uses_suffix_retry_chain() {
        let s = MockServer::start().await;
        // v1 path 404s -> the suffix chain retries the non-versioned path
        Mock::given(method("POST")).and(path("/api/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({"detail": "nope"})))
            .mount(&s)
            .await;
        Mock::given(method("POST")).and(path("/api/chat/completions"))
            .respond_with(move |_req: &_| ResponseTemplate::new(200).set_body_json(chat_reply(valid_items())))
            .mount(&s)
            .await;
        let ai = crate::voice_ai::VoiceAiClient::new(&s.uri(), "sk-test", crate::voice_ai::Suffix::V1).unwrap();
        let (out, sfx) = triage_suggest(&ai, "m", &[note("a", "T", "C")], &[], &[], crate::voice_ai::Suffix::V1).await.unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(sfx, crate::voice_ai::Suffix::Plain, "effective suffix returned for persistence");
    }
}