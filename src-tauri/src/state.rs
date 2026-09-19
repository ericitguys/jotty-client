//! Managed application state (Task 14).
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use rusqlite::OptionalExtension;

use crate::error::AppResult;
use crate::jotty::client::JottyClient;
use crate::keys;

pub struct AppState {
    pub db: tokio::sync::Mutex<rusqlite::Connection>,
    pub client: tokio::sync::RwLock<Option<JottyClient>>,
    pub keystore: Box<dyn keys::KeyStore>,
    pub ai_keystore: Box<dyn keys::KeyStore>,
    pub syncing: AtomicBool,
    pub db_path: PathBuf,
}

impl AppState {
    pub fn new(
        conn: rusqlite::Connection,
        keystore: Box<dyn keys::KeyStore>,
        ai_keystore: Box<dyn keys::KeyStore>,
    ) -> AppResult<Self> {
        // Ruling G: derive the db path from the connection itself (no extra arg).
        // rusqlite 0.32.1's Connection::path() returns Option<&str>.
        let db_path = PathBuf::from(conn.path().unwrap_or_default());
        Ok(Self {
            db: tokio::sync::Mutex::new(conn),
            client: tokio::sync::RwLock::new(None),
            keystore,
            ai_keystore,
            syncing: AtomicBool::new(false),
            db_path,
        })
    }

    /// Ruling O: spawn a tauri task that rebuilds the client from the sync_state
    /// url + keystore, guarded with `app.try_state::<AppState>()` (manage runs
    /// after setup returns). NO auto-sync in the restore path.
    pub fn restore_connection(&self, app: tauri::AppHandle) {
        use tauri::Manager;
        tauri::async_runtime::spawn(async move {
            // wait until the state is managed (setup must return first)
            let mut polls = 0u32;
            let state = loop {
                if let Some(s) = app.try_state::<AppState>() {
                    break s;
                }
                polls += 1;
                if polls > 200 {
                    return; // ~10s without manage() — give up quietly
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            };
            let url: Option<String> = {
                let conn = state.db.lock().await;
                conn.query_row(
                    "SELECT value FROM sync_state WHERE key='instance_url'",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None)
            };
            let Some(url) = url else { return };
            let Some(key) = state.keystore.get().unwrap_or(None) else { return };
            let Ok(client) = JottyClient::new(&url, &key) else { return };
            *state.client.write().await = Some(client);
            // NO auto-sync (ruling O)
        });
    }
}