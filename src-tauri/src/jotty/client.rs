use crate::error::{AppError, AppResult};
use crate::jotty::models::{Categories, Created, Health, ServerChecklist, ServerNote, UserPrefs, WebManifest};
use serde::de::DeserializeOwned;

#[derive(Debug, Clone)]
pub struct JottyClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
}

/// Instance branding resolved from /api/manifest (v0.9.0).
#[derive(Debug, Clone)]
pub struct BrandingData {
    pub name: Option<String>,
    pub icon_data_url: Option<String>,
    /// raw icon bytes — used by the command layer for the best-effort
    /// window/taskbar icon (set_icon); never serialized to the frontend.
    pub icon_bytes: Option<Vec<u8>>,
}

fn icon_mime(src: &str) -> &'static str {
    let ext = src.rsplit(['.', '/', '?']).next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

fn to_data_url(src: &str, bytes: &[u8]) -> String {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{};base64,{}", icon_mime(src), b64)
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

    /// Per-user preferences mirror (theme, default filters, click action...).
    /// Wire shape: {user: {...}} — unwrap like the other envelope getters.
    /// Upstream source: app/api/user/route.ts (withApiAuth → safeUserData).
    pub async fn get_user_prefs(&self) -> AppResult<UserPrefs> {
        let v = self.api_get::<serde_json::Value>("/api/user").await?;
        Ok(serde_json::from_value(v["user"].clone())
            .map_err(|e| AppError::Other(format!("parse /api/user: {e}")))?)
    }

    /// Instance branding (v0.9.0). Upstream writes the live app name + icon
    /// URLs into data/site.webmanifest on every page render and serves it
    /// publicly at /api/manifest; uploaded icon files are served publicly at
    /// /api/app-icons/<filename> — both without auth, so branding mirrors even
    /// for read-only API-key users.
    pub async fn get_branding(&self) -> AppResult<BrandingData> {
        let manifest: WebManifest = self.api_get("/api/manifest").await?;
        let icon = manifest
            .icons
            .iter()
            .max_by_key(|i| i.sizes.split(['x', 'X']).next()
                .and_then(|w| w.parse::<u32>().ok())
                .unwrap_or(0))
            .cloned();
        let (icon_data_url, icon_bytes) = match icon {
            None => (None, None),
            Some(icon) => match self.get_bytes(&icon.src).await {
                Err(_) => (None, None), // name survives a failed icon download
                Ok(bytes) => (Some(to_data_url(&icon.src, &bytes)), Some(bytes)),
            },
        };
        Ok(BrandingData { name: manifest.name, icon_data_url, icon_bytes })
    }

    async fn get_bytes(&self, path: &str) -> AppResult<Vec<u8>> {
        // absolute URLs pass through; anything else resolves against the instance
        let url = if path.starts_with("http://") || path.starts_with("https://") {
            path.to_string()
        } else {
            self.url(path)
        };
        let resp = self.http.get(url).send().await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(AppError::Api { status: status.as_u16(), body: resp.text().await.unwrap_or_default() });
        }
        Ok(resp.bytes().await?.to_vec())
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
    async fn get_user_prefs_unwraps_envelope() {
        // REAL wire shape (upstream app/api/user/route.ts: withApiAuth returns
        // {user: safeUserData} minus passwordHash/apiKey). Same defect class as
        // the get_categories envelope bug — a bare parse + serde(default) would
        // silently produce all-None prefs.
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user": {
                    "username": "eric",
                    "isAdmin": false,
                    "preferredTheme": "light",
                    "defaultNoteFilter": "recent",
                    "defaultChecklistFilter": "incomplete",
                    "checklistItemClickAction": "edit",
                    "hideConnectionIndicator": "enable",
                    "pinnedNotes": ["n1", "n2"],
                    "pinnedLists": ["l1"]
                }
            })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let prefs = c.get_user_prefs().await.unwrap();
        assert_eq!(prefs.preferred_theme.as_deref(), Some("light"));
        assert_eq!(prefs.default_note_filter.as_deref(), Some("recent"));
        assert_eq!(prefs.default_checklist_filter.as_deref(), Some("incomplete"));
        assert_eq!(prefs.checklist_item_click_action.as_deref(), Some("edit"));
        assert_eq!(prefs.hide_connection_indicator.as_deref(), Some("enable"));
        assert_eq!(prefs.pinned_notes, vec!["n1", "n2"]);
        assert_eq!(prefs.pinned_lists, vec!["l1"]);
    }

    #[tokio::test]
    async fn get_user_prefs_tolerates_absent_fields() {
        // an older/newer server may omit any preference — parse must not fail
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user": { "username": "eric" }
            })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let prefs = c.get_user_prefs().await.unwrap();
        assert_eq!(prefs.preferred_theme, None);
        assert!(prefs.pinned_notes.is_empty());
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

    // ---- branding mirror (v0.9.0) ------------------------------------------
    // Upstream writes the live name + icon URLs into data/site.webmanifest on
    // every page render (app/layout.tsx generateMetadata), served PUBLIC at
    // /api/manifest; uploaded icons are served PUBLIC at /api/app-icons/<file>.

    const PNG_1PX_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    #[tokio::test]
    async fn get_branding_happy_path_prefers_largest_icon() {
        let png = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.decode(PNG_1PX_B64).unwrap()
        };
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/manifest"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "name": "Acme Notes",
                "short_name": "Acme",
                "icons": [
                    {"src": "/app-icons/favicon-32x32.png", "sizes": "32x32", "type": "image/png"},
                    {"src": "/api/app-icons/512x512Icon-123.png", "sizes": "512x512", "type": "image/png"}
                ]
            })))
            .mount(&s).await;
        // only the 512 icon is mounted: picking the 32px one would 404 and fail the test
        Mock::given(method("GET")).and(path("/api/app-icons/512x512Icon-123.png"))
            .respond_with(ResponseTemplate::new(200)
                .set_body_bytes(png.clone())
                .insert_header("content-type", "image/png"))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let b = c.get_branding().await.unwrap();
        assert_eq!(b.name.as_deref(), Some("Acme Notes"));
        assert_eq!(b.icon_data_url.as_deref(), Some(&*format!("data:image/png;base64,{PNG_1PX_B64}")));
        assert_eq!(b.icon_bytes.as_deref(), Some(png.as_slice()));
    }

    #[tokio::test]
    async fn get_branding_manifest_error_is_err() {
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/manifest"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        assert!(c.get_branding().await.is_err());
    }

    #[tokio::test]
    async fn get_branding_name_survives_icon_download_failure() {
        // name still mirrors when the icon file 404s — degraded, not broken
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/manifest"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "name": "Acme Notes",
                "icons": [{"src": "/api/app-icons/gone.png", "sizes": "512x512", "type": "image/png"}]
            })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let b = c.get_branding().await.unwrap();
        assert_eq!(b.name.as_deref(), Some("Acme Notes"));
        assert_eq!(b.icon_data_url, None);
        assert_eq!(b.icon_bytes, None);
    }
}
