use crate::error::{AppError, AppResult};
use crate::jotty::models::{Categories, Created, Health, ServerChecklist, ServerNote};
use serde::de::DeserializeOwned;

#[derive(Debug, Clone)]
pub struct JottyClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
}

fn is_local(url: &reqwest::Url) -> bool {
    match url.host_str() {
        Some("localhost") | Some("127.0.0.1") | Some("::1") => true,
        _ => false,
    }
}

impl JottyClient {
    pub fn new(base_url: &str, api_key: &str) -> AppResult<Self> {
        let url = reqwest::Url::parse(base_url)
            .map_err(|e| AppError::InvalidConfig(format!("bad instance url: {e}")))?;
        if url.scheme() != "https" && !is_local(&url) {
            return Err(AppError::InvalidConfig("instance url must be https (http only allowed for localhost)".into()));
        }
        Ok(Self {
            // 30s per-request timeout: without it a hung connection (dropped
            // packets, stalled server) wedges do_sync's `syncing` flag forever
            // and every later sync silently no-ops.
            http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build()
                .map_err(|e| AppError::InvalidConfig(format!("http client: {e}")))?,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    async fn api_get<T: DeserializeOwned>(&self, path: &str) -> AppResult<T> {
        let resp = self.http.get(self.url(path)).header("x-api-key", &self.api_key).send().await?;
        finish(resp).await
    }

    async fn api_send<T: DeserializeOwned>(&self, method: reqwest::Method, path: &str, body: serde_json::Value) -> AppResult<T> {
        let resp = self.http.request(method, self.url(path))
            .header("x-api-key", &self.api_key)
            .json(&body)
            .send().await?;
        finish(resp).await
    }

    pub async fn health(&self) -> AppResult<Health> {
        self.api_get("/api/health").await
    }

    pub async fn get_notes(&self) -> AppResult<Vec<ServerNote>> {
        // (pre-ruled) `.into()` from Value is E0277 — From<Value> for Vec<T> doesn't exist.
        let v = self.api_get::<serde_json::Value>("/api/notes").await?;
        Ok(serde_json::from_value(v["notes"].clone())
            .map_err(|e| AppError::Other(format!("parse /api/notes: {e}")))?)
    }

    pub async fn get_checklists(&self) -> AppResult<Vec<ServerChecklist>> {
        // (pre-ruled) same repair as get_notes — `.into()` from Value is E0277.
        let v = self.api_get::<serde_json::Value>("/api/checklists").await?;
        Ok(serde_json::from_value(v["checklists"].clone())
            .map_err(|e| AppError::Other(format!("parse /api/checklists: {e}")))?)
    }

    pub async fn get_categories(&self) -> AppResult<Categories> {
        // Real wire shape (API.md §14): payload is wrapped under a top-level
        // "categories" key — unwrap like get_notes/get_checklists. The plain
        // parse previously relied on Categories' #[serde(default)] fields and
        // silently produced empty lists (sidebar showed no categories).
        let v = self.api_get::<serde_json::Value>("/api/categories").await?;
        Ok(serde_json::from_value(v["categories"].clone())
            .map_err(|e| AppError::Other(format!("parse /api/categories: {e}")))?)
    }

    pub async fn create_note(&self, title: &str, content: &str, category: &str) -> AppResult<ServerNote> {
        let created: Created<ServerNote> = self.api_send(
            reqwest::Method::POST, "/api/notes",
            serde_json::json!({"title": title, "content": content, "category": category}),
        ).await?;
        created.data.ok_or_else(|| AppError::Other("create_note: missing data".into()))
    }

    pub async fn update_note(&self, id: &str, title: &str, content: &str, category: &str) -> AppResult<ServerNote> {
        let created: Created<ServerNote> = self.api_send(
            reqwest::Method::PUT, &format!("/api/notes/{id}"),
            serde_json::json!({"title": title, "content": content, "category": category}),
        ).await?;
        created.data.ok_or_else(|| AppError::Other("update_note: missing data".into()))
    }

    pub async fn delete_note(&self, id: &str) -> AppResult<()> {
        self.api_send::<serde_json::Value>(reqwest::Method::DELETE, &format!("/api/notes/{id}"), serde_json::json!({})).await?;
        Ok(())
    }
    pub async fn create_checklist(&self, title: &str, category: &str) -> AppResult<ServerChecklist> {
        let created: Created<ServerChecklist> = self.api_send(
            reqwest::Method::POST, "/api/checklists",
            serde_json::json!({"title": title, "category": category, "type": "simple"}),
        ).await?;
        created.data.ok_or_else(|| AppError::Other("create_checklist: missing data".into()))
    }

    pub async fn update_checklist(&self, id: &str, title: &str, category: &str) -> AppResult<()> {
        self.api_send::<serde_json::Value>(
            reqwest::Method::PUT, &format!("/api/checklists/{id}"),
            serde_json::json!({"title": title, "category": category}),
        ).await?;
        Ok(())
    }

    pub async fn delete_checklist(&self, id: &str) -> AppResult<()> {
        self.api_send::<serde_json::Value>(reqwest::Method::DELETE, &format!("/api/checklists/{id}"), serde_json::json!({})).await?;
        Ok(())
    }

    pub async fn create_item(&self, list_id: &str, text: &str, parent_path: Option<&str>) -> AppResult<()> {
        let mut body = serde_json::json!({"text": text});
        if let Some(p) = parent_path {
            body["parentIndex"] = serde_json::Value::String(p.to_string());
        }
        self.api_send::<serde_json::Value>(reqwest::Method::POST, &format!("/api/checklists/{list_id}/items"), body).await?;
        Ok(())
    }

    pub async fn patch_item(&self, list_id: &str, path: &str, text: &str) -> AppResult<()> {
        self.api_send::<serde_json::Value>(
            reqwest::Method::PATCH, &format!("/api/checklists/{list_id}/items/{path}"),
            serde_json::json!({"text": text}),
        ).await?;
        Ok(())
    }

    pub async fn check_item(&self, list_id: &str, path: &str, checked: bool) -> AppResult<()> {
        let suffix = if checked { "check" } else { "uncheck" };
        self.api_send::<serde_json::Value>(
            reqwest::Method::PUT, &format!("/api/checklists/{list_id}/items/{path}/{suffix}"),
            serde_json::json!({}),
        ).await?;
        Ok(())
    }

    pub async fn delete_item(&self, list_id: &str, path: &str) -> AppResult<()> {
        self.api_send::<serde_json::Value>(reqwest::Method::DELETE, &format!("/api/checklists/{list_id}/items/{path}"), serde_json::json!({})).await?;
        Ok(())
    }
}

async fn finish<T: DeserializeOwned>(resp: reqwest::Response) -> AppResult<T> {
    let status = resp.status();
    if !status.is_success() {
        let s = status.as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Api { status: s, body });
    }
    Ok(resp.json::<T>().await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn server() -> MockServer {
        MockServer::start().await
    }

    #[tokio::test]
    async fn health_and_auth_header() {
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/health"))
            .and(header("x-api-key", "ck_test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"status":"healthy","version":"1.22.0"})))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck_test").unwrap();
        let h = c.health().await.unwrap();
        assert_eq!(h.status, "healthy");
        assert_eq!(h.version.as_deref(), Some("1.22.0"));
    }

    #[tokio::test]
    async fn get_notes_parses_payload() {
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"notes":[{"id":"n1","title":"T","category":"C","content":"body","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}]})))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let notes = c.get_notes().await.unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, "n1");
    }

    #[tokio::test]
    async fn get_categories_unwraps_envelope() {
        // REAL wire shape (upstream API.md §14, verified 1.22.0 + main): payload is
        // wrapped under a top-level "categories" key. serde(default) on Categories
        // would mask a missing unwrap as silently-empty lists.
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/categories"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "categories": {
                    "notes": [
                        {"name": "Personal", "path": "Personal", "count": 5, "level": 0},
                        {"name": "Projects", "path": "Work/Projects", "count": 2, "level": 1}
                    ],
                    "checklists": [
                        {"name": "Shopping", "path": "Shopping", "count": 4, "level": 0}
                    ]
                }
            })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let cats = c.get_categories().await.unwrap();
        assert_eq!(cats.notes.len(), 2);
        assert_eq!(cats.notes[0].name, "Personal");
        assert_eq!(cats.notes[0].count, 5);
        assert_eq!(cats.notes[1].path, "Work/Projects");
        assert_eq!(cats.checklists.len(), 1);
        assert_eq!(cats.checklists[0].name, "Shopping");
    }

    #[tokio::test]
    async fn api_error_maps_status_and_body() {
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let err = c.get_notes().await.unwrap_err();
        assert!(matches!(err, AppError::Api { status: 401, .. }));
    }

    #[tokio::test]
    async fn hung_request_times_out_instead_of_blocking_forever() {
        // regression: reqwest::Client::new() had no timeout — a stalled server
        // wedged do_sync's `syncing` flag and every later sync silently no-oped.
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(200).set_delay(std::time::Duration::from_secs(90))
                .set_body_json(serde_json::json!({"notes":[]})))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let started = std::time::Instant::now();
        let err = c.get_notes().await.unwrap_err();
        assert!(started.elapsed() < std::time::Duration::from_secs(35), "must fail fast via the 30s timeout, took {:?}", started.elapsed());
        assert!(!matches!(err, AppError::Api { .. }), "a timeout is a transport error, not an HTTP status error");
    }

    #[tokio::test]
    async fn create_note_returns_created_note() {
        let s = server().await;
        Mock::given(method("POST")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": {"id":"note-123","title":"New","content":"x","category":"Personal","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z","owner":"u"}
            })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let n = c.create_note("New", "x", "Personal").await.unwrap();
        assert_eq!(n.id, "note-123");
    }

    #[tokio::test]
    async fn plain_http_rejected_outside_localhost() {
        let err = JottyClient::new("http://example.com", "ck").unwrap_err();
        assert!(matches!(err, AppError::InvalidConfig(_)));
        assert!(JottyClient::new("http://localhost:1122", "ck").is_ok());
        assert!(JottyClient::new("http://127.0.0.1:1122", "ck").is_ok());
    }

    #[tokio::test]
    async fn checklist_crud_and_item_ops() {
        let s = server().await;
        // create
        Mock::given(method("POST")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": {"id":"list-1","title":"L","category":"Home","type":"simple","items":[],"createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}
            })))
            .mount(&s).await;
        // check item 0
        Mock::given(method("PUT")).and(path("/api/checklists/list-1/items/0/check"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        // nested path patch
        Mock::given(method("PATCH")).and(path("/api/checklists/list-1/items/0.1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        // nested delete
        Mock::given(method("DELETE")).and(path("/api/checklists/list-1/items/1.0.2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        // create with parentIndex
        Mock::given(method("POST")).and(path("/api/checklists/list-1/items"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true})))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let list = c.create_checklist("L", "Home").await.unwrap();
        assert_eq!(list.id, "list-1");
        c.check_item("list-1", "0", true).await.unwrap();
        c.patch_item("list-1", "0.1", "renamed").await.unwrap();
        c.delete_item("list-1", "1.0.2").await.unwrap();
        c.create_item("list-1", "new", Some("0")).await.unwrap();
        c.create_item("list-1", "top", None).await.unwrap();
    }

    #[tokio::test]
    async fn item_op_error_surfaces() {
        let s = server().await;
        Mock::given(method("PUT")).and(path("/api/checklists/l/items/9/check"))
            .respond_with(ResponseTemplate::new(400).set_body_string("bad index"))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let err = c.check_item("l", "9", true).await.unwrap_err();
        assert!(matches!(err, AppError::Api { status: 400, .. }));
    }
}
