# TailBurrow 🦊

> Just another vibe-code project.

TailBurrow is a lightning-fast, local-first desktop media library for archiving and browsing your furry art favorites. It stores files and metadata in a local SQLite library, providing offline access, advanced tag-based searching, and a slideshow viewer.

It seamlessly syncs with e621 and FurAffinity, ensuring your favorites stay accessible even if they disappear from the internet.

Built with Tauri, React, and Rust. Windows only.

---

## ✨ Features

### Library & Sync

- **Offline Archiving** — Downloads images/videos and metadata to your local drive.
- **Hybrid Sync** — Smartly imports from FurAffinity and e621, prioritizing higher-quality e621 metadata when duplicates are found.
- **Thumbnail Generation** — Automatically creates and caches thumbnails for fast grid browsing.
- **Trash System** — Deleted items go to trash first, with restore capability and manual empty.

### Browsing & Search

- **Advanced Search** — SQL-powered search supports tags, negation (`-tag`), wildcards (`*`), type filters (`type:video`, `ext:png`), and rating filters (`rating:s`).
- **Two Layouts** — Classic single-column view or Studio three-pane layout with resizable panels.
- **Masonry Grid** — Configurable column count (1–8) with infinite scroll loading.
- **Tag Categories** — Color-coded tag sections: Artist, Character, Species, Copyright, General, Meta, Lore.
- **Sort & Filter** — Sort by newest, oldest, score, random. Filter by source (e621/FurAffinity).

### Viewer

- **Slideshow Mode** — Configurable speed (1s–10s), with video-aware timing.
- **Video Controls** — Auto-mute toggle, wait-for-video-end option, full playback controls.
- **Fullscreen** — Immersive fullscreen viewer with auto-hiding HUD controls.
- **Autoscroll** — Hands-free scrolling with adjustable speed for grid browsing.
- **Metadata Editor** — Edit tags, ratings, and source URLs directly from the viewer.

### e621 Feeds

- **Feed System** — Create saved feeds from any e621 search query.
- **Live Search** — Search e621 directly from the app with real-time results.
- **One-Click Favorite** — Favorite posts on e621 and download to your library simultaneously.
- **Detail Panel** — Resizable side panel showing full post info, tags, and sources.
- **Blacklist** — Hide posts matching specific tags from feed results.

### Comics & Pools

- **Pool Discovery** — Scan your e621 favorites to find pools (comics, series, collections).
- **Comic Reader** — Full vertical-scroll reader with pages in correct pool order.
- **Remote Pages** — Pages not in your library are fetched from e621 and displayed inline. Remote videos are proxied and cached locally.
- **Zoom Controls** — Scale from 10% to 100% in 10% increments via UI or keyboard.
- **Reader Autoscroll** — Built-in autoscroll with adjustable speed for hands-free reading.
- **Pool Cache** — Discovered pools are cached for instant loading on startup.

### Security

- **App Lock** — PIN-based lock with SHA-256 hashing. Auto-locks when the window loses visibility.
- **Safe Mode** — Separate PIN that opens the app showing only safe-rated content, with no visible indicator.
- **Quick Lock** — `Ctrl+L` to lock instantly.

---

## ⌨️ Keyboard Shortcuts

|Key|Action|
|---|---|
|`A` / `←`|Previous image|
|`D` / `→`|Next image|
|`F`|Toggle fullscreen|
|`M`|Toggle auto-mute|
|`V`|Toggle wait-for-video|
|`E`|Edit metadata|
|`S`|Toggle settings|
|`Escape`|Close modal / exit viewer / exit comic reader|
|`Ctrl+L`|Lock app|
|`Ctrl+` / `Ctrl-`|Zoom in/out (comic reader)|

---

## 🚀 How to Use

1. Download the latest installer from the [Releases](https://arena.ai/releases) page.
2. Install & launch TailBurrow.
3. **Library Setup:** On first run, create or select a folder to store your library.
4. **Connect e621:**
    - Go to **Settings** (gear icon).
    - Enter your e621 **username** and **API Key**.
    - _(To find your Key: e621 Settings → Basic → Account → API Keys)_
5. **Sync:** Click **Start Import** to begin downloading your favorites.
6. **Enjoy:** Once finished, your collection is ready for offline browsing!

---

## 🐾 Importing from FurAffinity

TailBurrow can scrape your FA favorites using your session cookies.

1. Log into FurAffinity in your web browser.
2. Press `F12` (Developer Tools) and go to the **Application** (or **Storage**) tab.
3. Expand **Cookies** and look for `furaffinity.net`.
4. Copy the values for cookie **a** and cookie **b**.
5. Paste them into **TailBurrow Settings → FurAffinity**.

---

## 🛠️ How Sync Works

TailBurrow uses a "Hybrid Upgrade" strategy to ensure the best possible metadata:

1. **Scanning:** The app uses your session cookies to locally scan your FA favorites.
2. **Hashing:** It calculates the MD5 hash of every image found.
3. **Cross-Reference:** It checks the e621 database for that hash.
    - **Match Found:** The app "upgrades" the import — it downloads the file from e621 instead (often higher quality) and applies rich tags, ratings, and source links.
    - **No Match:** The image is preserved as a **FurAffinity Exclusive**, with the artist name and rating scraped directly from the submission page.

---

## 🗺️ Roadmap

- More sources: Twitter/X and Bluesky archiving.
- Cross-platform: macOS and Linux support.

---

## 📄 License

[MIT](LICENSE)