use std::{fs, path::{Path, PathBuf}};

pub fn ensure_layout(root: &Path) -> Result<(), String> {
  fs::create_dir_all(root.join("media")).map_err(|e| e.to_string())?;
  fs::create_dir_all(root.join(".cache").join("thumbs")).map_err(|e| e.to_string())?;
  fs::create_dir_all(root.join(".cache").join("tmp")).map_err(|e| e.to_string())?;
  fs::create_dir_all(root.join(".cache").join("remote_media")).map_err(|e| e.to_string())?;
  
  // Migrate old db/library.sqlite → library.db
  migrate_old_db(root)?;
  
  // Initialize database schema
  let db = crate::db::open(&db_path(root))?;
  crate::db::init_schema(&db)?;
  
  Ok(())
}

pub fn db_path(root: &Path) -> PathBuf {
  root.join("library.db")
}

fn migrate_old_db(root: &Path) -> Result<(), String> {
  let new_db = root.join("library.db");
  let old_db = root.join("db").join("library.sqlite");
  
  // If new db already exists, nothing to do
  if new_db.exists() {
    return Ok(());
  }
  
  // If old db exists, copy it AND its WAL files to new location
  if old_db.exists() {
    let old_shm = root.join("db").join("library.sqlite-shm");
    let old_wal = root.join("db").join("library.sqlite-wal");
    
    let new_shm = root.join("library.db-shm");
    let new_wal = root.join("library.db-wal");
    
    fs::copy(&old_db, &new_db).map_err(|e| format!("Failed to migrate database: {}", e))?;
    
    if old_wal.exists() {
      fs::copy(&old_wal, &new_wal).map_err(|e| format!("Failed to migrate WAL: {}", e))?;
    }
    if old_shm.exists() {
      fs::copy(&old_shm, &new_shm).map_err(|e| format!("Failed to migrate SHM: {}", e))?;
    }
  }
  
  Ok(())
}