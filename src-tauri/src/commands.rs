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
        .header("User-Agent", "TailBurrow/0.3.0 (local archiver)")
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
    .header("User-Agent", "TailBurrow/0.3.0 (test)")
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
    .header("User-Agent", "TailBurrow/0.3.0 (feeds)")
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
          .header("User-Agent", "TailBurrow/0.3.0 (sync)")
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
    .header("User-Agent", "TailBurrow/0.3.0 (favorite)")
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
        .header("User-Agent", "TailBurrow/0.3.0 (media proxy)")
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
        .header("User-Agent", "TailBurrow/0.3.0 (pools)")
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
            .header("User-Agent", "TailBurrow/0.3.0 (pools)")
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
                .header("User-Agent", "TailBurrow/0.3.0 (pools)")
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