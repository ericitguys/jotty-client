pub mod audio;
pub mod commands;
pub mod desktop_branding;
pub mod db;
pub mod error;
pub mod jotty;
pub mod keys;
pub mod state;
pub mod sync;
pub mod triage_ai;
pub mod updater;
pub mod voice_ai;

pub use sync::spawn_scheduler;

use tauri::Manager;

// P10 (v0.30.1): LINK-HOLD for the android-keyring crate's Java export.
// The Kotlin Keyring shim (MainActivity.onCreate, before super.onCreate)
// binds to this symbol by name — but nothing in Rust calls it anymore (the
// ndk-context registration fn panics; see setup below), and rustc's archive
// member granularity drops an unreferenced dependency's code object: the
// v0.30.1 verify-build proved the symbol MISSING from the cdylib without a
// Rust-side reference. This static takes the function's address (never
// calls it) — the data relocation pulls the rlib member and keeps the
// symbol exported from libjotty_client_lib.so. no_mangle + pub so no
// dead-code pass can drop it.
#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub static ANDROID_KEYRING_JNI_HOLD: unsafe extern "system" fn(
    *mut std::ffi::c_void,
    *mut std::ffi::c_void,
    *mut std::ffi::c_void,
) = {
    extern "system" {
        fn Java_io_crates_keyring_Keyring_00024Companion_setAndroidKeyringCredentialBuilder(
            env: *mut std::ffi::c_void,
            class: *mut std::ffi::c_void,
            context: *mut std::ffi::c_void,
        );
    }
    Java_io_crates_keyring_Keyring_00024Companion_setAndroidKeyringCredentialBuilder
};

// Mobile entry point (Android): the wry Android runtime calls `run` through the
// mobile_entry_point attribute; desktop builds are unaffected.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let db_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&db_dir)?;
            // P10 (v0.30.1 hotfix): the AndroidKeyStore CredentialBuilder is
            // NOT registered from Rust. The ndk-context registration fn
            // panics under tao 0.35 / wry 0.55 (nothing in the Tauri stack
            // initializes ndk-context — v0.30.0 shipped exactly that crash:
            // app opens and instantly closes on every launch). Registration
            // happens in Kotlin: MainActivity.onCreate calls the android-
            // keyring JNI export via the io.crates.keyring.Keyring shim
            // BEFORE super.onCreate() starts this runtime. What remains
            // here: the one-time legacy plaintext migration (both accounts),
            // GATED on the Kotlin-confirmed registration. keyring's default
            // builder on android is the in-memory mock — a migration run
            // without the REAL AndroidKeyStore builder would "succeed"
            // against the mock and delete the only plaintext copy
            // (permanent key loss at next process). The marker file
            // (keyring-builder-status) is written by MainActivity.onCreate
            // BEFORE this runtime starts; a missing/non-ok marker = the
            // registration was never confirmed = keep plaintext, skip the
            // migration, retry next launch.
            // The migration fn itself keeps the plaintext file on any
            // keystore failure, so a retry next startup is always safe.
            #[cfg(target_os = "android")]
            {
                let status_path = db_dir.join("keyring-builder-status");
                let registered = std::fs::read_to_string(&status_path)
                    .map(|s| s.trim() == "ok")
                    .unwrap_or(false);
                if registered {
                    for (account, label) in [
                        (keys::ACCOUNT, "api-key"),
                        (keys::AI_ACCOUNT, "openwebui-key"),
                    ] {
                        match keys::keys_migrate_legacy(&db_dir, account, &keys::OsKeyStore) {
                            Ok(Some(_)) => log::info!("legacy plaintext key migrated to AndroidKeyStore: {label}"),
                            Ok(None) => {}
                            Err(e) => log::warn!("legacy key migration skipped (kept plaintext): {e}"),
                        }
                    }
                } else {
                    log::error!(
                        "android keyring builder not confirmed (marker missing or failed) — legacy plaintext migration skipped, files kept"
                    );
                }
            }
            let conn = db::open(&db_dir.join("jotty.db"))?;
            db::migrations::run(&conn)?;
            let voice_dir = db_dir.join("voice");
            if let Err(e) = db::voice::sweep_startup(&conn, &voice_dir) {
                log::warn!("voice startup sweep failed (non-fatal): {e}");
            }
            // T3 (R-rec-5): recurrence startup sweep — mirrors the voice
            // sweep_startup warn pattern; non-fatal, a failed roll never
            // blocks startup.
            if let Err(e) = db::recurrence::sweep(&conn, chrono::Utc::now()) {
                log::warn!("recurrence startup sweep failed (non-fatal): {e}");
            }
            app.manage(crate::audio::VoiceRecorder::default());
            // restore connection if instance_url exists
            let state = state::AppState::new(
                conn,
                Box::new(keys::OsKeyStore),
                Box::new(keys::AiOsKeyStore),
            )?;
            state.restore_connection(app.handle().clone()); // spawns task: rebuild client from url+keyring, no auto-sync
            app.manage(state);
            sync::spawn_scheduler(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect_instance,
            commands::disconnect_instance,
            commands::get_connection,
            commands::list_notes,
            commands::get_note,
            commands::create_note,
            commands::quick_capture,
            commands::update_note,
            commands::delete_note,
            commands::list_checklists,
            commands::list_agenda,
            commands::get_checklist,
            commands::create_checklist,
            commands::update_checklist,
            commands::delete_checklist,
            commands::fetch_task_board,
            commands::get_board_columns,
            commands::create_task_board,
            commands::add_board_column,
            commands::update_board_column,
            commands::delete_board_column,
            commands::move_board_column,
            commands::add_item,
            commands::promote_note_to_board,
            commands::set_item_text,
            commands::set_item_checked,
            commands::set_item_status,
            commands::set_item_target_date,
            commands::set_item_reminder,
            commands::set_item_recurrence,
            commands::set_item_description,
            commands::set_item_est_time,
            commands::set_item_priority,
            commands::sweep_recurrence,
            commands::delete_item,
            commands::reorder_items,
            commands::list_categories,
            commands::search,
            commands::trigger_sync,
            commands::sync_status,
            commands::list_conflicts,
            commands::resolve_conflict,
            commands::get_settings,
            commands::set_sync_interval,
            commands::check_update,
            commands::download_update,
            commands::install_update,
            commands::open_update_url,
            commands::branding_desktop_status,
            commands::branding_desktop_apply,
            commands::branding_desktop_remove,
            commands::restart_app,
            commands::get_prefs,
            commands::get_branding,
            commands::voice_start_recording,
            commands::voice_stop_recording,
            commands::voice_delete_recording,
            commands::get_ai_settings,
            commands::set_ai_settings,
            commands::ai_get_models,
            commands::triage_suggest,
            commands::get_triage_settings,
            commands::set_triage_settings,
            commands::triage_tag_vocab,
            commands::triage_tag_vocab_add,
            commands::voice_transcribe,
            commands::voice_tidy,
            commands::voice_extract_tasks,
            commands::voice_extract_appointment,
            commands::voice_list_unsaved,
            commands::voice_save_note,
            commands::voice_transcribe_note,
            commands::voice_delete_note_audio,
            commands::voice_get_pending_transcriptions,
            commands::voice_retry_pending,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn scaffold_compiles() {
        assert_eq!(2 + 2, 4);
    }
}
