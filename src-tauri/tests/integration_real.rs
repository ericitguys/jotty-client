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

#[test]
#[ignore]
fn live_kanban_board_roundtrip() {
    let Some((url, key)) = env() else { return; };
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let client = JottyClient::new(&url, &key).unwrap();
        // 1) create a throwaway board (disposable name, deleted at the end)
        let board = jotty_client_lib::jotty::models::creation_board_statuses();
        let created = client.create_task(
            &format!("KANBAN-CLIENT-TEST {}", uuid::Uuid::new_v4()),
            "Uncategorized", &board,
        ).await.unwrap();
        // 2) add a card in the first column
        client.create_item(&created.id, "roundtrip card", None, Some("todo")).await.unwrap();
        // 3) read the board back: card is at index 0 with status todo
        let task = client.get_task(&created.id).await.unwrap();
        assert_eq!(task.items[0].status.as_deref(), Some("todo"));
        // 4) move it to in_progress via the status endpoint; verify via GET
        client.update_item_status(&created.id, "0", "in_progress").await.unwrap();
        let task = client.get_task(&created.id).await.unwrap();
        assert_eq!(task.items[0].status.as_deref(), Some("in_progress"));
        assert!(!task.items[0].completed.unwrap_or(false));
        // 5) move to the autoComplete column; verify completed flipped server-side
        client.update_item_status(&created.id, "0", "completed").await.unwrap();
        let task = client.get_task(&created.id).await.unwrap();
        assert_eq!(task.items[0].status.as_deref(), Some("completed"));
        assert!(task.items[0].completed.unwrap_or(false));
        // cleanup: delete the throwaway board (best-effort, log on failure)
        if let Err(e) = client.delete_checklist(&created.id).await {
            eprintln!("cleanup: failed to delete test board {}: {e:?}", created.id);
        }
    });
}