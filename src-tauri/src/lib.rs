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
    .manage(crate::fa::FAState::new())
    .manage(crate::db::DbPool::new())
    .setup(|app| {
      let config_dir = app.path().app_config_dir().expect("Failed to get config dir");
      crate::secrets::init(config_dir);

      // Load DB if library root is already set
      if let Ok(cfg) = crate::config::load_config(&app.handle()) {
          if let Some(root) = cfg.library_root {
              let root_path = std::path::PathBuf::from(&root);
              if root_path.exists() {
                  let pool = app.state::<crate::db::DbPool>();
                  if let Err(e) = pool.set_path(crate::library::db_path(&root_path)) {
                      eprintln!("Failed to load database: {}", e);
                  }

                  // Allow filesystem access for existing library
                  let _ = app.fs_scope().allow_directory(&root_path, true);
                  let _ = app.asset_protocol_scope().allow_directory(&root_path, true);
              }
          }
      }
      Ok(())
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
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
