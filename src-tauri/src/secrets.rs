use std::path::PathBuf;
use std::sync::Mutex;

static SECRETS_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn init(config_dir: PathBuf) {
    let path = config_dir.join("secrets.json");
    *SECRETS_PATH.lock().unwrap() = Some(path);
}

fn secrets_path() -> Result<PathBuf, String> {
    SECRETS_PATH
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "Secrets storage not initialized".to_string())
}

fn load_all() -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let path = secrets_path()?;
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let val: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    match val {
        serde_json::Value::Object(map) => Ok(map),
        _ => Ok(serde_json::Map::new()),
    }
}

fn save_all(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let path = secrets_path()?;
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let json = serde_json::to_string_pretty(&serde_json::Value::Object(map.clone()))
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
    let mut map = load_all()?;
    map.insert(key.to_string(), serde_json::Value::String(value.to_string()));
    save_all(&map)
}

pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    let map = load_all()?;
    let result = map.get(key).and_then(|v| v.as_str()).map(|s| s.to_string());
    Ok(result)
}

pub fn delete_secret(key: &str) -> Result<(), String> {
    let mut map = load_all()?;
    map.remove(key);
    save_all(&map)
}