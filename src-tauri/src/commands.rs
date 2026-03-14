use crate::{config, db, library};
use sha2::{Sha256, Digest};
use chrono::Utc;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::AppHandle;
use tauri_plugin_fs::FsExt;
use tauri::Manager;
use std::io::Write;
use std::sync::{Arc, Mutex};
use crate::fa::{FAState, FASyncStatus};


pub fn get_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  let cfg = config::load_config(app)?;
  let root = cfg.library_root.ok_or("Library root not set yet")?;
  Ok(PathBuf::from(root))
}

fn with_db<F, T>(app: &tauri::AppHandle, f: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, String>,
{
    let pool = app.state::<db::DbPool>();
    let guard = pool.get()?;
    let conn = guard.as_ref().unwrap(); // safe because get() checks for None
    f(conn)
}

fn sanitize_slug(s: &str) -> String {
  let mut out = s.trim().to_lowercase().replace(' ', "_");
  for ch in ['<', '>', ';', ':', '"', '/', '\\', '|', '?', '*'] {
    out = out.replace(ch, "");
  }
  if out.is_empty() {
    out = "unknown_artist".into();
  }
  out
}

fn pick_primary_artist(artists: &[String]) -> String {
  let deny = ["sound_warning", "conditional_dnp"];
  artists
    .iter()
    .find(|a| !deny.contains(&a.as_str()))
    .cloned()
    .unwrap_or_else(|| "unknown_artist".into())
}

#[derive(Serialize)]
pub struct Status {
  pub ok: bool,
  pub message: String,
}


#[derive(Serialize)]
pub struct ItemDto {
  pub item_id: i64,
  pub source: String,
  pub source_id: String,
  pub remote_url: Option<String>,
  pub file_rel: String,
  pub file_abs: String,
  pub ext: Option<String>,
  pub sources: Vec<String>,
  pub rating: Option<String>,
  pub fav_count: Option<i64>,
  pub score_total: Option<i64>,
  pub timestamp: Option<String>,
  pub added_at: String,
  pub tags_general: Vec<String>,
  pub tags_artist: Vec<String>,
  pub tags_copyright: Vec<String>,
  pub tags_character: Vec<String>,
  pub tags_species: Vec<String>,
  pub tags_meta: Vec<String>,
  pub tags_lore: Vec<String>,
}

#[derive(Deserialize)]
pub struct E621Tags {
  pub general: Vec<String>,
  pub species: Vec<String>,
  pub character: Vec<String>,
  pub artist: Vec<String>,
  pub meta: Vec<String>,
  pub lore: Vec<String>,
  pub copyright: Vec<String>,
}

#[derive(Deserialize)]
pub struct E621PostInput {
  pub id: i64,
  pub file_url: String,
  pub file_ext: String,
  pub file_md5: Option<String>,
  pub rating: Option<String>,
  pub fav_count: Option<i64>,
  pub score_total: Option<i64>,
  pub created_at: Option<String>,
  pub sources: Vec<String>,
  pub tags: E621Tags,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SyncStatus {
  pub running: bool,
  pub cancelled: bool,
  pub max_new_downloads: Option<u32>,

  pub scanned_pages: u32,
  pub scanned_posts: u32,
  pub skipped_existing: u32,

  pub new_attempted: u32,
  pub downloaded_ok: u32,
  pub failed_downloads: u32,
  pub unavailable: u32,

  pub last_error: Option<String>,
}

#[derive(Serialize)]
pub struct UnavailableDto {
  pub source: String,
  pub source_id: String,
  pub seen_at: String,
  pub reason: String,
  pub sources: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PoolInfo {
    pub pool_id: i64,
    pub name: String,
    pub post_count: i32,
    pub cover_url: String,
    pub cover_ext: String,
}

#[derive(Serialize)]
pub struct PoolPost {
    pub item_id: i64,
    pub source_id: String,
    pub file_abs: String,
    pub ext: String,
    pub position: i32,
}

#[derive(Serialize, Clone, Default)]
pub struct MaintenanceProgress {
    pub running: bool,
    pub current: u32,
    pub total: u32,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DeletedPostInfo {
    pub post_id: i64,
    pub item_id: i64,
    pub reason: String,
    pub tag_applied: String,
}

pub struct MaintenanceState {
    pub deleted_check: Mutex<MaintenanceProgress>,
    pub deleted_results: Mutex<Vec<DeletedPostInfo>>,
    pub metadata_update: Mutex<MaintenanceProgress>,
    pub fa_upgrade: Mutex<MaintenanceProgress>,
}

impl Default for MaintenanceState {
    fn default() -> Self {
        Self {
            deleted_check: Mutex::new(MaintenanceProgress::default()),
            deleted_results: Mutex::new(Vec::new()),
            metadata_update: Mutex::new(MaintenanceProgress::default()),
            fa_upgrade: Mutex::new(MaintenanceProgress::default()),
        }
    }
}

fn strip_html_tags(input: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => { in_tag = false; result.push(' '); }
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    // Collapse whitespace and trim
    result.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn extract_deletion_reason(html: &str) -> String {
    let lower = html.to_lowercase();

    // ── Strategy 1: Find bottom-notices section ──
    let section_start = lower.find("bottom-notices")
        .or_else(|| lower.find("this post was deleted"))
        .or_else(|| lower.find("notice-warning"));

    if let Some(start) = section_start {
        let chunk_end = (start + 3000).min(html.len());
        let chunk = &html[start..chunk_end];
        let chunk_lower = chunk.to_lowercase();

        // Look for "Reason:" (may be inside tags like <b>Reason:</b> or plain text)
        if let Some(reason_idx) = chunk_lower.find("reason:") {
            let after_reason = &chunk[reason_idx + 7..];
            let after_lower = after_reason.to_lowercase();

            let end = after_lower.find("</p>")
                .or_else(|| after_lower.find("<br"))
                .or_else(|| after_lower.find("</div>"))
                .or_else(|| after_lower.find("</span>"))
                .or_else(|| after_lower.find("</li>"))
                .unwrap_or(after_reason.len().min(500));

            let text = strip_html_tags(&after_reason[..end]);
            if !text.is_empty() {
                // Remove trailing "- Username - X days ago" if present
                return clean_reason_suffix(&text);
            }
        }
    }

    // ── Strategy 2: Look for [DELETION] marker ──
    if let Some(idx) = lower.find("[deletion]") {
        let after = &html[idx + 10..];
        let after_lower = after.to_lowercase();
        let end = after_lower.find("</p>")
            .or_else(|| after_lower.find("<br"))
            .or_else(|| after_lower.find("</div>"))
            .or_else(|| after_lower.find("\n"))
            .unwrap_or(after.len().min(500));

        let text = strip_html_tags(&after[..end]);
        if !text.is_empty() {
            return clean_reason_suffix(&text);
        }
    }

    // ── Strategy 3: Broad search for "Reason:" anywhere ──
    if let Some(reason_idx) = lower.find("reason:") {
        // Make sure this isn't in a script/style tag
        let before = &lower[..reason_idx];
        let in_script = before.rfind("<script").unwrap_or(0) > before.rfind("</script").unwrap_or(0);
        let in_style = before.rfind("<style").unwrap_or(0) > before.rfind("</style").unwrap_or(0);

        if !in_script && !in_style {
            let after = &html[reason_idx + 7..];
            let after_lower = after.to_lowercase();
            let end = after_lower.find("</p>")
                .or_else(|| after_lower.find("<br"))
                .or_else(|| after_lower.find("</div>"))
                .or_else(|| after_lower.find("\n"))
                .unwrap_or(after.len().min(500));

            let text = strip_html_tags(&after[..end]);
            if !text.is_empty() {
                return clean_reason_suffix(&text);
            }
        }
    }

    "Unknown reason".to_string()
}

fn clean_reason_suffix(text: &str) -> String {
    let trimmed = text.trim();
    // Remove trailing patterns like " - Username - 9 days ago"
    // Look for " - " followed by something containing "ago"
    if let Some(last_dash) = trimmed.rfind(" - ") {
        let after_last = &trimmed[last_dash + 3..];
        if after_last.contains("ago") || after_last.contains("day")
            || after_last.contains("hour") || after_last.contains("minute")
            || after_last.contains("second") || after_last.contains("month")
            || after_last.contains("year") || after_last.contains("week")
        {
            let before = &trimmed[..last_dash];
            // There might be another " - Username" before the timestamp
            if let Some(prev_dash) = before.rfind(" - ") {
                return before[..prev_dash].trim().to_string();
            }
            return before.trim().to_string();
        }
    }
    trimmed.to_string()
}

fn categorize_deletion_reason(reason: &str) -> &'static str {
    let lower = reason.to_lowercase();

    if lower.contains("ai assisted") || lower.contains("ai generated")
        || lower.contains("ai-assisted") || lower.contains("ai-generated")
        || lower.contains("artificial intelligence")
        || (lower.contains("irrelevant") && lower.contains("ai"))
    {
        "ai_generated"
    } else if lower.contains("artist request") || lower.contains("character owner")
        || lower.contains("takedown") || lower.contains("artist's request")
        || lower.contains("requested removal") || lower.contains("artists request")
        || lower.contains("owner request")
    {
        "artist_requested_deletion"
    } else if lower.contains("paysite") || lower.contains("commercial content")
        || lower.contains("paid content") || lower.contains("paywalled")
    {
        "paysite_content"
    } else if lower.contains("inferior") || lower.contains("duplicate")
        || lower.contains("better version") || lower.contains("replaced")
    {
        "inferior_version"
    } else {
        "deleted_on_e621"
    }
}

#[derive(Serialize)]
pub struct DuplicateGroup {
    pub md5: String,
    pub items: Vec<DuplicateItem>,
}

#[derive(Serialize)]
pub struct DuplicateItem {
    pub item_id: i64,
    pub source: String,
    pub source_id: String,
    pub file_rel: String,
    pub ext: String,
}

#[tauri::command]
pub fn e621_unavailable_list(app: AppHandle, limit: u32) -> Result<Vec<UnavailableDto>, String> {
  with_db(&app, |conn| {

    let mut stmt = conn.prepare(
      r#"
      SELECT source, source_id, seen_at, reason, sources_json
      FROM unavailable_posts
      ORDER BY seen_at DESC
      LIMIT ?
      "#
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([limit], |r| {
      let sources_json: String = r.get(4)?;
      let sources: Vec<String> = serde_json::from_str(&sources_json).unwrap_or_default();

      Ok(UnavailableDto {
        source: r.get(0)?,
        source_id: r.get(1)?,
        seen_at: r.get(2)?,
        reason: r.get(3)?,
        sources,
      })
    }).map_err(|e| e.to_string())?;

    let mut out = vec![];
    for row in rows {
      out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
  })
}

#[derive(Default)]
pub struct SyncState {
  pub status: SyncStatus,
  pub cancel_requested: bool,
}

#[tauri::command]
pub fn get_config(app: AppHandle) -> Result<config::AppConfig, String> {
  config::load_config(&app)
}

#[tauri::command]
pub fn set_library_root(app: AppHandle, library_root: String) -> Result<Status, String> {
  let root = PathBuf::from(&library_root);

  if !root.exists() {
    return Err("Selected library root does not exist".into());
  }
  if !root.is_dir() {
    return Err("Selected library root is not a directory".into());
  }

  library::ensure_layout(&root)?;

  let pool = app.state::<db::DbPool>();
  pool.set_path(library::db_path(&root))?;

  // allow file access for chosen library root
  if let Err(e) = app.fs_scope().allow_directory(&root, true) {
    return Err(format!("Failed to allow directory in fs scope: {e}"));
  }
  // allow asset:// serving for convertFileSrc(...)
  if let Err(e) = app.asset_protocol_scope().allow_directory(&root, true) {
    return Err(format!("Failed to allow directory in asset protocol scope: {e}"));
  }

  let mut cfg = config::load_config(&app)?;
  cfg.library_root = Some(library_root);
  config::save_config(&app, &cfg)?;

  Ok(Status {
    ok: true,
    message: "Library root set and DB initialized".into(),
  })
}

#[tauri::command]
pub async fn add_e621_post(app: AppHandle, post: E621PostInput) -> Result<Status, String> {
    let root = get_root(&app)?;
    library::ensure_layout(&root)?;

    // ── Dedup checks (need their own connection) ──
    let dedup_conn = db::open(&library::db_path(&root))?;
    db::init_schema(&dedup_conn)?;

    let exists: i64 = dedup_conn
        .query_row(
            "SELECT COUNT(*) FROM items WHERE source='e621' AND source_id=? AND trashed_at IS NULL",
            params![post.id.to_string()],
            |r: &Row| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    if exists > 0 {
        return Ok(Status { ok: true, message: "Already downloaded".into() });
    }

    if let Some(md5) = &post.file_md5 {
        let md5_exists: i64 = dedup_conn
            .query_row(
                "SELECT COUNT(*) FROM items WHERE md5=? AND trashed_at IS NULL",
                params![md5],
                |r: &Row| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        if md5_exists > 0 {
            return Ok(Status { ok: true, message: "Already downloaded (md5 match)".into() });
        }
    }

    // Drop the dedup connection before downloading
    drop(dedup_conn);

    // ── Build filename ──
    let primary_artist = sanitize_slug(&pick_primary_artist(&post.tags.artist));
    let ext = post.file_ext.trim().to_lowercase();

    if ext.is_empty() {
        return Err("Missing file_ext from e621".into());
    }

    let base = format!("{primary_artist}_e621_{}.{}", post.id, ext);
    let media_dir = root.join("media");
    let mut filename = base.clone();
    let mut dest_path = media_dir.join(&filename);

    let mut n = 1;
    while dest_path.exists() {
        filename = format!("{primary_artist}_e621_{}_dup{}.{}", post.id, n, ext);
        dest_path = media_dir.join(&filename);
        n += 1;
    }

    // ── Download to temp file ──
    let tmp_dir = root.join(".cache").join("tmp");
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let tmp_path = tmp_dir.join(format!("{filename}.part"));

    let client = reqwest::Client::new();
    let resp = client
        .get(&post.file_url)
        .header("User-Agent", "TailBurrow/0.3.1 (local archiver)")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;

    fs::rename(&tmp_path, &dest_path).map_err(|e| e.to_string())?;

    // ── DB insert (with cleanup on failure) ──
    let cleanup_path = dest_path.clone();
    let db_result = (|| -> Result<(), String> {
        let file_rel = format!("media/{}", filename.replace('\\', "/"));
        generate_and_save_thumb(&root, &file_rel);

        let added_at = Utc::now().to_rfc3339();

        let mut conn = db::open(&library::db_path(&root))?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        tx.execute(
            r#"
            INSERT INTO items(source, source_id, md5, remote_url, file_rel, ext, rating, fav_count, score_total, created_at, added_at, primary_artist)
            VALUES('e621', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            params![
                post.id.to_string(),
                post.file_md5,
                post.file_url,
                file_rel,
                ext,
                post.rating,
                post.fav_count,
                post.score_total,
                post.created_at,
                added_at,
                primary_artist
            ],
        ).map_err(|e| e.to_string())?;

        let item_id = tx.last_insert_rowid();

        insert_tags_for_item(&tx, item_id, &post.tags)?;

        for u in &post.sources {
            let sid = upsert_source(&tx, u)?;
            tx.execute(
                "INSERT OR IGNORE INTO item_sources(item_id, source_row_id) VALUES(?, ?)",
                params![item_id, sid],
            ).map_err(|e| e.to_string())?;
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })();

    if let Err(e) = db_result {
        let _ = fs::remove_file(&cleanup_path);
        return Err(e);
    }

    Ok(Status { ok: true, message: "Downloaded into library".into() })
}

#[derive(Serialize)]
pub struct E621CredInfo {
  pub username: Option<String>,
  pub has_api_key: bool,
}

fn load_e621_creds() -> Result<(String, String), String> {
  let username = crate::secrets::get_secret("e621_username")?
    .ok_or("e621 username not set")?;
  let api_key = crate::secrets::get_secret("e621_api_key")?
    .ok_or("e621 api key not set")?;
  Ok((username, api_key))
}

fn upsert_unavailable(
  conn: &Connection,
  source: &str,
  source_id: &str,
  reason: &str,
  sources: Vec<String>,
) -> Result<(), String> {
  let seen_at = Utc::now().to_rfc3339();
  let sources_json = serde_json::to_string(&sources).map_err(|e| e.to_string())?;

  conn.execute(
    r#"
    INSERT INTO unavailable_posts(source, source_id, seen_at, reason, sources_json)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id)
    DO UPDATE SET seen_at=excluded.seen_at, reason=excluded.reason, sources_json=excluded.sources_json
    "#,
    params![source, source_id, seen_at, reason, sources_json],
  ).map_err(|e| e.to_string())?;

  Ok(())
}

#[tauri::command]
pub fn e621_get_cred_info() -> Result<E621CredInfo, String> {
  let username = crate::secrets::get_secret("e621_username")?;
  let has_api_key = crate::secrets::get_secret("e621_api_key")?.is_some();
  Ok(E621CredInfo { username, has_api_key })
}

#[tauri::command]
pub fn e621_set_credentials(username: String, api_key: String) -> Result<Status, String> {
  let u = username.trim();
  if u.is_empty() {
    return Err("Username cannot be empty".into());
  }

  crate::secrets::set_secret("e621_username", u)?;

  if !api_key.trim().is_empty() {
    crate::secrets::set_secret("e621_api_key", api_key.trim())?;
  }

  Ok(Status { ok: true, message: "Saved e621 credentials".into() })
}

#[tauri::command]
pub async fn e621_test_connection() -> Result<Status, String> {
  let (username, api_key) = load_e621_creds()?;

  let client = reqwest::Client::new();
  let resp = client
    .get("https://e621.net/posts.json")
    .basic_auth(username, Some(api_key))
    .header("User-Agent", "TailBurrow/0.3.1 (test)")
    .query(&[("limit", "1"), ("tags", "order:id_desc")])
    .send()
    .await
    .map_err(|e| e.to_string())?;

  if !resp.status().is_success() {
    return Err(format!("Test failed: HTTP {}", resp.status()));
  }

  Ok(Status { ok: true, message: "Connected to e621 successfully".into() })
}

#[tauri::command]
pub async fn e621_fetch_posts(tags: String, limit: u32, page: Option<String>) -> Result<serde_json::Value, String> {
  let (username, api_key) = load_e621_creds()?;

  let client = reqwest::Client::new();
  let mut req = client
    .get("https://e621.net/posts.json")
    .basic_auth(username, Some(api_key))
    .header("User-Agent", "TailBurrow/0.3.1 (feeds)")
    .query(&[("tags", tags), ("limit", limit.to_string())]);

  if let Some(p) = page {
    req = req.query(&[("page", p)]);
  }

  let resp = req.send().await.map_err(|e| e.to_string())?;
  if !resp.status().is_success() {
    return Err(format!("e621 error: HTTP {}", resp.status()));
  }

  resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn e621_sync_status(state: tauri::State<'_, Arc<Mutex<SyncState>>>) -> Result<SyncStatus, String> {
  let st = state.lock().map_err(|_| "Sync state lock poisoned")?;
  Ok(st.status.clone())
}

#[tauri::command]
pub fn e621_sync_cancel(state: tauri::State<'_, Arc<Mutex<SyncState>>>) -> Result<Status, String> {
  let mut st = state.lock().map_err(|_| "Sync state lock poisoned")?;
  st.cancel_requested = true;
  st.status.cancelled = true;
  Ok(Status { ok: true, message: "Cancel requested".into() })
}

#[tauri::command]
pub fn e621_sync_start(
  app: AppHandle,
  state: tauri::State<'_, Arc<Mutex<SyncState>>>,
  max_new_downloads: Option<u32>,
) -> Result<Status, String> {
  {
    let mut st = state.lock().map_err(|_| "Sync state lock poisoned")?;
    if st.status.running {
      return Err("Sync already running".into());
    }
    st.cancel_requested = false;
    st.status = SyncStatus {
      running: true,
      cancelled: false,
      max_new_downloads,
      ..Default::default()
    };
  }

  let app2 = app.clone();
  let state2 = state.inner().clone();

  std::thread::spawn(move || {
    let result: Result<(), String> = (|| {
      let root = get_root(&app2)?;
      let conn = db::open(&library::db_path(&root))?;
      db::init_schema(&conn)?;

      // Load creds from DB settings (you already implemented e621 creds in settings)
      // This expects keys: e621_username, e621_api_key
      let (username, api_key) = load_e621_creds()?;

      let client = reqwest::blocking::Client::new();

      let mut page: u32 = 1;

      loop {
        // cancel check
        {
          let st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
          if st.cancel_requested {
            break;
          }
        }

        // stop if hit max
        {
          let st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
          if let Some(maxn) = st.status.max_new_downloads {
            if st.status.new_attempted >= maxn {
              break;
            }
          }
        }

        // fetch favorites page
        let tags = format!("fav:{} order:id_desc", username);
        let resp = client
          .get("https://e621.net/posts.json")
          .basic_auth(&username, Some(&api_key))
          .header("User-Agent", "TailBurrow/0.3.1 (sync)")
          .query(&[
            ("tags", tags.as_str()),
            ("limit", "320"),
            ("page", &page.to_string()),
          ])
          .send()
          .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
          return Err(format!("e621 sync API error: HTTP {}", resp.status()));
        }

        let json: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        let posts = json.get("posts").and_then(|p| p.as_array()).cloned().unwrap_or_default();

        {
          let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
          st.status.scanned_pages += 1;
        }

        // e621 API rules: max 2 requests/second
        std::thread::sleep(std::time::Duration::from_millis(500));

        if posts.is_empty() {
          break;
        }

        for p in posts {
          // cancel check
          {
            let st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
            if st.cancel_requested {
              break;
            }
          }

          {
            let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
            st.status.scanned_posts += 1;
          }

          let post_id = p.get("id").and_then(|x| x.as_i64()).unwrap_or(0);
          if post_id == 0 {
            continue;
          }

          // ── Store pool associations from this post ──
          if let Some(pools_arr) = p.get("pools").and_then(|v| v.as_array()) {
              for pv in pools_arr {
                  if let Some(pid) = pv.as_i64() {
                      conn.execute(
                          "INSERT OR IGNORE INTO post_pools(source_id, pool_id) VALUES(?,?)",
                          params![post_id.to_string(), pid],
                      ).ok();
                  }
              }
          }
          // Mark this post as pool-scanned regardless
          conn.execute(
              "INSERT OR IGNORE INTO pool_scan_log(source_id) VALUES(?)",
              params![post_id.to_string()],
          ).ok();

          // already downloaded check by (source,id)
          let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM items WHERE source='e621' AND source_id=? AND trashed_at IS NULL",
            params![post_id.to_string()],
            |r: &Row| r.get(0),
          ).map_err(|e| e.to_string())?;

          if exists > 0 {
            let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
            st.status.skipped_existing += 1;
            continue;
          }

          // md5 check (optional)
          let md5 = p.get("file").and_then(|f| f.get("md5")).and_then(|m| m.as_str()).map(|s| s.to_string());
          if let Some(ref m) = md5 {
            let md5_exists: i64 = conn.query_row(
              "SELECT COUNT(*) FROM items WHERE md5=? AND trashed_at IS NULL",
              params![m],
              |r: &Row| r.get(0),
            ).map_err(|e| e.to_string())?;
            if md5_exists > 0 {
              let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
              st.status.skipped_existing += 1;
              continue;
            }
          }

          // stop after N new downloads (attempted)
          {
            let st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
            if let Some(maxn) = st.status.max_new_downloads {
              if st.status.new_attempted >= maxn {
                break;
              }
            }
          }

          // file.url might be missing for deleted/blocked
          let file_url = p.get("file").and_then(|f| f.get("url")).and_then(|u| u.as_str()).map(|s| s.to_string());
          let file_ext = p.get("file").and_then(|f| f.get("ext")).and_then(|u| u.as_str()).unwrap_or("").to_string();

          let sources: Vec<String> = p.get("sources")
            .and_then(|s| s.as_array())
            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();

          if file_url.is_none() {
            upsert_unavailable(&conn, "e621", &post_id.to_string(), "missing_file_url", sources)?;
            let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
            st.status.unavailable += 1;
            continue;
          }

          // convert to your existing E621PostInput and reuse add_e621_post
          let tags_obj = p.get("tags").cloned().unwrap_or(serde_json::Value::Null);

          let vec_from = |k: &str| -> Vec<String> {
            tags_obj.get(k)
              .and_then(|v| v.as_array())
              .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
              .unwrap_or_default()
          };

          let post_input = E621PostInput {
            id: post_id,
            file_url: file_url.clone().unwrap(),
            file_ext,
            file_md5: md5.clone(),
            rating: p.get("rating").and_then(|x| x.as_str()).map(|s| s.to_string()),
            fav_count: p.get("fav_count").and_then(|x| x.as_i64()),
            score_total: p.get("score").and_then(|s| s.get("total")).and_then(|x| x.as_i64()),
            created_at: p.get("created_at").and_then(|x| x.as_str()).map(|s| s.to_string()),
            sources,
            tags: E621Tags {
              general: vec_from("general"),
              species: vec_from("species"),
              character: vec_from("character"),
              artist: vec_from("artist"),
              meta: vec_from("meta"),
              lore: vec_from("lore"),
              copyright: vec_from("copyright"),
            },
          };

          {
            let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
            st.status.new_attempted += 1;
          }

          match tauri::async_runtime::block_on(add_e621_post(app2.clone(), post_input)) {
            Ok(_) => {
              let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
              st.status.downloaded_ok += 1;
            }
            Err(err) => {
              upsert_unavailable(&conn, "e621", &post_id.to_string(), "download_failed", file_url.is_some().then(|| vec![]).unwrap_or_default())?;
              let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
              st.status.failed_downloads += 1;
              st.status.last_error = Some(err);
            }
          }

          // e621 API rules: max 2 requests/second
          std::thread::sleep(std::time::Duration::from_millis(500));
        }

        page += 1;
      }

      Ok(())
    })();

    // mark finished
    let mut st = state2.lock().ok();
    if let Some(ref mut st) = st {
      st.status.running = false;
      if let Err(e) = result {
        st.status.last_error = Some(e);
      }
    }
  });

  Ok(Status { ok: true, message: "Sync started".into() })
}

#[tauri::command]
pub async fn e621_favorite(post_id: i64) -> Result<Status, String> {
  let (username, api_key) = load_e621_creds()?;

  let client = reqwest::Client::new();
  let resp = client
    .post("https://e621.net/favorites.json")
    .basic_auth(username, Some(api_key))
    .header("User-Agent", "TailBurrow/0.3.1 (favorite)")
    .header("Content-Type", "application/x-www-form-urlencoded")
    .body(format!("post_id={}", post_id))
    .send()
    .await
    .map_err(|e| e.to_string())?;

  if !resp.status().is_success() && resp.status().as_u16() != 422 {
    return Err(format!("Favorite failed: HTTP {}", resp.status()));
  }

  Ok(Status { ok: true, message: "Favorited on e621".into() })
}

#[tauri::command]
pub fn fa_set_credentials(a: String, b: String) -> Result<(), String> {
  crate::secrets::set_secret("fa_cookie_a", &a)?;
  crate::secrets::set_secret("fa_cookie_b", &b)?;
  Ok(())
}

#[derive(serde::Serialize)]
pub struct FaCredInfo {
    pub has_creds: bool,
}

#[tauri::command]
pub fn fa_get_cred_info() -> Result<FaCredInfo, String> {
  let has_a = crate::secrets::get_secret("fa_cookie_a")?.is_some();
  let has_b = crate::secrets::get_secret("fa_cookie_b")?.is_some();
  Ok(FaCredInfo { has_creds: has_a && has_b })
}

#[tauri::command]
pub fn fa_start_sync(app: tauri::AppHandle, limit: Option<u32>) -> Result<(), String> {
  let a = crate::secrets::get_secret("fa_cookie_a")?
    .ok_or("FA cookie A not set")?;
  let b = crate::secrets::get_secret("fa_cookie_b")?
    .ok_or("FA cookie B not set")?;

  let stop_after = limit.unwrap_or(0);

  tauri::async_runtime::spawn(async move {
    crate::fa::run_sync(app, a, b, stop_after).await;
  });

  Ok(())
}

#[tauri::command]
pub fn get_trash_count(app: tauri::AppHandle) -> Result<u32, String> {
    with_db(&app, |conn| {
        let count: u32 = conn.query_row(
            "SELECT COUNT(*) FROM items WHERE trashed_at IS NOT NULL",
            [],
            |row| row.get(0),
        ).unwrap_or(0);
        Ok(count)
    })
}

#[tauri::command]
pub fn get_trashed_items(app: tauri::AppHandle) -> Result<Vec<ItemDto>, String> {
    let root = get_root(&app)?;
    with_db(&app, |conn| {
      let mut stmt = conn.prepare(
          r#"
          SELECT
            i.item_id, i.source, i.source_id, i.remote_url, i.file_rel, i.ext,
            i.rating, i.fav_count, i.score_total, i.created_at, i.added_at,
            '', '', '' -- We don't need tags/sources for the trash view usually
          FROM items i
          WHERE i.trashed_at IS NOT NULL
          ORDER BY i.trashed_at DESC
          "#
      ).map_err(|e| e.to_string())?;

      let rows = stmt.query_map([], |r| {
          let file_rel: String = r.get(4)?;
          let file_abs = root.join(&file_rel);
          
          Ok(ItemDto {
              item_id: r.get(0)?,
              source: r.get(1)?,
              source_id: r.get(2)?,
              remote_url: r.get(3)?,
              file_rel: file_rel,
              file_abs: file_abs.to_string_lossy().to_string(),
              ext: r.get(5)?,
              rating: r.get(6)?,
              fav_count: r.get(7)?,
              score_total: r.get(8)?,
              timestamp: r.get(9)?,
              added_at: r.get(10)?,
              tags_general: vec![],
              tags_artist: vec![],
              tags_copyright: vec![],
              tags_character: vec![],
              tags_species: vec![],
              tags_meta: vec![],
              tags_lore: vec![],
              sources: vec![],
          })
      }).map_err(|e| e.to_string())?;

      let mut out = vec![];
      for row in rows {
          out.push(row.map_err(|e| e.to_string())?);
      }
      Ok(out)
    })
}

#[tauri::command]
pub fn restore_item(app: tauri::AppHandle, item_id: i64) -> Result<(), String> {
    with_db(&app, |conn| {
        conn.execute(
            "UPDATE items SET trashed_at = NULL WHERE item_id = ?",
            [item_id]
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub fn empty_trash(app: tauri::AppHandle) -> Result<(), String> {
    let root = get_root(&app)?;

    with_db(&app, |conn| {
        let mut stmt = conn.prepare("SELECT file_rel FROM items WHERE trashed_at IS NOT NULL")
            .map_err(|e| e.to_string())?;
        
        let files_to_delete: Vec<String> = stmt.query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();

        let cache_dir = root.join(".cache").join("thumbs");

        for rel_path in &files_to_delete {
            let abs_path = root.join(rel_path);
            if abs_path.exists() {
                let _ = std::fs::remove_file(abs_path);
            }

            let name_hash = format!("{:x}", md5::compute(rel_path.as_bytes()));
            let thumb_path = cache_dir.join(format!("{}.jpg", name_hash));
            
            if thumb_path.exists() {
                let _ = std::fs::remove_file(thumb_path);
            }
        }

        conn.execute("DELETE FROM items WHERE trashed_at IS NOT NULL", [])
            .map_err(|e| e.to_string())?;

        Ok(())
    })
}

#[tauri::command]
pub fn fa_sync_status(state: tauri::State<FAState>) -> FASyncStatus {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
pub fn fa_cancel_sync(state: tauri::State<FAState>) {
    *state.should_cancel.lock().unwrap() = true;
}

#[tauri::command]
pub fn fa_clear_credentials() -> Result<(), String> {
  crate::secrets::delete_secret("fa_cookie_a")?;
  crate::secrets::delete_secret("fa_cookie_b")?;
  Ok(())
}

#[tauri::command]
pub fn clear_library_root(app: tauri::AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("config.json");

    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }

    let pool = app.state::<db::DbPool>();
    pool.clear();

    Ok(())
}

#[tauri::command]
pub fn update_item_tags(app: tauri::AppHandle, item_id: i64, tags: Vec<String>) -> Result<(), String> {
    with_db(&app, |conn| {
        conn.execute("DELETE FROM item_tags WHERE item_id = ?", [item_id])
            .map_err(|e| e.to_string())?;

        for tag in &tags {
            let clean_tag = tag.trim().to_lowercase();
            if clean_tag.is_empty() { continue; }

            conn.execute(
                "INSERT OR IGNORE INTO tags (name, type) VALUES (?, 'general')",
                [&clean_tag]
            ).map_err(|e| e.to_string())?;

            let tag_id: i64 = conn.query_row(
                "SELECT tag_id FROM tags WHERE name = ?",
                [&clean_tag],
                |row| row.get(0)
            ).map_err(|e| e.to_string())?;

            conn.execute(
                "INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?)",
                [item_id, tag_id]
            ).map_err(|e| e.to_string())?;
        }

        Ok(())
    })
}

#[tauri::command]
pub fn e621_clear_credentials() -> Result<(), String> {
  crate::secrets::delete_secret("e621_username")?;
  crate::secrets::delete_secret("e621_api_key")?;
  Ok(())
}

#[tauri::command]
pub fn get_library_stats(app: tauri::AppHandle) -> Result<u32, String> {
    with_db(&app, |conn| {
        let count: u32 = conn.query_row(
            "SELECT COUNT(*) FROM items WHERE trashed_at IS NULL",
            [],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(count)
    })
}

#[tauri::command]
pub fn update_item_rating(app: tauri::AppHandle, item_id: i64, rating: String) -> Result<(), String> {
    let r = match rating.to_lowercase().as_str() {
        "s" | "safe" => "s",
        "q" | "questionable" => "q",
        "e" | "explicit" => "e",
        _ => return Err("Invalid rating".into()),
    };

    with_db(&app, |conn| {
        conn.execute(
            "UPDATE items SET rating = ? WHERE item_id = ?",
            rusqlite::params![r, item_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub fn update_item_sources(app: tauri::AppHandle, item_id: i64, sources: Vec<String>) -> Result<(), String> {
    with_db(&app, |conn| {
        conn.execute("DELETE FROM item_sources WHERE item_id = ?", [item_id])
            .map_err(|e| e.to_string())?;

        for url in &sources {
            let clean_url = url.trim();
            if clean_url.is_empty() { continue; }

            conn.execute("INSERT OR IGNORE INTO sources (url) VALUES (?)", [clean_url])
                .map_err(|e| e.to_string())?;
            
            let source_row_id: i64 = conn.query_row(
                "SELECT source_row_id FROM sources WHERE url = ?", 
                [clean_url], 
                |r| r.get(0)
            ).map_err(|e| e.to_string())?;

            conn.execute(
                "INSERT INTO item_sources (item_id, source_row_id) VALUES (?, ?)", 
                [item_id, source_row_id]
            ).map_err(|e| e.to_string())?;
        }

        Ok(())
    })
}

#[tauri::command]
pub fn list_items(
    app: tauri::AppHandle,
    limit: Option<u32>,
    offset: Option<u32>,
    search: Option<String>,
    rating: Option<String>,
    source: Option<String>,
    order: Option<String>,
) -> Result<Vec<ItemDto>, String> {
    let limit = limit.unwrap_or(100);
    let offset = offset.unwrap_or(0);
    let search_query = search.unwrap_or_default();
    let rating_filter = rating.unwrap_or("all".to_string());
    let source_filter = source.unwrap_or("all".to_string());
    let sort_order = order.unwrap_or("newest".to_string());

    let root = get_root(&app)?;
    let dedup_conn = db::open(&library::db_path(&root))?;
    db::init_schema(&dedup_conn)?;

    // Base SQL
    with_db(&app, |conn| {
      let mut sql = String::from(
          r#"
          SELECT
            i.item_id, i.source, i.source_id, i.remote_url, i.file_rel, i.ext,
            i.rating, i.fav_count, i.score_total, i.created_at, i.added_at,
            -- Fetch ALL tags with their types concatenated by '$$'
            (SELECT GROUP_CONCAT(t.name || '$$' || t.type, char(9)) 
            FROM item_tags it 
            JOIN tags t ON it.tag_id = t.tag_id 
            WHERE it.item_id = i.item_id),
            (SELECT GROUP_CONCAT(s.url, char(9)) FROM item_sources isrc JOIN sources s ON isrc.source_row_id = s.source_row_id WHERE isrc.item_id = i.item_id)
          FROM items i
          WHERE i.trashed_at IS NULL
          "#
      );

      let mut params_store: Vec<String> = vec![]; 
      let mut where_clauses: Vec<String> = vec![];

      // --- 1. RATING FILTER ---
      if rating_filter != "all" {
          if rating_filter == "nsfw" {
              where_clauses.push("(i.rating = 'q' OR i.rating = 'e')".to_string());
          } else {
              params_store.push(rating_filter);
              where_clauses.push(format!("i.rating = ?{}", params_store.len()));
          }
      }

      // --- 2. SOURCE FILTER ---
      if source_filter != "all" {
          params_store.push(source_filter);
          where_clauses.push(format!("i.source = ?{}", params_store.len()));
      }

      // --- 3. TAG SEARCH ---
      let terms: Vec<&str> = search_query.split_whitespace().collect();
      for term in terms {
          // --- 1. NEGATED TYPE (-type:image) ---
          if term.starts_with("-type:") {
              let val = term.replace("-type:", "").to_lowercase();
              match val.as_str() {
                  "image" | "img" => where_clauses.push("NOT (i.ext IN ('jpg', 'jpeg', 'png', 'webp'))".to_string()),
                  "video" | "vid" => where_clauses.push("NOT (i.ext IN ('mp4', 'webm'))".to_string()),
                  "gif" => where_clauses.push("i.ext != 'gif'".to_string()),
                  _ => {}
              }
          }
          // --- 2. POSITIVE TYPE (type:video) ---
          else if term.starts_with("type:") {
              let val = term.replace("type:", "").to_lowercase();
              match val.as_str() {
                  "image" | "img" => where_clauses.push("(i.ext IN ('jpg', 'jpeg', 'png', 'webp'))".to_string()),
                  "video" | "vid" => where_clauses.push("(i.ext IN ('mp4', 'webm'))".to_string()),
                  "gif" => where_clauses.push("(i.ext = 'gif')".to_string()),
                  _ => {}
              }
          }
          // --- 3. NEGATED EXTENSION (-ext:png) ---
          else if term.starts_with("-ext:") {
              let val = term.replace("-ext:", "").to_lowercase();
              params_store.push(val);
              where_clauses.push(format!("i.ext != ?{}", params_store.len()));
          }
          // --- 4. POSITIVE EXTENSION (ext:png) ---
          else if term.starts_with("ext:") {
              let val = term.replace("ext:", "").to_lowercase();
              params_store.push(val);
              where_clauses.push(format!("i.ext = ?{}", params_store.len()));
          }
          // --- 5. META TAGS (rating, source, order - ignored here, handled by params) ---
          // We skip these so they don't get treated as generic tags
          else if term.starts_with("rating:") {
              let val = term.replace("rating:", "").to_lowercase();
              // Map common aliases
              let r = match val.as_str() {
                  "safe" | "s" => "s",
                  "questionable" | "q" => "q",
                  "explicit" | "e" => "e",
                  _ => "s"
              };
              params_store.push(r.to_string());
              where_clauses.push(format!("i.rating = ?{}", params_store.len()));
          }
          else if term.starts_with("-rating:") {
              let val = term.replace("-rating:", "").to_lowercase();
              let r = match val.as_str() {
                  "safe" | "s" => "s",
                  "questionable" | "q" => "q",
                  "explicit" | "e" => "e",
                  _ => "s"
              };
              params_store.push(r.to_string());
              where_clauses.push(format!("i.rating != ?{}", params_store.len()));
          }
          else if term.starts_with("source:") || term.starts_with("order:") {
              continue;
          }
          // --- 6. NEGATED TAG (-tag) ---
          else if term.starts_with("-") {
              let tag = term.trim_start_matches("-").to_lowercase();
              params_store.push(tag);
              where_clauses.push(format!(
                  "NOT EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON it.tag_id = t.tag_id WHERE it.item_id = i.item_id AND t.name = ?{})", 
                  params_store.len()
              ));
          }
          // --- 7. REGULAR TAG (tag) ---
          else {
              let tag = term.to_lowercase();
              if tag.contains("*") {
                  let like_tag = tag.replace("*", "%");
                  params_store.push(like_tag);
                  where_clauses.push(format!(
                      "EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON it.tag_id = t.tag_id WHERE it.item_id = i.item_id AND t.name LIKE ?{})", 
                      params_store.len()
                  ));
              } else {
                  params_store.push(tag);
                  where_clauses.push(format!(
                      "EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON it.tag_id = t.tag_id WHERE it.item_id = i.item_id AND t.name = ?{})", 
                      params_store.len()
                  ));
              }
          }
          
      }

      // --- APPLY WHERE ---
      if !where_clauses.is_empty() {
          sql.push_str(" AND ");
          sql.push_str(&where_clauses.join(" AND "));
      }

      // --- 4. ORDERING ---
      let order_clause = match sort_order.as_str() {
          "score" => "ORDER BY i.score_total DESC",
          "favs" | "favcount" => "ORDER BY i.fav_count DESC",
          "random" => "ORDER BY RANDOM()",
          "oldest" => "ORDER BY i.added_at ASC",
          _ => "ORDER BY i.added_at DESC", // Default 'newest'
      };

      sql.push_str(&format!(" {} LIMIT {} OFFSET {}", order_clause, limit, offset));

      // Prepare & Execute
      let db_params: Vec<&dyn rusqlite::ToSql> = params_store.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
      let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

      let rows = stmt.query_map(&*db_params, |r| {
          let file_rel: String = r.get(4)?;
          let file_abs = root.join(&file_rel);
          
          // Parse the raw tag string "name$$type\tname2$$type2"
          let raw_tags: Option<String> = r.get(11)?;
          let mut t_gen = vec![];
          let mut t_art = vec![];
          let mut t_cop = vec![];
          let mut t_cha = vec![];
          let mut t_spe = vec![];
          let mut t_met = vec![];
          let mut t_lor = vec![];

          if let Some(s) = raw_tags {
              for entry in s.split('\t') {
                  if let Some((name, type_)) = entry.split_once("$$") {
                      let n = name.to_string();
                      match type_ {
                          "artist" => t_art.push(n),
                          "copyright" => t_cop.push(n),
                          "character" => t_cha.push(n),
                          "species" => t_spe.push(n),
                          "meta" => t_met.push(n),
                          "lore" => t_lor.push(n),
                          _ => t_gen.push(n),
                      }
                  }
              }
          }

          let split_tab = |s: String| -> Vec<String> {
              if s.is_empty() { vec![] } else { s.split('\t').map(|x| x.to_string()).collect() }
          };

          Ok(ItemDto {
              item_id: r.get(0)?,
              source: r.get(1)?,
              source_id: r.get(2)?,
              remote_url: r.get(3)?,
              file_rel: file_rel,
              file_abs: file_abs.to_string_lossy().to_string(),
              ext: r.get(5)?,
              rating: r.get(6)?,
              fav_count: r.get(7)?,
              score_total: r.get(8)?,
              timestamp: r.get(9)?,
              added_at: r.get(10)?,
              tags_general: t_gen,
              tags_artist: t_art,
              tags_copyright: t_cop,
              tags_character: t_cha,
              tags_species: t_spe,
              tags_meta: t_met,
              tags_lore: t_lor,
              sources: split_tab(r.get(12).unwrap_or_default()),
          })
      }).map_err(|e| e.to_string())?;

        let mut out = vec![];
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
}

// Add this helper function
pub fn generate_and_save_thumb(root: &std::path::Path, file_rel: &str) {
    let path = root.join(file_rel);
    let cache_dir = root.join(".cache").join("thumbs");
    
    // Create cache dir if missing
    if !cache_dir.exists() {
        let _ = std::fs::create_dir_all(&cache_dir);
    }

    let name_hash = format!("{:x}", md5::compute(file_rel.as_bytes()));
    let thumb_path = cache_dir.join(format!("{}.jpg", name_hash));

    if thumb_path.exists() { return; }

    // Try to open and resize
    if let Ok(img) = image::open(&path) {
        let thumb = img.resize(400, u32::MAX, image::imageops::FilterType::Lanczos3);
        let mut bytes: Vec<u8> = Vec::new();
        if thumb.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageOutputFormat::Jpeg(70)).is_ok() {
            let _ = std::fs::write(thumb_path, &bytes);
        }
    }
}

#[tauri::command]
pub async fn ensure_thumbnail(app: tauri::AppHandle, file_rel: String) -> Result<String, String> {
    // Offload to a blocking thread to prevent freezing the UI
    tauri::async_runtime::spawn_blocking(move || {
        let root = get_root(&app)?;
        let path = root.join(&file_rel);
        
        // Cache location: library_root/.cache/thumbs/
        let cache_dir = root.join(".cache").join("thumbs");
        if !cache_dir.exists() {
            std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
        }
        
        // Use MD5 of the relative path as filename
        let name_hash = format!("{:x}", md5::compute(file_rel.as_bytes()));
        let thumb_filename = format!("{}.jpg", name_hash);
        let thumb_path = cache_dir.join(&thumb_filename);
        
        // 1. If thumbnail exists, return it immediately
        if thumb_path.exists() {
            return Ok(thumb_path.to_string_lossy().to_string());
        }
        
        // 2. Skip videos/gifs for now (return empty string -> frontend uses fallback)
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        if ["mp4", "webm", "gif"].contains(&ext.as_str()) {
            return Ok("".to_string());
        }

        if !path.exists() {
            return Err(format!("Source file not found: {:?}", path));
        }

        // 3. Generate Thumbnail
        // This is the slow part!
        let img = image::open(&path).map_err(|e| format!("Failed to open image: {}", e))?;
        let thumb = img.resize(400, u32::MAX, image::imageops::FilterType::Lanczos3); // Resize

        let mut bytes: Vec<u8> = Vec::new();
        // Encode as JPEG (quality 70 is good enough for thumbs)
        thumb.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageOutputFormat::Jpeg(70))
            .map_err(|e| e.to_string())?;
            
        std::fs::write(&thumb_path, &bytes).map_err(|e| e.to_string())?;
        
        Ok(thumb_path.to_string_lossy().to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn proxy_remote_media(app: AppHandle, url: String) -> Result<String, String> {
    let root = get_root(&app)?;
    let cache_dir = root.join(".cache").join("remote_media");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    let url_hash = format!("{:x}", md5::compute(url.as_bytes()));
    let ext = url.rsplit('.')
        .next()
        .and_then(|e| if e.len() <= 5 && e.chars().all(|c| c.is_alphanumeric()) { Some(e) } else { None })
        .unwrap_or("bin");
    let cached_path = cache_dir.join(format!("{}.{}", url_hash, ext));

    if cached_path.exists() {
        return Ok(cached_path.to_string_lossy().to_string());
    }

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "TailBurrow/0.3.1 (media proxy)")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Failed to fetch media: HTTP {}", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    fs::write(&cached_path, &bytes).map_err(|e| e.to_string())?;

    Ok(cached_path.to_string_lossy().to_string())
}

fn insert_tags_for_item(conn: &Connection, item_id: i64, tags: &E621Tags) -> Result<(), String> {
    let categories: &[(&[String], &str)] = &[
        (&tags.general, "general"),
        (&tags.species, "species"),
        (&tags.character, "character"),
        (&tags.artist, "artist"),
        (&tags.meta, "meta"),
        (&tags.lore, "lore"),
        (&tags.copyright, "copyright"),
    ];

    for (tag_list, tag_type) in categories {
        for t in *tag_list {
            let id = upsert_tag(conn, t, tag_type)?;
            conn.execute(
                "INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES(?,?)",
                params![item_id, id],
            ).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

fn upsert_tag(conn: &Connection, name: &str, tag_type: &str) -> Result<i64, String> {
  conn.execute(
    "INSERT INTO tags(name, type) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET type=excluded.type",
    params![name, tag_type],
  ).map_err(|e| e.to_string())?;

  let id: i64 = conn.query_row(
    "SELECT tag_id FROM tags WHERE name=?",
    params![name],
    |r: &Row| r.get(0),
  ).map_err(|e| e.to_string())?;

  Ok(id)
}

fn upsert_source(conn: &Connection, url: &str) -> Result<i64, String> {
  conn
    .execute(
      "INSERT INTO sources(url) VALUES(?) ON CONFLICT(url) DO NOTHING",
      params![url],
    )
    .map_err(|e| e.to_string())?;

  let id: i64 = conn
    .query_row(
      "SELECT source_row_id FROM sources WHERE url=?",
      params![url],
      |r: &Row| r.get(0),
    )
    .map_err(|e| e.to_string())?;

  Ok(id)
}


#[tauri::command]
pub fn trash_item(app: tauri::AppHandle, item_id: i64) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    with_db(&app, |conn| {
        conn.execute(
            "UPDATE items SET trashed_at = ? WHERE item_id = ?",
            rusqlite::params![now, item_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub fn auto_clean_trash(app: tauri::AppHandle) {
    let _ = prune_expired_trash(&app);
}

#[tauri::command]
pub fn get_unscanned_e621_ids(app: AppHandle) -> Result<Vec<i64>, String> {
    with_db(&app, |conn| {
        let mut stmt = conn.prepare(
            "SELECT i.source_id FROM items i
             WHERE i.source = 'e621' AND i.trashed_at IS NULL
               AND i.source_id NOT IN (SELECT source_id FROM pool_scan_log)"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([], |row| {
            let s: String = row.get(0)?;
            Ok(s.parse::<i64>().unwrap_or(0))
        }).map_err(|e| e.to_string())?;

        Ok(rows.filter_map(|r| r.ok()).filter(|id| *id > 0).collect())
    })
}

#[tauri::command]
pub fn get_known_pool_ids(app: AppHandle) -> Result<Vec<i64>, String> {
    with_db(&app, |conn| {
        let mut stmt = conn.prepare("SELECT DISTINCT pool_id FROM post_pools")
            .map_err(|e| e.to_string())?;

        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    })
}

#[tauri::command]
pub async fn check_posts_for_pools(app: AppHandle, ids: Vec<i64>) -> Result<Vec<i64>, String> {
    if ids.is_empty() {
        return Ok(vec![]);
    }

    let (username, api_key) = load_e621_creds()?;
    let client = reqwest::Client::new();
    let ids_param = ids.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",");

    let resp = client
        .get("https://e621.net/posts.json")
        .basic_auth(&username, Some(&api_key))
        .header("User-Agent", "TailBurrow/0.3.1 (pools)")
        .query(&[("tags", format!("id:{}", ids_param)), ("limit", "320".to_string())])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Ok(vec![]);
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let posts = json.get("posts").and_then(|p| p.as_array()).cloned().unwrap_or_default();

    let mut pool_ids = std::collections::HashSet::new();

    // ── Persist results in DB ──
    let root = get_root(&app)?;
    let conn = db::open(&library::db_path(&root))?;

    for post in &posts {
        let post_id = post.get("id").and_then(|i| i.as_i64()).unwrap_or(0);
        if post_id == 0 { continue; }

        if let Some(pools) = post.get("pools").and_then(|p| p.as_array()) {
            for pv in pools {
                if let Some(pid) = pv.as_i64() {
                    pool_ids.insert(pid);
                    if let Err(e) = conn.execute(
                        "INSERT OR IGNORE INTO post_pools(source_id, pool_id) VALUES(?,?)",
                        params![post_id.to_string(), pid],
                    ) {
                        eprintln!("[warn] failed to insert post_pool ({}, {}): {}", post_id, pid, e);
                    }
                }
            }
        }
        if let Err(e) = conn.execute(
            "INSERT OR IGNORE INTO pool_scan_log(source_id) VALUES(?)",
            params![post_id.to_string()],
        ) {
            eprintln!("[warn] failed to insert pool_scan_log ({}): {}", post_id, e);
        }
    }

    // Mark ALL requested IDs as scanned (even those not returned / with no pools)
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    Ok(pool_ids.into_iter().collect())
}

#[tauri::command]
pub async fn fetch_pool_infos_batch(_app: AppHandle, pool_ids: Vec<i64>) -> Result<Vec<PoolInfo>, String> {
    if pool_ids.is_empty() {
        return Ok(vec![]);
    }

    let (username, api_key) = load_e621_creds()?;
    let client = reqwest::Client::new();

    let mut result: Vec<PoolInfo> = vec![];

    for chunk in pool_ids.chunks(20) {
        let ids_str = chunk.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",");

        // 1. Fetch pool metadata
        let resp = client
            .get("https://e621.net/pools.json")
            .basic_auth(&username, Some(&api_key))
            .header("User-Agent", "TailBurrow/0.3.1 (pools)")
            .query(&[("search[id]", ids_str.as_str()), ("limit", "20")])
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            continue;
        }

        let pools_json: Vec<serde_json::Value> = resp.json().await.unwrap_or_default();

        let mut batch_pools: Vec<PoolInfo> = Vec::new();
        let mut need_remote: Vec<(usize, i64)> = Vec::new();

        for pj in &pools_json {
            let pool_id = pj.get("id").and_then(|i| i.as_i64()).unwrap_or(0);
            let name = pj.get("name").and_then(|n| n.as_str()).unwrap_or("Unknown").replace('_', " ");
            let post_ids_arr = pj.get("post_ids").and_then(|p| p.as_array()).cloned().unwrap_or_default();
            let post_count = post_ids_arr.len() as i32;

                        let cover_url = String::new();
            let cover_ext = String::new();

            let idx = batch_pools.len();

            // Always fetch cover from e621 API
            if let Some(first_id) = post_ids_arr.first().and_then(|v| v.as_i64()).filter(|id| *id > 0) {
                need_remote.push((idx, first_id));
            }

            batch_pools.push(PoolInfo { pool_id, name, post_count, cover_url, cover_ext });
        }

        // 2. Batch-fetch remote covers
        if !need_remote.is_empty() {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            let cover_ids = need_remote.iter().map(|(_, pid)| pid.to_string()).collect::<Vec<_>>().join(",");

            let cover_resp = client
                .get("https://e621.net/posts.json")
                .basic_auth(&username, Some(&api_key))
                .header("User-Agent", "TailBurrow/0.3.1 (pools)")
                .query(&[("tags", format!("id:{}", cover_ids)), ("limit", "320".to_string())])
                .send()
                .await;

            if let Ok(resp) = cover_resp {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    let posts = json.get("posts").and_then(|p| p.as_array()).cloned().unwrap_or_default();

                    let post_map: std::collections::HashMap<i64, &serde_json::Value> = posts.iter()
                        .filter_map(|p| p.get("id").and_then(|i| i.as_i64()).map(|id| (id, p)))
                        .collect();

                    for (pool_idx, post_id) in &need_remote {
                        if let Some(post) = post_map.get(post_id) {
                            let file_ext = post.get("file").and_then(|f| f.get("ext")).and_then(|e| e.as_str()).unwrap_or("jpg");
                            let is_video = file_ext == "mp4" || file_ext == "webm";

                            let (url, cover_ext) = if is_video {
                                // For video posts, always use preview image as cover
                                let u = post.get("preview").and_then(|p| p.get("url")).and_then(|u| u.as_str())
                                    .or_else(|| post.get("sample").and_then(|s| s.get("url")).and_then(|u| u.as_str()))
                                    .unwrap_or("");
                                (u, "jpg")
                            } else {
                                let u = post.get("sample").and_then(|s| s.get("url")).and_then(|u| u.as_str())
                                    .or_else(|| post.get("preview").and_then(|p| p.get("url")).and_then(|u| u.as_str()))
                                    .or_else(|| post.get("file").and_then(|f| f.get("url")).and_then(|u| u.as_str()))
                                    .unwrap_or("");
                                (u, file_ext)
                            };

                            if !url.is_empty() {
                                batch_pools[*pool_idx].cover_url = url.to_string();
                                batch_pools[*pool_idx].cover_ext = cover_ext.to_string();
                            }
                        }
                    }
                }
            }
        }

        result.extend(batch_pools);
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }

    Ok(result)
}

#[tauri::command]
pub async fn get_pool_posts(app: AppHandle, pool_id: i64) -> Result<Vec<PoolPost>, String> {
    let (username, api_key) = load_e621_creds()?;
    let root = get_root(&app)?;

    let client = reqwest::Client::new();

    // Fetch pool info from e621
    let resp = client
        .get(format!("https://e621.net/pools/{}.json", pool_id))
        .basic_auth(&username, Some(&api_key))
        .header("User-Agent", "TailBurrow/0.2.5 (pools)")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Failed to fetch pool: HTTP {}", resp.status()));
    }

    let pool_json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let post_ids = pool_json.get("post_ids").and_then(|p| p.as_array()).cloned().unwrap_or_default();

    let conn = db::open(&library::db_path(&root))?;
    let mut posts: Vec<PoolPost> = vec![];

    // Fetch missing posts in batches of 100 from e621
    let mut missing_ids = vec![];
    let mut local_map = std::collections::HashMap::new();

    for post_id_val in &post_ids {
        let post_id = post_id_val.as_i64().unwrap_or(0);
        if post_id == 0 { continue; }

        let local: Option<(i64, String, String)> = conn.query_row(
            "SELECT item_id, file_rel, COALESCE(ext, '') FROM items WHERE source = 'e621' AND source_id = ? AND trashed_at IS NULL",
            params![post_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        ).ok();

        if let Some((item_id, file_rel, ext)) = local {
            local_map.insert(post_id, (item_id, root.join(&file_rel).to_string_lossy().to_string(), ext));
        } else {
            missing_ids.push(post_id);
        }
    }

    let mut remote_map = std::collections::HashMap::new();
    
    for chunk in missing_ids.chunks(100) {
        let ids_param = chunk.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",");
        
        let resp = client
            .get("https://e621.net/posts.json")
            .basic_auth(&username, Some(&api_key))
            .header("User-Agent", "TailBurrow/0.2.5 (pools)")
            .query(&[("tags", format!("id:{}", ids_param)), ("limit", "100".to_string())])
            .send()
            .await;

        if let Ok(resp) = resp {
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    let remote_posts = json.get("posts").and_then(|p| p.as_array()).cloned().unwrap_or_default();
                    for rp in remote_posts {
                        let id = rp.get("id").and_then(|i| i.as_i64()).unwrap_or(0);
                        let ext = rp.get("file").and_then(|f| f.get("ext")).and_then(|e| e.as_str()).unwrap_or("jpg").to_string();
                        let is_video = ext == "mp4" || ext == "webm";

                        let url = if is_video {
                            // For videos, prefer file URL (sample may be null)
                            rp.get("file").and_then(|f| f.get("url")).and_then(|u| u.as_str())
                                .or_else(|| rp.get("sample").and_then(|s| s.get("url")).and_then(|u| u.as_str()))
                                .unwrap_or("").to_string()
                        } else {
                            rp.get("sample").and_then(|s| s.get("url")).and_then(|u| u.as_str())
                                .or_else(|| rp.get("file").and_then(|f| f.get("url")).and_then(|u| u.as_str()))
                                .or_else(|| rp.get("preview").and_then(|p| p.get("url")).and_then(|u| u.as_str()))
                                .unwrap_or("").to_string()
                        };
                        
                        if id > 0 && !url.is_empty() {
                            remote_map.insert(id, (url, ext));
                        }
                    }
                }
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }

    // Assemble final list in correct pool order
    for (position, post_id_val) in post_ids.iter().enumerate() {
        let post_id = post_id_val.as_i64().unwrap_or(0);
        if post_id == 0 { continue; }

        if let Some((item_id, file_abs, ext)) = local_map.get(&post_id) {
            posts.push(PoolPost {
                item_id: *item_id,
                source_id: post_id.to_string(),
                file_abs: file_abs.clone(),
                ext: ext.clone(),
                position: position as i32,
            });
        } else if let Some((url, ext)) = remote_map.get(&post_id) {
            posts.push(PoolPost {
                item_id: 0, // 0 indicates it's not downloaded
                source_id: post_id.to_string(),
                file_abs: url.clone(), // We reuse file_abs to store the remote URL
                ext: ext.clone(),
                position: position as i32,
            });
        }
    }

    Ok(posts)
}

#[tauri::command]
pub fn save_pools_cache(app: AppHandle, pools: Vec<PoolInfo>) -> Result<(), String> {
    let root = get_root(&app)?;
    let cache_dir = root.join(".cache");
    if !cache_dir.exists() {
        std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    }
    
    let cache_file = cache_dir.join("pools_cache.json");
    let json = serde_json::to_string(&pools).map_err(|e| e.to_string())?;
    std::fs::write(cache_file, json).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
pub fn load_pools_cache(app: AppHandle) -> Result<Vec<PoolInfo>, String> {
    let root = get_root(&app)?;
    let cache_file = root.join(".cache").join("pools_cache.json");
    
    if !cache_file.exists() {
        return Ok(vec![]);
    }
    
    let json = std::fs::read_to_string(cache_file).map_err(|e| e.to_string())?;
    let pools: Vec<PoolInfo> = serde_json::from_str(&json).unwrap_or_default();
    
    Ok(pools)
}

#[tauri::command]
pub fn clear_pools_cache(app: AppHandle) -> Result<(), String> {
    let root = get_root(&app)?;
    let cache_file = root.join(".cache").join("pools_cache.json");
    
    if cache_file.exists() {
        std::fs::remove_file(cache_file).map_err(|e| e.to_string())?;
    }
    
    Ok(())
}

fn hash_pin(pin: &str, prefix: &str) -> String {
    let salt: [u8; 16] = rand::random();
    let salted = format!("{}:{}:{}", prefix, hex::encode(salt), pin);
    let hash = Sha256::digest(salted.as_bytes());
    format!("{}${}", hex::encode(salt), hex::encode(hash))
}

fn verify_pin_hash(pin: &str, prefix: &str, stored: &str) -> bool {
    // Support legacy MD5 hashes during migration
    if !stored.contains('$') {
        let legacy_salted = format!("{}_{}", prefix, pin);
        let legacy_hash = format!("{:x}", md5::compute(legacy_salted.as_bytes()));
        return legacy_hash == stored;
    }

    let parts: Vec<&str> = stored.splitn(2, '$').collect();
    if parts.len() != 2 { return false; }
    let salted = format!("{}:{}:{}", prefix, parts[0], pin);
    let hash = Sha256::digest(salted.as_bytes());
    format!("{}${}", parts[0], hex::encode(hash)) == stored
}

#[tauri::command]
pub fn has_app_lock() -> Result<bool, String> {
    Ok(crate::secrets::get_secret("app_lock_hash")?.is_some())
}

#[tauri::command]
pub fn set_app_lock(pin: String) -> Result<(), String> {
    let pin = pin.trim();
    if pin.len() < 4 {
        return Err("PIN must be at least 4 characters".into());
    }
    let hash = hash_pin(pin, "tailburrow_lock");
    crate::secrets::set_secret("app_lock_hash", &hash)?;
    Ok(())
}

#[tauri::command]
pub fn verify_app_lock(pin: String) -> Result<bool, String> {
    let stored = match crate::secrets::get_secret("app_lock_hash")? {
        Some(h) => h,
        None => return Ok(true),
    };
    Ok(verify_pin_hash(pin.trim(), "tailburrow_lock", &stored))
}

#[tauri::command]
pub fn clear_app_lock(pin: String) -> Result<(), String> {
    let stored = crate::secrets::get_secret("app_lock_hash")?
        .ok_or("No lock configured")?;
    if !verify_pin_hash(pin.trim(), "tailburrow_lock", &stored) {
        return Err("Incorrect PIN".into());
    }
    crate::secrets::delete_secret("app_lock_hash")?;
    Ok(())
}

#[tauri::command]
pub fn set_safe_pin(pin: String) -> Result<(), String> {
    let pin = pin.trim();
    if pin.len() < 4 {
        return Err("PIN must be at least 4 characters".into());
    }
    let hash = hash_pin(pin, "tailburrow_safe");
    crate::secrets::set_secret("app_safe_hash", &hash)?;
    Ok(())
}

#[tauri::command]
pub fn has_safe_pin() -> Result<bool, String> {
    Ok(crate::secrets::get_secret("app_safe_hash")?.is_some())
}

#[tauri::command]
pub fn verify_safe_pin(pin: String) -> Result<bool, String> {
    let stored = match crate::secrets::get_secret("app_safe_hash")? {
        Some(h) => h,
        None => return Ok(false),
    };
    Ok(verify_pin_hash(pin.trim(), "tailburrow_safe", &stored))
}

#[tauri::command]
pub fn clear_safe_pin(pin: String) -> Result<(), String> {
    let stored = crate::secrets::get_secret("app_safe_hash")?
        .ok_or("No safe PIN configured")?;
    if !verify_pin_hash(pin.trim(), "tailburrow_safe", &stored) {
        return Err("Incorrect PIN".into());
    }
    crate::secrets::delete_secret("app_safe_hash")?;
    Ok(())
}

#[tauri::command]
pub async fn import_local_files(
    app: AppHandle,
    file_paths: Vec<String>,
    tags: Vec<String>,
    rating: String,
    sources: Vec<String>,
) -> Result<usize, String> {
    let root = get_root(&app)?;
    library::ensure_layout(&root)?;

    let media_dir = root.join("media");
    let r = match rating.to_lowercase().as_str() {
        "s" | "q" | "e" => rating.to_lowercase(),
        _ => "s".to_string(),
    };

    let mut imported: usize = 0;

    for file_path in &file_paths {
        let src_path = PathBuf::from(file_path);
        if !src_path.exists() {
            continue;
        }

        // ── Read file bytes & compute MD5 ──
        let file_bytes = fs::read(&src_path)
            .map_err(|e| format!("Failed to read {}: {}", file_path, e))?;
        let md5_hash = format!("{:x}", md5::compute(&file_bytes));

        // ── Extension ──
        let ext = src_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_else(|| "bin".to_string());

        // ── Dedup by MD5 ──
        {
            let dedup_conn = db::open(&library::db_path(&root))?;
            db::init_schema(&dedup_conn)?;

            let md5_exists: i64 = dedup_conn
                .query_row(
                    "SELECT COUNT(*) FROM items WHERE md5 = ? AND trashed_at IS NULL",
                    params![md5_hash],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;

            if md5_exists > 0 {
                continue;
            }
        }

        // ── Use MD5 as source_id (content-addressed) ──
        let source_id = md5_hash.clone();

        // ── Build destination path ──
        let base_filename = format!("local_{}.{}", &source_id[..12], ext);
        let mut filename = base_filename.clone();
        let mut dest_path = media_dir.join(&filename);

        let mut n = 1u32;
        while dest_path.exists() {
            filename = format!("local_{}_dup{}.{}", &source_id[..12], n, ext);
            dest_path = media_dir.join(&filename);
            n += 1;
        }

        // ── Copy file into library ──
        fs::write(&dest_path, &file_bytes)
            .map_err(|e| format!("Failed to write {}: {}", dest_path.display(), e))?;

        // ── Generate thumbnail ──
        let file_rel = format!("media/{}", filename);
        generate_and_save_thumb(&root, &file_rel);

        // ── DB insert (with cleanup on failure) ──
        let cleanup_path = dest_path.clone();
        let db_result = (|| -> Result<(), String> {
            let added_at = Utc::now().to_rfc3339();

            let mut conn = db::open(&library::db_path(&root))?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;

            tx.execute(
                r#"
                INSERT INTO items(
                    source, source_id, md5, remote_url, file_rel, ext,
                    rating, fav_count, score_total, created_at, added_at, primary_artist
                )
                VALUES('local', ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, 'local')
                "#,
                params![
                    source_id,
                    md5_hash,
                    file_rel,
                    ext,
                    r,
                    added_at,
                    added_at,
                ],
            )
            .map_err(|e| e.to_string())?;

            let item_id = tx.last_insert_rowid();

            // Insert tags (all as "general" type)
            let import_tags = E621Tags {
                general: tags.iter().map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()).collect(),
                species: vec![],
                character: vec![],
                artist: vec![],
                meta: vec![],
                lore: vec![],
                copyright: vec![],
            };
            insert_tags_for_item(&tx, item_id, &import_tags)?;

            // Insert sources
            for url in &sources {
                let trimmed = url.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let sid = upsert_source(&tx, trimmed)?;
                tx.execute(
                    "INSERT OR IGNORE INTO item_sources(item_id, source_row_id) VALUES(?, ?)",
                    params![item_id, sid],
                )
                .map_err(|e| e.to_string())?;
            }

            tx.commit().map_err(|e| e.to_string())?;
            Ok(())
        })();

        if let Err(e) = db_result {
            let _ = fs::remove_file(&cleanup_path);
            return Err(format!("Failed to import {}: {}", file_path, e));
        }

        imported += 1;
    }

    Ok(imported)
}

// Prune items trashed more than 30 days ago
pub fn prune_expired_trash(app: &tauri::AppHandle) -> Result<(), String> {
    let root = match get_root(app) {
        Ok(r) => r,
        Err(_) => return Ok(()), // No library loaded yet
    };
    
    let conn = db::open(&library::db_path(&root)).map_err(|e| e.to_string())?;

    // 1. Find expired files
    // SQL: Select items trashed > 30 days ago
    // We use SQLite's datetime functions. 
    // 'now' is UTC. 'trashed_at' is stored as ISO8601 string.
    let mut stmt = conn.prepare(
        "SELECT file_rel FROM items WHERE trashed_at < datetime('now', '-30 days') AND trashed_at IS NOT NULL"
    ).map_err(|e| e.to_string())?;

    let files_to_delete: Vec<String> = stmt.query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    // 2. Delete files from disk
    for rel_path in files_to_delete {
        let abs_path = root.join(rel_path);
        if abs_path.exists() {
            let _ = std::fs::remove_file(abs_path);
        }
    }

    // 3. Delete rows from DB
    conn.execute(
        "DELETE FROM items WHERE trashed_at < datetime('now', '-30 days') AND trashed_at IS NOT NULL",
        []
    ).map_err(|e| e.to_string())?;

    Ok(())
}

// ── Find Duplicates (synchronous) ─────────────────────────────

#[tauri::command]
pub fn maintenance_find_duplicates(app: AppHandle) -> Result<Vec<DuplicateGroup>, String> {
    with_db(&app, |conn| {
        let mut stmt = conn.prepare(
            "SELECT md5 FROM items \
             WHERE md5 IS NOT NULL AND md5 != '' AND trashed_at IS NULL \
             GROUP BY md5 HAVING COUNT(*) > 1"
        ).map_err(|e| e.to_string())?;

        let md5s: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let mut groups = Vec::new();

        for md5 in &md5s {
            let mut item_stmt = conn.prepare(
                "SELECT item_id, source, source_id, file_rel, COALESCE(ext, '') \
                 FROM items WHERE md5 = ? AND trashed_at IS NULL \
                 ORDER BY CASE source \
                   WHEN 'e621' THEN 0 \
                   WHEN 'furaffinity' THEN 1 \
                   ELSE 2 END, \
                 added_at ASC"
            ).map_err(|e| e.to_string())?;

            let items: Vec<DuplicateItem> = item_stmt
                .query_map(params![md5], |row| {
                    Ok(DuplicateItem {
                        item_id: row.get(0)?,
                        source: row.get(1)?,
                        source_id: row.get(2)?,
                        file_rel: row.get(3)?,
                        ext: row.get(4)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();

            if items.len() > 1 {
                groups.push(DuplicateGroup { md5: md5.clone(), items });
            }
        }

        Ok(groups)
    })
}

// ── Deleted Check ─────────────────────────────────────────────

#[tauri::command]
pub fn maintenance_deleted_check_status(
    state: tauri::State<'_, Arc<MaintenanceState>>,
) -> Result<MaintenanceProgress, String> {
    Ok(state.deleted_check.lock().map_err(|_| "Lock poisoned")?.clone())
}

#[tauri::command]
pub fn maintenance_start_deleted_check(
    app: AppHandle,
    state: tauri::State<'_, Arc<MaintenanceState>>,
) -> Result<(), String> {
    {
        let mut st = state.deleted_check.lock().map_err(|_| "Lock poisoned")?;
        if st.running { return Err("Already running".into()); }
        *st = MaintenanceProgress { running: true, current: 0, total: 0, message: "Starting...".into() };
    }
    {
        let mut res = state.deleted_results.lock().map_err(|_| "Lock poisoned")?;
        res.clear();
    }

    let state2 = state.inner().clone();
    let app2 = app.clone();

    std::thread::spawn(move || {
        let result: Result<(), String> = (|| {
            let root = get_root(&app2)?;
            let conn = db::open(&library::db_path(&root))?;
            let (username, api_key) = load_e621_creds()?;
            let client = reqwest::blocking::Client::new();

            // ── Phase 1: Collect all deleted favorites from e621 ──
            let tags = format!("fav:{} status:deleted", username);
            let mut page = 1u32;
            let mut deleted_e621_ids: Vec<i64> = Vec::new();

            {
                let mut st = state2.deleted_check.lock().map_err(|_| "Lock poisoned")?;
                st.message = "Fetching deleted favorites from e621...".into();
            }

            loop {
                let resp = client
                    .get("https://e621.net/posts.json")
                    .basic_auth(&username, Some(&api_key))
                    .header("User-Agent", "TailBurrow/0.3.1 (maintenance)")
                    .query(&[
                        ("tags", tags.as_str()),
                        ("limit", "320"),
                        ("page", &page.to_string()),
                    ])
                    .send()
                    .map_err(|e| e.to_string())?;

                if !resp.status().is_success() {
                    return Err(format!("e621 API error: HTTP {}", resp.status()));
                }

                let json: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
                let posts = json.get("posts")
                    .and_then(|p| p.as_array())
                    .cloned()
                    .unwrap_or_default();

                if posts.is_empty() { break; }

                for post in &posts {
                    if let Some(id) = post.get("id").and_then(|i| i.as_i64()) {
                        deleted_e621_ids.push(id);
                    }
                }

                {
                    let mut st = state2.deleted_check.lock().map_err(|_| "Lock poisoned")?;
                    st.message = format!("Scanned {} pages, {} deleted favorites so far...", page, deleted_e621_ids.len());
                }

                if posts.len() < 320 { break; }
                page += 1;
                std::thread::sleep(std::time::Duration::from_millis(500));
            }

            // ── Phase 2: Cross-reference with local library ──
            let mut in_library: Vec<(i64, i64)> = Vec::new(); // (post_id, item_id)

            for &post_id in &deleted_e621_ids {
                let item_id: Option<i64> = conn.query_row(
                    "SELECT item_id FROM items WHERE source='e621' AND source_id=? AND trashed_at IS NULL",
                    params![post_id.to_string()],
                    |r| r.get(0),
                ).ok();

                if let Some(id) = item_id {
                    in_library.push((post_id, id));
                }
            }

            let total = in_library.len() as u32;
            {
                let mut st = state2.deleted_check.lock().map_err(|_| "Lock poisoned")?;
                st.total = total;
                st.message = format!(
                    "Found {} deleted favorites, {} in library. Fetching reasons...",
                    deleted_e621_ids.len(), total
                );
            }

            // ── Phase 3: Fetch deletion reasons via HTML & auto-tag ──
            let deleted_tag_id = upsert_tag(&conn, "deleted_on_e621", "meta")?;
            let mut results: Vec<DeletedPostInfo> = Vec::new();
            let mut checked = 0u32;
            let mut category_counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();

            for (post_id, item_id) in &in_library {
                checked += 1;

                // Fetch HTML page — explicitly request HTML, no auth (avoids JSON redirect)
                let reason = match client
                    .get(format!("https://e621.net/posts/{}", post_id))
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TailBurrow/0.3.1")
                    .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                    .send()
                {
                    Ok(resp) => {
                        let content_type = resp.headers()
                            .get("content-type")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_lowercase();

                        if resp.status().is_success() {
                            match resp.text() {
                                Ok(body) => {
                                    if content_type.contains("json") {
                                        // Got JSON instead of HTML — try to parse
                                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                                            json.get("post")
                                                .and_then(|p| p.get("flags"))
                                                .and_then(|f| f.get("reason"))
                                                .and_then(|r| r.as_str())
                                                .map(|s| s.to_string())
                                                .unwrap_or_else(|| "Unknown reason (JSON response)".to_string())
                                        } else {
                                            "Unknown reason (parse error)".to_string()
                                        }
                                    } else {
                                        extract_deletion_reason(&body)
                                    }
                                }
                                Err(_) => "Unknown reason (read error)".to_string(),
                            }
                        } else {
                            format!("Unknown reason (HTTP {})", resp.status())
                        }
                    }
                    Err(e) => format!("Unknown reason ({})", e),
                };

                let category = categorize_deletion_reason(&reason);

                // Always apply deleted_on_e621
                conn.execute(
                    "INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES(?,?)",
                    params![item_id, deleted_tag_id],
                ).ok();

                // Apply category-specific tag if different
                if category != "deleted_on_e621" {
                    let cat_tag_id = upsert_tag(&conn, category, "meta")?;
                    conn.execute(
                        "INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES(?,?)",
                        params![item_id, cat_tag_id],
                    ).ok();
                }

                *category_counts.entry(category.to_string()).or_insert(0) += 1;

                results.push(DeletedPostInfo {
                    post_id: *post_id,
                    item_id: *item_id,
                    reason: reason.clone(),
                    tag_applied: category.to_string(),
                });

                {
                    let mut st = state2.deleted_check.lock().map_err(|_| "Lock poisoned")?;
                    st.current = checked;
                    st.message = format!("Fetching reasons: {}/{} — {}", checked, total, reason.chars().take(60).collect::<String>());
                }

                // Rate limit — be gentle with HTML pages
                std::thread::sleep(std::time::Duration::from_millis(700));
            }

            // Store results
            {
                let mut res = state2.deleted_results.lock().map_err(|_| "Lock poisoned")?;
                *res = results;
            }

            // Build summary
            let ai = category_counts.get("ai_generated").copied().unwrap_or(0);
            let artist = category_counts.get("artist_requested_deletion").copied().unwrap_or(0);
            let paysite = category_counts.get("paysite_content").copied().unwrap_or(0);
            let inferior = category_counts.get("inferior_version").copied().unwrap_or(0);
            let other = category_counts.get("deleted_on_e621").copied().unwrap_or(0);

            {
                let mut st = state2.deleted_check.lock().map_err(|_| "Lock poisoned")?;
                st.running = false;
                st.current = total;
                st.total = deleted_e621_ids.len() as u32;

                let mut parts = vec![
                    format!("{} deleted on e621, {} in library", deleted_e621_ids.len(), in_library.len()),
                ];
                if ai > 0 { parts.push(format!("AI: {}", ai)); }
                if artist > 0 { parts.push(format!("Artist request: {}", artist)); }
                if paysite > 0 { parts.push(format!("Paysite: {}", paysite)); }
                if inferior > 0 { parts.push(format!("Inferior/duplicate: {}", inferior)); }
                if other > 0 { parts.push(format!("Other: {}", other)); }

                st.message = parts.join(" • ");
            }

            Ok(())
        })();

        if let Err(e) = result {
            if let Ok(mut st) = state2.deleted_check.lock() {
                st.running = false;
                st.message = format!("Error: {}", e);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn maintenance_get_deleted_results(
    state: tauri::State<'_, Arc<MaintenanceState>>,
) -> Result<Vec<DeletedPostInfo>, String> {
    let res = state.deleted_results.lock().map_err(|_| "Lock poisoned")?;
    Ok(res.clone())
}

#[tauri::command]
pub async fn e621_unfavorite(post_id: i64) -> Result<Status, String> {
    let (username, api_key) = load_e621_creds()?;

    let client = reqwest::Client::new();
    let resp = client
        .delete(format!("https://e621.net/favorites/{}.json", post_id))
        .basic_auth(username, Some(api_key))
        .header("User-Agent", "TailBurrow/0.3.1 (maintenance)")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    // 204 = success, 404 = already not favorited
    if !resp.status().is_success() && resp.status().as_u16() != 404 {
        return Err(format!("Unfavorite failed: HTTP {}", resp.status()));
    }

    Ok(Status { ok: true, message: "Unfavorited".into() })
}

// ── Metadata Update ───────────────────────────────────────────

#[tauri::command]
pub fn maintenance_metadata_update_status(
    state: tauri::State<'_, Arc<MaintenanceState>>,
) -> Result<MaintenanceProgress, String> {
    Ok(state.metadata_update.lock().map_err(|_| "Lock poisoned")?.clone())
}

#[tauri::command]
pub fn maintenance_start_metadata_update(
    app: AppHandle,
    state: tauri::State<'_, Arc<MaintenanceState>>,
) -> Result<(), String> {
    {
        let mut st = state.metadata_update.lock().map_err(|_| "Lock poisoned")?;
        if st.running { return Err("Already running".into()); }
        *st = MaintenanceProgress { running: true, current: 0, total: 0, message: "Starting...".into() };
    }

    let state2 = state.inner().clone();
    let app2 = app.clone();

    std::thread::spawn(move || {
        let result: Result<(), String> = (|| {
            let root = get_root(&app2)?;
            let mut conn = db::open(&library::db_path(&root))?;
            conn.busy_timeout(std::time::Duration::from_secs(30)).map_err(|e| e.to_string())?;

            // Collect (item_id, source_id) pairs — scope the statement borrow
            let all_items: Vec<(i64, i64)> = {
                let mut stmt = conn.prepare(
                    "SELECT item_id, source_id FROM items WHERE source = 'e621' AND trashed_at IS NULL"
                ).map_err(|e| e.to_string())?;

                let result = stmt.query_map([], |row| {
                        let item_id: i64 = row.get(0)?;
                        let sid: String = row.get(1)?;
                        Ok((item_id, sid.parse::<i64>().unwrap_or(0)))
                    })
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .filter(|(_, sid)| *sid > 0)
                    .collect();
                result
            };

            let total = all_items.len() as u32;
            {
                let mut st = state2.metadata_update.lock().map_err(|_| "Lock poisoned")?;
                st.total = total;
                st.message = format!("Updating {} posts...", total);
            }

            if total == 0 {
                let mut st = state2.metadata_update.lock().map_err(|_| "Lock poisoned")?;
                st.running = false;
                st.message = "No e621 posts to update.".into();
                return Ok(());
            }

            let (username, api_key) = load_e621_creds()?;
            let client = reqwest::blocking::Client::new();
            let mut updated = 0u32;
            let mut checked = 0u32;
            let mut errors = 0u32;

            // Build a lookup: e621_source_id → item_id
            let id_map: std::collections::HashMap<i64, i64> = all_items.iter()
                .map(|(item_id, sid)| (*sid, *item_id))
                .collect();

            let source_ids: Vec<i64> = all_items.iter().map(|(_, sid)| *sid).collect();

            for chunk in source_ids.chunks(100) {
                let ids_str = chunk.iter()
                    .map(|id| id.to_string())
                    .collect::<Vec<_>>()
                    .join(",");

                let resp = client
                    .get("https://e621.net/posts.json")
                    .basic_auth(&username, Some(&api_key))
                    .header("User-Agent", "TailBurrow/0.3.1 (maintenance)")
                    .query(&[
                        ("tags", format!("id:{}", ids_str)),
                        ("limit", "320".to_string()),
                    ])
                    .send();

                match resp {
                    Ok(r) if r.status().is_success() => {
                        if let Ok(json) = r.json::<serde_json::Value>() {
                            let posts = json.get("posts")
                                .and_then(|p| p.as_array())
                                .cloned()
                                .unwrap_or_default();

                            let tx = conn.transaction().map_err(|e| e.to_string())?;

                            for post in &posts {
                                let post_id = post.get("id").and_then(|i| i.as_i64()).unwrap_or(0);
                                let item_id = match id_map.get(&post_id) {
                                    Some(id) => *id,
                                    None => continue,
                                };

                                let score_total = post.get("score")
                                    .and_then(|s| s.get("total"))
                                    .and_then(|t| t.as_i64());
                                let fav_count = post.get("fav_count").and_then(|f| f.as_i64());
                                let rating = post.get("rating")
                                    .and_then(|r| r.as_str())
                                    .map(|s| s.to_string());

                                // Update item fields
                                tx.execute(
                                    "UPDATE items SET score_total=?, fav_count=?, rating=? WHERE item_id=?",
                                    params![score_total, fav_count, rating, item_id],
                                ).ok();

                                // Parse tags
                                let tags_obj = post.get("tags").cloned()
                                    .unwrap_or(serde_json::Value::Null);

                                let vec_from = |k: &str| -> Vec<String> {
                                    tags_obj.get(k)
                                        .and_then(|v| v.as_array())
                                        .map(|a| a.iter()
                                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                            .collect())
                                        .unwrap_or_default()
                                };

                                let tags = E621Tags {
                                    general: vec_from("general"),
                                    species: vec_from("species"),
                                    character: vec_from("character"),
                                    artist: vec_from("artist"),
                                    meta: vec_from("meta"),
                                    lore: vec_from("lore"),
                                    copyright: vec_from("copyright"),
                                };

                                // Replace tags
                                tx.execute("DELETE FROM item_tags WHERE item_id=?", [item_id]).ok();
                                if let Err(e) = insert_tags_for_item(&tx, item_id, &tags) {
                                    eprintln!("[maintenance] tag insert error for {}: {}", post_id, e);
                                    errors += 1;
                                    continue;
                                }

                                // Update primary artist
                                let primary_artist = sanitize_slug(&pick_primary_artist(&tags.artist));
                                tx.execute(
                                    "UPDATE items SET primary_artist=? WHERE item_id=?",
                                    params![primary_artist, item_id],
                                ).ok();

                                // Update sources
                                let sources: Vec<String> = post.get("sources")
                                    .and_then(|s| s.as_array())
                                    .map(|arr| arr.iter()
                                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                        .collect())
                                    .unwrap_or_default();

                                tx.execute("DELETE FROM item_sources WHERE item_id=?", [item_id]).ok();
                                for url in &sources {
                                    if let Ok(sid) = upsert_source(&tx, url) {
                                        tx.execute(
                                            "INSERT OR IGNORE INTO item_sources(item_id, source_row_id) VALUES(?,?)",
                                            params![item_id, sid],
                                        ).ok();
                                    }
                                }

                                updated += 1;
                            }

                            tx.commit().map_err(|e| e.to_string())?;
                        }
                    }
                    _ => {
                        errors += chunk.len() as u32;
                    }
                }

                checked += chunk.len() as u32;
                {
                    let mut st = state2.metadata_update.lock().map_err(|_| "Lock poisoned")?;
                    st.current = checked;
                    st.message = format!("Updated {}/{}...", updated, total);
                }

                std::thread::sleep(std::time::Duration::from_millis(500));
            }

            {
                let mut st = state2.metadata_update.lock().map_err(|_| "Lock poisoned")?;
                st.running = false;
                st.current = total;
                st.message = format!(
                    "Done. Updated {} of {} posts.{}",
                    updated, total,
                    if errors > 0 { format!(" {} errors.", errors) } else { String::new() }
                );
            }

            Ok(())
        })();

        if let Err(e) = result {
            if let Ok(mut st) = state2.metadata_update.lock() {
                st.running = false;
                st.message = format!("Error: {}", e);
            }
        }
    });

    Ok(())
}

// ── FA → e621 Upgrade ─────────────────────────────────────────

#[tauri::command]
pub fn maintenance_fa_upgrade_status(
    state: tauri::State<'_, Arc<MaintenanceState>>,
) -> Result<MaintenanceProgress, String> {
    Ok(state.fa_upgrade.lock().map_err(|_| "Lock poisoned")?.clone())
}

#[tauri::command]
pub fn maintenance_start_fa_upgrade(
    app: AppHandle,
    state: tauri::State<'_, Arc<MaintenanceState>>,
) -> Result<(), String> {
    {
        let mut st = state.fa_upgrade.lock().map_err(|_| "Lock poisoned")?;
        if st.running { return Err("Already running".into()); }
        *st = MaintenanceProgress { running: true, current: 0, total: 0, message: "Starting...".into() };
    }

    let state2 = state.inner().clone();
    let app2 = app.clone();

    std::thread::spawn(move || {
        let result: Result<(), String> = (|| {
            let root = get_root(&app2)?;
            let conn = db::open(&library::db_path(&root))?;

            // 1. Collect all FA items with MD5
            let mut stmt = conn.prepare(
                "SELECT item_id, source_id, md5 FROM items \
                 WHERE source = 'furaffinity' AND md5 IS NOT NULL AND md5 != '' \
                 AND trashed_at IS NULL"
            ).map_err(|e| e.to_string())?;

            let fa_items: Vec<(i64, String, String)> = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();

            let total = fa_items.len() as u32;
            {
                let mut st = state2.fa_upgrade.lock().map_err(|_| "Lock poisoned")?;
                st.total = total;
                st.message = format!("Checking {} FA posts...", total);
            }

            if total == 0 {
                let mut st = state2.fa_upgrade.lock().map_err(|_| "Lock poisoned")?;
                st.running = false;
                st.message = "No FurAffinity posts to upgrade.".into();
                return Ok(());
            }

            // 2. Collect known e621 MD5s for local fast-path
            let mut e621_stmt = conn.prepare(
                "SELECT md5 FROM items WHERE source = 'e621' AND md5 IS NOT NULL AND md5 != '' AND trashed_at IS NULL"
            ).map_err(|e| e.to_string())?;

            let known_e621_md5s: std::collections::HashSet<String> = e621_stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();

            let (username, api_key) = load_e621_creds()?;
            let client = reqwest::blocking::Client::new();
            let now = chrono::Local::now().to_rfc3339();
            let mut upgraded = 0u32;
            let mut skipped = 0u32;
            let mut errors = 0u32;
            let mut checked = 0u32;

            for (item_id, _fa_source_id, md5) in &fa_items {
                checked += 1;

                // Fast path: already have this MD5 as e621 item locally
                if known_e621_md5s.contains(md5) {
                    conn.execute(
                        "UPDATE items SET trashed_at = ? WHERE item_id = ?",
                        params![now, item_id],
                    ).ok();
                    upgraded += 1;

                    let mut st = state2.fa_upgrade.lock().map_err(|_| "Lock poisoned")?;
                    st.current = checked;
                    st.message = format!(
                        "Checked {}/{}... {} upgraded, {} skipped",
                        checked, total, upgraded, skipped
                    );
                    continue;
                }

                // Slow path: query e621 API by MD5
                let resp = client
                    .get("https://e621.net/posts.json")
                    .basic_auth(&username, Some(&api_key))
                    .header("User-Agent", "TailBurrow/0.3.1 (maintenance)")
                    .query(&[
                        ("tags", format!("md5:{}", md5)),
                        ("limit", "1".to_string()),
                    ])
                    .send();

                match resp {
                    Ok(r) if r.status().is_success() => {
                        if let Ok(json) = r.json::<serde_json::Value>() {
                            let posts = json.get("posts")
                                .and_then(|p| p.as_array())
                                .cloned()
                                .unwrap_or_default();

                            if let Some(e621_post) = posts.first() {
                                let e6_id = e621_post.get("id")
                                    .and_then(|i| i.as_i64())
                                    .unwrap_or(0);
                                let file_url = e621_post.get("file")
                                    .and_then(|f| f.get("url"))
                                    .and_then(|u| u.as_str())
                                    .map(|s| s.to_string());
                                let file_ext = e621_post.get("file")
                                    .and_then(|f| f.get("ext"))
                                    .and_then(|e| e.as_str())
                                    .unwrap_or("jpg")
                                    .to_string();
                                let file_md5 = e621_post.get("file")
                                    .and_then(|f| f.get("md5"))
                                    .and_then(|m| m.as_str())
                                    .map(|s| s.to_string());

                                if e6_id > 0 {
                                    if let Some(ref url) = file_url {
                                        // Trash FA item first (so MD5 dedup doesn't block)
                                        conn.execute(
                                            "UPDATE items SET trashed_at = ? WHERE item_id = ?",
                                            params![now, item_id],
                                        ).ok();

                                        let tags_obj = e621_post.get("tags").cloned()
                                            .unwrap_or(serde_json::Value::Null);
                                        let vec_from = |k: &str| -> Vec<String> {
                                            tags_obj.get(k)
                                                .and_then(|v| v.as_array())
                                                .map(|a| a.iter()
                                                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                                    .collect())
                                                .unwrap_or_default()
                                        };

                                        let sources: Vec<String> = e621_post.get("sources")
                                            .and_then(|s| s.as_array())
                                            .map(|arr| arr.iter()
                                                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                                .collect())
                                            .unwrap_or_default();

                                        let post_input = E621PostInput {
                                            id: e6_id,
                                            file_url: url.clone(),
                                            file_ext,
                                            file_md5,
                                            rating: e621_post.get("rating")
                                                .and_then(|r| r.as_str())
                                                .map(|s| s.to_string()),
                                            fav_count: e621_post.get("fav_count")
                                                .and_then(|f| f.as_i64()),
                                            score_total: e621_post.get("score")
                                                .and_then(|s| s.get("total"))
                                                .and_then(|t| t.as_i64()),
                                            created_at: e621_post.get("created_at")
                                                .and_then(|c| c.as_str())
                                                .map(|s| s.to_string()),
                                            sources,
                                            tags: E621Tags {
                                                general: vec_from("general"),
                                                species: vec_from("species"),
                                                character: vec_from("character"),
                                                artist: vec_from("artist"),
                                                meta: vec_from("meta"),
                                                lore: vec_from("lore"),
                                                copyright: vec_from("copyright"),
                                            },
                                        };

                                        match tauri::async_runtime::block_on(
                                            add_e621_post(app2.clone(), post_input)
                                        ) {
                                            Ok(_) => { upgraded += 1; }
                                            Err(e) => {
                                                // Download failed — restore FA item
                                                conn.execute(
                                                    "UPDATE items SET trashed_at = NULL WHERE item_id = ?",
                                                    params![item_id],
                                                ).ok();
                                                eprintln!("[maintenance] FA upgrade failed for {}: {}", e6_id, e);
                                                errors += 1;
                                            }
                                        }
                                    } else {
                                        // e621 post exists but file URL is null (deleted file)
                                        skipped += 1;
                                    }
                                } else {
                                    skipped += 1;
                                }
                            } else {
                                // Not found on e621
                                skipped += 1;
                            }
                        }
                    }
                    _ => {
                        errors += 1;
                    }
                }

                {
                    let mut st = state2.fa_upgrade.lock().map_err(|_| "Lock poisoned")?;
                    st.current = checked;
                    st.message = format!(
                        "Checked {}/{}... {} upgraded, {} skipped",
                        checked, total, upgraded, skipped
                    );
                }

                std::thread::sleep(std::time::Duration::from_millis(500));
            }

            {
                let mut st = state2.fa_upgrade.lock().map_err(|_| "Lock poisoned")?;
                st.running = false;
                st.current = total;
                st.message = format!(
                    "Done. {} upgraded to e621, {} not found, {} errors.",
                    upgraded, skipped, errors
                );
            }

            Ok(())
        })();

        if let Err(e) = result {
            if let Ok(mut st) = state2.fa_upgrade.lock() {
                st.running = false;
                st.message = format!("Error: {}", e);
            }
        }
    });

    Ok(())
}