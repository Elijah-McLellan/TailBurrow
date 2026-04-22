mod commands;
mod config;
mod db;
mod library;
pub mod fa; 
mod secrets;

use tauri::Manager; 
use tauri_plugin_fs::FsExt;
use std::sync::{Arc, Mutex};

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_fs::init())
    .manage(Arc::new(Mutex::new(commands::SyncState::default())))
    .manage(Arc::new(commands::MaintenanceState::default()))
    .manage(crate::fa::FAState::new())
    .manage(crate::db::DbPool::new())
    .setup(|app| {
      // Load DB if library root is already set
      if let Ok(cfg) = crate::config::load_config(&app.handle()) {
          if let Some(root) = cfg.library_root {
              let root_path = std::path::PathBuf::from(&root);
              if root_path.exists() {
                  // Initialize secrets inside the library folder
                  crate::secrets::init(root_path.clone());

                  let pool = app.state::<crate::db::DbPool>();
                  if let Err(e) = pool.set_path(crate::library::db_path(&root_path)) {
                      eprintln!("Failed to load database: {}", e);
                      if let Ok(mut cfg2) = crate::config::load_config(&app.handle()) {
                          cfg2.library_root = None;
                          let _ = crate::config::save_config(&app.handle(), &cfg2);
                      }
                  }

                  // Allow filesystem access for existing library
                  let _ = app.fs_scope().allow_directory(&root_path, true);
                  let _ = app.asset_protocol_scope().allow_directory(&root_path, true);
              }
          }
      }
      Ok(())
    })
    .on_window_event(|app, event| {
      if let tauri::WindowEvent::CloseRequested { .. } = event {
        // Cancel e621 sync
        if let Some(sync_state) = app.try_state::<Arc<Mutex<commands::SyncState>>>() {
          if let Ok(mut st) = sync_state.lock() {
            st.cancel_requested = true;
          }
        }
        // Cancel FA sync
        if let Some(fa_state) = app.try_state::<crate::fa::FAState>() {
          *fa_state.should_cancel.lock().unwrap() = true;
        }
        // Give threads a moment to finish current operation
        std::thread::sleep(std::time::Duration::from_millis(500));
      }
    })
    .invoke_handler(tauri::generate_handler![
      commands::add_e621_post,
      commands::get_config,
      commands::set_library_root,
      commands::list_items,
      commands::trash_item,
      commands::get_library_stats,
      commands::clear_library_root,
      commands::update_item_tags,
      commands::fa_set_credentials,
      commands::fa_start_sync,
      commands::fa_sync_status,
      commands::fa_cancel_sync,
      commands::get_trashed_items,
      commands::restore_item,
      commands::empty_trash,
      commands::auto_clean_trash,
      commands::fa_get_cred_info,
      commands::fa_clear_credentials,
      commands::update_item_rating,
      commands::update_item_sources,
      commands::get_trash_count,
      commands::ensure_thumbnail,
      commands::e621_clear_credentials,
      commands::e621_get_cred_info,
      commands::e621_set_credentials,
      commands::e621_test_connection,
      commands::e621_fetch_posts,
      commands::e621_favorite,
      commands::e621_sync_start,
      commands::e621_sync_status,
      commands::e621_sync_cancel,
      commands::e621_unavailable_list,
      commands::has_app_lock,
      commands::set_app_lock,
      commands::verify_app_lock,
      commands::clear_app_lock,
      commands::set_safe_pin,
      commands::has_safe_pin,
      commands::verify_safe_pin,
      commands::clear_safe_pin,
      commands::get_unscanned_e621_ids,
      commands::get_known_pool_ids,
      commands::check_posts_for_pools,
      commands::fetch_pool_infos_batch,
      commands::get_pool_posts,
      commands::save_pools_cache,
      commands::load_pools_cache,
      commands::clear_pools_cache,
      commands::proxy_remote_media,
      commands::import_local_files,
      commands::maintenance_find_duplicates,
      commands::maintenance_start_deleted_check,
      commands::maintenance_deleted_check_status,
      commands::maintenance_start_metadata_update,
      commands::maintenance_metadata_update_status,
      commands::maintenance_start_fa_upgrade,
      commands::maintenance_fa_upgrade_status,
      commands::maintenance_get_deleted_results,
      commands::e621_unfavorite,
      commands::search_tags,
      commands::get_post_pools,
      commands::load_app_settings,
      commands::save_app_settings,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}