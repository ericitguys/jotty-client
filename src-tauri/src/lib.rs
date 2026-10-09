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

// Mobile entry point (Android): the wry Android runtime calls `run` through the
// mobile_entry_point attribute; desktop builds are unaffected.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let db_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&db_dir)?;
            // P10: route keyring to the system AndroidKeyStore-backed builder
            // BEFORE any Entry exists (restore_connection below reads keys).
            // Failure is LOUD (logged) — no plaintext fallback reappears.
            #[cfg(target_os = "android")]
            if let Err(e) = android_keyring::set_android_keyring_credential_builder() {
                log::error!("android keyring builder init failed: {e}");
            }
            // P10: one-time legacy plaintext migration (both accounts). The
            // migration fn keeps the plaintext file on any keystore failure,
            // so a retry next startup is always safe.
            #[cfg(target_os = "android")]
            {
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
