// Round-trip against a REAL jotty instance. Skipped unless JOTTY_TEST_URL and
// JOTTY_TEST_API_KEY are set; run with `cargo test --test integration_real -- --ignored`.
use jotty_client_lib::db::{self, notes, outbox};
use jotty_client_lib::jotty::client::JottyClient;
use jotty_client_lib::sync;

fn env() -> Option<(String, String)> {
    let url = std::env::var("JOTTY_TEST_URL").ok()?;
    let key = std::env::var("JOTTY_TEST_API_KEY").ok()?;
    Some((url, key))
}

fn fresh_db() -> rusqlite::Connection {
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(&dir.path().join("i.db")).unwrap();
    std::mem::forget(dir);
    db::migrations::run(&conn).unwrap();
    conn
}

#[test]
#[ignore]
fn roundtrip_note_push_and_pull() {
    let Some((url, key)) = env() else { return; };
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let client = JottyClient::new(&url, &key).unwrap();
        let mut conn = fresh_db();

        // push: create a note offline, then sync
        let local = notes::insert_local(&conn, &notes::NewNote {
            title: format!("integration {}", uuid::Uuid::new_v4()),
            content: "hello from the fat client".into(),
            category: "Uncategorized".into(),
        }).unwrap();
        outbox::enqueue(&conn, "create", "note", &local.id,
            &serde_json::json!({"temp_id": local.id, "title": local.title, "content": local.content, "category": "Uncategorized"})).unwrap();
        let report = sync::run(&mut conn, &client).await.unwrap();
        assert!(report.errors.is_empty(), "errors: {:?}", report.errors);
        assert_eq!(report.pushed, 1);

        // the note now has a server id
        let ids: Vec<String> = {
            let mut stmt = conn.prepare("SELECT id FROM notes").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert_eq!(ids.len(), 1);
        assert_ne!(ids[0], local.id, "id must be remapped to server uuid");
    });
}