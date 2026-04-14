use std::{fs, path::{Path, PathBuf}};

pub fn ensure_layout(root: &Path) -> Result<(), String> {
  fs::create_dir_all(root.join("media")).map_err(|e| e.to_string())?;
  fs::create_dir_all(root.join(".cache").join("thumbs")).map_err(|e| e.to_string())?;
  fs::create_dir_all(root.join(".cache").join("tmp")).map_err(|e| e.to_string())?;
  fs::create_dir_all(root.join(".cache").join("remote_media")).map_err(|e| e.to_string())?;
  
  // Initialize database schema
  let db = crate::db::open(&db_path(root))?;
  crate::db::init_schema(&db)?;
  
  Ok(())
}

pub fn db_path(root: &Path) -> PathBuf {
  root.join("library.db")
}