use crate::error::{AppError, AppResult};
use crate::jotty::models::{Categories, Created, Health, KanbanBoard, ServerChecklist, ServerNote, ServerStatus, UserPrefs, WebManifest};
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
    /// The site's theme background color from the manifest (e.g. "#111827"),
    /// validated as a hex color; None when absent or malformed.
    pub theme_color: Option<String>,
    /// raw icon bytes — used by the command layer for the best-effort
    /// window/taskbar icon (set_icon); never serialized to the frontend.
    pub icon_bytes: Option<Vec<u8>>,
}

/// Manifest theme_color → Option<String>, only valid #rgb / #rrggbb hex kept.
fn clean_theme_color(v: &Option<String>) -> Option<String> {
    let s = v.as_deref()?.trim();
    let body = s.strip_prefix('#')?;
    let ok = (body.len() == 3 || body.len() == 6) && body.chars().all(|c| c.is_ascii_hexdigit());
    if ok { Some(s.to_ascii_lowercase()) } else { None }
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

pub(crate) fn is_local(url: &reqwest::Url) -> bool {
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
        Ok(BrandingData {
            name: manifest.name,
            icon_data_url,
            icon_bytes,
            theme_color: clean_theme_color(&manifest.theme_color),
        })
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

    /// GET /api/tasks/{taskId} — kanban boards. Real wire shape wraps the board
    /// in a top-level "task" key (upstream app/api/tasks/[taskId]/route.ts);
    /// a bare parse would rely on serde(default) and silently produce empties.
    pub async fn get_task(&self, id: &str) -> AppResult<ServerChecklist> {
        let v = self.api_get::<serde_json::Value>(&format!("/api/tasks/{id}")).await?;
        let task = v.get("task").ok_or_else(|| AppError::Other("get_task: missing task envelope".into()))?;
        serde_json::from_value(task.clone())
            .map_err(|e| AppError::Other(format!("parse /api/tasks/{{id}}: {e}")))
    }

    /// GET /api/kanban/{boardId} — the ONLY board endpoint whose item payloads carry
    /// `reminder` (upstream transformBoard/transformItem; the /api/tasks/{id} GET maps
    /// items via toApiItem which DROPS reminder — source-verified @ b5458a2). Envelope:
    /// a top-level "board" key wraps the board — a bare parse would rely on
    /// serde(default) and silently produce empties (get_categories lesson).
    pub async fn get_kanban_board(&self, board_id: &str) -> AppResult<KanbanBoard> {
        let v = self.api_get::<serde_json::Value>(&format!("/api/kanban/{board_id}")).await?;
        let board = v.get("board").ok_or_else(|| AppError::Other("get_kanban_board: missing board envelope".into()))?;
        serde_json::from_value(board.clone())
            .map_err(|e| AppError::Other(format!("parse /api/kanban/{{id}}: {e}")))
    }

    /// POST /api/tasks — create a kanban board with its column set.
    pub async fn create_task(&self, title: &str, category: &str, statuses: &[ServerStatus]) -> AppResult<ServerChecklist> {
        let created: Created<ServerChecklist> = self.api_send(
            reqwest::Method::POST, "/api/tasks",
            serde_json::json!({ "title": title, "category": category, "statuses": statuses }),
        ).await?;
        created.data.ok_or_else(|| AppError::Other("create_task: missing data".into()))
    }

    /// PUT /api/tasks/{taskId}/items/{index}/status — move a kanban card.
    pub async fn update_item_status(&self, list_id: &str, path: &str, status: &str) -> AppResult<()> {
        self.api_send::<serde_json::Value>(
            reqwest::Method::PUT, &format!("/api/tasks/{list_id}/items/{path}/status"),
            serde_json::json!({ "status": status }),
        ).await?;
        Ok(())
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

    pub async fn create_item(&self, list_id: &str, text: &str, parent_path: Option<&str>, status: Option<&str>) -> AppResult<()> {
        let mut body = serde_json::json!({"text": text});
        if let Some(p) = parent_path {
            body["parentIndex"] = serde_json::Value::String(p.to_string());
        }
        if let Some(st) = status {
            body["status"] = serde_json::Value::String(st.to_string());
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

    /// PATCH /api/checklists/{listId}/items/{indexPath} — targetDate only.
    /// Upstream route (items/[itemIndex]/route.ts, source-verified 2026-09-25):
    /// targetDate must be a string or null; null clears ("" formData -> undefined).
    /// Partial update: other fields untouched.
    pub async fn update_item_target_date(&self, list_id: &str, path: &str, target_date: Option<&str>) -> AppResult<()> {
        let mut body = serde_json::json!({});
        body["targetDate"] = match target_date {
            Some(d) => serde_json::Value::String(d.to_string()),
            None => serde_json::Value::Null,
        };
        self.api_send::<serde_json::Value>(
            reqwest::Method::PATCH, &format!("/api/checklists/{list_id}/items/{path}"),
            body,
        ).await?;
        Ok(())
    }

    /// PATCH /api/checklists/{listId}/items/{indexPath} — startDate only.
    /// Upstream route (items/[itemIndex]/route.ts, source-verified 2026-09-28,
    /// same partial-update route as targetDate): startDate must be a string or
    /// null; null clears. Body mirrors update_item_target_date's shape.
    pub async fn update_item_start_date(&self, list_id: &str, path: &str, start_date: Option<&str>) -> AppResult<()> {
        let mut body = serde_json::json!({});
        body["startDate"] = match start_date {
            Some(d) => serde_json::Value::String(d.to_string()),
            None => serde_json::Value::Null,
        };
        self.api_send::<serde_json::Value>(
            reqwest::Method::PATCH, &format!("/api/checklists/{list_id}/items/{path}"),
            body,
        ).await?;
        Ok(())
    }

    /// Set/clear a kanban item reminder via the ITEM-LEVEL PUT partial update:
    /// Some(iso) → PUT /api/kanban/{board_id}/items/{item_id} with
    /// {"reminder":{"datetime":iso}}; None → the same PUT with {"reminder":null}.
    ///
    /// The dedicated sub-route PUT/DELETE /api/kanban/{board}/items/{item}/reminder
    /// is AUTH-DEAD for API-key clients: it returns 400 "Not authenticated"
    /// (PUT and DELETE — the action calls setKanbanItemReminder(formData) with
    /// no user and checks session-cookie getCurrentUser; routes byte-identical
    /// at v1.26.1 == v1.27.0). The item-level PUT is the API-key-viable path:
    /// it forwards user.username into updateItem (partial update — only
    /// `reminder` is touched; text/status/dates/history untouched), parses the
    /// body's reminder via JSON.parse guarded by truthiness, and null clears.
    /// Undocumented in howto/API.md as of v1.27.0.
    pub async fn set_item_reminder(&self, board_id: &str, item_id: &str, datetime: Option<&str>) -> AppResult<()> {
        let reminder = match datetime {
            Some(iso) => serde_json::json!({ "datetime": iso }),
            None => serde_json::Value::Null,
        };
        self.api_send::<serde_json::Value>(
            reqwest::Method::PUT,
            &format!("/api/kanban/{board_id}/items/{item_id}"),
            serde_json::json!({ "reminder": reminder }),
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
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
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
        c.create_item("list-1", "new", Some("0"), None).await.unwrap();
        c.create_item("list-1", "top", None, None).await.unwrap();
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
    async fn get_branding_theme_color_validated() {
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/manifest"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "name": "T", "theme_color": "  #111827 "
            })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let b = c.get_branding().await.unwrap();
        assert_eq!(b.theme_color.as_deref(), Some("#111827"));
    }

    #[tokio::test]
    async fn get_branding_bad_theme_color_is_none() {
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/manifest"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "theme_color": "blue"
            })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let b = c.get_branding().await.unwrap();
        assert_eq!(b.theme_color, None);
    }

    #[tokio::test]
    async fn get_branding_theme_color_absent_is_none() {
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/manifest"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"name": "T"})))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let b = c.get_branding().await.unwrap();
        assert_eq!(b.theme_color, None);
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

    #[tokio::test]
    async fn get_task_unwraps_envelope_and_aliases_name() {
        // REAL wire shape (upstream GET /api/tasks/{taskId} → { "task": {...} }).
        // The default-statuses fallback uses `name`, persisted ones use `label` —
        // parser must accept BOTH (spec §3 shape trap).
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/tasks/b-uuid"))
            .and(header("x-api-key", "ck"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "task": {
                    "id": "b-uuid", "title": "Board", "category": "Home",
                    "statuses": [
                        { "id": "todo", "name": "To Do", "order": 0 },
                        { "id": "done", "label": "Done", "color": "#22c55f", "order": 1, "autoComplete": true }
                    ],
                    "items": [
                        { "id": "srv-1", "index": 0, "text": "card a", "completed": false, "status": "done" }
                    ],
                    "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-02T00:00:00.000Z"
                }
            })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let t = c.get_task("b-uuid").await.unwrap();
        assert_eq!(t.id, "b-uuid");
        let sts = t.statuses.unwrap();
        assert_eq!(sts[0].label, "To Do");          // came from `name`
        assert!(!sts[0].auto_complete);
        assert_eq!(sts[1].label, "Done");           // native label
        assert!(sts[1].auto_complete);
        assert_eq!(sts[1].color.as_deref(), Some("#22c55f"));
        assert_eq!(t.items[0].status.as_deref(), Some("done"));
    }

    #[tokio::test]
    async fn get_task_404_maps_to_api_error() {
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/tasks/nope"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({"error":"Task not found"})))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let err = c.get_task("nope").await.unwrap_err();
        assert!(matches!(err, AppError::Api { status: 404, .. }));
    }

    #[tokio::test]
    async fn create_task_posts_statuses_and_unwraps_data() {
        let s = server().await;
        Mock::given(method("POST")).and(path("/api/tasks"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": { "id": "new-uuid", "title": "Board", "category": "Work",
                          "statuses": [ { "id": "todo", "label": "To Do", "order": 0 } ],
                          "items": [], "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
            })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let t = c.create_task("Board", "Work", &crate::jotty::models::creation_board_statuses()).await.unwrap();
        assert_eq!(t.id, "new-uuid");
        // request body assertions: statuses serialized camelCase with autoComplete
        let reqs = s.received_requests().await.unwrap();
        let body = reqs[0].body.clone();
        let text = String::from_utf8_lossy(&body).to_string();
        assert!(text.contains("\"autoComplete\":true"), "body: {text}");
        assert!(text.contains("\"label\":\"To Do\""));
    }

    #[tokio::test]
    async fn update_item_status_puts_tasks_status_endpoint() {
        let s = server().await;
        Mock::given(method("PUT")).and(path("/api/tasks/b-uuid/items/0/status"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true})))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        c.update_item_status("b-uuid", "0", "in_progress").await.unwrap();
        let reqs = s.received_requests().await.unwrap();
        assert!(String::from_utf8_lossy(&reqs[0].body).contains("\"status\":\"in_progress\""));
    }

    // ---- kanban board GET + item reminders (appointments phase 2, spec §3) --

    #[tokio::test]
    async fn get_kanban_board_unwraps_board_envelope_and_parses_reminder() {
        // REAL wire shape (upstream GET /api/kanban/{boardId} → { "board": {...} }).
        // Items are transformItem-shaped — the ONLY board GET whose item payloads
        // carry `reminder` (the /api/tasks/{id} GET maps via toApiItem, which drops it).
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/kanban/b1"))
            .and(header("x-api-key", "ck"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "board": {
                    "id": "b1", "title": "Appointments", "category": "Life",
                    "statuses": [ { "id": "todo", "name": "To Do", "order": 0 } ],
                    "items": [
                        { "id": "srv-1", "index": 0, "text": "Dentist", "status": "todo",
                          "completed": false,
                          "reminder": { "datetime": "2026-10-01T09:00:00.000Z", "notified": false } }
                    ],
                    "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"
                }
            })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let board = c.get_kanban_board("b1").await.unwrap();
        assert_eq!(board.id, "b1");
        assert_eq!(board.title.as_deref(), Some("Appointments"));
        assert_eq!(board.category.as_deref(), Some("Life"));
        assert_eq!(board.statuses.as_ref().unwrap().len(), 1);
        assert_eq!(board.items.len(), 1);
        // ServerReminder has no PartialEq (T1 byte-exact derive) — assert via fields
        let rem = board.items[0].reminder.as_ref().expect("reminder must parse");
        assert_eq!(rem.datetime, "2026-10-01T09:00:00.000Z");
        assert_eq!(rem.notified, Some(false));
    }

    #[tokio::test]
    async fn get_kanban_board_without_reminder_parses_none() {
        // reminder key absent on the item → None (serde default, not an error).
        // Carry-forward (T1 review Minor-4): a reminder object WITHOUT "datetime"
        // must FAIL the whole board parse (ServerReminder.datetime is required) —
        // per spec §5.3 it becomes a non-fatal enrichment error in T3, but it may
        // never surface as a silently-emptied board.
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/kanban/b1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "board": {
                    "id": "b1", "title": "Appointments", "category": "Life",
                    "statuses": [ { "id": "todo", "name": "To Do", "order": 0 } ],
                    "items": [
                        { "id": "srv-1", "index": 0, "text": "Dentist", "status": "todo",
                          "completed": false }
                    ],
                    "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"
                }
            })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let board = c.get_kanban_board("b1").await.unwrap();
        assert!(board.items[0].reminder.is_none(), "absent reminder key must parse as None");

        // characterization: reminder present but datetime missing → Err, not empty
        Mock::given(method("GET")).and(path("/api/kanban/b2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "board": {
                    "id": "b2",
                    "items": [ { "id": "srv-2", "index": 0, "text": "Card",
                                 "reminder": { "notified": false } } ]
                }
            })))
            .mount(&s).await;
        let err = c.get_kanban_board("b2").await.unwrap_err();
        assert!(err.to_string().contains("missing field `datetime`"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn get_kanban_board_malformed_body_is_err_not_silent_empty() {
        // envelope lesson (get_categories): a missing envelope key must NOT fall
        // through serde(default) into a silently-empty board.
        let s = server().await;
        Mock::given(method("GET")).and(path("/api/kanban/b1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "wrong": 1 })))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let err = c.get_kanban_board("b1").await.unwrap_err();
        assert!(err.to_string().contains("missing board envelope"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn set_item_reminder_put_carries_datetime_body() {
        // item-level PUT partial update: body must carry {"reminder":{"datetime": iso}}
        // — the mock pins the ITEM-LEVEL path (no /reminder suffix; the sub-route
        // would not match and hits would stay 0).
        let s = server().await;
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        Mock::given(method("PUT")).and(path("/api/kanban/b1/items/srv-1"))
            .respond_with(move |_: &wiremock::Request| {
                counter.fetch_add(1, Ordering::SeqCst);
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true}))
            })
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        c.set_item_reminder("b1", "srv-1", Some("2026-10-01T09:00:00Z")).await.unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 1, "PUT must hit the item-level endpoint exactly once");
        let reqs = s.received_requests().await.unwrap();
        let body = String::from_utf8_lossy(&reqs[0].body).to_string();
        assert!(body.contains("\"reminder\""), "body: {body}");
        assert!(body.contains("\"datetime\""), "body: {body}");
        assert!(body.contains("2026-10-01T09:00:00Z"), "body: {body}");
    }

    #[tokio::test]
    async fn set_item_reminder_none_sends_null_reminder_put() {
        // clearing = PUT {"reminder":null} on the item-level route (the reminder
        // sub-route is auth-dead for API-key clients — no DELETE anymore).
        let s = server().await;
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        Mock::given(method("PUT")).and(path("/api/kanban/b1/items/srv-1"))
            .respond_with(move |_: &wiremock::Request| {
                counter.fetch_add(1, Ordering::SeqCst);
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true}))
            })
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        c.set_item_reminder("b1", "srv-1", None).await.unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 1, "None must PUT the item-level endpoint exactly once");
        let reqs = s.received_requests().await.unwrap();
        let body = String::from_utf8_lossy(&reqs[0].body).to_string();
        assert!(body.contains("\"reminder\":null"), "body: {body}");
    }

    #[tokio::test]
    async fn set_item_reminder_4xx_maps_to_api_error() {
        // a 4xx on the item-level PUT maps to AppError::Api (route-agnostic mapping)
        let s = server().await;
        Mock::given(method("PUT")).and(path("/api/kanban/b1/items/srv-1"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({"error":"Not authenticated"})))
            .mount(&s).await;
        let c = JottyClient::new(&s.uri(), "ck").unwrap();
        let err = c.set_item_reminder("b1", "srv-1", Some("2026-10-01T09:00:00Z")).await.unwrap_err();
        assert!(matches!(err, AppError::Api { status: 400, .. }));
    }
}
