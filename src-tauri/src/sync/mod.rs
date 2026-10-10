pub mod pull;
pub mod push;
pub mod resolve;

use rusqlite::Connection;
use crate::error::AppResult;
use crate::jotty::client::JottyClient;

// Runtime-specific bridge for the voice-notes retry dispatch. voice_ai::maybe_retry
// is not generic over the Tauri runtime, so this sealed trait lets do_sync stay
// generic while still spawning the real retry on the production Wry runtime.
pub(crate) mod retry_dispatch {
    use tauri::Runtime;
    pub trait DispatchRetry: Runtime {
        fn dispatch_voice_retry(app: tauri::AppHandle<Self>);
    }
    impl DispatchRetry for tauri::Wry {
        fn dispatch_voice_retry(app: tauri::AppHandle<tauri::Wry>) {
            tauri::async_runtime::spawn(async move { crate::voice_ai::maybe_retry(app).await });
        }
    }
    #[cfg(test)]
    impl DispatchRetry for tauri::test::MockRuntime {
        fn dispatch_voice_retry(_app: tauri::AppHandle<tauri::test::MockRuntime>) {}
    }
}

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pushed: usize,
    pub push_conflicts: usize,
    pub pull: pull::PullStats,
    pub errors: Vec<String>,
}

pub async fn run(conn: &mut Connection, client: &JottyClient) -> AppResult<SyncReport> {
    let mut errors = Vec::new();
    let push_res = push::push_pending(conn, client).await;
    let (pushed, push_conflicts) = match push_res {
        Ok(s) => (s.pushed, s.conflicts),
        Err(e) => {
            errors.push(format!("push failed: {e}"));
            (0, 0)
        }
    };
    let pull_res = pull::pull_all(conn, client).await;
    let pull_stats = match pull_res {
        Ok(s) => s,
        Err(e) => {
            errors.push(format!("pull failed: {e}"));
            pull::PullStats::default()
        }
    };
    Ok(SyncReport { pushed, push_conflicts, pull: pull_stats, errors })
}

impl SyncReport {
    pub fn to_dto(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// Scheduler (Task 14): scheduler_tick + do_sync transplanted VERBATIM from the
// plan's T13 section (lines ~3186-3251). Ruling N: spawn_scheduler is DEFINED
// here and re-exported from lib.rs via `pub use sync::spawn_scheduler;`.
//
// Transplant adaptations (disclosed in task-14-report.md §fixes):
// - spawn_scheduler calls `scheduler_tick(&app)` bare — the plan fence's
//   `sync::scheduler_tick(&app)` path was written for lib.rs and does not
//   resolve inside this module;
// - `client` → `_client` in scheduler_tick: the verbatim binding is never read
//   and would add an unused-variable warning, breaking the "no new warnings"
//   gate;
// - `pub` visibility on spawn_scheduler (required by `pub use` re-export).
use rusqlite::OptionalExtension;
use tauri::Manager;

pub fn spawn_scheduler<R>(app: tauri::AppHandle<R>)
where
    R: tauri::Runtime + retry_dispatch::DispatchRetry + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            ticker.tick().await;
            if let Err(e) = scheduler_tick::<R>(&app).await {
                log::warn!("scheduler tick failed: {e}");
            }
        }
    });
}

pub async fn scheduler_tick<R>(app: &tauri::AppHandle<R>) -> AppResult<()>
where
    R: tauri::Runtime + retry_dispatch::DispatchRetry,
{
    let state = app.state::<crate::state::AppState>();
    // skip if not connected or another sync is running
    if state.syncing.load(std::sync::atomic::Ordering::SeqCst) { return Ok(()); }
    let client_guard = state.client.read().await;
    let Some(_client) = client_guard.clone() else { return Ok(()); };
    drop(client_guard);

    let due = {
        let conn = state.db.lock().await;
        // kimi audit 1.1 (FIX-NOW): bare unwrap_or fallbacks masked sync_state
        // read failures (a corrupt/stale-locked DB looked like a healthy
        // default config). Behavior is preserved — fallback VALUES are
        // identical — the failures now surface as a warning line each.
        let interval_min: i64 = match conn.query_row(
            "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM sync_state WHERE key='sync_interval_minutes'), 5)",
            [], |r| r.get(0))
        {
            Ok(v) => v,
            Err(e) => {
                log::warn!("sync_state read failed; using default sync interval: {e}");
                5
            }
        };
        let last: Option<String> = match conn.query_row(
            "SELECT value FROM sync_state WHERE key='last_sync_at'", [], |r| r.get(0)).optional()
        {
            Ok(v) => v,
            Err(e) => {
                log::warn!("last_sync_at read failed; scheduling without last-sync knowledge: {e}");
                None
            }
        };
        match last.and_then(|l| chrono::DateTime::parse_from_rfc3339(&l).ok()) {
            Some(t) => {
                let since = (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_minutes();
                since >= interval_min
            }
            None => true,
        }
    };
    if !due { return Ok(()); }
    do_sync::<R>(app).await
}

pub async fn do_sync<R>(app: &tauri::AppHandle<R>) -> AppResult<()>
where
    R: tauri::Runtime + retry_dispatch::DispatchRetry,
{
    fn truncate_ellipsis(s: &str, max: usize) -> String {
        if s.chars().count() <= max {
            s.to_string()
        } else {
            s.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
        }
    }
    fn format_errors(errors: &[String]) -> String {
        if errors.len() <= 2 {
            errors.join(" | ")
        } else {
            format!("{} | {} (+{} more)", errors[0], errors[1], errors.len() - 2)
        }
    }

    let state = app.state::<crate::state::AppState>();
    if state.syncing.swap(true, std::sync::atomic::Ordering::SeqCst) { return Ok(()); }
    let result = {
        let client_guard = state.client.read().await;
        let Some(client) = client_guard.clone() else {
            state.syncing.store(false, std::sync::atomic::Ordering::SeqCst);
            return Ok(());
        };
        drop(client_guard);
        let mut conn = state.db.lock().await;
        // rusqlite's Connection is Send but NOT Sync; run()'s future holds
        // `&Connection` across awaits (push.rs close_item_group, pull.rs) making
        // it !Send, while tauri command futures must be Send. The run() future is
        // created and driven on THIS thread (block_in_place + LocalSet) and is
        // never held across an await, so the enclosing future stays Send.
        // (push/pull files are sha-untouched; disclosed in task-14-report.md §fixes.)
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current()
                .block_on(tokio::task::LocalSet::new().run_until(run(&mut conn, &client)))
        })
    };
    state.syncing.store(false, std::sync::atomic::Ordering::SeqCst);

    // audit 4.2: surface pull-side (and other non-outbox) sync failures in the
    // badge via a dedicated sync_state key. do_sync's Ok(()) return contract is
    // preserved; callers that need failure details read this key.
    {
        let conn = state.db.lock().await;
        let stored = match &result {
            Ok(report) if !report.errors.is_empty() => {
                Some(truncate_ellipsis(&format_errors(&report.errors), 300))
            }
            Ok(_) => None,
            Err(e) => Some(truncate_ellipsis(&e.to_string(), 300)),
        };
        if let Some(value) = stored {
            conn.execute(
                "INSERT INTO sync_state(key,value) VALUES ('last_pull_error',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [value],
            )?;
        } else {
            conn.execute("DELETE FROM sync_state WHERE key='last_pull_error'", [])?;
        }
    }

    if let Ok(report) = &result {
        use tauri::Emitter;
        let _ = app.emit("sync-updated", serde_json::to_value(report).unwrap_or_default());
    }
    // Voice-notes retry (spec §6): after a SUCCESSFUL sync the jotty server is
    // reachable — give the AI transcription queue a chance. Spawned: do_sync's
    // callers (scheduler + manual trigger) must not block on AI latency.
    if result.is_ok() {
        retry_dispatch::DispatchRetry::dispatch_voice_retry(app.clone());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations, notes, open};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn push_runs_before_pull() {
        let s = MockServer::start().await;
        let order: std::sync::Arc<std::sync::Mutex<Vec<&'static str>>> = Default::default();
        // pull endpoints
        // simpler: use separate mocks with side-effecting response via wiremock "FnResponse"
        // push endpoint (update note)
        {
            let order = order.clone();
            Mock::given(method("PUT")).and(path("/api/notes/n1"))
                .respond_with(move |_req: &_| {
                    order.lock().unwrap().push("push");
                    ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true,"data":{"id":"n1","title":"T","content":"local","category":"Home","createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2026-06-01T00:00:00.000Z"}}))
                })
                .mount(&s).await;
        }
        {
            let order = order.clone();
            Mock::given(method("GET")).and(path("/api/notes"))
                .respond_with(move |_req: &_| {
                    order.lock().unwrap().push("pull");
                    ResponseTemplate::new(200).set_body_json(serde_json::json!({"notes":[]}))
                })
                .mount(&s).await;
        }
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"checklists":[]})))
            .mount(&s).await;

        let mut conn = {
            let dir = tempfile::tempdir().unwrap();
            let c = open(&dir.path().join("t.db")).unwrap();
            std::mem::forget(dir);
            migrations::run(&c).unwrap();
            c
        };
        // local dirty note n1 with a queued update; server pull returns empty notes (would tombstone it if pull ran first without push)
        conn.execute("INSERT INTO notes (id,title,content,category,created_at,updated_at,dirty) VALUES ('n1','T','local','Home','2024-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',1)", []).unwrap();
        crate::db::outbox::enqueue(&conn, "update", "note", "n1", &serde_json::json!({"id":"n1","title":"T","content":"local","category":"Home"})).unwrap();

        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let report = run(&mut conn, &client).await.unwrap();
        assert_eq!(report.pushed, 1);
        let o = order.lock().unwrap();
        assert_eq!(o.as_slice(), &["push", "pull"], "push must precede pull");
        // note survived (pushed, then pull LWW saw our newer updatedAt)
        assert!(notes::get(&conn, "n1").unwrap().is_some());
    }

    // audit 4.2 RED: do_sync persists pull failures under a dedicated sync_state
    // key and clears it after a fully successful sync; sync_status surfaces it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn do_sync_persists_and_clears_last_pull_error() {
        use crate::keys::MockKeyStore;
        use crate::state::AppState;
        use wiremock::matchers::{method, path};

        fn db() -> rusqlite::Connection {
            let dir = tempfile::tempdir().unwrap();
            let c = open(&dir.path().join("t.db")).unwrap();
            std::mem::forget(dir);
            migrations::run(&c).unwrap();
            c
        }

        // 1) failing pull: do_sync returns Ok but records the error.
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(500).set_body_string("server down"))
            .mount(&s).await;
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"checklists":[]})))
            .mount(&s).await;

        let conn = db();
        let app = tauri::Builder::<tauri::Wry>::default()
            .any_thread()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = AppState::new(conn, Box::new(MockKeyStore::default()), Box::new(MockKeyStore::default())).unwrap();
        *state.client.write().await = Some(JottyClient::new(&s.uri(), "ck").unwrap());
        app.manage(state);

        assert!(do_sync(&app.handle()).await.is_ok());

        let st = app.state::<AppState>();
        let conn = st.db.lock().await;
        let stored: Option<String> = conn
            .query_row("SELECT value FROM sync_state WHERE key='last_pull_error'", [], |r| r.get(0))
            .optional()
            .unwrap();
        let err = stored.unwrap_or_default();
        assert!(
            err.contains("server down") || err.contains("pull failed"),
            "last_pull_error should capture the pull failure, got: {err}"
        );
        let status = crate::commands::sync_status_inner(&conn, false).unwrap();
        assert!(
            status.last_pull_error.as_deref().unwrap_or_default().contains("server down")
                || status.last_pull_error.as_deref().unwrap_or_default().contains("pull failed"),
            "SyncStatusDto.last_pull_error should surface the error"
        );
        drop(conn);

        // 2) successful pull: the key is cleared.
        let s2 = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/notes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"notes":[]})))
            .mount(&s2).await;
        Mock::given(method("GET")).and(path("/api/checklists"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"checklists":[]})))
            .mount(&s2).await;
        *st.client.write().await = Some(JottyClient::new(&s2.uri(), "ck").unwrap());
        assert!(do_sync(&app.handle()).await.is_ok());

        let conn = st.db.lock().await;
        let stored: Option<String> = conn
            .query_row("SELECT value FROM sync_state WHERE key='last_pull_error'", [], |r| r.get(0))
            .optional()
            .unwrap();
        assert!(stored.is_none(), "last_pull_error should be cleared after a clean sync, got: {stored:?}");
        let status = crate::commands::sync_status_inner(&conn, false).unwrap();
        assert!(status.last_pull_error.is_none());
    }
}
