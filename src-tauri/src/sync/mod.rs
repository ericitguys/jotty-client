pub mod pull;
pub mod push;
pub mod resolve;

use rusqlite::Connection;
use crate::error::AppResult;
use crate::jotty::client::JottyClient;

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
}
