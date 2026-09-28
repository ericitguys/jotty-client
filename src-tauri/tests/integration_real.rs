// Round-trip against a REAL jotty instance. Skipped unless JOTTY_TEST_URL and
// JOTTY_TEST_API_KEY are set; run with `cargo test --test integration_real -- --ignored`.
use jotty_client_lib::db::{self, items, notes, outbox};
use jotty_client_lib::jotty::client::JottyClient;
use jotty_client_lib::sync;
use jotty_client_lib::sync::pull;

/// Env gate: a dev jotty instance + its API key (dev/docker-compose.yml — the
/// `jotty-desktop-test` container on 127.0.0.1:1122; fixture key in
/// dev/data/users/users.json). Never fabricated: without both env vars the
/// whole test returns early (SKIPPED is the expected default-run outcome).
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

/// T9: the full appointment round-trip against the real instance —
/// REST create → pull → server-truth reminder write → pull → local mirror.
/// Skipped without JOTTY_TEST_URL/JOTTY_TEST_API_KEY; never fabricated.
#[test]
#[ignore]
fn real_appointment_round_trip() {
    let Some((url, key)) = env() else { return; };
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let client = JottyClient::new(&url, &key).unwrap();
        let mut conn = fresh_db();

        // Wire-pinned constants: the reminder datetime is stored VERBATIM
        // upstream (setKanbanItemReminder JSON.parse's the PUT body — no
        // normalization), the kanban item's file segment renders as
        // `reminder:{"datetime":…}`, and the catalog PATCH targetDate is a
        // date-only string (T8.1 production shape).
        const REMINDER: &str = "2026-10-01T09:00:00Z";
        const TARGET_DATE: &str = "2026-10-01";

        // 1) throwaway board, deleted at the end (disposable-name pattern)
        let created = client.create_task(
            &format!("Agenda test {}", chrono::Utc::now().timestamp_millis()),
            "Uncategorized",
            &jotty_client_lib::jotty::models::creation_board_statuses(),
        ).await.unwrap();
        let board = created.id.clone();

        // 2) the appointment card: index 0 on the fresh board; the target date
        //    rides the PATCH (index-resolved) BEFORE the first pull so the
        //    catalog round-trips it onto the local row
        let text = format!("roundtrip appointment {}", uuid::Uuid::new_v4());
        client.create_item(&board, &text, None, Some("todo")).await.unwrap();
        client.update_item_target_date(&board, "0", Some(TARGET_DATE)).await.unwrap();

        // 2) pull: catalog imports the board + item row (server_item_id from
        //    the stable id, target_date) — enrichment runs with no reminder yet
        let stats = pull::pull_all(&mut conn, &client).await.unwrap();
        assert_eq!(stats.enrichment_errors, 0, "clean pull must not report enrichment errors");

        // 3) stable item id comes from the ONLY board GET that carries ids the
        //    reminder route accepts (transformItem → item.id; matched by text)
        let item_id = {
            let kb = client.get_kanban_board(&board).await.unwrap();
            let item = kb.items.iter().find(|i| i.text == text)
                .unwrap_or_else(|| panic!("item {text:?} missing from kanban GET"));
            let id = item.id.clone().expect("kanban GET must carry the stable item id");
            assert_eq!(kb.items.len(), 1);
            assert!(item.reminder.is_none(), "fresh item must start reminderless");
            id
        };

        // 4) server-truth reminder write (upstream PUT {datetime})
        client.set_item_reminder(&board, &item_id, Some(REMINDER)).await.unwrap();

        // 5) server truth: the reminder round-trips verbatim on the board GET
        let kb = client.get_kanban_board(&board).await.unwrap();
        let item = kb.items.iter().find(|i| i.text == text)
            .unwrap_or_else(|| panic!("item {text:?} missing from kanban GET after reminder"));
        assert_eq!(
            item.reminder.as_ref().map(|r| r.datetime.as_str()),
            Some(REMINDER),
            "reminder must round-trip verbatim through the kanban GET",
        );

        // 6) FILE segment (best-effort, container-optional): the board's
        //    checklist file in the container carries the literal
        //    `reminder:{"datetime":…}` line (kanban item metadata) plus the
        //    uuid frontmatter. Skipped with a disclosure when docker/the
        //    container is unavailable — never a silent pass.
        //    NB: the file is NAMED after the sanitized title, the uuid lives in
        //    the frontmatter — grep for both, never for a filename.
        let probe = std::process::Command::new("docker")
            .args(["exec", "jotty-desktop-test", "true"])
            .output();
        match probe {
            Ok(p) if p.status.success() => {
                let needle = format!("reminder:{{\"datetime\":\"{REMINDER}\"}}");
                let grep = std::process::Command::new("docker")
                    .args(["exec", "jotty-desktop-test", "grep", "-rlF", "--", &needle, "/app/data"])
                    .output()
                    .expect("docker exec grep after a successful probe");
                assert!(
                    grep.status.success(),
                    "reminder segment `{needle}` missing from the container data dir (grep exit {:?}, stderr: {})",
                    grep.status.code(),
                    String::from_utf8_lossy(&grep.stderr),
                );
                let files = String::from_utf8_lossy(&grep.stdout);
                let uuid_line = format!("uuid: {board}");
                let grep_uuid = std::process::Command::new("docker")
                    .args(["exec", "jotty-desktop-test", "grep", "-rlF", "--", &uuid_line, "/app/data/checklists"])
                    .output()
                    .expect("docker exec grep for the board uuid frontmatter");
                assert!(
                    grep_uuid.status.success(),
                    "board uuid frontmatter not found in the container checklists dir",
                );
                let uuid_files = String::from_utf8_lossy(&grep_uuid.stdout);
                assert!(
                    uuid_files.lines().any(|u| files.lines().any(|f| f == u)),
                    "the reminder-bearing file must be our board's checklist file (reminder in {files:?}, uuid in {uuid_files:?})",
                );
            }
            Ok(p) => eprintln!(
                "file-check SKIPPED (disclosed): docker exec probe failed (exit {:?}) — container jotty-desktop-test not reachable",
                p.status.code(),
            ),
            Err(e) => eprintln!("file-check SKIPPED (disclosed): docker unavailable: {e}"),
        }

        // 7) pull #2: the enrichment merge mirrors the reminder onto the local
        //    row via the stable server_item_id — dirty untouched (server truth)
        let stats2 = pull::pull_all(&mut conn, &client).await.unwrap();
        assert_eq!(stats2.enrichment_errors, 0, "pull #2 must enrich cleanly");
        let rows = items::list_for_checklist(&conn, &board).unwrap();
        assert_eq!(rows.len(), 1, "exactly one local row for the throwaway board");
        let row = &rows[0];
        assert_eq!(row.text, text);
        assert_eq!(row.server_item_id.as_deref(), Some(item_id.as_str()),
            "the catalog item's stable id must be stored on the local row");
        assert_eq!(row.reminder_datetime.as_deref(), Some(REMINDER),
            "enrichment must mirror the server reminder onto the local row");
        assert_eq!(row.target_date.as_deref(), Some(TARGET_DATE),
            "the catalog round-trip must carry the target date");

        // cleanup: delete the throwaway board (best-effort, log on failure)
        if let Err(e) = client.delete_checklist(&board).await {
            eprintln!("cleanup: failed to delete test board {board}: {e:?}");
        }
    });
}