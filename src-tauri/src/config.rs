use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
  pub library_root: Option<String>,
}

/// Where to store the pointer file that tells us where the library is.
/// Tries next to the executable first, falls back to AppData.
fn pointer_path(_app: &AppHandle) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("tailburrow");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(".tailburrow-root"))
}

fn read_pointer(app: &AppHandle) -> Result<Option<String>, String> {
    let path = pointer_path(app)?;
    if !path.exists() { return Ok(None); }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let trimmed = content.trim().to_string();
    Ok(if trimmed.is_empty() { None } else { Some(trimmed) })
}

fn write_pointer(app: &AppHandle, root: &str) -> Result<(), String> {
    let path = pointer_path(app)?;
    fs::write(path, root).map_err(|e| e.to_string())
}

pub fn load_config(app: &AppHandle) -> Result<AppConfig, String> {
    let root = read_pointer(app)?;
    Ok(AppConfig { library_root: root })
}

pub fn save_config(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    match &cfg.library_root {
        Some(root) => write_pointer(app, root),
        None => {
            let path = pointer_path(app)?;
            let _ = fs::remove_file(path);
            Ok(())
        }
    }
}