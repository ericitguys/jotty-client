use crate::error::{AppError, AppResult};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainQuery {
    #[serde(default)]
    pub focus: Option<String>,
    #[serde(default = "default_depth")]
    pub depth: u32,
    #[serde(default = "default_limit")]
    pub limit: u32,
    #[serde(default)]
    pub suggestions: bool,
}

fn default_depth() -> u32 { 2 }
fn default_limit() -> u32 { 60 }

impl Default for BrainQuery {
    fn default() -> Self {
        Self { focus: None, depth: 2, limit: 60, suggestions: false }
    }
}

pub const BRAIN_CACHE_MAX_ROWS: usize = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrainNode {
    pub id: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub links: u64,
    #[serde(default)]
    pub distance: Option<u64>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrainEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
    #[serde(default)]
    pub weight: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrainResponse {
    pub status: String,
    #[serde(default)]
    pub focus: Option<String>,
    #[serde(default)]
    pub nodes: Vec<BrainNode>,
    #[serde(default)]
    pub edges: Vec<BrainEdge>,
    #[serde(default)]
    pub total: u64,
    #[serde(default)]
    pub truncated: bool,
}

pub fn brain_cache_key(q: &BrainQuery) -> String {
    format!(
        "depth={}&focus={}&limit={}&suggestions={}",
        q.depth,
        q.focus.as_deref().unwrap_or("").to_lowercase(),
        q.limit,
        q.suggestions
    )
}

impl crate::jotty::client::JottyClient {
    pub async fn fetch_brain(&self, q: &BrainQuery) -> AppResult<BrainResponse> {
        crate::jotty::client::fetch_brain_impl(self, q).await
    }
}

pub(crate) fn brain_snapshot_write(
    conn: &rusqlite::Connection,
    cache_key: &str,
    resp: &BrainResponse,
) -> AppResult<()> {
    let json = serde_json::to_string(resp)
        .map_err(|e| AppError::Other(format!("brain snapshot serialize: {e}")))?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute_batch("BEGIN")?;
    let res = (|| -> AppResult<()> {
        conn.execute(
            "INSERT INTO brain_snapshots(cache_key, response_json, fetched_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(cache_key) DO UPDATE SET response_json=excluded.response_json, fetched_at=excluded.fetched_at",
            rusqlite::params![cache_key, json, now],
        )?;
        conn.execute(
            "DELETE FROM brain_snapshots WHERE cache_key NOT IN
               (SELECT cache_key FROM brain_snapshots ORDER BY fetched_at DESC, cache_key DESC LIMIT ?1)",
            [BRAIN_CACHE_MAX_ROWS as i64],
        )?;
        Ok(())
    })();
    match res {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => { let _ = conn.execute_batch("ROLLBACK"); return Err(e); }
    }
    Ok(())
}

pub(crate) fn brain_snapshot_read(
    conn: &rusqlite::Connection,
    cache_key: &str,
) -> AppResult<Option<(BrainResponse, String)>> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT response_json, fetched_at FROM brain_snapshots WHERE cache_key = ?1",
            [cache_key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(AppError::from)?;
    let Some((json, fetched_at)) = row else { return Ok(None) };
    match serde_json::from_str::<BrainResponse>(&json) {
        Ok(r) => Ok(Some((r, fetched_at))),
        Err(_) => Ok(None),
    }
}

pub(crate) fn brain_snapshot_stale(conn: &rusqlite::Connection, fetched_at: &str) -> AppResult<bool> {
    let last_sync: Option<String> = conn.query_row(
        "SELECT value FROM sync_state WHERE key='last_sync_at'", [], |r| r.get(0)).optional()?;
    if let Some(ls) = last_sync {
        if ls.as_str() > fetched_at { return Ok(true); }
    }
    let has_pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM outbox WHERE state IN ('pending','conflict')", [], |r| r.get(0))?;
    Ok(has_pending > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jotty::client::JottyClient;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn parses_top_level_brain_response() {
        let s = MockServer::start().await;
        let body = serde_json::json!({
            "status": "ready",
            "nodes": [{"id":"n1","kind":"note","title":"N1","links":2}],
            "edges": [{"source":"n1","target":"n2","kind":"wiki","weight":1.0}],
            "total": 1,
            "truncated": false,
        });
        Mock::given(method("GET"))
            .and(path("/api/brain"))
            .and(wiremock::matchers::header("x-api-key", "ck"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&s).await;
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let q = BrainQuery::default();
        let resp = client.fetch_brain(&q).await.unwrap();
        assert_eq!(resp.status, "ready");
        assert_eq!(resp.total, 1);
        assert!(!resp.truncated);
        assert_eq!(resp.nodes.len(), 1);
        let n = &resp.nodes[0];
        assert_eq!(n.id, "n1");
        assert_eq!(n.kind, "note");
        assert_eq!(n.title, "N1");
        assert_eq!(n.links, 2);
        assert_eq!(resp.edges.len(), 1);
        let e = &resp.edges[0];
        assert_eq!(e.source, "n1");
        assert_eq!(e.target, "n2");
        assert_eq!(e.kind, "wiki");
        assert_eq!(e.weight, 1.0);
        let requests = s.received_requests().await.expect("server kept requests");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].url.path(), "/api/brain");
        assert_eq!(requests[0].url.query().unwrap_or(""), "depth=2&focus=&limit=60&suggestions=false");
    }

    #[tokio::test]
    async fn inverted_envelope_fails() {
        let s = MockServer::start().await;
        let wrapped = serde_json::json!({"data":{"status":"ready","nodes":[],"edges":[],"total":0,"truncated":false}});
        Mock::given(method("GET")).and(path("/api/brain"))
            .respond_with(ResponseTemplate::new(200).set_body_json(wrapped))
            .mount(&s).await;
        let client = JottyClient::new(&s.uri(), "ck").unwrap();
        let err = client.fetch_brain(&BrainQuery::default()).await.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("missing field") || msg.contains("status") || msg.contains("error decoding response body"),
            "got: {err}"
        );
    }

    #[test]
    fn cache_key_canonicalizes() {
        let uuid = "A1B2-C3d4-E5f6";
        let a = brain_cache_key(&BrainQuery { focus: Some(uuid.into()), ..Default::default() });
        let b = brain_cache_key(&BrainQuery { focus: Some(uuid.to_lowercase().into()), depth: 2, limit: 60, suggestions: false });
        assert_eq!(a, b);
        assert_eq!(a, "depth=2&focus=a1b2-c3d4-e5f6&limit=60&suggestions=false");
        let none = brain_cache_key(&BrainQuery { focus: None, ..Default::default() });
        assert_eq!(none, "depth=2&focus=&limit=60&suggestions=false");
        let with_true = brain_cache_key(&BrainQuery { focus: None, depth: 2, limit: 60, suggestions: true });
        assert_eq!(with_true, "depth=2&focus=&limit=60&suggestions=true");
    }

    fn db() -> rusqlite::Connection {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("t.db")).unwrap();
        std::mem::forget(dir);
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    fn sample_resp() -> BrainResponse {
        BrainResponse {
            status: "ready".into(),
            focus: None,
            nodes: vec![BrainNode { id: "n1".into(), kind: "note".into(), title: "N1".into(), category: None, owner: None, links: 1, distance: None, tags: None }],
            edges: vec![],
            total: 1,
            truncated: false,
        }
    }

    #[test]
    fn snapshot_write_read_trim_roundtrip() {
        let conn = db();
        let r = sample_resp();
        for i in 0..31 {
            let key = format!("k{i}");
            let mut rr = r.clone();
            rr.focus = Some(key.clone());
            brain_snapshot_write(&conn, &key, &rr).unwrap();
        }
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM brain_snapshots", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 30);
        let first: Option<String> = conn.query_row(
            "SELECT response_json FROM brain_snapshots WHERE cache_key='k0'", [], |r| r.get(0)
        ).optional().unwrap();
        assert!(first.is_none(), "oldest row k0 must be trimmed");
        let same_key = "k1";
        let mut r2 = r.clone();
        r2.total = 42;
        brain_snapshot_write(&conn, same_key, &r2).unwrap();
        let count2: i64 = conn.query_row("SELECT COUNT(*) FROM brain_snapshots", [], |r| r.get(0)).unwrap();
        assert_eq!(count2, 30);
        let (read, _) = brain_snapshot_read(&conn, same_key).unwrap().unwrap();
        assert_eq!(read.total, 42);
    }

    #[test]
    fn corrupt_snapshot_reads_none() {
        let conn = db();
        conn.execute(
            "INSERT INTO brain_snapshots(cache_key, response_json, fetched_at) VALUES (?1,?2,?3)",
            rusqlite::params!["bad", "not json", "2026-10-20T00:00:00Z"],
        ).unwrap();
        assert!(brain_snapshot_read(&conn, "bad").unwrap().is_none());
    }
}
