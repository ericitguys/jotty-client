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

/// T9 + v0.21 R3/R4: the full appointment round-trip against the real
/// instance — REST create → pull → server-truth reminder write → pull →
/// local mirror, then the WEB-set enrichment arm: a raw item-level PUT (no
/// client involved) sets a DIFFERENT datetime and pull #3 must mirror it
/// onto the local row (a server-set write the CLIENT never made). R4 panic
/// guard: every step lives in `run()` returning Result — no unwrap/expect/
/// panic inside; the board id is captured the moment it exists so the
/// best-effort cleanup runs for EVERY outcome, then the error surfaces as
/// the test's panic. Skipped without JOTTY_TEST_URL/JOTTY_TEST_API_KEY;
/// never fabricated.
#[test]
#[ignore]
fn real_appointment_round_trip() {
    let Some((url, key)) = env() else { return; };
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let client = JottyClient::new(&url, &key).unwrap();
        let mut conn = fresh_db();

        // R4: the steps run inside `run` (any failure short-circuits with
        // `?`; no unwrap/panic inside); the board id lands in `board` as
        // soon as it exists so the best-effort cleanup below runs for every
        // outcome — a mid-flow Err (like the T9 400 class) now self-cleans.
        let mut board: Option<String> = None;
        let result = run(&client, &mut conn, &mut board, &url, &key).await;
        if let Some(board) = board.as_deref() {
            if let Err(e) = client.delete_checklist(board).await {
                eprintln!("cleanup: failed to delete test board {board}: {e:?}");
            }
        }
        result.unwrap_or_else(|e| panic!("round-trip failed: {e:?}"));
    });
}

async fn run(
    client: &JottyClient,
    conn: &mut rusqlite::Connection,
    board_out: &mut Option<String>,
    url: &str,
    key: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    // Wire-pinned constants: the reminder datetime is stored VERBATIM
    // upstream (setKanbanItemReminder JSON.parse's the PUT body — no
    // normalization), the kanban item's file segment renders as
    // `reminder:{"datetime":…}`, and the catalog PATCH targetDate is a
    // date-only string (T8.1 production shape). WEB_REMINDER differs from
    // REMINDER on purpose: the R3 arm must prove a merge of a server-set
    // value, not a client echo.
    const REMINDER: &str = "2026-10-01T09:00:00Z";
    const WEB_REMINDER: &str = "2026-10-01T11:30:00Z";
    const TARGET_DATE: &str = "2026-10-01";

    // 1) throwaway board, deleted at the end (disposable-name pattern);
    //    captured for cleanup the moment it exists
    let created = client.create_task(
        &format!("Agenda test {}", chrono::Utc::now().timestamp_millis()),
        "Uncategorized",
        &jotty_client_lib::jotty::models::creation_board_statuses(),
    ).await?;
    *board_out = Some(created.id.clone());
    let board = created.id.clone();

    // 2) the appointment card: index 0 on the fresh board; the target date
    //    rides the PATCH (index-resolved) BEFORE the first pull so the
    //    catalog round-trips it onto the local row
    let text = format!("roundtrip appointment {}", uuid::Uuid::new_v4());
    client.create_item(&board, &text, None, Some("todo")).await?;
    client.update_item_target_date(&board, "0", Some(TARGET_DATE)).await?;

    // 3) pull #1: catalog imports the board + item row (server_item_id from
    //    the stable id, target_date) — enrichment runs with no reminder yet
    let stats = pull::pull_all(conn, client).await?;
    if stats.enrichment_errors != 0 {
        return Err(format!(
            "clean pull must not report enrichment errors (got {})",
            stats.enrichment_errors,
        ).into());
    }

    // 4) stable item id comes from the ONLY board GET that carries ids the
    //    reminder route accepts (transformItem → item.id; matched by text)
    let item_id = {
        let kb = client.get_kanban_board(&board).await?;
        let item = kb.items.iter().find(|i| i.text == text)
            .ok_or_else(|| format!("item {text:?} missing from kanban GET"))?;
        if kb.items.len() != 1 {
            return Err(format!(
                "kanban GET must carry exactly one item, got {}",
                kb.items.len(),
            ).into());
        }
        if item.reminder.is_some() {
            return Err("fresh item must start reminderless".to_string().into());
        }
        item.id.clone().ok_or_else(|| "kanban GET must carry the stable item id".to_string())?
    };

    // 5) server-truth reminder write (upstream PUT {datetime})
    client.set_item_reminder(&board, &item_id, Some(REMINDER)).await?;

    // 6) server truth: the reminder round-trips verbatim on the board GET
    {
        let kb = client.get_kanban_board(&board).await?;
        let item = kb.items.iter().find(|i| i.text == text)
            .ok_or_else(|| format!("item {text:?} missing from kanban GET after reminder"))?;
        if item.reminder.as_ref().map(|r| r.datetime.as_str()) != Some(REMINDER) {
            return Err(format!(
                "reminder must round-trip verbatim through the kanban GET (got {:?})",
                item.reminder.as_ref().map(|r| r.datetime.as_str()),
            ).into());
        }
    }

    // 7) FILE segment (best-effort, container-optional): the board's
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
                .output()?;
            if !grep.status.success() {
                return Err(format!(
                    "reminder segment `{needle}` missing from the container data dir (grep exit {:?}, stderr: {})",
                    grep.status.code(),
                    String::from_utf8_lossy(&grep.stderr),
                ).into());
            }
            let files = String::from_utf8_lossy(&grep.stdout);
            let uuid_line = format!("uuid: {board}");
            let grep_uuid = std::process::Command::new("docker")
                .args(["exec", "jotty-desktop-test", "grep", "-rlF", "--", &uuid_line, "/app/data/checklists"])
                .output()?;
            if !grep_uuid.status.success() {
                return Err("board uuid frontmatter not found in the container checklists dir".to_string().into());
            }
            let uuid_files = String::from_utf8_lossy(&grep_uuid.stdout);
            if !uuid_files.lines().any(|u| files.lines().any(|f| f == u)) {
                return Err(format!(
                    "the reminder-bearing file must be our board's checklist file (reminder in {files:?}, uuid in {uuid_files:?})"
                ).into());
            }
        }
        Ok(p) => eprintln!(
            "file-check SKIPPED (disclosed): docker exec probe failed (exit {:?}) — container jotty-desktop-test not reachable",
            p.status.code(),
        ),
        Err(e) => eprintln!("file-check SKIPPED (disclosed): docker unavailable: {e}"),
    }

    // 8) pull #2: the enrichment merge mirrors the reminder onto the local
    //    row via the stable server_item_id — dirty untouched (server truth)
    let stats2 = pull::pull_all(conn, client).await?;
    if stats2.enrichment_errors != 0 {
        return Err(format!("pull #2 must enrich cleanly (got {})", stats2.enrichment_errors).into());
    }
    let rows = items::list_for_checklist(conn, &board)?;
    if rows.len() != 1 {
        return Err(format!(
            "exactly one local row for the throwaway board, got {}",
            rows.len(),
        ).into());
    }
    let row = &rows[0];
    if row.text != text {
        return Err(format!("local row text drift: {:?} != {text:?}", row.text).into());
    }
    if row.server_item_id.as_deref() != Some(item_id.as_str()) {
        return Err("the catalog item's stable id must be stored on the local row".to_string().into());
    }
    if row.reminder_datetime.as_deref() != Some(REMINDER) {
        return Err(format!(
            "enrichment must mirror the server reminder onto the local row (got {:?})",
            row.reminder_datetime,
        ).into());
    }
    if row.target_date.as_deref() != Some(TARGET_DATE) {
        return Err("the catalog round-trip must carry the target date".to_string().into());
    }

    // 9) R3 — web-set-reminder enrichment live arm: simulate a WEB edit
    //    server-side WITHOUT the client (raw reqwest PUT straight to the
    //    item-level route with the seeded API key and a DIFFERENT datetime —
    //    proves the merge is server-set, not a client echo). A non-200 fails
    //    the run loudly.
    let http = reqwest::Client::builder().build()?;
    let put_url = format!("{url}/api/kanban/{board}/items/{item_id}");
    let resp = http
        .put(&put_url)
        .header("x-api-key", key)
        .json(&serde_json::json!({ "reminder": { "datetime": WEB_REMINDER } }))
        .send()
        .await?;
    let status = resp.status();
    if status.as_u16() != 200 {
        let body = resp.text().await.unwrap_or_else(|_| "<unreadable>".to_string());
        return Err(format!(
            "web-set reminder PUT {put_url}: expected 200, got {status} — {body}"
        ).into());
    }

    // 10) pull #3: the enrichment merge must carry the server-set web
    //     reminder the CLIENT never wrote onto the local row.
    let stats3 = pull::pull_all(conn, client).await?;
    if stats3.enrichment_errors != 0 {
        return Err(format!("pull #3 must enrich cleanly (got {})", stats3.enrichment_errors).into());
    }
    let rows3 = items::list_for_checklist(conn, &board)?;
    if rows3.len() != 1 {
        return Err(format!(
            "exactly one local row after pull #3, got {}",
            rows3.len(),
        ).into());
    }
    let row3 = &rows3[0];
    if row3.reminder_datetime.as_deref() != Some(WEB_REMINDER) {
        return Err(format!(
            "pull #3 must carry the server-set web reminder (got {:?}, want {WEB_REMINDER})",
            row3.reminder_datetime,
        ).into());
    }

    Ok(())
}