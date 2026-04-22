use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::{aead::Aead, Aes256Gcm, Key, KeyInit, Nonce};
use sha2::{Digest, Sha256};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};

static SECRETS_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

// Application-specific key derivation seed
const APP_SECRET: &[u8] = b"tailburrow-v0.3.2-credential-protection";
// Fixed 12-byte nonce (fine for this threat model — prevents casual reading)
const NONCE: &[u8; 12] = b"tailburrow01";

fn derive_key() -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(APP_SECRET);
    let hash = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&hash);
    key
}

fn encrypt(plaintext: &str) -> Result<String, String> {
    let binding = derive_key();
    let key = Key::<Aes256Gcm>::from_slice(&binding);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(NONCE);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("Encryption failed: {}", e))?;
    Ok(BASE64.encode(&ciphertext))
}

fn decrypt(ciphertext_b64: &str) -> Result<String, String> {
    let binding = derive_key();
    let key = Key::<Aes256Gcm>::from_slice(&binding);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(NONCE);
    let ciphertext = BASE64
        .decode(ciphertext_b64)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|e| format!("Decryption failed: {}", e))?;
    String::from_utf8(plaintext).map_err(|e| format!("UTF-8 decode failed: {}", e))
}

/// Initialize secrets storage — call with the library root path
pub fn init(library_root: PathBuf) {
    let dir = library_root.join(".cache");
    let _ = std::fs::create_dir_all(&dir);
    *SECRETS_DIR.lock().unwrap() = Some(dir);
}

fn secrets_file() -> Result<PathBuf, String> {
    SECRETS_DIR
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "Secrets storage not initialized".to_string())
}

fn load_all() -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let path = secrets_file()?.join("secrets.json");
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;

    // Try encrypted format first
    if let Ok(plaintext) = decrypt(content.trim()) {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&plaintext) {
            return Ok(map);
        }
    }

    // Fall back to plaintext (migration from old version)
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&content) {
        // Re-save in encrypted format
        let _ = save_all(&map);
        return Ok(map);
    }

    // Can't read it — start fresh
    Ok(serde_json::Map::new())
}

fn save_all(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let dir = secrets_file()?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&serde_json::Value::Object(map.clone()))
        .map_err(|e| e.to_string())?;
    let encrypted = encrypt(&json)?;
    std::fs::write(dir.join("secrets.json"), encrypted).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
    let mut map = load_all()?;
    map.insert(key.to_string(), serde_json::Value::String(value.to_string()));
    save_all(&map)
}

pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    let map = load_all()?;
    Ok(map.get(key).and_then(|v| v.as_str()).map(|s| s.to_string()))
}

pub fn delete_secret(key: &str) -> Result<(), String> {
    let mut map = load_all()?;
    map.remove(key);
    save_all(&map)
}