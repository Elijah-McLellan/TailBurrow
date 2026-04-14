import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Search, Upload, Play, Pause, ChevronLeft, ChevronRight,
  X, Tag, Trash2, Rss, Plus, Star, Maximize, Settings,
  Database, Loader2, Volume2, VolumeX, Clock, Pencil,
  Info, Undo, ChevronsDown, BookOpen, ArrowLeft, ZoomIn, 
  ZoomOut, Shield, RefreshCw
} from "lucide-react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import Masonry from "react-masonry-css";

const APP_VERSION = "0.3.2";
const TOAST_DURATION_MS = 4000;

// Video extensions
const VIDEO_EXTENSIONS = ['mp4', 'webm'];
const ANIMATED_EXTENSIONS = ['mp4', 'webm', 'gif'];

type Toast = {
  id: number;
  message: string;
  type: 'info' | 'error' | 'success';
};

let toastIdCounter = 0;

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return createPortal(
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`flex items-start gap-3 px-4 py-3 rounded-xl shadow-xl border backdrop-blur-sm animate-in slide-in-from-right fade-in duration-200 cursor-pointer ${
            toast.type === 'error'
              ? 'bg-red-900/90 border-red-700 text-red-100'
              : toast.type === 'success'
              ? 'bg-green-900/90 border-green-700 text-green-100'
              : 'bg-gray-800/90 border-gray-600 text-gray-100'
          }`}
          onClick={() => onDismiss(toast.id)}
        >
          <span className="text-sm flex-1 break-words">{toast.message}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onDismiss(toast.id); }}
            className="text-current opacity-60 hover:opacity-100 flex-shrink-0 mt-0.5"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}

// ─── CONSTANTS ───────────────────────────────────────────────
const HUD_TIMEOUT_MS = 2000;
const FADE_DURATION_MS = 300;
const TOOLTIP_GRACE_MS = 200;
const INFINITE_SCROLL_MARGIN = "2000px 0px";
const FEED_PAGE_LIMIT = 200;

// ─── TYPES ───────────────────────────────────────────────────
type AppConfig = { library_root?: string | null };
type ItemDto = {
  item_id: number;
  source: string;
  source_id: string;
  remote_url?: string | null;
  file_abs: string;
  file_rel: string;
  ext?: string | null;
  sources: string[];
  rating?: string | null;
  fav_count?: number | null;
  score_total?: number | null;
  timestamp?: string | null;
  added_at: string;
  tags_general: string[];
  tags_artist: string[];
  tags_copyright: string[];
  tags_character: string[];
  tags_species: string[];
  tags_meta: string[];
  tags_lore: string[];
};
type LibraryItem = {
  item_id: number;
  source: string;
  source_id: string;
  remote_url?: string | null;
  url: string;
  ext?: string | null;
  tags: string[];
  artist: string[];
  sources: string[];
  rating?: string | null;
  fav_count?: number | null;
  score: { total: number };
  timestamp?: string | null;
  file_rel: string;
  tags_general: string[];
  tags_artist: string[];
  tags_copyright: string[];
  tags_character: string[];
  tags_species: string[];
  tags_meta: string[];
  tags_lore: string[];
};
type SyncStatus = {
  running: boolean; cancelled: boolean; max_new_downloads?: number | null;
  scanned_pages: number; scanned_posts: number; skipped_existing: number;
  new_attempted: number; downloaded_ok: number; failed_downloads: number;
  unavailable: number; last_error?: string | null; started_at?: string | null;
};
type UnavailableDto = { source: string; source_id: string; seen_at: string; reason: string; sources: string[] };
type Feed = { id: number; name: string; query: string };
type FeedPagingState = { beforeId: number | null; done: boolean };
type E621CredInfo = { username?: string | null; has_api_key: boolean };
type FASyncStatus = {
  running: boolean; scanned: number; skipped_url: number; skipped_md5: number;
  imported: number; upgraded: number; errors: number; current_message: string;
};
type FACreds = { a: string; b: string };

type PoolInfo = {
  pool_id: number;
  name: string;
  post_count: number;
  cover_url: string;
  cover_ext: string;
};

type PoolPost = {
  item_id: number;
  source_id: string;
  file_abs: string;
  ext: string;
  position: number;
};

type E621Post = {
  id: number;
  file: { url: string | null; ext: string; md5: string; width: number; height: number };
  preview: { url: string | null; width: number; height: number };
  sample: { url: string | null; width: number; height: number };
  score: { total: number };
  fav_count: number;
  rating: string;
  created_at: string;
  sources: string[];
  is_favorited: boolean;
  tags: {
    general: string[];
    species: string[];
    character: string[];
    artist: string[];
    copyright: string[];
    meta: string[];
    lore: string[];
  };
};

type DuplicateGroup = {
  md5: string;
  items: { item_id: number; source: string; source_id: string; file_rel: string; ext: string }[];
};

type MaintenanceProgress = {
  running: boolean;
  current: number;
  total: number;
  message: string;
  started_at?: string | null;
};

type DeletedPostInfo = {
  post_id: number;
  item_id: number;
  reason: string;
  tag_applied: string;
};

// ─── HELPERS ─────────────────────────────────────────────────
function mapItemDto(r: ItemDto): LibraryItem {
  const tagsGeneral = r.tags_general || [];
  const tagsArtist = r.tags_artist || [];
  const tagsCopyright = r.tags_copyright || [];
  const tagsCharacter = r.tags_character || [];
  const tagsSpecies = r.tags_species || [];
  const tagsMeta = r.tags_meta || [];
  const tagsLore = r.tags_lore || [];

  return {
    item_id: r.item_id,
    source: r.source,
    source_id: r.source_id,
    remote_url: r.remote_url,
    url: convertFileSrc(r.file_abs),
    file_rel: r.file_rel,
    ext: r.ext,
    tags: [
      ...tagsGeneral,
      ...tagsArtist,
      ...tagsCopyright,
      ...tagsCharacter,
      ...tagsSpecies,
      ...tagsMeta,
      ...tagsLore,
    ],
    artist: tagsArtist,
    sources: r.sources || [],
    rating: r.rating,
    fav_count: r.fav_count,
    score: { total: r.score_total ?? 0 },
    timestamp: r.timestamp,
    tags_general: tagsGeneral,
    tags_artist: tagsArtist,
    tags_copyright: tagsCopyright,
    tags_character: tagsCharacter,
    tags_species: tagsSpecies,
    tags_meta: tagsMeta,
    tags_lore: tagsLore,
  };
}

function getSocialMediaName(url: string): string {
  try {
    const u = url.toLowerCase();
    if (u.includes('twitter.com') || u.includes('x.com')) return 'Twitter';
    if (u.includes('pbs.twimg.com') || u.includes('video.twimg.com')) return 'Twitter (File)';
    if (u.includes('t.me') || u.includes('telegram.org')) return 'Telegram';
    if (u.includes('bsky.app') || u.includes('bluesky')) return 'Bluesky';
    if (u.includes('cdn.bsky.app') || u.includes('oyster.us-east.host.bsky')) return 'Bluesky (File)';
    if (u.includes('inkbunny.net')) return 'Inkbunny';
    if (u.includes('ib.metapix.net')) return 'Inkbunny (File)';
    if (u.includes('furaffinity.net')) return 'FurAffinity';
    if (u.includes('patreon.com')) return 'Patreon';
    if (u.includes('patreonusercontent.com')) return 'Patreon (File)';
    if (u.includes('discordapp.com') || u.includes('discord.com')) return 'Discord';
    if (u.includes('cdn.discordapp.com')) return 'Discord (File)';
    if (u.includes('tumblr.com')) return 'Tumblr';
    if (u.includes('media.tumblr.com')) return 'Tumblr (File)';
    if (u.includes('deviantart.com') || u.includes('deviantar.com')) return 'DeviantArt';
    if (u.includes('artstation.com')) return 'ArtStation';
    if (u.includes('pixiv.net') || u.includes('pximg.net')) return 'Pixiv';
    if (u.includes('reddit.com') || u.includes('redd.it')) return 'Reddit';
    if (u.includes('instagram.com') || u.includes('cdninstagram.com')) return 'Instagram';
    if (u.includes('weasyl.com')) return 'Weasyl';
    if (u.includes('sofurry.com')) return 'SoFurry';
    if (u.includes('newgrounds.com')) return 'Newgrounds';
    if (u.includes('mastodon')) return 'Mastodon';
    if (u.includes('cohost.org')) return 'Cohost';
    if (u.includes('itaku.ee')) return 'Itaku';
    const hostname = new URL(url).hostname.replace('www.', '');
    const domain = hostname.split('.')[0];
    if (domain.length <= 2) return hostname;
    return domain.charAt(0).toUpperCase() + domain.slice(1);
  } catch {
    return 'Source';
  }
}

const ARTIST_DENY_LIST = ['conditional_dnp', 'sound_warning', 'unknown_artist', 'epilepsy_warning'];

function getDisplayArtists(item: { artist?: string[]; tags_artist?: string[] }): string {
  const artists = (item.artist && item.artist.length > 0) ? item.artist : (item.tags_artist || []);
  const filtered = artists.filter(a => !ARTIST_DENY_LIST.includes(a));
  return filtered.length > 0 ? filtered.join(", ") : "Unknown";
}

function parsePositiveInt(s: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = s.trim();
  if (trimmed === "") return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return { ok: false };
  return { ok: true, value: n };
}

function formatETA(startedAt: string | undefined | null, current: number, total: number): string | null {
  if (!startedAt || current <= 0 || total <= 0 || current >= total) return null;
  try {
    const started = new Date(startedAt).getTime();
    const now = Date.now();
    const elapsed = (now - started) / 1000; // seconds
    if (elapsed < 3) return null; // wait a few seconds before showing ETA
    const rate = current / elapsed;
    const remaining = (total - current) / rate;
    if (remaining < 60) return `~${Math.ceil(remaining)}s left`;
    if (remaining < 3600) return `~${Math.ceil(remaining / 60)}m left`;
    return `~${Math.floor(remaining / 3600)}h ${Math.ceil((remaining % 3600) / 60)}m left`;
  } catch { return null; }
}

// ─── EXTRACTED COMPONENTS (stable, outside main component) ───

const HelpTooltip = ({ text }: { text: React.ReactNode }) => {
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEnter = useCallback(() => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (!coords && iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect();
      setCoords({ x: rect.left + rect.width / 2, y: rect.top - 8 });
    }
  }, [coords]);

  const handleLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => setCoords(null), TOOLTIP_GRACE_MS);
  }, []);

  return (
    <>
      <div ref={iconRef} onMouseEnter={handleEnter} onMouseLeave={handleLeave} className="inline-block ml-2 cursor-help">
        <Info className="w-4 h-4 text-gray-400 hover:text-purple-400 transition-colors" />
      </div>
      {coords && createPortal(
        <div
          className="fixed z-[9999] w-64 p-3 bg-gray-900 border border-gray-600 rounded-lg shadow-xl text-xs text-gray-200 animate-in fade-in zoom-in-95 duration-150"
          style={{ left: coords.x, top: coords.y, transform: "translate(-50%, -100%)", pointerEvents: "auto" }}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
        >
          {text}
          <div className="absolute top-full left-1/2 -translate-x-1/2 border-8 border-transparent border-t-gray-600" />
        </div>,
        document.body
      )}
    </>
  );
};

const tagCategoryStyles: Record<string, { bg: string; heading: string }> = {
  'text-yellow-400': { bg: 'bg-yellow-400/30 hover:bg-yellow-400/45', heading: 'text-yellow-400' },
  'text-pink-400': { bg: 'bg-pink-400/30 hover:bg-pink-400/45', heading: 'text-pink-400' },
  'text-green-400': { bg: 'bg-green-400/30 hover:bg-green-400/45', heading: 'text-green-400' },
  'text-red-400': { bg: 'bg-red-400/30 hover:bg-red-400/45', heading: 'text-red-400' },
  'text-blue-300': { bg: 'bg-blue-400/30 hover:bg-blue-400/45', heading: 'text-blue-300' },
  'text-gray-400': { bg: 'bg-gray-400/30 hover:bg-gray-400/45', heading: 'text-gray-400' },
  'text-purple-300': { bg: 'bg-purple-400/30 hover:bg-purple-400/45', heading: 'text-purple-300' },
};

const TagSection = ({ title, tags, color, onTagClick }: { title: string; tags: string[]; color: string; onTagClick: (t: string) => void }) => {
  if (!tags || tags.length === 0) return null;
  const styles = tagCategoryStyles[color] || { bg: 'bg-gray-500/20 hover:bg-gray-500/30', heading: color };
  return (
    <div className="mb-3">
      <div className={`text-[10px] uppercase font-bold tracking-wider mb-1.5 ${styles.heading}`}>{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {tags.sort().map(tag => (
          <button key={tag} onClick={() => onTagClick(tag)} className={`px-2.5 py-1 rounded-full text-xs text-white transition-colors ${styles.bg}`}>
            {tag}
          </button>
        ))}
      </div>
    </div>
  );
};

const Thumbnail = ({ item, className, onLoad }: { item: LibraryItem; className?: string; onLoad?: () => void }) => {
  const [src, setSrc] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const fileRel = item.file_rel;
  const fallbackUrl = item.url;
  const ext = (item.ext || "").toLowerCase();

  useEffect(() => {
    let active = true;
    setSrc("");
    setLoaded(false);

    if (ANIMATED_EXTENSIONS.includes(ext)) {
      setSrc(fallbackUrl);
      return;
    }

    const fetchThumb = async () => {
      try {
        const thumbPath = await invoke<string>("ensure_thumbnail", { fileRel });
        if (active) {
          setSrc(thumbPath ? convertFileSrc(thumbPath) : fallbackUrl);
        }
      } catch {
        if (active) setSrc(fallbackUrl);
      }
    };
    fetchThumb();
    return () => { active = false; };
  }, [fileRel, fallbackUrl, ext]);

  const handleLoad = useCallback(() => {
    setLoaded(true);
    onLoad?.();
  }, [onLoad]);

  return (
    <div className="relative">
      {/* Skeleton shown until image is fully loaded */}
      {!loaded && (
        <div className={`${className} aspect-square animate-pulse bg-gray-700 rounded`} />
      )}
      {src && (
        <img
          src={src}
          className={`${className} ${loaded ? "" : "absolute inset-0 opacity-0"}`}
          loading="lazy"
          alt=""
          onLoad={handleLoad}
        />
      )}
    </div>
  );
};

function InfiniteSentinel({ onVisible, disabled }: { onVisible: () => void; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const callbackRef = useRef(onVisible);
  callbackRef.current = onVisible;

  useEffect(() => {
    if (disabled) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) callbackRef.current(); },
      { root: null, rootMargin: INFINITE_SCROLL_MARGIN, threshold: 0 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [disabled]);

  return <div ref={ref} className="h-10 w-full" />;
}

const GridItem = React.memo(({ item, index, onSelect, isSelected, isMultiSelected, onMultiClick }: {
  item: LibraryItem;
  index: number;
  onSelect: (index: number) => void;
  isSelected?: boolean;
  isMultiSelected?: boolean;
  onMultiClick?: (index: number, e: React.MouseEvent) => void;
}) => {
  const isVid = VIDEO_EXTENSIONS.includes((item.ext || "").toLowerCase());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
      const video = videoRef.current;
      if (video && !video.paused) {
        video.pause();
      }
    };
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);

    hoverTimeoutRef.current = setTimeout(() => {
      const video = videoRef.current;
      if (video && video.paused) {
        video.play().catch(() => {});
      }
    }, 120);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    const video = videoRef.current;
    if (video && !video.paused) {
      video.pause();
    }
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      onMultiClick?.(index, e);
    } else {
      onSelect(index);
    }
  }, [index, onSelect, onMultiClick]);

  return (
    <div
      onClick={handleClick}
      className={`relative group cursor-pointer bg-gray-800 rounded-lg overflow-hidden transition-all ${
        isMultiSelected
          ? 'ring-2 ring-yellow-400 border border-yellow-400'
          : isSelected
          ? 'ring-2 ring-purple-500 border border-purple-500'
          : 'border border-gray-700 hover:border-purple-500'
      }`}
    >
      {/* Selection checkbox */}
      {isMultiSelected !== undefined && (
        <div
          className={`absolute top-2 left-2 z-10 w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
            isMultiSelected
              ? 'bg-yellow-400 border-yellow-400'
              : 'border-white/30 bg-black/30 opacity-0 group-hover:opacity-100'
          }`}
          onClick={(e) => {
              e.stopPropagation();
              onMultiClick?.(index, {
                  ctrlKey: true,
                  metaKey: false,
                  shiftKey: false,
                  preventDefault: () => {},
                  stopPropagation: () => {},
              } as unknown as React.MouseEvent);
          }}
        >
          {isMultiSelected && (
            <svg className="w-3 h-3 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>
      )}

      {isVid ? (
        <div className="relative">
          <video
            ref={videoRef}
            src={item.url}
            className="w-full h-auto object-cover max-h-[600px]"
            muted
            loop
            preload="metadata"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          />
          <div className="absolute top-2 right-2 bg-black/50 p-1 rounded-full">
            <Play className="w-3 h-3 text-white" />
          </div>
        </div>
      ) : (
        <Thumbnail item={item} className="w-full h-auto object-cover max-h-[600px]" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3 pointer-events-none">
        <div className="flex items-center gap-1.5 mb-1">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${
            item.source === 'e621' ? 'bg-blue-600'
              : item.source === 'local' ? 'bg-emerald-600'
              : 'bg-orange-600'
          }`}>
            {item.source === 'e621' ? 'E6' : item.source === 'local' ? 'LC' : 'FA'}
          </span>
          <span className="text-white text-sm font-medium truncate">
            {getDisplayArtists(item)}
          </span>
        </div>
        <div className="flex justify-between items-center text-xs text-gray-300 border-t border-white/20 pt-1">
          <span>⭐ {item.fav_count || 0}</span>
          <span className={`font-bold uppercase ${item.rating === 'e' ? 'text-red-400' : item.rating === 'q' ? 'text-yellow-400' : 'text-green-400'}`}>
            {item.rating || 'S'}
          </span>
        </div>
      </div>
    </div>
  );
});

const FeedPostItem = React.memo(({ post, feedId, downloaded, busy, onFavorite, onSelect }: {
  post: E621Post;
  feedId: number;
  downloaded: boolean;
  busy: boolean;
  onFavorite: (feedId: number, post: E621Post) => void;
  onSelect?: (post: E621Post) => void;
}) => {
  const isRemoteFav = post.is_favorited;
  const imageUrl = post.sample.url || post.file.url || post.preview.url;
  const artists = post.tags.artist.filter(a => !ARTIST_DENY_LIST.includes(a));
  const w = post.sample.width || post.file.width || 1;
  const h = post.sample.height || post.file.height || 1;

  return (
    <div
      className="relative group cursor-pointer bg-gray-800 rounded-lg overflow-hidden border border-gray-700 hover:border-purple-500 transition-all"
      onClick={() => onSelect?.(post)}
    >
      {imageUrl ? (
        <>
          <img
            src={imageUrl}
            alt=""
            className="w-full object-cover"
            style={{ aspectRatio: `${w} / ${h}` }}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
          <button
            onClick={(e) => { e.stopPropagation(); onFavorite(feedId, post); }}
            disabled={busy}
            className={`absolute top-2 right-2 p-1.5 rounded-full transition z-20 ${isRemoteFav ? "bg-yellow-500 text-yellow-900" : "bg-black/60 text-gray-300 hover:bg-black/80"} ${busy ? "opacity-60 cursor-not-allowed" : ""}`}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Star className={`w-4 h-4 ${isRemoteFav ? "fill-current" : ""}`} />}
          </button>
        </>
      ) : (
        <div className="w-full h-48 flex items-center justify-center bg-gray-800">
          <p className="text-gray-500 text-sm">No image</p>
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3 pointer-events-none">
        {downloaded && (
          <div className="absolute top-2 left-2 bg-green-500/80 text-white p-1.5 rounded-full">
            <Database className="w-3.5 h-3.5" />
          </div>
        )}
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-white text-sm font-medium truncate">
            {artists.length > 0 ? artists.slice(0, 2).join(", ") : "Unknown"}
          </span>
        </div>
        <div className="flex justify-between items-center text-xs text-gray-300 border-t border-white/20 pt-1">
          <span>⭐ {post.fav_count} • Score: {post.score.total}</span>
          <span className={`font-bold uppercase ${post.rating === 'e' ? 'text-red-400' : post.rating === 'q' ? 'text-yellow-400' : 'text-green-400'}`}>
            {post.rating || 'S'}
          </span>
        </div>
      </div>
    </div>
  );
});

const AutoscrollWidget = ({ active, autoscroll, setAutoscroll, autoscrollSpeed, setAutoscrollSpeed, hidden, rightOffset }: {
  active: boolean; autoscroll: boolean; setAutoscroll: (v: boolean) => void;
  autoscrollSpeed: number; setAutoscrollSpeed: (v: number) => void; hidden: boolean; rightOffset?: number;
}) => {
  if (!active || hidden) return null;

  const rightPx = (rightOffset || 0) + 16;

  if (!autoscroll) {
    return (
      <button
        onClick={() => setAutoscroll(true)}
        className="fixed bottom-12 px-3 py-2 rounded-xl shadow-lg border transition-all z-40 flex items-center gap-2 text-xs font-medium bg-[#161621] hover:bg-[#1d1b2d] text-[#9e98aa] hover:text-white border-[#1d1b2d]"
        style={{ right: rightPx }}
        title="Start Autoscroll"
      >
        <ChevronsDown className="w-4 h-4" />
        Scroll
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-12 backdrop-blur border rounded-xl shadow-xl z-40 animate-in fade-in slide-in-from-bottom-4 bg-[#161621]/95 border-[#1d1b2d]"
      style={{ right: rightPx }}
    >
      <div className="flex items-center gap-2 p-2">
        <button
          onClick={() => setAutoscroll(false)}
          className="p-1.5 rounded-lg transition-colors hover:bg-[#1d1b2d] text-red-400"
          title="Stop"
        >
          <Pause className="w-4 h-4" />
        </button>
        <input
          type="range"
          min="1"
          max="10"
          step="0.5"
          value={autoscrollSpeed}
          onChange={(e) => setAutoscrollSpeed(Number(e.target.value))}
          className="w-24 h-1.5 cursor-pointer accent-[#967abc]"
        />
        <span className="text-[10px] font-mono w-6 text-right text-[#9e98aa]">{autoscrollSpeed}x</span>
      </div>
    </div>
  );
};

const PoolCover = ({ pool }: { pool: PoolInfo }) => {
  const [error, setError] = useState(false);

  if (!pool.cover_url || error) {
    return (
      <div className="w-full aspect-[3/4] flex items-center justify-center bg-[#1d1b2d]">
        <BookOpen className="w-12 h-12 opacity-30" />
      </div>
    );
  }

  return (
    <img
      src={pool.cover_url}
      alt={pool.name}
      className="w-full h-auto object-cover"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setError(true)}
    />
  );
};

const ComicPage = ({ post, comicScale }: {
  post: PoolPost; comicScale: number;
}) => {
  const isVideo = ['mp4', 'webm'].includes(post.ext.toLowerCase());
  const isLocal = post.item_id !== 0;
  const [src, setSrc] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc('');
    setLoading(true);
    setError(false);

    if (isLocal) {
      setSrc(convertFileSrc(post.file_abs));
      setLoading(false);
      return;
    }

    // Remote content — proxy videos through backend, images load directly
    if (isVideo) {
      invoke<string>("proxy_remote_media", { url: post.file_abs })
        .then(localPath => {
          if (!cancelled) {
            setSrc(convertFileSrc(localPath));
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setError(true);
            setLoading(false);
          }
        });
    } else {
      setSrc(post.file_abs);
      setLoading(false);
    }

    return () => { cancelled = true; };
  }, [post.file_abs, post.item_id, isLocal, isVideo]);

  return (
    <div style={{ width: `${comicScale}%` }} className="relative group max-w-full overflow-hidden">
      {isLocal && (
        <div className="absolute top-2 left-2 z-10 bg-green-500/80 text-white p-1.5 rounded-full pointer-events-none">
          <Database className="w-3.5 h-3.5" />
        </div>
      )}
      {loading ? (
        <div
          className="w-full max-w-full aspect-video flex items-center justify-center"
          style={{ backgroundColor: '#0a0a12' }}
        >
          <Loader2 className="w-8 h-8 animate-spin text-gray-500" />
        </div>
      ) : error ? (
        <div
          className="w-full aspect-video flex flex-col items-center justify-center gap-2 text-gray-500"
          style={{ backgroundColor: '#0a0a12' }}
        >
          <p className="text-sm">Failed to load video</p>
          <button
            onClick={() => {
              try {
                const url = `https://e621.net/posts/${post.source_id}`;
                openUrl(url);
              } catch { /* ignore */ }
            }}
            className={`text-xs px-3 py-1.5 rounded-lg bg-[#1d1b2d] hover:bg-[#4c4b5a] text-[#967abc]`}
          >
            View on e621
          </button>
        </div>
      ) : isVideo ? (
        <video
          key={src}
          src={src}
          controls
          playsInline
          preload="auto"
          className="w-full h-auto max-w-full"
          style={{ backgroundColor: '#0a0a12'}}
        />
      ) : (
        <img
          src={src}
          alt={`Page ${post.position + 1}`}
          className="w-full h-auto block max-w-full"
          loading="lazy"
          style={{ backgroundColor: '#0a0a12' }}
          referrerPolicy="no-referrer"
        />
      )}
    </div>
  );
};

// ─── RESIZE HANDLE ───────────────────────────────────────────
const ResizeHandle = ({ onDrag }: { onDrag: (clientX: number) => void }) => {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => { cleanupRef.current?.(); };
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMouseMove = (ev: MouseEvent) => onDrag(ev.clientX);
    const cleanup = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      cleanupRef.current = null;
    };
    const onMouseUp = () => cleanup();
    cleanupRef.current = cleanup;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  return (
    <div
      onMouseDown={handleMouseDown}
      className="w-1.5 flex-shrink-0 cursor-col-resize bg-[#1d1b2d] hover:bg-[#967abc] active:bg-[#967abc]/80 transition-colors"
    />
  );
};

// ─── SKELETON COMPONENTS ─────────────────────────────────────
const Skeleton = ({ className = "", style }: { className?: string; style?: React.CSSProperties }) => (
  <div className={`animate-pulse bg-gray-700 rounded ${className}`} style={style} />
);

const skeletonAspects = [
  "aspect-[3/4]",
  "aspect-square",
  "aspect-[4/5]",
  "aspect-[2/3]",
  "aspect-[5/6]",
  "aspect-[3/4]",
  "aspect-[4/3]",
  "aspect-square",
  "aspect-[3/5]",
  "aspect-[4/5]",
  "aspect-[3/4]",
  "aspect-square",
  "aspect-[2/3]",
  "aspect-[5/4]",
  "aspect-[3/4]",
];

const SkeletonGridItem = ({ index = 0, dark }: { index?: number; dark?: boolean }) => (
  <div className={`${dark ? 'bg-[#161621] border-[#1d1b2d]' : 'bg-gray-800 border-gray-700'} rounded-lg overflow-hidden border`}>
    <Skeleton className={`w-full ${skeletonAspects[index % skeletonAspects.length]}`} style={dark ? { backgroundColor: '#1d1b2d' } : undefined} />
  </div>
);

const SkeletonFeedPost = ({ index = 0, dark }: { index?: number; dark?: boolean }) => (
  <div className={`${dark ? 'bg-[#161621]' : 'bg-gray-700'} rounded overflow-hidden`}>
    <Skeleton className={`w-full ${skeletonAspects[index % skeletonAspects.length]}`} style={dark ? { backgroundColor: '#1d1b2d' } : undefined} />
  </div>
);

// ─── MAIN COMPONENT ──────────────────────────────────────────
// ─── ERROR BOUNDARY ──────────────────────────────────────────
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("TailBurrow crashed:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex items-center justify-center bg-[#0f0f17] text-white">
          <div className="text-center max-w-md px-6">
            <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-[#1d1b2d] flex items-center justify-center">
              <svg className="w-8 h-8 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h2 className="text-xl font-bold mb-2">Something went wrong</h2>
            <p className="text-[#9e98aa] text-sm mb-4">
              {this.state.error?.message || "An unexpected error occurred."}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
              }}
              className="px-6 py-2.5 rounded-xl bg-[#967abc] hover:bg-[#967abc]/80 text-white font-medium transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// ─── MAIN COMPONENT ──────────────────────────────────────────
function FavoritesViewerInner() {
  type ConfirmOpts = { title: string; message: string; okLabel?: string; cancelLabel?: string; onConfirm: () => void };
  const [confirmModal, setConfirmModal] = useState<ConfirmOpts | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const toast = useCallback((message: string, type: 'info' | 'error' | 'success' = 'info') => {
    const id = ++toastIdCounter;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, TOAST_DURATION_MS);
  }, []);
  // --- STATE ---
  const [isLocked, setIsLocked] = useState(true);
  const [lockChecked, setLockChecked] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');
  const [activeTab, setActiveTab] = useState('viewer');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [searchTags, setSearchTags] = useState('');
  const [tagSuggestions, setTagSuggestions] = useState<{ name: string; tag_type: string; count: number }[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const suggestionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFetchingSuggestionsRef = useRef(false);
  const [sortOrder, setSortOrder] = useState(() => localStorage.getItem('preferred_sort_order') || 'default');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [fadeIn, setFadeIn] = useState(true);
  const [imageLoading, setImageLoading] = useState(true);

  // Slideshow
  const [isSlideshow, setIsSlideshow] = useState(false);
  const [slideshowSpeed, setSlideshowSpeed] = useState(5000);
  const [autoMuteVideos, setAutoMuteVideos] = useState(false);
  const [globalMute, setGlobalMute] = useState(true);

  const [waitForVideoEnd, setWaitForVideoEnd] = useState(true);

  // Feeds
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [feedPosts, setFeedPosts] = useState<Record<number, E621Post[]>>({});
  const [loadingFeeds, setLoadingFeeds] = useState<Record<number, boolean>>({});
  const [newFeedQuery, setNewFeedQuery] = useState('');
  const [newFeedName, setNewFeedName] = useState('');
  const [selectedFeedId, setSelectedFeedId] = useState<number | null>(null);
  const [showAddFeedModal, setShowAddFeedModal] = useState(false);
  const [editingFeedId, setEditingFeedId] = useState<number | null>(null);
  const [feedDrag, setFeedDrag] = useState<{
    id: number;
    ghostX: number;
    ghostY: number;
    ghostWidth: number;
    ghostHeight: number;
    ghostLabel: string;
    insertIndex: number;
  } | null>(null);
  const feedPillRefs = useRef<Map<number, HTMLElement>>(new Map());
  const feedDragStartRef = useRef<{ x: number; y: number; id: number; index: number } | null>(null);
  const feedDragCleanupRef = useRef<(() => void) | null>(null);
  const feedDragRef = useRef(feedDrag);
  useEffect(() => { feedDragRef.current = feedDrag; }, [feedDrag]);
  const [feedSearchInput, setFeedSearchInput] = useState('');
  const [feedSearchResults, setFeedSearchResults] = useState<E621Post[]>([]);
  const [feedSearchLoading, setFeedSearchLoading] = useState(false);
  const [selectedFeedPost, setSelectedFeedPost] = useState<E621Post | null>(null);
  const [feedPostIndex, setFeedPostIndex] = useState(0);
  const [feedDetailWidth, setFeedDetailWidth] = useState(() =>
    Number(localStorage.getItem('feed_detail_width') || 500)
  );
  const feedsContainerRef = useRef<HTMLDivElement>(null);
  const [feedDetailOpen, setFeedDetailOpen] = useState(false);
  const [feedSlideshow, setFeedSlideshow] = useState(false);
  const [feedViewerOverlay, setFeedViewerOverlay] = useState(false);
  const [feedImageLoading, setFeedImageLoading] = useState(true);
  const [feedFadeIn, setFeedFadeIn] = useState(true);
  const [showSpeedSlider, setShowSpeedSlider] = useState(false);
  const speedSliderRef = useRef<HTMLDivElement>(null);
  const savedVideoTimeRef = useRef(0);
  const [libraryDetailOpen, setLibraryDetailOpen] = useState(false);
  const [currentPostPools, setCurrentPostPools] = useState<PoolInfo[]>([]);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<number>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  const [showBulkTagModal, setShowBulkTagModal] = useState(false);
  const [bulkTagInput, setBulkTagInput] = useState('');
  const [bulkTagMode, setBulkTagMode] = useState<'add' | 'remove'>('add');

  // Settings & System
  const [showSettings, setShowSettings] = useState(false);
  const [libraryRoot, setLibraryRoot] = useState("");
  const [syncMaxNew, setSyncMaxNew] = useState<string>("");
  const [syncFullMode, setSyncFullMode] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [unavailableList, setUnavailableList] = useState<UnavailableDto[]>([]);
  // Settings tabs
  const [settingsTab, setSettingsTab] = useState<'general' | 'credentials' | 'security' | 'maintenance'>('general');

  // Maintenance - Find Duplicates
  const [dupGroups, setDupGroups] = useState<DuplicateGroup[]>([]);
  const [dupLoading, setDupLoading] = useState(false);

  // Maintenance - Long-running tasks
  const [deletedCheckStatus, setDeletedCheckStatus] = useState<MaintenanceProgress | null>(null);
  const [metaUpdateStatus, setMetaUpdateStatus] = useState<MaintenanceProgress | null>(null);
  const [faUpgradeStatus, setFaUpgradeStatus] = useState<MaintenanceProgress | null>(null);
  const [deletedResults, setDeletedResults] = useState<DeletedPostInfo[]>([]);
  const [unfavoritingDeleted, setUnfavoritingDeleted] = useState(false);
  const [unfavoriteProgress, setUnfavoriteProgress] = useState({ current: 0, total: 0 });

  // Paging
  const [initialLoading, setInitialLoading] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreItems, setHasMoreItems] = useState(true);
  const [totalDatabaseItems, setTotalDatabaseItems] = useState(0);
  const [itemsPerPage, setItemsPerPage] = useState(() => Number(localStorage.getItem('items_per_page') || 100));
  const loadingRef = useRef(false);
  const loadRequestIdRef = useRef(0);
  const currentIndexRef = useRef(0);
  const itemsRef = useRef<LibraryItem[]>([]);
  const hasMoreRef = useRef(true);
  const faSyncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadingFeedsRef = useRef<Record<number, boolean>>({});
  const feedPagingRef = useRef<Record<number, FeedPagingState>>({});

  // e621
  const [feedActionBusy, setFeedActionBusy] = useState<Record<number, boolean>>({});
  const [feedPaging, setFeedPaging] = useState<Record<number, FeedPagingState>>({});
  const [apiUsername, setApiUsername] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [e621CredInfo, setE621CredInfo] = useState<E621CredInfo>({ username: null, has_api_key: false });
  const [credWarned, setCredWarned] = useState(false);
  const [isEditingE621, setIsEditingE621] = useState(false);

  // UI
  const [viewerOverlay, setViewerOverlay] = useState(false);
  const [showHud, setShowHud] = useState(true);
  const syncWasRunningRef = useRef(false);
  const hudHoverRef = useRef(false);
  const hudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Edit Modal
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingTags, setEditingTags] = useState<string[]>([]);
  const [newTagInput, setNewTagInput] = useState("");
  const [editingSources, setEditingSources] = useState<string[]>([]);
  const [editingRating, setEditingRating] = useState("s");
  const [newSourceInput, setNewSourceInput] = useState("");

  // Trash
  const [showTrashModal, setShowTrashModal] = useState(false);
  const [trashedItems, setTrashedItems] = useState<LibraryItem[]>([]);
  const [trashCount, setTrashCount] = useState(0);

  // Preferences
  const [blacklist, setBlacklist] = useState(() => localStorage.getItem('blacklist_tags') || "");
  const [gridColumns, setGridColumns] = useState(() => Number(localStorage.getItem('grid_columns') || 5));
  const [autoscroll, setAutoscroll] = useState(false);
  const [autoscrollSpeed, setAutoscrollSpeed] = useState(1);

  // Layout
  const [libraryDetailWidth, setLibraryDetailWidth] = useState(() =>
    Number(localStorage.getItem('library_detail_width') || 420)
  );

  // FurAffinity
  const [faCreds, setFaCreds] = useState<FACreds>({ a: '', b: '' });
  const [faStatus, setFaStatus] = useState<FASyncStatus | null>(null);
  const [filterSource, setFilterSource] = useState('all');
  const [isEditingFA, setIsEditingFA] = useState(false);
  const [faCredsSet, setFaCredsSet] = useState(false);
  const [faLimit, setFaLimit] = useState("");

  // App Lock
  const [hasLock, setHasLock] = useState(false);
  const [lockNewPin, setLockNewPin] = useState('');
  const [lockConfirmPin, setLockConfirmPin] = useState('');
  const [lockRemovePin, setLockRemovePin] = useState('');
  const [safeMode, setSafeMode] = useState(false);
  const [safePinInput, setSafePinInput] = useState('');

  // Comics
  const [pools, setPools] = useState<PoolInfo[]>([]);
  const [poolsLoading, setPoolsLoading] = useState(false);
  const [comicSearchInput, setComicSearchInput] = useState('');
  const [selectedPool, setSelectedPool] = useState<PoolInfo | null>(null);
  const [poolPosts, setPoolPosts] = useState<PoolPost[]>([]);
  const [poolPostsLoading, setPoolPostsLoading] = useState(false);
  const [comicScale, setComicScale] = useState(100);
  const [comicAutoscroll, setComicAutoscroll] = useState(false);
  const [comicAutoscrollSpeed, setComicAutoscrollSpeed] = useState(1);
  const [poolScanProgress, setPoolScanProgress] = useState<{ current: number; total: number } | null>(null);
  const comicContainerRef = useRef<HTMLDivElement>(null);
  const poolScrollPositions = useRef<Map<number, number>>(new Map());
  const detailVideoRef = useRef<HTMLVideoElement | null>(null);
  const fullscreenVideoRef = useRef<HTMLVideoElement | null>(null);
  const feedDetailVideoRef = useRef<HTMLVideoElement | null>(null);
  const feedFullscreenVideoRef = useRef<HTMLVideoElement | null>(null);
  const savedFeedVideoTimeRef = useRef(0);

  // Self Import
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFiles, setImportFiles] = useState<string[]>([]);
  const [importTagInput, setImportTagInput] = useState('');
  const [importTags, setImportTags] = useState<string[]>([]);
  const [importRating, setImportRating] = useState<string>('s');
  const [importSourceInput, setImportSourceInput] = useState('');
  const [importSources, setImportSources] = useState<string[]>([]);
  const [importLoading, setImportLoading] = useState(false);

  // --- DERIVED STATE (stable) ---
  const currentItem = items[currentIndex] || null;
  const filteredPools = useMemo(() => {
    if (!comicSearchInput.trim()) return pools;
    const lower = comicSearchInput.toLowerCase().trim();
    if (lower.startsWith('pool:')) {
      const idStr = lower.replace('pool:', '').trim();
      return pools.filter(p => p.pool_id.toString() === idStr);
    }
    return pools.filter(p => p.name.toLowerCase().includes(lower) || p.pool_id.toString() === lower);
  }, [pools, comicSearchInput]);
  const itemCount = items.length;
  const ext = (currentItem?.ext || "").toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.includes(ext);
  const pendingTagSearchRef = useRef(false);

  // Refs for loadData to avoid recreating it on every filter change
  const searchTagsRef = useRef(searchTags);
  const selectedTagsRef = useRef(selectedTags);
  const filterSourceRef = useRef(filterSource);
  const sortOrderRef = useRef(sortOrder);
  const safeModeRef = useRef(safeMode);
  const itemsPerPageRef = useRef(itemsPerPage);

  useEffect(() => { searchTagsRef.current = searchTags; }, [searchTags]);
  useEffect(() => { selectedTagsRef.current = selectedTags; }, [selectedTags]);
  useEffect(() => { filterSourceRef.current = filterSource; }, [filterSource]);
  useEffect(() => { sortOrderRef.current = sortOrder; }, [sortOrder]);
  useEffect(() => { safeModeRef.current = safeMode; }, [safeMode]);
  useEffect(() => { itemsPerPageRef.current = itemsPerPage; }, [itemsPerPage]);

  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
  useEffect(() => { hasMoreRef.current = hasMoreItems; }, [hasMoreItems]);
  useEffect(() => { searchTagsRef.current = searchTags; }, [searchTags]);
  useEffect(() => { selectedTagsRef.current = selectedTags; }, [selectedTags]);
  useEffect(() => { filterSourceRef.current = filterSource; }, [filterSource]);
  useEffect(() => { sortOrderRef.current = sortOrder; }, [sortOrder]);
  useEffect(() => { safeModeRef.current = safeMode; }, [safeMode]);
  useEffect(() => { itemsPerPageRef.current = itemsPerPage; }, [itemsPerPage]);

  useEffect(() => {
    loadingFeedsRef.current = loadingFeeds;
  }, [loadingFeeds]);

  useEffect(() => {
    feedPagingRef.current = feedPaging;
  }, [feedPaging]);

  const downloadedE621Ids = useMemo(
    () => new Set(items.filter(it => it.source === "e621").map(it => Number(it.source_id))),
    [items]
  );

  // --- CORE DATA ---
  const loadData = useCallback(async (append: boolean, overrides?: { pageSize?: number }) => {
    const requestId = ++loadRequestIdRef.current;
    const limit = overrides?.pageSize ?? itemsPerPageRef.current;

    if (!append) {
      setIsSearching(true);
    }

    try {
      const offset = append ? itemsRef.current.length : 0;
      let combinedSearch = [searchTagsRef.current, ...selectedTagsRef.current].join(" ").trim();
      if (safeModeRef.current && !combinedSearch.includes("rating:")) {
        combinedSearch = combinedSearch ? `${combinedSearch} rating:s` : "rating:s";
      }
      const rows = await invoke<ItemDto[]>("list_items", {
        limit,
        offset,
        search: combinedSearch,
        source: filterSourceRef.current,
        order: sortOrderRef.current,
      });

      if (requestId !== loadRequestIdRef.current) return;

      if (!append) {
        const total = await invoke<number>("get_library_stats");
        if (requestId !== loadRequestIdRef.current) return;
        setTotalDatabaseItems(total);
      }

      setHasMoreItems(rows.length === limit);
      const mapped = rows.map(mapItemDto);

      setItems(prev => {
        const next = append ? [...prev, ...mapped] : mapped;
        itemsRef.current = next;
        return next;
      });

      if (!append) {
        setCurrentIndex(prev => {
          const newLen = mapped.length;
          return newLen === 0 ? 0 : Math.min(prev, newLen - 1);
        });
      }
    } catch (error) {
      if (requestId !== loadRequestIdRef.current) return;
      console.error("Failed to load library:", error);
      toast("Failed to load library. Please check your library settings.", "error");
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setIsSearching(false);
      }
    }
  }, [toast]);

  const loadMoreItems = useCallback(async () => {
    if (loadingRef.current || !hasMoreRef.current) return;
    loadingRef.current = true;
    setIsLoadingMore(true);
    try {
      await loadData(true);
    } finally {
      setIsLoadingMore(false);
      loadingRef.current = false;
    }
  }, [loadData]);

  // --- HUD ---
  const scheduleHudHide = useCallback(() => {
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    hudTimerRef.current = setTimeout(() => { if (!hudHoverRef.current) setShowHud(false); }, HUD_TIMEOUT_MS);
  }, []);

  const pokeHud = useCallback(() => {
    setShowHud(true);
    scheduleHudHide();
  }, [scheduleHudHide]);

  // --- NAVIGATION ---
  const goToNext = useCallback((manual = false) => {
    if (viewerOverlay && manual) pokeHud();

    const len = itemsRef.current.length;
    if (len === 0) return;
    const atEnd = currentIndexRef.current >= len - 1;

    if (atEnd && hasMoreRef.current) {
      loadMoreItems();
      return;
    }

    if (viewerOverlay) {
      setFadeIn(false);
      setTimeout(() => {
        setCurrentIndex(prev => {
          const l = itemsRef.current.length;
          return l === 0 ? 0 : (prev + 1) % l;
        });
        requestAnimationFrame(() => setFadeIn(true));
      }, FADE_DURATION_MS);
    } else {
      setCurrentIndex(prev => {
        const l = itemsRef.current.length;
        return l === 0 ? 0 : (prev + 1) % l;
      });
    }
  }, [viewerOverlay, pokeHud, loadMoreItems]);

  const goToPrev = useCallback((manual = false) => {
    if (viewerOverlay && manual) pokeHud();
    if (viewerOverlay) {
      setFadeIn(false);
      setTimeout(() => {
        setCurrentIndex(prev => {
          const len = itemsRef.current.length;
          return len === 0 ? 0 : (prev - 1 + len) % len;
        });
        requestAnimationFrame(() => setFadeIn(true));
      }, FADE_DURATION_MS);
    } else {
      setCurrentIndex(prev => {
        const len = itemsRef.current.length;
        return len === 0 ? 0 : (prev - 1 + len) % len;
      });
    }
  }, [viewerOverlay, pokeHud]);

  const selectAll = useCallback(() => {
    setSelectedItemIds(new Set(items.map(i => i.item_id)));
  }, [items]);

  const deselectAll = useCallback(() => {
    setSelectedItemIds(new Set());
  }, []);

  // --- SYNC ---
  const refreshSyncStatus = useCallback(async () => {
    setSyncStatus(await invoke<SyncStatus>("e621_sync_status"));
  }, []);

  const startSync = useCallback(async () => {
    const parsed = parsePositiveInt(syncMaxNew);
    if (!parsed.ok) { toast("Stop-after-N must be a positive number or blank.", "error"); return; }
    await invoke("e621_sync_start", { maxNewDownloads: parsed.value, forceFullSync: syncFullMode });
    syncWasRunningRef.current = true;
    await refreshSyncStatus();
  }, [syncMaxNew, syncFullMode, refreshSyncStatus, toast]);

  const cancelSync = useCallback(async () => {
    await invoke("e621_sync_cancel");
    await refreshSyncStatus();
  }, [refreshSyncStatus]);

  const loadUnavailable = useCallback(async () => {
    setUnavailableList(await invoke<UnavailableDto[]>("e621_unavailable_list", { limit: 200 }));
    setShowUnavailable(true);
  }, []);

  const refreshE621CredInfo = useCallback(async () => {
    const info = await invoke<E621CredInfo>("e621_get_cred_info");
    setE621CredInfo(info);
    if (info.username) setApiUsername(info.username);
  }, []);

  const saveE621Credentials = useCallback(async () => {
    await invoke("e621_set_credentials", { username: apiUsername, apiKey });
    setApiKey("");
    await refreshE621CredInfo();
    setCredWarned(false);
    toast("Saved e621 credentials.", "success");
  }, [apiUsername, apiKey, refreshE621CredInfo, toast]);

  // --- FEEDS ---
  const loadFeeds = useCallback(() => {
    try {
      const stored = localStorage.getItem('e621_feeds');
      if (stored) setFeeds(JSON.parse(stored));
    } catch (e) {
      console.warn("Failed to load feeds from localStorage:", e);
    }
  }, []);

  const saveFeeds = useCallback((newFeeds: Feed[]) => {
    localStorage.setItem("e621_feeds", JSON.stringify(newFeeds));
    setFeeds(newFeeds);
  }, []);

  const removeFeed = useCallback((feedId: number) => {
    saveFeeds(feeds.filter(f => f.id !== feedId));
    setFeedPosts(prev => { const copy = { ...prev }; delete copy[feedId]; return copy; });
    setFeedPaging(prev => { const copy = { ...prev }; delete copy[feedId]; return copy; });
  }, [feeds, saveFeeds]);

  const fetchFeedPosts = useCallback(async (feedId: number, query: string, opts?: { reset?: boolean }) => {
    const reset = opts?.reset ?? false;

    if (!e621CredInfo.username || !e621CredInfo.has_api_key) {
      if (!credWarned) {
        toast("Set e621 credentials in Settings first.", "error");
        setCredWarned(true);
      }
      return;
    }

if (loadingFeedsRef.current[feedId]) return;

    const currentPaging = feedPagingRef.current[feedId];
    if (!reset && (currentPaging?.done || /\border:random\b/i.test(query))) return;

    loadingFeedsRef.current = { ...loadingFeedsRef.current, [feedId]: true };
    setLoadingFeeds(prev => ({ ...prev, [feedId]: true }));

    try {
      const pageParam = (!reset && currentPaging?.beforeId) ? `b${currentPaging.beforeId}` : "1";
      const safeQuery = safeMode && !query.includes("rating:") ? `${query} rating:s` : query;
      const data = await invoke<{ posts: E621Post[] }>("e621_fetch_posts", { tags: safeQuery, limit: FEED_PAGE_LIMIT, page: pageParam });
      const rawPosts = data.posts || [];

      const blTags = blacklist.toLowerCase().split(/[\s\n]+/).filter(Boolean);
      const filteredPosts = rawPosts.filter((post) => {
        if (blTags.length === 0) return true;
        const pTags = [
          ...post.tags.general, ...post.tags.species,
          ...post.tags.character, ...post.tags.artist,
          ...post.tags.copyright, ...post.tags.meta,
          ...post.tags.lore,
        ];
        return !pTags.some((t) => blTags.includes(t));
      });

      setFeedPosts(prev => {
        const existing = reset ? [] : (prev[feedId] || []);
        const uniqueMap = new Map<number, E621Post>();
        [...existing, ...filteredPosts].forEach((p) => uniqueMap.set(p.id, p));
        return { ...prev, [feedId]: Array.from(uniqueMap.values()) };
      });

      const minId = rawPosts.reduce((m, p) => Math.min(m, p.id), Number.POSITIVE_INFINITY);
      setFeedPaging(prev => ({
        ...prev,
        [feedId]: {
          beforeId: minId !== Number.POSITIVE_INFINITY ? minId : (prev[feedId]?.beforeId ?? null),
          done: rawPosts.length < FEED_PAGE_LIMIT,
        },
      }));
    } catch (e) {
      console.error('Error fetching feed:', e);
      toast("Error fetching feed: " + (e instanceof Error ? e.message : String(e)), "error");
    } finally {
      loadingFeedsRef.current = { ...loadingFeedsRef.current, [feedId]: false };
      setLoadingFeeds(prev => ({ ...prev, [feedId]: false }));
    }
  }, [e621CredInfo, credWarned, blacklist]);

  const currentFeedPosts = useMemo(() => {
    if (feedSearchInput && feedSearchResults.length > 0) return feedSearchResults;
    if (selectedFeedId && feedPosts[selectedFeedId]) return feedPosts[selectedFeedId];
    return [];
  }, [feedSearchInput, feedSearchResults, selectedFeedId, feedPosts]);

  useEffect(() => {
    savedFeedVideoTimeRef.current = 0;
    setFeedImageLoading(true);
    setFeedFadeIn(true);
  }, [selectedFeedPost?.id]);

  const goToNextFeedPost = useCallback(() => {
    if (currentFeedPosts.length === 0) return;
    setFeedFadeIn(false);
    setTimeout(() => {
      const nextIndex = (feedPostIndex + 1) % currentFeedPosts.length;
      setFeedPostIndex(nextIndex);
      setSelectedFeedPost(currentFeedPosts[nextIndex]);
      requestAnimationFrame(() => setFeedFadeIn(true));
    }, FADE_DURATION_MS);
  }, [currentFeedPosts, feedPostIndex]);

  const goToPrevFeedPost = useCallback(() => {
    if (currentFeedPosts.length === 0) return;
    setFeedFadeIn(false);
    setTimeout(() => {
      const prevIndex = (feedPostIndex - 1 + currentFeedPosts.length) % currentFeedPosts.length;
      setFeedPostIndex(prevIndex);
      setSelectedFeedPost(currentFeedPosts[prevIndex]);
      requestAnimationFrame(() => setFeedFadeIn(true));
    }, FADE_DURATION_MS);
  }, [currentFeedPosts, feedPostIndex]);

  const ensureFavorite = useCallback(async (feedId: number, post: E621Post) => {
    const id = post.id;
    const isCurrentlyFavorited = post.is_favorited;
    
    try {
      setFeedActionBusy(prev => ({ ...prev, [id]: true }));
      
      if (isCurrentlyFavorited) {
        // Unfavorite
        await invoke("e621_unfavorite", { postId: id });
        
        // Update grid
        if (feedId === -1) {
          setFeedSearchResults(prev => prev.map(p => p.id === id ? { ...p, is_favorited: false } : p));
        } else {
          setFeedPosts(prev => ({
            ...prev,
            [feedId]: (prev[feedId] || []).map((p) => p.id === id ? { ...p, is_favorited: false } : p),
          }));
        }
        
        // Update detail pane
        setSelectedFeedPost(prev =>
          prev && prev.id === id ? { ...prev, is_favorited: false } : prev
        );
      } else {
        // Favorite (and download if needed)
        if (!downloadedE621Ids.has(id)) {
          if (!post.file.url) throw new Error("This post has no original file URL (deleted/blocked).");
          await invoke("add_e621_post", {
            post: {
              id: post.id, file_url: post.file.url, file_ext: post.file.ext, file_md5: post.file.md5,
              rating: post.rating, fav_count: post.fav_count, score_total: post.score.total,
              created_at: post.created_at, sources: post.sources || [],
              tags: {
                general: post.tags.general, species: post.tags.species,
                character: post.tags.character, artist: post.tags.artist,
                meta: post.tags.meta, lore: post.tags.lore,
                copyright: post.tags.copyright,
              },
            },
          });
          await loadData(false);
        }
        
        await invoke("e621_favorite", { postId: id });

        // Update grid
        if (feedId === -1) {
          setFeedSearchResults(prev => prev.map(p => p.id === id ? { ...p, is_favorited: true } : p));
        } else {
          setFeedPosts(prev => ({
            ...prev,
            [feedId]: (prev[feedId] || []).map((p) => p.id === id ? { ...p, is_favorited: true } : p),
          }));
        }

        // Update detail pane
        setSelectedFeedPost(prev =>
          prev && prev.id === id ? { ...prev, is_favorited: true } : prev
        );
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setFeedActionBusy(prev => ({ ...prev, [id]: false }));
    }
  }, [downloadedE621Ids, loadData, toast]);

  const searchFeedPosts = useCallback(async (query: string) => {
    if (!e621CredInfo.username || !e621CredInfo.has_api_key) {
      if (!credWarned) {
        toast("Set e621 credentials in Settings first.", "error");
        setCredWarned(true);
      }
      return;
    }
    if (!query.trim()) return;

    setFeedSearchLoading(true);
    setSelectedFeedId(null);
    setSelectedFeedPost(null);

    try {
      const safeQuery = safeMode && !query.includes("rating:") ? `${query.trim()} rating:s` : query.trim();
      const data = await invoke<{ posts: E621Post[] }>("e621_fetch_posts", { tags: safeQuery, limit: FEED_PAGE_LIMIT, page: "1" });
      const rawPosts = data.posts || [];

      const blTags = blacklist.toLowerCase().split(/[\s\n]+/).filter(Boolean);
      const filteredPosts = rawPosts.filter((post) => {
        if (blTags.length === 0) return true;
        const pTags = [...post.tags.general, ...post.tags.species, ...post.tags.character, ...post.tags.artist, ...post.tags.copyright, ...post.tags.meta, ...post.tags.lore];
        return !pTags.some((t) => blTags.includes(t));
      });

      setFeedSearchResults(filteredPosts);
    } catch (e) {
      toast("Search error: " + (e instanceof Error ? e.message : String(e)), "error");
    } finally {
      setFeedSearchLoading(false);
    }
  }, [e621CredInfo, credWarned, blacklist, toast]);

  // --- LIBRARY MANAGEMENT ---
  const refreshLibraryRoot = useCallback(async () => {
    const cfg = await invoke<AppConfig>("get_config");
    setLibraryRoot(cfg.library_root || "");
  }, []);

  const changeLibraryRoot = useCallback(async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (!dir || Array.isArray(dir)) return;
    await invoke("set_library_root", { libraryRoot: dir });
    await refreshLibraryRoot();
    setPools([]);
    setSelectedPool(null);
    setPoolPosts([]);
    await loadData(false);
    try {
      const cachedPools = await invoke<PoolInfo[]>("load_pools_cache");
      if (cachedPools?.length) setPools(cachedPools);
    } catch { /* no cache for new library */ }
  }, [refreshLibraryRoot, loadData]);

  const openExternalUrl = useCallback(async (url: string) => {
    try { await openUrl(url); } catch (e) { console.error("Failed to open URL:", e); toast("Failed to open link.", "error"); }
  }, [toast]);

  const handlePageSizeChange = useCallback(async (newSize: number) => {
    setItemsPerPage(newSize);
    localStorage.setItem('items_per_page', String(newSize));
    setInitialLoading(true);
    try {
      await loadData(false, { pageSize: newSize });
    } finally {
      setInitialLoading(false);
    }
  }, [loadData]);

  const fetchTagSuggestions = useCallback(async (prefix: string) => {
    if (prefix.length < 2) {
      setTagSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    // Prevent overlapping requests
    if (isFetchingSuggestionsRef.current) return;
    isFetchingSuggestionsRef.current = true;
    try {
      const results = await invoke<{ name: string; tag_type: string; count: number }[]>("search_tags", { prefix, limit: 8 });
      setTagSuggestions(results);
      setShowSuggestions(results.length > 0);
      setSelectedSuggestionIndex(-1);
    } catch {
      setTagSuggestions([]);
      setShowSuggestions(false);
    } finally {
      isFetchingSuggestionsRef.current = false;
    }
  }, []);

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  }, []);

  const toggleTagAndSearch = useCallback((tag: string) => {
    pendingTagSearchRef.current = true;
    setSelectedTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  }, []);

  const deleteCurrentItem = useCallback(async () => {
    if (!currentItem) return;
    const deletedId = currentItem.item_id;
    await invoke("trash_item", { itemId: deletedId });
    setTrashCount(prev => prev + 1);

    // Optimistically remove from local state and clamp index
    setItems(prev => {
      const next = prev.filter(i => i.item_id !== deletedId);
      setCurrentIndex(ci => {
        if (next.length === 0) return 0;
        return Math.min(ci, next.length - 1);
      });
      return next;
    });
  }, [currentItem]);

  // --- TRASH ---
  const loadTrash = useCallback(async () => {
    const rows = await invoke<ItemDto[]>("get_trashed_items");
    setTrashedItems(rows.map(mapItemDto));
    setShowTrashModal(true);
  }, []);

  const handleRestore = useCallback(async (itemId: number) => {
    await invoke("restore_item", { itemId });
    setTrashedItems(prev => prev.filter(i => i.item_id !== itemId));
    setTrashCount(prev => Math.max(0, prev - 1));
    loadData(false);
  }, [loadData]);

  const handleEmptyTrash = useCallback(() => {
    setConfirmModal({
      title: "Empty Trash",
      message: "Permanently delete all items in trash? This cannot be undone.",
      okLabel: "Delete Forever",
      onConfirm: async () => {
        await invoke("empty_trash");
        setTrashedItems([]);
        setTrashCount(0);
      },
    });
  }, []);

  const loadPools = useCallback(async () => {
    if (!e621CredInfo.username || !e621CredInfo.has_api_key) {
      toast("Set e621 credentials in Settings first.", "error");
      return;
    }
    setPoolsLoading(true);
    setPoolScanProgress({ current: 0, total: 0 });

    try {
      const knownPoolIds: number[] = await invoke("get_known_pool_ids");

      const existingIds = new Set<number>();
      setPools(prev => { prev.forEach(p => existingIds.add(p.pool_id)); return prev; });

      const newDbPoolIds = knownPoolIds.filter(id => !existingIds.has(id));

      if (newDbPoolIds.length > 0) {
        const infos = await invoke<PoolInfo[]>("fetch_pool_infos_batch", { poolIds: newDbPoolIds });
        if (infos.length > 0) {
          setPools(prev => {
            const poolMap = new Map(prev.map(p => [p.pool_id, p]));
            infos.forEach(p => poolMap.set(p.pool_id, p));
            const next = Array.from(poolMap.values());
            next.sort((a, b) => a.name.localeCompare(b.name));
            invoke("save_pools_cache", { pools: next }).catch(console.error);
            return next;
          });
          infos.forEach(p => existingIds.add(p.pool_id));
        }
      }

      const localIds: number[] = await invoke("get_unscanned_e621_ids");

      if (localIds.length === 0) {
        return;
      }

      setPoolScanProgress({ current: 0, total: localIds.length });
      const discoveredPoolIds = new Set<number>();

      for (let i = 0; i < localIds.length; i += 100) {

        const chunk = localIds.slice(i, i + 100);
        try {
          const foundPoolIds = await invoke<number[]>("check_posts_for_pools", { ids: chunk });
          foundPoolIds.forEach(pid => {
            if (!existingIds.has(pid)) discoveredPoolIds.add(pid);
          });
        } catch (err) {
          console.warn("Chunk scan error", err);
        }
        setPoolScanProgress({ current: Math.min(i + 100, localIds.length), total: localIds.length });
      }

      const newPoolIds = Array.from(discoveredPoolIds);

      if (newPoolIds.length > 0) {
        const infos = await invoke<PoolInfo[]>("fetch_pool_infos_batch", { poolIds: newPoolIds });
        if (infos.length > 0) {
          setPools(prev => {
            const poolMap = new Map(prev.map(p => [p.pool_id, p]));
            infos.forEach(p => poolMap.set(p.pool_id, p));
            const next = Array.from(poolMap.values());
            next.sort((a, b) => a.name.localeCompare(b.name));
            invoke("save_pools_cache", { pools: next }).catch(console.error);
            return next;
          });
        }
      }
    } catch (e) {
      toast("Failed to scan pools: " + String(e), "error");
    } finally {
      setPoolsLoading(false);
      setPoolScanProgress(null);
    }
  }, [e621CredInfo, toast]);

  const openPool = useCallback(async (pool: PoolInfo) => {
    setSelectedPool(pool);
    setPoolPostsLoading(true);
    try {
      const posts = await invoke<PoolPost[]>("get_pool_posts", { poolId: pool.pool_id });
      setPoolPosts(posts);
      // Restore scroll position after render
      requestAnimationFrame(() => {
        const saved = poolScrollPositions.current.get(pool.pool_id);
        if (saved && comicContainerRef.current) {
          comicContainerRef.current.scrollTop = saved;
        }
      });
    } catch (e) {
      toast("Failed to load pool posts: " + String(e), "error");
    } finally {
      setPoolPostsLoading(false);
    }
  }, [toast]);

  const closePool = useCallback(() => {
    // Save scroll position before leaving
    if (selectedPool && comicContainerRef.current) {
      poolScrollPositions.current.set(selectedPool.pool_id, comicContainerRef.current.scrollTop);
    }
    setSelectedPool(null);
    setPoolPosts([]);
    setComicAutoscroll(false);
  }, [selectedPool]);

  // --- SELF IMPORT ---
  const selectImportFiles = useCallback(async () => {
    const files = await openDialog({
      multiple: true,
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'] },
        { name: 'Videos', extensions: ['mp4', 'webm'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (!files) return;
    const paths = Array.isArray(files) ? files : [files];
    setImportFiles(prev => {
      const set = new Set(prev);
      paths.forEach(p => set.add(p));
      return Array.from(set);
    });
  }, []);

  const openImportModal = useCallback(async () => {
    const files = await openDialog({
      multiple: true,
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'] },
        { name: 'Videos', extensions: ['mp4', 'webm'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (!files) return;
    const paths = Array.isArray(files) ? files : [files];
    if (paths.length === 0) return;
    setImportFiles(paths);
    setImportTags([]);
    setImportTagInput('');
    setImportRating('s');
    setImportSources([]);
    setImportSourceInput('');
    setShowImportModal(true);
  }, []);

  const handleImport = useCallback(async () => {
    if (importFiles.length === 0) return;
    setImportLoading(true);
    try {
      const result = await invoke<number>("import_local_files", {
        filePaths: importFiles,
        tags: importTags,
        rating: importRating,
        sources: importSources,
      });
      toast(`Imported ${result} file(s).`, "success");
      setShowImportModal(false);
      setImportFiles([]);
      setImportTags([]);
      setImportRating('s');
      setImportSources([]);
      setImportTagInput('');
      setImportSourceInput('');
      await loadData(false);
    } catch (e) {
      toast("Import failed: " + (e instanceof Error ? e.message : String(e)), "error");
    } finally {
      setImportLoading(false);
    }
  }, [importFiles, importTags, importRating, importSources, loadData, toast]);

  const handleClearPoolsCache = useCallback(() => {
    setConfirmModal({
      title: "Clear Cache",
      message: "Are you sure you want to clear the comics cache? You will need to rescan to see them again.",
      okLabel: "Clear",
      onConfirm: async () => {
        try {
          await invoke("clear_pools_cache");
          setPools([]);
          toast("Comics cache cleared.", "success");
        } catch (e) {
          toast("Failed to clear cache: " + String(e), "error");
        }
      },
    });
  }, [toast]);

  // --- MAINTENANCE ---
  const findDuplicates = useCallback(async () => {
    setDupLoading(true);
    try {
      const groups = await invoke<DuplicateGroup[]>("maintenance_find_duplicates");
      setDupGroups(groups);
      if (groups.length === 0) toast("No duplicates found.", "success");
    } catch (e) {
      toast("Failed: " + String(e), "error");
    } finally {
      setDupLoading(false);
    }
  }, [toast]);

  const trashDuplicate = useCallback(async (itemId: number) => {
    await invoke("trash_item", { itemId });
    setTrashCount(prev => prev + 1);
    setDupGroups(prev =>
      prev.map(g => ({ ...g, items: g.items.filter(i => i.item_id !== itemId) }))
          .filter(g => g.items.length > 1)
    );
    setItems(prev => {
      const next = prev.filter(i => i.item_id !== itemId);
      setCurrentIndex(ci => next.length === 0 ? 0 : Math.min(ci, next.length - 1));
      return next;
    });
  }, []);

  const startDeletedCheck = useCallback(async () => {
    try {
      await invoke("maintenance_start_deleted_check");
      setDeletedCheckStatus({ running: true, current: 0, total: 0, message: "Starting..." });
    } catch (e) { toast("Failed: " + String(e), "error"); }
  }, [toast]);

  const startMetadataUpdate = useCallback(async () => {
    try {
      await invoke("maintenance_start_metadata_update");
      setMetaUpdateStatus({ running: true, current: 0, total: 0, message: "Starting..." });
    } catch (e) { toast("Failed: " + String(e), "error"); }
  }, [toast]);

  const startFaUpgrade = useCallback(async () => {
    try {
      await invoke("maintenance_start_fa_upgrade");
      setFaUpgradeStatus({ running: true, current: 0, total: 0, message: "Starting..." });
    } catch (e) { toast("Failed: " + String(e), "error"); }
  }, [toast]);
  const unfavoriteDeletedPosts = useCallback(async () => {
    const posts = deletedResults;
    if (posts.length === 0) return;

    setUnfavoritingDeleted(true);
    setUnfavoriteProgress({ current: 0, total: posts.length });

    let success = 0;
    for (let i = 0; i < posts.length; i++) {
      try {
        await invoke("e621_unfavorite", { postId: posts[i].post_id });
        success++;
      } catch (e) {
        console.error("Failed to unfavorite:", posts[i].post_id, e);
      }
      setUnfavoriteProgress({ current: i + 1, total: posts.length });
      await new Promise(r => setTimeout(r, 600));
    }

    setUnfavoritingDeleted(false);
    toast(`Unfavorited ${success} of ${posts.length} deleted posts from e621.`, "success");
  }, [deletedResults, toast]);

  const handleUnlock = useCallback(async () => {
    setPinError('');
    try {
      const isSafe = await invoke<boolean>("verify_safe_pin", { pin: pinInput });
      if (isSafe) {
        setSafeMode(true);
        setIsLocked(false);
        setGlobalMute(false);
        setPinInput('');
        return;
      }

      const ok = await invoke<boolean>("verify_app_lock", { pin: pinInput });
      if (ok) {
        setSafeMode(false);
        setIsLocked(false);
        setGlobalMute(false);
        setPinInput('');
      } else {
        setPinError('Incorrect PIN');
        setPinInput('');
      }
    } catch (e) {
      setPinError(String(e));
    }
  }, [pinInput]);

  const handleSetLock = useCallback(async () => {
    if (lockNewPin.length < 4) {
      toast("PIN must be at least 4 characters.", "error");
      return;
    }
    if (lockNewPin !== lockConfirmPin) {
      toast("PINs don't match.", "error");
      return;
    }
    try {
      await invoke("set_app_lock", { pin: lockNewPin });
      setHasLock(true);
      setLockNewPin('');
      setLockConfirmPin('');
      toast("App lock enabled.", "success");
    } catch (e) {
      toast("Failed to set lock: " + String(e), "error");
    }
  }, [lockNewPin, lockConfirmPin, toast]);

  const handleRemoveLock = useCallback(async () => {
    if (!lockRemovePin) {
      toast("Enter your current PIN to remove lock.", "error");
      return;
    }
    try {
      await invoke("clear_app_lock", { pin: lockRemovePin });
      setHasLock(false);
      setLockRemovePin('');
      toast("App lock removed.", "success");
    } catch (e) {
      toast(String(e), "error");
    }
  }, [lockRemovePin, toast]);


  // --- EDIT MODAL ---
  const openEditModal = useCallback(() => {
    if (!currentItem) return;
    setEditingTags([...(currentItem.tags || [])]);
    setEditingSources([...(currentItem.sources || [])]);
    setEditingRating(currentItem.rating || "s");
    setNewTagInput("");
    setNewSourceInput("");
    setShowEditModal(true);
  }, [currentItem]);

  const saveMetadata = useCallback(async () => {
    if (!currentItem) return;
    try {
      await invoke("update_item_tags", { itemId: currentItem.item_id, tags: editingTags });
      await invoke("update_item_rating", { itemId: currentItem.item_id, rating: editingRating });
      await invoke("update_item_sources", { itemId: currentItem.item_id, sources: editingSources });

      setItems(prev => prev.map(item =>
        item.item_id === currentItem.item_id
          ? { ...item, tags: editingTags, rating: editingRating, sources: editingSources }
          : item
      ));
      setShowEditModal(false);
    } catch (error) {
      console.error("Failed to save metadata:", error);
      toast("Failed to save: " + String(error), "error");
    }
  }, [currentItem, editingTags, editingRating, editingSources]);

  // --- FURAFFINITY ---
  const refreshFaCreds = useCallback(async () => {
    try {
      const info = await invoke<{ has_creds: boolean }>("fa_get_cred_info");
      setFaCredsSet(info.has_creds);
    } catch (error) {
      console.error("Failed to check FA creds:", error);
    }
  }, []);

  const startFaSync = useCallback(async () => {
    if (!faCredsSet && (!faCreds.a || !faCreds.b)) {
      toast("Please save cookies first.", "error");
      return;
    }
    if (faCreds.a && faCreds.b) {
      await invoke("fa_set_credentials", { a: faCreds.a, b: faCreds.b });
      setFaCredsSet(true);
    }

    const parsed = parsePositiveInt(faLimit);
    if (!parsed.ok) { toast("Limit must be a positive number or blank.", "error"); return; }

    await invoke("fa_start_sync", { limit: parsed.value });

    // Clear any previous interval before starting a new one
    if (faSyncIntervalRef.current) {
      clearInterval(faSyncIntervalRef.current);
    }

    faSyncIntervalRef.current = setInterval(async () => {
      const st = await invoke<FASyncStatus>("fa_sync_status");
      setFaStatus(st);
      if (!st.running) {
        if (faSyncIntervalRef.current) {
          clearInterval(faSyncIntervalRef.current);
          faSyncIntervalRef.current = null;
        }
        loadData(false);
      }
    }, 1000);
  }, [faCredsSet, faCreds, faLimit, loadData, toast]);

  const cancelFaSync = useCallback(async () => {
    await invoke("fa_cancel_sync");
  }, []);

  // --- EFFECTS ---

  // Init
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      // Check app lock first
      try {
        const locked = await invoke<boolean>("has_app_lock");
        setHasLock(locked);
        if (!locked) {
          setIsLocked(false);
        }
        setLockChecked(true);
      } catch {
        setIsLocked(false);
        setLockChecked(true);
      }

      setInitialLoading(true);
      try {
        const cfg = await invoke<AppConfig>("get_config");
        const root = cfg.library_root || "";
        setLibraryRoot(root);

        if (root) {
          await loadData(false);
        }
        
        loadFeeds();
        await refreshE621CredInfo();
        await refreshFaCreds();
        // Load cached pools on startup
        try {
          const cachedPools = await invoke<PoolInfo[]>("load_pools_cache");
          if (cachedPools && cachedPools.length > 0 && !cancelled) {
            setPools(cachedPools);
          }
        } catch (e) {
          console.warn("No pools cache found or failed to load");
        }
      } catch (error) {
        if (!cancelled) console.error("Failed to initialize:", error);
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    };
    init();
    invoke<number>("get_trash_count").then(setTrashCount).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync status polling
  useEffect(() => {
    if (!showSettings) return;
    const tick = async () => {
      try {
        const st = await invoke<SyncStatus>("e621_sync_status");
        setSyncStatus(st);
        if (syncWasRunningRef.current && !st.running) { await loadData(false); }
        syncWasRunningRef.current = st.running;
      } catch { /* ignore */ }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [showSettings, loadData]);

  // Auto-select first post when switching feeds (only if detail pane is open)
  const prevFeedIdRef = useRef(selectedFeedId);
  const pendingFeedSelectRef = useRef<number | null>(null);
  
  useEffect(() => {
    if (selectedFeedId === null || feedSearchInput) return;
    
    const feedChanged = prevFeedIdRef.current !== selectedFeedId;
    prevFeedIdRef.current = selectedFeedId;
    
    // When feed changes, mark it as pending if pane is open
    if (feedChanged && feedDetailOpen) {
      pendingFeedSelectRef.current = selectedFeedId;
    }
    
    // If we're not waiting for this feed to load, skip
    if (pendingFeedSelectRef.current !== selectedFeedId) return;
    
    const posts = feedPosts[selectedFeedId];
    if (posts && posts.length > 0) {
      setFeedPostIndex(0);
      setSelectedFeedPost(posts[0]);
      pendingFeedSelectRef.current = null;
    }
  }, [selectedFeedId, feedPosts, feedSearchInput, feedDetailOpen]);

  // Trash count
  useEffect(() => {
    if (showSettings) {
      invoke<number>("get_trash_count").then(setTrashCount).catch(() => {});
    }
  }, [showSettings]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (target && target.tagName === "SELECT") { (target as HTMLElement).blur(); }

      const key = e.key.toLowerCase();

      if (e.key === "Escape") {
        e.preventDefault();
        if (confirmModal) { setConfirmModal(null); return; }
        if (showSettings) { setShowSettings(false); return; }
        if (showEditModal) { setShowEditModal(false); return; }
        if (showTrashModal) { setShowTrashModal(false); return; }
        if (showAddFeedModal) { setShowAddFeedModal(false); return; }
        if (viewerOverlay) {
          pokeHud();
          if (document.fullscreenElement) document.exitFullscreen();
          setViewerOverlay(false);
          return;
        }
        if (activeTab === 'comics' && selectedPool) { closePool(); return; }
        if (showBulkTagModal) { setShowBulkTagModal(false); return; }
        if (selectedItemIds.size > 0) { deselectAll(); return; }
        if (activeTab === 'viewer' && libraryDetailOpen) { setLibraryDetailOpen(false); return; }
      }
      if (showImportModal) { setShowImportModal(false); return; }
      // Comic zoom: Ctrl+ / Ctrl-
      if (activeTab === 'comics' && selectedPool && (e.ctrlKey || e.metaKey)) {
        if (key === '=' || key === '+') {
          e.preventDefault();
          setComicScale(s => Math.min(100, s + 10));
          return;
        }
        if (key === '-') {
          e.preventDefault();
          setComicScale(s => Math.max(10, s - 10));
          return;
        }
      }

      if (key === "s") { e.preventDefault(); setShowSettings(prev => !prev); }
      // Bulk select all: Ctrl+A in library
      if (activeTab === 'viewer' && key === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        selectAll();
        return;
      }
      if (key === "l" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (hasLock) {
          setIsLocked(true);
          setGlobalMute(true);
          setSafeMode(false);
          setPinInput('');
          setPinError('');
        }
      }

      if (activeTab === "viewer") {
        if (key === "a" || e.key === "ArrowLeft") { e.preventDefault(); goToPrev(true); }
        else if (key === "d" || e.key === "ArrowRight") { e.preventDefault(); goToNext(true); }
        else if (key === "f") {
          e.preventDefault();
          (async () => {
            try {
              if (!document.fullscreenElement) {
                if (isVideo && detailVideoRef.current) {
                  savedVideoTimeRef.current = detailVideoRef.current.currentTime;
                  detailVideoRef.current.pause();
                }
                await document.documentElement.requestFullscreen();
                setViewerOverlay(true);
              } else {
                if (isVideo && fullscreenVideoRef.current) {
                  savedVideoTimeRef.current = fullscreenVideoRef.current.currentTime;
                }
                await document.exitFullscreen();
                setViewerOverlay(false);
              }
            } catch (e) {
              console.warn("Fullscreen request failed:", e);
            }
          })();
        }
        else if (key === "m") { e.preventDefault(); setAutoMuteVideos(v => !v); }
        else if (key === "v") { e.preventDefault(); setWaitForVideoEnd(v => !v); }
        else if (key === "e") {
          e.preventDefault();
          openEditModal();
        }
      }

      if (activeTab === "feeds" && feedDetailOpen && selectedFeedPost) {
        if (key === "a" || e.key === "ArrowLeft") { e.preventDefault(); goToPrevFeedPost(); }
        else if (key === "d" || e.key === "ArrowRight") { e.preventDefault(); goToNextFeedPost(); }
        else if (key === "s" || key === " ") {
          e.preventDefault();
          ensureFavorite(selectedFeedId ?? -1, selectedFeedPost);
        }
        else if (key === "f") {
          e.preventDefault();
          (async () => {
            try {
              const isFeedVideo = selectedFeedPost && (selectedFeedPost.file.ext === 'webm' || selectedFeedPost.file.ext === 'mp4');
              if (!document.fullscreenElement) {
                if (isFeedVideo && feedDetailVideoRef.current) {
                  savedFeedVideoTimeRef.current = feedDetailVideoRef.current.currentTime;
                  feedDetailVideoRef.current.pause();
                }
                await document.documentElement.requestFullscreen();
                setFeedViewerOverlay(true);
              } else {
                if (isFeedVideo && feedFullscreenVideoRef.current) {
                  savedFeedVideoTimeRef.current = feedFullscreenVideoRef.current.currentTime;
                }
                await document.exitFullscreen();
                setFeedViewerOverlay(false);
              }
            } catch (e) {
              console.warn("Fullscreen request failed:", e);
            }
          })();
        }
        else if (key === "m") { e.preventDefault(); setAutoMuteVideos(v => !v); }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab, viewerOverlay, pokeHud, goToPrev, goToNext, openEditModal,
    showSettings, showEditModal, showTrashModal, showAddFeedModal, showImportModal,
    selectedPool, closePool, confirmModal, libraryDetailOpen,
    selectedItemIds, deselectAll, selectAll, showBulkTagModal,
    feedDetailOpen, selectedFeedPost, goToPrevFeedPost, goToNextFeedPost,
    ensureFavorite, selectedFeedId]);

  // HUD management
  useEffect(() => { if (viewerOverlay) pokeHud(); }, [viewerOverlay, pokeHud]);
  useEffect(() => {
    return () => {
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
      if (faSyncIntervalRef.current) clearInterval(faSyncIntervalRef.current);
      feedDragCleanupRef.current?.();
    };
  }, []);

  // Auto-lock on OS lock (screen lock / sleep)
  useEffect(() => {
    if (!hasLock) return;
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        setIsLocked(true);
        setGlobalMute(true);
        setSafeMode(false);
        setPinInput('');
        setPinError('');
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [hasLock]);

  // Fullscreen exit handler
  useEffect(() => {
    const handler = () => {
      if (!document.fullscreenElement) {
        if (viewerOverlay && fullscreenVideoRef.current && isVideo) {
          savedVideoTimeRef.current = fullscreenVideoRef.current.currentTime;
        }
        if (feedViewerOverlay && feedFullscreenVideoRef.current) {
          const isFeedVideo = selectedFeedPost && (selectedFeedPost.file.ext === 'webm' || selectedFeedPost.file.ext === 'mp4');
          if (isFeedVideo) {
            savedFeedVideoTimeRef.current = feedFullscreenVideoRef.current.currentTime;
          }
        }

        if (viewerOverlay) setViewerOverlay(false);
        if (feedViewerOverlay) setFeedViewerOverlay(false);

        // Resume library video after fullscreen exit
        if (isVideo) {
          setTimeout(() => {
            if (detailVideoRef.current) {
              if (savedVideoTimeRef.current > 0) {
                detailVideoRef.current.currentTime = savedVideoTimeRef.current;
                savedVideoTimeRef.current = 0;
              }
              detailVideoRef.current.play().catch(() => {});
            }
          }, 300);
        }

        // Resume feed video after fullscreen exit
        const isFeedVideo = selectedFeedPost && (selectedFeedPost.file.ext === 'webm' || selectedFeedPost.file.ext === 'mp4');
        if (isFeedVideo) {
          setTimeout(() => {
            if (feedDetailVideoRef.current) {
              if (savedFeedVideoTimeRef.current > 0) {
                feedDetailVideoRef.current.currentTime = savedFeedVideoTimeRef.current;
                savedFeedVideoTimeRef.current = 0;
              }
              feedDetailVideoRef.current.play().catch(() => {});
            }
          }, 300);
        }
      }
    };
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, [viewerOverlay, feedViewerOverlay, isVideo, selectedFeedPost]);

  // Persist preferences
  useEffect(() => { try { localStorage.setItem('preferred_sort_order', sortOrder); } catch { /* ignore */ } }, [sortOrder]);
  useEffect(() => { localStorage.setItem('blacklist_tags', blacklist); }, [blacklist]);

  useEffect(() => {
    document.documentElement.style.backgroundColor = '#0f0f17';
    document.body.style.backgroundColor = '#0f0f17';
    return () => {
      document.documentElement.style.backgroundColor = '';
      document.body.style.backgroundColor = '';
    };
  }, []);

  // Feed slideshow
  useEffect(() => {
    if (!feedSlideshow || currentFeedPosts.length === 0 || !selectedFeedPost) return;
    const currentExt = (selectedFeedPost.file.ext || '').toLowerCase();
    const isFeedVideo = VIDEO_EXTENSIONS.includes(currentExt);
    if (waitForVideoEnd && isFeedVideo) return;

    const timeout = setTimeout(() => {
      setFeedFadeIn(false);
      setTimeout(() => {
        const nextIndex = (feedPostIndex + 1) % currentFeedPosts.length;
        setFeedPostIndex(nextIndex);
        setSelectedFeedPost(currentFeedPosts[nextIndex]);
        requestAnimationFrame(() => setFeedFadeIn(true));
      }, FADE_DURATION_MS);
    }, slideshowSpeed);

    return () => clearTimeout(timeout);
  }, [feedSlideshow, slideshowSpeed, waitForVideoEnd, selectedFeedPost, feedPostIndex, currentFeedPosts]);

  // Slideshow: timer resets on each slide change via currentIndex dep.
  // isVideo dep changes with currentIndex since it's derived from currentItem.
  useEffect(() => {
    if (!isSlideshow || itemCount === 0) return;
    if (waitForVideoEnd && isVideo) return;

    const timeout = setTimeout(() => {
      setFadeIn(false);
      setTimeout(() => {
        setCurrentIndex(prev => {
          const len = itemsRef.current.length;
          return len === 0 ? 0 : (prev + 1) % len;
        });
        requestAnimationFrame(() => setFadeIn(true));
      }, FADE_DURATION_MS);
    }, slideshowSpeed);

    return () => clearTimeout(timeout);
  }, [isSlideshow, slideshowSpeed, waitForVideoEnd, isVideo, currentIndex]);

    useEffect(() => {
    if (!showSpeedSlider) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (speedSliderRef.current && !speedSliderRef.current.contains(e.target as Node)) {
        setShowSpeedSlider(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSpeedSlider]);

  useEffect(() => {
    if (!currentItem || currentItem.source !== 'e621') {
      setCurrentPostPools([]);
      return;
    }
    let cancelled = false;
    invoke<PoolInfo[]>("get_post_pools", { sourceId: currentItem.source_id })
      .then(pools => { if (!cancelled) setCurrentPostPools(pools); })
      .catch(() => { if (!cancelled) setCurrentPostPools([]); });
    return () => { cancelled = true; };
  }, [currentItem?.item_id]);

  // Image preloading (removed imageCache from deps to prevent loop)
  const imageCacheRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (itemCount === 0) return;
    const preloadIndexes = [
      currentIndex,
      (currentIndex + 1) % itemCount,
      (currentIndex + 2) % itemCount,
      (currentIndex - 1 + itemCount) % itemCount,
    ];

    const images: HTMLImageElement[] = [];

    preloadIndexes.forEach(idx => {
      const item = items[idx];
      if (!item || imageCacheRef.current[item.url] || ["mp4", "webm"].includes((item.ext || "").toLowerCase())) return;
      const img = new Image();
      img.src = item.url;
      img.onload = () => { imageCacheRef.current[item.url] = true; };
      images.push(img);
    });

    return () => {
      images.forEach(img => {
        img.onload = null;
        img.onerror = null;
        // Use data URI instead of empty string to avoid phantom request to current page
        img.src = "data:,";
      });
    };
  }, [currentIndex, itemCount, items]);

  // Auto-load more when near end in single view
  useEffect(() => {
    const threshold = Math.max(0, itemCount - 50);
    if (hasMoreItems && !isLoadingMore && currentIndex >= threshold && itemCount > 0) {
      loadMoreItems();
    }
  }, [currentIndex, itemCount, hasMoreItems, isLoadingMore, loadMoreItems]);

  // Reload when filters change
  const isFirstMountRef = useRef(true);
  const filterKeyRef = useRef("");
  useEffect(() => {
    const key = `${sortOrder}|${filterSource}|${safeMode}`;
    if (filterKeyRef.current === key) return;
    filterKeyRef.current = key;

    if (isFirstMountRef.current) {
      isFirstMountRef.current = false;
      return;
    }

    if (!initialLoading) {
      // Cancel any in-flight requests
      loadRequestIdRef.current++;
      itemsRef.current = [];
      hasMoreRef.current = true;
      setItems([]);
      setSelectedItemIds(new Set());
      setHasMoreItems(true);
      setCurrentIndex(0);
      loadData(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortOrder, filterSource, safeMode]);

  // Autoscroll
  const autoscrollTargetRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!autoscroll) return;
    let frameId: number;
    const scroll = () => {
      // Find the scrollable container for both library and feeds
      if (!autoscrollTargetRef.current) {
        const candidates = document.querySelectorAll('.overflow-y-auto');
        for (const el of candidates) {
          if (el.scrollHeight > el.clientHeight) {
            autoscrollTargetRef.current = el as HTMLElement;
            break;
          }
        }
      }
      if (autoscrollTargetRef.current) {
        autoscrollTargetRef.current.scrollBy(0, autoscrollSpeed);
      } else {
        window.scrollBy(0, autoscrollSpeed);
      }
      frameId = requestAnimationFrame(scroll);
    };
    frameId = requestAnimationFrame(scroll);
    return () => {
      cancelAnimationFrame(frameId);
      autoscrollTargetRef.current = null;
    };
  }, [autoscroll, autoscrollSpeed, activeTab]);

  // Comic autoscroll
  useEffect(() => {
    if (!comicAutoscroll || !comicContainerRef.current) return;
    let frameId: number;
    const scroll = () => {
      comicContainerRef.current?.scrollBy(0, comicAutoscrollSpeed);
      frameId = requestAnimationFrame(scroll);
    };
    frameId = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frameId);
  }, [comicAutoscroll, comicAutoscrollSpeed]);

  // Maintenance task polling
  useEffect(() => {
    if (!showSettings || settingsTab !== 'maintenance') return;
    const anyRunning = deletedCheckStatus?.running || metaUpdateStatus?.running || faUpgradeStatus?.running;
    if (!anyRunning) return;

    const tick = async () => {
      try {
        if (deletedCheckStatus?.running) {
          const st = await invoke<MaintenanceProgress>("maintenance_deleted_check_status");
          setDeletedCheckStatus(st);
          if (!st.running) {
            // Fetch results when check completes
            try {
              const results = await invoke<DeletedPostInfo[]>("maintenance_get_deleted_results");
              setDeletedResults(results);
            } catch { /* ignore */ }
            loadData(false);
          }
        }
      } catch { /* command may not exist yet */ }
      try {
        if (metaUpdateStatus?.running) {
          const st = await invoke<MaintenanceProgress>("maintenance_metadata_update_status");
          setMetaUpdateStatus(st);
          if (!st.running) loadData(false);
        }
      } catch { /* command may not exist yet */ }
      try {
        if (faUpgradeStatus?.running) {
          const st = await invoke<MaintenanceProgress>("maintenance_fa_upgrade_status");
          setFaUpgradeStatus(st);
          if (!st.running) loadData(false);
        }
      } catch { /* command may not exist yet */ }
    };

    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [showSettings, settingsTab, deletedCheckStatus?.running, metaUpdateStatus?.running, faUpgradeStatus?.running, loadData]);

  // Tag search — only fires when explicitly requested
  useEffect(() => {
    if (!pendingTagSearchRef.current) return;
    pendingTagSearchRef.current = false;
    setItems([]);
    setSelectedItemIds(new Set());
    setHasMoreItems(true);
    loadData(false);
  }, [selectedTags, loadData]);

  // --- RENDER HELPERS ---
  const handleItemSelect = useCallback((index: number) => {
    setCurrentIndex(index);
    setLibraryDetailOpen(true);
  }, []);
  const handleGridClick = useCallback((index: number, e: React.MouseEvent) => {
    const item = items[index];
    if (!item) return;

    if (e.ctrlKey || e.metaKey) {
      // Ctrl+click: toggle individual
      e.preventDefault();
      setSelectedItemIds(prev => {
        const next = new Set(prev);
        if (next.has(item.item_id)) {
          next.delete(item.item_id);
        } else {
          next.add(item.item_id);
        }
        return next;
      });
      setLastClickedIndex(index);
      return;
    }

    if (e.shiftKey && lastClickedIndex !== null) {
      // Shift+click: range select
      e.preventDefault();
      const start = Math.min(lastClickedIndex, index);
      const end = Math.max(lastClickedIndex, index);
      setSelectedItemIds(prev => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          if (items[i]) next.add(items[i].item_id);
        }
        return next;
      });
      return;
    }

    // Normal click: open detail pane, clear selection
    if (selectedItemIds.size > 0) {
      setSelectedItemIds(new Set());
    }
    setLastClickedIndex(index);
    handleItemSelect(index);
  }, [items, lastClickedIndex, selectedItemIds, handleItemSelect]);

  const bulkTrash = useCallback(async () => {
    if (selectedItemIds.size === 0) return;
    const ids = Array.from(selectedItemIds);

    for (const id of ids) {
      await invoke("trash_item", { itemId: id });
    }

    setTrashCount(prev => prev + ids.length);

    // Use ids array (captured above) instead of selectedItemIds Set directly
    const idSet = new Set(ids);
    setItems(prev => {
      const next = prev.filter(i => !idSet.has(i.item_id));
      setCurrentIndex(ci => {
        if (next.length === 0) return 0;
        return Math.min(ci, next.length - 1);
      });
      return next;
    });

    setSelectedItemIds(new Set());
    toast(`Moved ${ids.length} items to trash.`, "success");
  }, [selectedItemIds, toast]);

  const bulkAddTag = useCallback(async () => {
    const tag = bulkTagInput.trim().toLowerCase();
    if (!tag || selectedItemIds.size === 0) return;
    const ids = Array.from(selectedItemIds);
    for (const id of ids) {
      const item = items.find(i => i.item_id === id);
      if (!item) continue;
      const currentTags = [...(item.tags || [])];
      if (!currentTags.includes(tag)) {
        currentTags.push(tag);
        await invoke("update_item_tags", { itemId: id, tags: currentTags });
      }
    }
    // Refresh items
    setItems(prev => prev.map(item => {
      if (selectedItemIds.has(item.item_id) && !item.tags.includes(tag)) {
        return { ...item, tags: [...item.tags, tag], tags_general: [...item.tags_general, tag] };
      }
      return item;
    }));
    setBulkTagInput('');
    setShowBulkTagModal(false);
    toast(`Added "${tag}" to ${ids.length} items.`, "success");
  }, [bulkTagInput, selectedItemIds, items, toast]);

  const bulkRemoveTag = useCallback(async () => {
    const tag = bulkTagInput.trim().toLowerCase();
    if (!tag || selectedItemIds.size === 0) return;
    const ids = Array.from(selectedItemIds);
    for (const id of ids) {
      const item = items.find(i => i.item_id === id);
      if (!item) continue;
      const currentTags = (item.tags || []).filter(t => t !== tag);
      await invoke("update_item_tags", { itemId: id, tags: currentTags });
    }
    setItems(prev => prev.map(item => {
      if (selectedItemIds.has(item.item_id)) {
        return {
          ...item,
          tags: item.tags.filter(t => t !== tag),
          tags_general: item.tags_general.filter(t => t !== tag),
          tags_artist: item.tags_artist.filter(t => t !== tag),
          tags_character: item.tags_character.filter(t => t !== tag),
          tags_copyright: item.tags_copyright.filter(t => t !== tag),
          tags_species: item.tags_species.filter(t => t !== tag),
          tags_meta: item.tags_meta.filter(t => t !== tag),
          tags_lore: item.tags_lore.filter(t => t !== tag),
        };
      }
      return item;
    }));
    setBulkTagInput('');
    setShowBulkTagModal(false);
    toast(`Removed "${tag}" from ${ids.length} items.`, "success");
  }, [bulkTagInput, selectedItemIds, items, toast]);

  const handleLibraryDetailResize = useCallback((clientX: number) => {
    const containerWidth = window.innerWidth;
    const newWidth = Math.max(300, Math.min(containerWidth - clientX, containerWidth * 0.6));
    setLibraryDetailWidth(newWidth);
    localStorage.setItem('library_detail_width', String(Math.round(newWidth)));
  }, []);

  const handleFeedDetailResize = useCallback((clientX: number) => {
    if (!feedsContainerRef.current) return;
    const rect = feedsContainerRef.current.getBoundingClientRect();
    const newWidth = Math.max(300, Math.min(rect.right - clientX, rect.width * 0.65));
    setFeedDetailWidth(newWidth);
    localStorage.setItem('feed_detail_width', String(Math.round(newWidth)));
  }, []);

const shouldHideAutoscroll = showSettings || showEditModal || showTrashModal || activeTab === 'comics';
  // --- RENDER ---
  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[#0f0f17] text-white">
      {/* Lock Screen */}
      {(!lockChecked || (isLocked && hasLock)) && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-[#0f0f17]">
          {lockChecked ? (
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-[#1d1b2d] flex items-center justify-center">
                <svg className="w-8 h-8 text-[#967abc]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
              </div>
              <h2 className="text-xl font-bold text-white mb-2">TailBurrow</h2>
              <p className="text-[#4c4b5a] text-sm mb-6">Enter PIN to unlock</p>
              <div className="flex gap-2 justify-center mb-3">
                <input
                  type="password"
                  value={pinInput}
                  onChange={(e) => { setPinInput(e.target.value); setPinError(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleUnlock(); }}
                  placeholder="••••"
                  maxLength={16}
                  autoFocus
                  className="w-48 px-4 py-3 text-center text-lg tracking-[0.3em] rounded-xl bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc] focus:outline-none text-white placeholder-[#4c4b5a]"
                />
              </div>
              {pinError && <p className="text-red-400 text-sm mb-3">{pinError}</p>}
              <button
                onClick={handleUnlock}
                disabled={!pinInput}
                className="px-8 py-2.5 rounded-xl bg-[#967abc] hover:bg-[#967abc]/80 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Unlock
              </button>
            </div>
          ) : (
            <div className="w-16 h-16 rounded-2xl bg-[#1d1b2d] flex items-center justify-center animate-pulse">
              <svg className="w-8 h-8 text-[#967abc]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            </div>
          )}
        </div>
      )}

      {/* Welcome Screen - First Time Setup */}
      {lockChecked && !isLocked && !libraryRoot && !initialLoading && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#0f0f17] text-white">
          <div className="max-w-2xl px-8 text-center">
            <div className="w-24 h-24 mx-auto mb-8 rounded-3xl bg-gradient-to-br from-[#967abc] to-[#6b4d8a] flex items-center justify-center">
              <Database className="w-12 h-12 text-white" />
            </div>
            <h1 className="text-4xl font-bold mb-4 bg-gradient-to-r from-[#967abc] to-[#c9a3e8] bg-clip-text text-transparent">
              Welcome to TailBurrow
            </h1>
            <p className="text-lg text-[#9e98aa] mb-8 leading-relaxed">
              Your personal e621, FurAffinity, and local media archive. Let's get started by setting up your library.
            </p>
            <div className="bg-[#161621] rounded-2xl border border-[#1d1b2d] p-8 mb-8 text-left">
              <h2 className="text-xl font-semibold mb-6 text-[#967abc]">Quick Setup</h2>
              <div className="space-y-4">
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-[#967abc]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-[#967abc] font-bold">1</span>
                  </div>
                  <div>
                    <h3 className="font-medium mb-1">Choose a Library Folder</h3>
                    <p className="text-sm text-[#9e98aa]">Select an empty folder where TailBurrow will store your downloads and database.</p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-[#967abc]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-[#967abc] font-bold">2</span>
                  </div>
                  <div>
                    <h3 className="font-medium mb-1">Add e621 Credentials</h3>
                    <p className="text-sm text-[#9e98aa]">Required for downloading favorites, searching feeds, and accessing the API.</p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-[#967abc]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-[#967abc] font-bold">3</span>
                  </div>
                  <div>
                    <h3 className="font-medium mb-1">Start Archiving</h3>
                    <p className="text-sm text-[#9e98aa]">Sync your favorites, browse feeds, or import local files.</p>
                  </div>
                </div>
              </div>
            </div>
            <button
              onClick={changeLibraryRoot}
              className="px-8 py-4 rounded-xl bg-[#967abc] hover:bg-[#967abc]/80 text-white font-semibold text-lg transition-all transform hover:scale-105 shadow-lg hover:shadow-[#967abc]/50"
            >
              Choose Library Folder
            </button>
            <p className="mt-8 text-xs text-[#4c4b5a]">TailBurrow v{APP_VERSION}</p>
          </div>
        </div>
      )}

      {/* e621 Credentials Required Screen */}
      {lockChecked && !isLocked && !initialLoading && libraryRoot && !e621CredInfo.has_api_key && !showSettings && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-[#0f0f17] text-white">
          <div className="max-w-xl px-8">
            <div className="bg-[#161621] rounded-2xl border border-[#1d1b2d] p-8">
              <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-[#967abc]/20 flex items-center justify-center">
                <Shield className="w-8 h-8 text-[#967abc]" />
              </div>
              <h2 className="text-2xl font-bold mb-4 text-center">e621 Credentials Required</h2>
              <p className="text-[#9e98aa] mb-6 text-center">
                TailBurrow needs your e621 API credentials to download favorites, search feeds, and access the full catalog.
              </p>
              <div className="space-y-4 mb-6">
                <div>
                  <label className="block text-sm font-medium mb-2 text-[#9e98aa]">Username</label>
                  <input
                    type="text"
                    value={apiUsername}
                    onChange={(e) => setApiUsername(e.target.value)}
                    placeholder="Your e621 username"
                    className="w-full px-4 py-3 rounded-xl bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc] focus:outline-none text-white placeholder-[#4c4b5a]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2 text-[#9e98aa]">API Key</label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Your e621 API key"
                    className="w-full px-4 py-3 rounded-xl bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc] focus:outline-none text-white placeholder-[#4c4b5a]"
                  />
                </div>
              </div>
              <div className="bg-[#1c1b26] rounded-xl p-4 mb-6 border border-[#1d1b2d]">
                <p className="text-xs text-[#9e98aa] mb-2">
                  <strong className="text-white">How to get your API key:</strong>
                </p>
                <ol className="text-xs text-[#9e98aa] space-y-1 list-decimal list-inside">
                  <li>Log in to <button onClick={() => openExternalUrl("https://e621.net")} className="text-[#967abc] hover:underline">e621.net</button></li>
                  <li>Go to Account → Manage API Access</li>
                  <li>Create a new API key</li>
                  <li>Copy and paste it above</li>
                </ol>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setShowSettings(true);
                    setSettingsTab('credentials');
                  }}
                  className="flex-1 px-4 py-3 rounded-xl bg-[#1d1b2d] hover:bg-[#4c4b5a] text-[#9e98aa] transition-colors text-sm"
                >
                  Skip for Now
                </button>
                <button
                  onClick={async () => {
                    await saveE621Credentials();
                  }}
                  disabled={!apiUsername.trim() || !apiKey.trim()}
                  className="flex-1 px-4 py-3 rounded-xl bg-[#967abc] hover:bg-[#967abc]/80 text-white font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Save & Continue
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className={`border-b flex-shrink-0 border-[#1d1b2d] bg-[#161621]`}>
        <div className={"px-4"}>
          <div className="flex items-center gap-4 py-2">
            <div className="flex gap-1 flex-shrink-0">
              <button onClick={() => setActiveTab('viewer')} className={`px-3 py-1.5 font-medium border-b-2 transition flex items-center gap-1.5 text-sm ${activeTab === 'viewer' ? 'border-[#967abc] text-[#967abc]' : 'border-transparent text-[#9e98aa] hover:text-white'}`}><Database className="w-3.5 h-3.5" />Library</button>
              <button onClick={() => {
                setActiveTab('feeds');
                if (feeds.length > 0 && !selectedFeedId && !feedSearchInput) {
                  const firstFeed = feeds[0];
                  setSelectedFeedId(firstFeed.id);
                  if (!feedPosts[firstFeed.id] || feedPosts[firstFeed.id].length === 0) {
                    fetchFeedPosts(firstFeed.id, firstFeed.query, { reset: true });
                  }
                }
              }} className={`px-3 py-1.5 font-medium border-b-2 transition flex items-center gap-1.5 text-sm ${activeTab === 'feeds' ? 'border-[#967abc] text-[#967abc]' : 'border-transparent text-[#9e98aa] hover:text-white'}`}><Rss className="w-3.5 h-3.5" />Discover</button>
              <button onClick={() => setActiveTab('comics')} className={`px-3 py-1.5 font-medium border-b-2 transition flex items-center gap-1.5 text-sm ${activeTab === 'comics' ? ('border-[#967abc] text-[#967abc]') : ('border-transparent text-[#9e98aa] hover:text-white')}`}><BookOpen className="w-3.5 h-3.5" />Comics</button>
            </div>

            <div className="flex flex-1 items-center gap-2 min-w-0">
              {activeTab === 'viewer' || activeTab === 'comics' ? (
                <>
                  <div className="flex-1 min-w-[150px] relative">
                    {activeTab === 'comics' && (
                      <Search className="absolute left-3 top-2 w-3.5 h-3.5 text-[#4c4b5a]" />
                    )}
                      {activeTab === 'comics' ? (
                        <input
                          type="text"
                          placeholder="Search comics by name or pool:12345"
                          value={comicSearchInput}
                          onChange={(e) => setComicSearchInput(e.target.value)}
                          className="w-full pl-9 pr-3 py-1.5 text-sm rounded-xl focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc] text-white placeholder-[#4c4b5a]"
                        />
                      ) : (
                        <div className="w-full relative flex items-center flex-wrap gap-1 min-h-[34px] pl-9 pr-3 py-1 rounded-xl bg-[#1c1b26] border border-[#1d1b2d] focus-within:border-[#967abc] transition-colors">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#4c4b5a] pointer-events-none" />
                          {selectedTags.map(tag => {
                            const isNegative = tag.startsWith('-');
                            return (
                              <span
                                key={tag}
                                className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border cursor-pointer select-none ${
                                  isNegative
                                    ? 'bg-red-500/20 text-red-400 border-red-500/30'
                                    : 'bg-[#967abc]/25 text-[#967abc] border-[#967abc]/30'
                                }`}
                                onClick={() => {
                                  pendingTagSearchRef.current = true;
                                  setSelectedTags(prev =>
                                    prev.map(t => t === tag ? (isNegative ? tag.slice(1) : `-${tag}`) : t)
                                  );
                                }}
                              >
                                {isNegative && <span className="font-bold mr-0.5">−</span>}
                                {isNegative ? tag.slice(1) : tag}
                                <button
                                  onClick={(e) => { e.stopPropagation(); pendingTagSearchRef.current = true; toggleTag(tag); }}
                                  className="transition-colors"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </span>
                            );
                          })}
                          <div className="flex-1 min-w-[80px] relative">
                            <input
                              type="text"
                              placeholder={selectedTags.length === 0 ? "Search tags..." : ""}
                              value={searchTags}
                              onChange={(e) => {
                                const val = e.target.value;
                                if (val.endsWith(' ')) {
                                  const tag = val.trim().toLowerCase();
                                  if (tag && !selectedTags.includes(tag)) {
                                    setSelectedTags(prev => [...prev, tag]);
                                  }
                                  setSearchTags('');
                                  setShowSuggestions(false);
                                } else {
                                  setSearchTags(val);
                                  if (suggestionTimeoutRef.current) clearTimeout(suggestionTimeoutRef.current);
                                  suggestionTimeoutRef.current = setTimeout(() => fetchTagSuggestions(val.trim()), 400);
                                }
                              }}
                              onKeyDown={(e) => {
                                if (showSuggestions && tagSuggestions.length > 0) {
                                  if (e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    setSelectedSuggestionIndex(prev => Math.min(prev + 1, tagSuggestions.length - 1));
                                    return;
                                  }
                                  if (e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    setSelectedSuggestionIndex(prev => Math.max(prev - 1, -1));
                                    return;
                                  }
                                  if (e.key === 'Tab' && selectedSuggestionIndex >= 0) {
                                    e.preventDefault();
                                    const tag = tagSuggestions[selectedSuggestionIndex].name;
                                    if (!selectedTags.includes(tag)) {
                                      pendingTagSearchRef.current = true;
                                      setSelectedTags(prev => [...prev, tag]);
                                    }
                                    setSearchTags('');
                                    setShowSuggestions(false);
                                    return;
                                  }
                                }
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  const tag = selectedSuggestionIndex >= 0 && showSuggestions
                                    ? tagSuggestions[selectedSuggestionIndex].name
                                    : searchTags.trim().toLowerCase();
                                  if (tag && !selectedTags.includes(tag)) {
                                    pendingTagSearchRef.current = true;
                                    setSelectedTags(prev => [...prev, tag]);
                                    setSearchTags('');
                                  } else if (!tag) {
                                    setSearchTags('');
                                    setItems([]);
                                    setSelectedItemIds(new Set());
                                    setHasMoreItems(true);
                                    loadData(false);
                                  }
                                  setShowSuggestions(false);
                                }
                                if (e.key === 'Escape') {
                                  setShowSuggestions(false);
                                }
                                if (e.key === 'Backspace' && searchTags === '' && selectedTags.length > 0) {
                                  pendingTagSearchRef.current = true;
                                  setSelectedTags(prev => prev.slice(0, -1));
                                }
                              }}
                              onFocus={() => { if (searchTags.trim().length >= 2) fetchTagSuggestions(searchTags.trim()); }}
                              onBlur={() => { setTimeout(() => setShowSuggestions(false), 200); }}
                              className="w-full bg-transparent text-sm text-white placeholder-[#4c4b5a] focus:outline-none py-0.5"
                            />
                            {showSuggestions && tagSuggestions.length > 0 && (
                              <div className="absolute top-full left-0 mt-1 w-64 max-h-60 overflow-y-auto rounded-xl bg-[#161621] border border-[#1d1b2d] shadow-xl z-50">
                                {tagSuggestions.map((s, i) => {
                                  const typeColor = s.tag_type === 'artist' ? 'text-yellow-400'
                                    : s.tag_type === 'character' ? 'text-green-400'
                                    : s.tag_type === 'species' ? 'text-red-400'
                                    : s.tag_type === 'copyright' ? 'text-pink-400'
                                    : s.tag_type === 'meta' ? 'text-gray-400'
                                    : s.tag_type === 'lore' ? 'text-purple-300'
                                    : 'text-blue-300';
                                  return (
                                    <button
                                      key={s.name}
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        if (!selectedTags.includes(s.name)) {
                                          pendingTagSearchRef.current = true;
                                          setSelectedTags(prev => [...prev, s.name]);
                                        }
                                        setSearchTags('');
                                        setShowSuggestions(false);
                                      }}
                                      className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between transition-colors ${
                                        i === selectedSuggestionIndex ? 'bg-[#967abc]/20' : 'hover:bg-[#1d1b2d]'
                                      }`}
                                    >
                                      <span className={typeColor}>{s.name}</span>
                                      <span className="text-[10px] text-[#4c4b5a]">{s.count}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                  </div>
                  {activeTab === 'viewer' && (
                    <>
                      <select value={sortOrder} onChange={(e) => { setSortOrder(e.target.value); e.target.blur(); }} className={`px-3 py-1.5 text-sm rounded-xl focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]`}>
                        <option value="default">Default</option>
                        <option value="random">Random</option>
                        <option value="score">Score</option>
                        <option value="newest">Newest</option>
                        <option value="oldest">Oldest</option>
                      </select>
                      <select value={filterSource} onChange={(e) => { setFilterSource(e.target.value); e.target.blur(); }} className={`px-3 py-1.5 text-sm rounded-xl focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]`}>
                        <option value="all">All</option>
                        <option value="e621">e621</option>
                        <option value="furaffinity">FurAffinity</option>
                        <option value="local">Local Import</option>
                      </select>
                    </>
                  )}
                </>
              ) : (
                <div className="flex-1 min-w-[150px] relative">
                  <Search className={`absolute left-3 top-2 w-3.5 h-3.5 text-[#4c4b5a]`} />
                  <input
                    type="text"
                    placeholder="Search e621 tags..."
                    value={feedSearchInput}
                    onChange={(e) => setFeedSearchInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && feedSearchInput.trim()) {
                        searchFeedPosts(feedSearchInput);
                      }
                    }}
                    className={`w-full pl-9 pr-3 py-1.5 text-sm rounded-xl focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc] text-white placeholder-[#4c4b5a]`}
                  />
                </div>
              )}
            </div>
            <button
              onClick={openImportModal}
              className={`p-1.5 flex-shrink-0 text-[#9e98aa] hover:text-white`}
              title="Import Files"
            >
              <Upload className="w-4 h-4" />
            </button>
            <button onClick={() => setShowSettings(true)} className={`p-1.5 flex-shrink-0 text-[#9e98aa] hover:text-white`} title="Settings">
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
      {/* Feed Fullscreen Overlay */}
      {feedViewerOverlay && selectedFeedPost && (
        <div
          className="fixed inset-0 z-50 bg-black"
          onMouseMove={pokeHud}
          onMouseDown={pokeHud}
          onWheel={pokeHud}
          onTouchStart={pokeHud}
        >
          <div className="relative w-full h-full">
            <div className="absolute inset-y-0 left-0 w-1/5 z-10 cursor-pointer" onClick={goToPrevFeedPost} />
            <div className="absolute inset-y-0 right-0 w-1/5 z-10 cursor-pointer" onClick={goToNextFeedPost} />

            <div className="w-full h-full flex items-center justify-center relative">
              {selectedFeedPost.file.ext !== 'webm' && selectedFeedPost.file.ext !== 'mp4' && (
                <div
                  className="absolute inset-0 scale-110 blur-3xl opacity-15"
                  style={{ backgroundImage: `url(${selectedFeedPost.sample.url || selectedFeedPost.file.url || ''})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
                />
              )}
              {selectedFeedPost.file.ext === 'webm' || selectedFeedPost.file.ext === 'mp4' ? (
                <video
                  ref={feedFullscreenVideoRef}
                  key={selectedFeedPost.id}
                  src={selectedFeedPost.file.url || selectedFeedPost.sample.url || ''}
                  controls
                  autoPlay
                  playsInline
                  loop={!waitForVideoEnd || !feedSlideshow}
                  muted={globalMute || autoMuteVideos}
                  className={`w-full h-full object-contain transition-opacity duration-300 ${feedFadeIn ? "opacity-100" : "opacity-0"}`}
                  style={{ pointerEvents: 'none' }}
                  onLoadedMetadata={(e) => {
                    if (!globalMute && !autoMuteVideos) e.currentTarget.volume = 1.0;
                    if (savedFeedVideoTimeRef.current > 0) {
                      e.currentTarget.currentTime = savedFeedVideoTimeRef.current;
                      savedFeedVideoTimeRef.current = 0;
                    }
                  }}
                  onLoadedData={() => setFeedImageLoading(false)}
                  onError={() => setFeedImageLoading(false)}
                  onEnded={() => { if (waitForVideoEnd && feedSlideshow) goToNextFeedPost(); }}
                />
              ) : (
                <img
                  key={selectedFeedPost.id}
                  src={selectedFeedPost.sample.url || selectedFeedPost.file.url || ''}
                  alt=""
                  className={`w-full h-full object-contain transition-opacity duration-200 ${feedFadeIn ? "opacity-100" : "opacity-0"}`}
                  onLoad={() => setFeedImageLoading(false)}
                  referrerPolicy="no-referrer"
                />
              )}
            </div>

            <div
              className={`absolute bottom-6 left-1/2 -translate-x-1/2 transition-all duration-300 ease-out ${showHud ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"}`}
              onMouseEnter={() => { hudHoverRef.current = true; setShowHud(true); }}
              onMouseLeave={() => { hudHoverRef.current = false; scheduleHudHide(); }}
            >
              <div className="relative z-20 px-6 py-4 bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-700/50 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-center gap-1.5">
                  <button onClick={goToPrevFeedPost} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded"><ChevronLeft className="w-4 h-4" /></button>
                  <button onClick={() => setFeedSlideshow(!feedSlideshow)} className="p-1.5 bg-[#967abc] hover:bg-[#967abc]/80 rounded">{feedSlideshow ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}</button>
                    <div className="relative" ref={speedSliderRef}>
                      <button
                        onClick={() => setShowSpeedSlider(prev => !prev)}
                        className="p-1.5 rounded bg-[#1d1b2d] hover:bg-[#4c4b5a] text-xs font-mono text-[#9e98aa] hover:text-white transition-colors"
                      >
                        {slideshowSpeed / 1000}s
                      </button>
                      {showSpeedSlider && (
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-900/95 backdrop-blur border border-gray-700/50 shadow-xl animate-in fade-in zoom-in-95 duration-100">
                          <input
                            type="range"
                            min={1}
                            max={15}
                            step={1}
                            value={slideshowSpeed / 1000}
                            onChange={(e) => setSlideshowSpeed(Number(e.target.value) * 1000)}
                            className="w-28 h-1.5 cursor-pointer accent-[#967abc]"
                          />
                          <span className="text-[10px] font-mono text-[#9e98aa] w-6 text-right">{slideshowSpeed / 1000}s</span>
                        </div>
                      )}
                    </div>
                  <button onClick={() => setAutoMuteVideos(!autoMuteVideos)} className={`p-1.5 rounded ${autoMuteVideos ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-[#1d1b2d] hover:bg-[#4c4b5a]'}`}>{autoMuteVideos ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}</button>
                  <button onClick={() => setWaitForVideoEnd(!waitForVideoEnd)} className={`p-1.5 rounded ${waitForVideoEnd ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-[#1d1b2d] hover:bg-[#4c4b5a]'}`}><Clock className="w-4 h-4" /></button>
                  <button onClick={async () => {
                    const isFeedVideo = selectedFeedPost.file.ext === 'webm' || selectedFeedPost.file.ext === 'mp4';
                    if (isFeedVideo && feedFullscreenVideoRef.current) {
                      savedFeedVideoTimeRef.current = feedFullscreenVideoRef.current.currentTime;
                    }
                    await document.exitFullscreen();
                    setFeedViewerOverlay(false);
                  }} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded"><Maximize className="w-4 h-4" /></button>
                  <button
                    onClick={() => ensureFavorite(selectedFeedId ?? -1, selectedFeedPost)}
                    disabled={!!feedActionBusy[selectedFeedPost.id]}
                    className={`p-1.5 rounded ${selectedFeedPost.is_favorited ? 'bg-yellow-500 text-yellow-900' : 'bg-[#1d1b2d] hover:bg-[#4c4b5a]'}`}
                  >
                    {feedActionBusy[selectedFeedPost.id] ? <Loader2 className="w-4 h-4 animate-spin" /> : <Star className={`w-4 h-4 ${selectedFeedPost.is_favorited ? 'fill-current' : ''}`} />}
                  </button>
                  <button onClick={goToNextFeedPost} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded"><ChevronRight className="w-4 h-4" /></button>
                  <span className="text-xs text-[#4c4b5a] ml-1">{feedPostIndex + 1}/{currentFeedPosts.length}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Fullscreen Overlay */}
      {viewerOverlay && currentItem && (
        <div
          className="fixed inset-0 z-50 bg-black"
          onMouseMove={pokeHud}
          onMouseDown={pokeHud}
          onWheel={pokeHud}
          onTouchStart={pokeHud}
        >
          <div className="relative w-full h-full">
            {/* Click zones for navigation */}
            <div className="absolute inset-y-0 left-0 w-1/5 z-10 cursor-pointer" onClick={() => goToPrev(true)} />
            <div className="absolute inset-y-0 right-0 w-1/5 z-10 cursor-pointer" onClick={() => goToNext(true)} />

            {/* Media */}
            <div className="w-full h-full flex items-center justify-center relative">
              {!isVideo && currentItem && (
                <div
                  className="absolute inset-0 scale-110 blur-3xl opacity-15"
                  style={{ backgroundImage: `url(${currentItem.url})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
                />
              )}
              {isVideo ? (
                <video
                  ref={fullscreenVideoRef}
                  key={currentItem.url}
                  src={currentItem.url}
                  controls
                  autoPlay
                  loop={!waitForVideoEnd || !isSlideshow}
                  muted={globalMute || autoMuteVideos}
                  className={`w-full h-full object-contain transition-opacity duration-300 ${fadeIn ? "opacity-100" : "opacity-0"}`}
                  style={{ pointerEvents: 'none' }}
                  onCanPlay={(e) => {
                    if (!globalMute && !autoMuteVideos) e.currentTarget.volume = 1.0;
                    if (savedVideoTimeRef.current > 0) {
                      e.currentTarget.currentTime = savedVideoTimeRef.current;
                      savedVideoTimeRef.current = 0;
                    }
                  }}
                  onLoadedData={() => setImageLoading(false)}
                  onError={() => setImageLoading(false)}
                  onEnded={() => { if (waitForVideoEnd && isSlideshow) goToNext(); }}
                />
              ) : (
                <img
                  key={currentItem.url}
                  src={currentItem.url}
                  alt=""
                  className={`w-full h-full object-contain transition-opacity duration-200 ${fadeIn ? "opacity-100" : "opacity-0"}`}
                  onLoad={() => setImageLoading(false)}
                  onError={(e) => {
                    setImageLoading(false);
                    e.currentTarget.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect fill='%23374151' width='400' height='300'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' fill='%239CA3AF' font-size='20'%3EImage not found%3C/text%3E%3C/svg%3E";
                  }}
                />
              )}
            </div>

            {/* HUD Controls */}
            <div
              className={`absolute bottom-6 left-1/2 -translate-x-1/2 transition-all duration-300 ease-out ${showHud ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"}`}
              onMouseEnter={() => { hudHoverRef.current = true; setShowHud(true); }}
              onMouseLeave={() => { hudHoverRef.current = false; scheduleHudHide(); }}
            >
              <div className="relative z-20 px-6 py-4 bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-700/50 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-center gap-1.5">
                  <button onClick={() => goToPrev(true)} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded"><ChevronLeft className="w-4 h-4" /></button>
                  <button onClick={() => setIsSlideshow(!isSlideshow)} className="p-1.5 bg-[#967abc] hover:bg-[#967abc]/80 rounded">{isSlideshow ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}</button>
                  <input
                    type="range"
                    min={1}
                    max={15}
                    step={1}
                    value={slideshowSpeed / 1000}
                    onChange={(e) => setSlideshowSpeed(Number(e.target.value) * 1000)}
                    className="w-24 h-1.5 cursor-pointer accent-[#967abc]"
                  />
                  <span className="text-xs text-[#9e98aa] font-mono w-6">{slideshowSpeed / 1000}s</span>
                  <button onClick={() => setAutoMuteVideos(!autoMuteVideos)} className={`p-1.5 rounded ${autoMuteVideos ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-[#1d1b2d] hover:bg-[#4c4b5a]'}`}>{autoMuteVideos ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}</button>
                  <button onClick={() => setWaitForVideoEnd(!waitForVideoEnd)} className={`p-1.5 rounded ${waitForVideoEnd ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-[#1d1b2d] hover:bg-[#4c4b5a]'}`}><Clock className="w-4 h-4" /></button>
                  <button onClick={async () => { await document.exitFullscreen(); setViewerOverlay(false); }} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded"><Maximize className="w-4 h-4" /></button>
                  <button onClick={() => goToNext(true)} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded"><ChevronRight className="w-4 h-4" /></button>
                  <span className="text-xs text-[#4c4b5a] ml-1">{currentIndex + 1}/{itemCount}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Viewer Tab */}
      {activeTab === 'viewer' && (
        <div className="flex-1 flex overflow-hidden bg-[#0f0f17]">
          {/* Grid */}
          <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden relative">
            <div className="p-4">
              {(initialLoading || isSearching) ? (
                <Masonry
                  breakpointCols={{ default: libraryDetailOpen ? Math.max(2, gridColumns - 2) : gridColumns, 700: 2, 500: 1 }}
                  className="flex w-auto gap-3"
                  columnClassName="flex flex-col gap-3"
                >
                  {Array.from({ length: (libraryDetailOpen ? Math.max(2, gridColumns - 2) : gridColumns) * 3 }).map((_, i) => (
                    <SkeletonGridItem key={`init-skeleton-${i}`} index={i} dark />
                  ))}
                </Masonry>
              ) : itemCount > 0 ? (
                <>
                  <Masonry
                    breakpointCols={{ default: libraryDetailOpen ? Math.max(2, gridColumns - 2) : gridColumns, 700: 2, 500: 1 }}
                    className="flex w-auto gap-3"
                    columnClassName="flex flex-col gap-3"
                  >
                    {items.map((item, index) => (
                      <GridItem
                        key={item.item_id}
                        item={item}
                        index={index}
                        onSelect={(i) => {
                          if (selectedItemIds.size > 0) {
                            setSelectedItemIds(new Set());
                          }
                          handleItemSelect(i);
                        }}
                        isSelected={libraryDetailOpen && index === currentIndex}
                        isMultiSelected={selectedItemIds.has(item.item_id)}
                        onMultiClick={handleGridClick}
                      />
                    ))}
                    {isLoadingMore && Array.from({ length: (libraryDetailOpen ? Math.max(2, gridColumns - 2) : gridColumns) * 2 }).map((_, i) => (
                      <SkeletonGridItem key={`skeleton-${i}`} index={i} dark />
                    ))}
                  </Masonry>
                  {hasMoreItems && <InfiniteSentinel onVisible={loadMoreItems} disabled={isLoadingMore} />}
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-[#4c4b5a] min-h-[60vh]">
                  {!libraryRoot ? (
                    <div className="text-center animate-in fade-in zoom-in duration-300">
                      <Database className="w-20 h-20 mx-auto mb-6 opacity-80 text-[#967abc]" />
                      <h2 className="text-3xl font-bold text-white mb-3">Welcome!</h2>
                      <p className="mb-8 max-w-md mx-auto text-[#9e98aa]">
                        To get started, select a folder where your favorites will be stored.
                        <br /><span className="text-sm opacity-75">(You can create a new empty folder or select an existing one)</span>
                      </p>
                      <button onClick={changeLibraryRoot} className="px-8 py-4 text-white rounded-xl font-bold text-lg shadow-lg transition-all transform hover:-translate-y-1 bg-[#967abc] hover:bg-[#967abc]/80 hover:shadow-[#967abc]/20">
                        Select Library Folder
                      </button>
                    </div>
                  ) : (
                    <div className="text-center">
                      <Upload className="w-16 h-16 mx-auto mb-4 opacity-50" />
                      <p className="text-xl font-semibold text-gray-200">Library is Ready</p>
                      <p className="text-sm mt-2 mb-6 text-[#9e98aa]">
                        Your database is set up. Go to <b>Settings</b> to sync your favorites.
                      </p>
                      <button onClick={() => setShowSettings(true)} className="px-4 py-2 rounded-xl text-white transition-colors bg-[#1d1b2d] hover:bg-[#4c4b5a]">Open Settings</button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Bulk Action Bar */}
            {selectedItemIds.size > 0 && (
              <div className="sticky bottom-4 z-30 flex justify-center pointer-events-none">
                <div className="pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-2xl bg-[#161621]/95 backdrop-blur-md border border-[#1d1b2d] shadow-2xl animate-in slide-in-from-bottom-4 fade-in duration-200">
                  <span className="text-sm font-medium text-white mr-1">
                    {selectedItemIds.size} selected
                  </span>

                  <div className="w-px h-6 bg-[#1d1b2d]" />

                  <button
                    onClick={selectAll}
                    className="px-3 py-1.5 text-xs rounded-lg bg-[#1d1b2d] hover:bg-[#4c4b5a] text-[#9e98aa] hover:text-white transition-colors"
                  >
                    Select All
                  </button>

                  <button
                    onClick={() => { setBulkTagMode('add'); setBulkTagInput(''); setShowBulkTagModal(true); }}
                    className="px-3 py-1.5 text-xs rounded-lg bg-[#967abc] hover:bg-[#967abc]/80 text-white transition-colors flex items-center gap-1.5"
                  >
                    <Tag className="w-3.5 h-3.5" />
                    Add Tag
                  </button>

                  <button
                    onClick={() => { setBulkTagMode('remove'); setBulkTagInput(''); setShowBulkTagModal(true); }}
                    className="px-3 py-1.5 text-xs rounded-lg bg-[#1d1b2d] hover:bg-[#4c4b5a] text-[#9e98aa] hover:text-white transition-colors flex items-center gap-1.5"
                  >
                    <Tag className="w-3.5 h-3.5" />
                    Remove Tag
                  </button>

                  <button
                    onClick={() => {
                      setConfirmModal({
                        title: "Bulk Trash",
                        message: `Move ${selectedItemIds.size} selected items to trash?`,
                        okLabel: "Move to Trash",
                        onConfirm: bulkTrash,
                      });
                    }}
                    className="px-3 py-1.5 text-xs rounded-lg bg-red-900/50 hover:bg-red-600 text-red-200 hover:text-white transition-colors flex items-center gap-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Trash
                  </button>

                  <div className="w-px h-6 bg-[#1d1b2d]" />

                  <button
                    onClick={deselectAll}
                    className="p-1.5 rounded-lg hover:bg-[#1d1b2d] text-[#9e98aa] hover:text-white transition-colors"
                    title="Clear selection"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Detail Pane */}
          {libraryDetailOpen && currentItem && (
            <>
              <ResizeHandle onDrag={handleLibraryDetailResize} />
          <div style={{ width: libraryDetailWidth, maxWidth: '60vw', minWidth: 300 }} className="flex-shrink-0 flex flex-col h-full bg-[#161621] border-l border-[#1d1b2d]">

                {/* Everything below header scrolls together */}
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {/* Media */}
                  <div className="relative bg-[#0a0a12] flex items-center justify-center overflow-hidden" style={{ height: 'calc(100vh - 120px)', minHeight: '300px' }}>
                    {/* Blurred background */}
                    {currentItem && !isVideo && (
                      <div
                        className="absolute inset-0 scale-110 blur-3xl opacity-20"
                        style={{ backgroundImage: `url(${currentItem.url})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
                      />
                    )}
                    <button
                      onClick={() => setLibraryDetailOpen(false)}
                      className="absolute top-2 right-2 z-20 p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    {imageLoading && (
                      <div className="absolute inset-0 flex items-center justify-center z-10">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#967abc]" />
                      </div>
                    )}
                    {isVideo ? (
                      <video
                        ref={detailVideoRef}
                        key={currentItem.url}
                        src={currentItem.url}
                        controls
                        autoPlay
                        playsInline
                        loop={!waitForVideoEnd || !isSlideshow}
                        muted={globalMute || autoMuteVideos || viewerOverlay}
                        className={`max-w-full max-h-full object-contain transition-opacity duration-200 ${fadeIn ? "opacity-100" : "opacity-0"} ${viewerOverlay ? 'opacity-0 pointer-events-none' : ''}`}
                        onCanPlay={(e) => {
                          if (viewerOverlay) return;
                          if (!globalMute && !autoMuteVideos) e.currentTarget.volume = 1.0;
                          if (savedVideoTimeRef.current > 0) {
                            e.currentTarget.currentTime = savedVideoTimeRef.current;
                            savedVideoTimeRef.current = 0;
                            e.currentTarget.play().catch(() => {});
                          }
                        }}
                        onLoadedData={() => setImageLoading(false)}
                        onError={() => setImageLoading(false)}
                        onEnded={() => { if (!viewerOverlay && waitForVideoEnd && isSlideshow) goToNext(); }}
                      />
                    ) : (
                      <img
                        key={currentItem.url}
                        src={currentItem.url}
                        alt=""
                        className={`max-w-full max-h-full object-contain transition-opacity duration-200 ${fadeIn ? "opacity-100" : "opacity-0"}`}
                        onLoad={() => setImageLoading(false)}
                        onError={(e) => {
                          setImageLoading(false);
                          e.currentTarget.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect fill='%23374151' width='400' height='300'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' fill='%239CA3AF' font-size='20'%3EImage not found%3C/text%3E%3C/svg%3E";
                        }}
                      />
                    )}
                  </div>

                  {/* Controls - sticks visually below image */}
                  <div className="sticky bottom-0 z-10 p-3 border-t border-[#1d1b2d] bg-[#161621] flex items-center justify-center gap-1.5">
                    <button onClick={() => goToPrev(true)} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded transition-colors"><ChevronLeft className="w-4 h-4" /></button>
                    <button onClick={() => setIsSlideshow(!isSlideshow)} className="p-1.5 bg-[#967abc] hover:bg-[#967abc]/80 rounded transition-colors">{isSlideshow ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}</button>
                    <div className="relative" ref={speedSliderRef}>
                      <button
                        onClick={() => setShowSpeedSlider(prev => !prev)}
                        className="p-1.5 rounded bg-[#1d1b2d] hover:bg-[#4c4b5a] text-xs font-mono text-[#9e98aa] hover:text-white transition-colors"
                      >
                        {slideshowSpeed / 1000}s
                      </button>
                      {showSpeedSlider && (
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-900/95 backdrop-blur border border-gray-700/50 shadow-xl animate-in fade-in zoom-in-95 duration-100">
                          <input
                            type="range"
                            min={1}
                            max={15}
                            step={1}
                            value={slideshowSpeed / 1000}
                            onChange={(e) => setSlideshowSpeed(Number(e.target.value) * 1000)}
                            className="w-28 h-1.5 cursor-pointer accent-[#967abc]"
                          />
                          <span className="text-[10px] font-mono text-[#9e98aa] w-6 text-right">{slideshowSpeed / 1000}s</span>
                        </div>
                      )}
                    </div>
                    <button onClick={() => setAutoMuteVideos(!autoMuteVideos)} className={`p-1.5 rounded transition-colors ${autoMuteVideos ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-[#1d1b2d] hover:bg-[#4c4b5a]'}`}>{autoMuteVideos ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}</button>
                    <button onClick={() => setWaitForVideoEnd(!waitForVideoEnd)} className={`p-1.5 rounded transition-colors ${waitForVideoEnd ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-[#1d1b2d] hover:bg-[#4c4b5a]'}`}><Clock className="w-4 h-4" /></button>
                    <button onClick={async () => {
                      try {
                        if (!document.fullscreenElement) {
                          if (isVideo && detailVideoRef.current) {
                            savedVideoTimeRef.current = detailVideoRef.current.currentTime;
                          }
                          await document.documentElement.requestFullscreen();
                          setViewerOverlay(true);
                        } else {
                          if (isVideo && fullscreenVideoRef.current) {
                            savedVideoTimeRef.current = fullscreenVideoRef.current.currentTime;
                          }
                          await document.exitFullscreen();
                          setViewerOverlay(false);
                        }
                      } catch (err) { console.warn("Fullscreen failed:", err); }
                    }} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded transition-colors"><Maximize className="w-4 h-4" /></button>
                    <button onClick={deleteCurrentItem} className="p-1.5 bg-[#1d1b2d] hover:bg-red-600 rounded text-[#9e98aa] hover:text-white transition-colors"><Trash2 className="w-4 h-4" /></button>
                    <button onClick={openEditModal} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded text-[#9e98aa] hover:text-white transition-colors"><Pencil className="w-4 h-4" /></button>
                    <button onClick={() => goToNext(true)} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded transition-colors"><ChevronRight className="w-4 h-4" /></button>
                  </div>

                  {/* Info & Tags */}
                  <div className="p-4">
                    <div className="mb-4 pb-3 border-b border-[#1d1b2d]">
                      <div className="flex items-center gap-1.5 mb-2 min-w-0">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wider flex-shrink-0 ${
                          currentItem.source === 'e621' ? 'bg-blue-600'
                            : currentItem.source === 'local' ? 'bg-emerald-600'
                            : 'bg-orange-600'
                        }`}>
                          {currentItem.source === 'e621' ? 'E6' : currentItem.source === 'local' ? 'LC' : 'FA'}
                        </span>
                        <span className="text-sm font-medium truncate text-white">
                          {getDisplayArtists(currentItem)}
                        </span>
                      </div>
                      <div className="flex gap-3 text-xs text-[#9e98aa]">
                        <span>⭐ {currentItem.fav_count || 0}</span>
                        <span>Score: {currentItem.score.total}</span>
                        <span className={`font-bold uppercase ${currentItem.rating === 'e' ? 'text-red-400' : currentItem.rating === 'q' ? 'text-yellow-400' : 'text-green-400'}`}>
                          {currentItem.rating === 'e' ? 'Explicit' : currentItem.rating === 'q' ? 'Questionable' : 'Safe'}
                        </span>
                      </div>
                      {currentPostPools.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {currentPostPools.map(pool => (
                            <button
                              key={pool.pool_id}
                              onClick={() => {
                                setActiveTab('comics');
                                openPool(pool);
                              }}
                              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-[#1d1b2d] hover:bg-[#4c4b5a] text-[#967abc] transition-colors"
                            >
                              <BookOpen className="w-3 h-3" />
                              {pool.name}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                        {currentItem.source === 'e621' && (
                          <button onClick={() => openExternalUrl(`https://e621.net/posts/${currentItem.source_id}`)} className="text-[#967abc] hover:text-[#967abc]/80 underline">e621</button>
                        )}
                        {currentItem.sources?.filter(s => currentItem.source !== 'e621' || !s.includes('e621.net/posts')).slice(0, 3).map((source, i) => (
                          <button key={i} onClick={() => openExternalUrl(source)} className="text-[#967abc] hover:text-[#967abc]/80 underline" title={source}>{getSocialMediaName(source)}</button>
                        ))}
                      </div>
                    </div>

                    <h3 className="text-sm font-semibold mb-3 flex items-center gap-2 text-[#9e98aa]"><Tag className="w-3.5 h-3.5" /> Tags</h3>
                    <TagSection title="Artists" tags={currentItem.tags_artist} color="text-yellow-400" onTagClick={toggleTagAndSearch} />
                    <TagSection title="Copyrights" tags={currentItem.tags_copyright} color="text-pink-400" onTagClick={toggleTagAndSearch} />
                    <TagSection title="Characters" tags={currentItem.tags_character} color="text-green-400" onTagClick={toggleTagAndSearch} />
                    <TagSection title="Species" tags={currentItem.tags_species} color="text-red-400" onTagClick={toggleTagAndSearch} />
                    <TagSection title="General" tags={currentItem.tags_general} color="text-blue-300" onTagClick={toggleTagAndSearch} />
                    <TagSection title="Meta" tags={currentItem.tags_meta} color="text-gray-400" onTagClick={toggleTagAndSearch} />
                    <TagSection title="Lore" tags={currentItem.tags_lore} color="text-purple-300" onTagClick={toggleTagAndSearch} />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Feeds Tab */}
      {activeTab === 'feeds' && (
        <div ref={feedsContainerRef} className={`flex-1 flex overflow-hidden bg-[#0f0f17]`}>
          {/* Feed grid pane */}
          <div className="flex-1 min-w-0 overflow-y-auto">
            <div className={"p-4"}>
              {/* Feed pills */}
              <div className="flex justify-center items-center gap-2 mb-4 flex-wrap relative">
                {feeds.map((feed, index) => {
                  const isActive = selectedFeedId === feed.id && !feedSearchInput;
                  const isDragging = feedDrag?.id === feed.id;
                  const insertBefore = feedDrag && feedDrag.id !== feed.id && feedDrag.insertIndex === index;
                  const insertAfter = feedDrag && feedDrag.id !== feed.id && feedDrag.insertIndex === index + 1 && index === feeds.length - 1;

                  return (
                    <div
                      key={feed.id}
                      className="flex items-center"
                      style={{ transition: isDragging ? 'none' : 'all 200ms ease' }}
                    >
                      {/* Insert indicator before */}
                      <div
                        className={`transition-all duration-200 ease-out rounded-full ${
                          insertBefore
                            ? ('w-1 h-8 bg-[#967abc] mx-1')
                            : 'w-0 h-8 mx-0'
                        }`}
                      />
                      <button
                        ref={(el) => {
                          if (el) feedPillRefs.current.set(feed.id, el);
                          else feedPillRefs.current.delete(feed.id);
                        }}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.preventDefault();
                          feedDragStartRef.current = { x: e.clientX, y: e.clientY, id: feed.id, index };
                          const el = e.currentTarget;

                          const onMove = (ev: PointerEvent) => {
                            const start = feedDragStartRef.current;
                            if (!start) return;
                            const dx = Math.abs(ev.clientX - start.x);
                            const dy = Math.abs(ev.clientY - start.y);

                            if (!feedDrag && dx < 5 && dy < 5) return;

                            const rect = el.getBoundingClientRect();

                            // Find insert position
                            let insertIdx = start.index;
                            const pills = feeds.map((f, i) => {
                              const pillEl = feedPillRefs.current.get(f.id);
                              if (!pillEl || f.id === start.id) return null;
                              const r = pillEl.getBoundingClientRect();
                              return { index: i, cx: r.left + r.width / 2 };
                            }).filter(Boolean) as { index: number; cx: number }[];

                            // Determine where the cursor is relative to other pills
                            if (pills.length > 0) {
                              if (ev.clientX <= pills[0].cx) {
                                insertIdx = pills[0].index;
                              } else if (ev.clientX >= pills[pills.length - 1].cx) {
                                insertIdx = pills[pills.length - 1].index + 1;
                              } else {
                                for (let i = 0; i < pills.length - 1; i++) {
                                  if (ev.clientX >= pills[i].cx && ev.clientX < pills[i + 1].cx) {
                                    insertIdx = pills[i + 1].index;
                                    break;
                                  }
                                }
                              }
                              // Adjust for the dragged item's original position
                              if (insertIdx > start.index) {
                                // When dragging right, account for the gap left by the dragged item
                              }
                            }

                            setFeedDrag({
                              id: start.id,
                              ghostX: ev.clientX,
                              ghostY: ev.clientY,
                              ghostWidth: rect.width,
                              ghostHeight: rect.height,
                              ghostLabel: feed.name,
                              insertIndex: insertIdx,
                            });
                          };

                          const onUp = () => {
                            document.removeEventListener('pointermove', onMove);
                            document.removeEventListener('pointerup', onUp);
                            feedDragCleanupRef.current = null;

                            const start = feedDragStartRef.current;
                            const drag = feedDragRef.current;

                            if (start && drag) {
                              // Perform reorder
                              const fromIdx = feeds.findIndex(f => f.id === start.id);
                              let toIdx = drag.insertIndex;
                              if (fromIdx !== -1 && toIdx !== fromIdx) {
                                const reordered = [...feeds];
                                const [moved] = reordered.splice(fromIdx, 1);
                                if (toIdx > fromIdx) toIdx--;
                                reordered.splice(toIdx, 0, moved);
                                saveFeeds(reordered);
                              }
                            } else if (start && !drag) {
                              // It was a click
                              if (isActive) {
                                fetchFeedPosts(feed.id, feed.query, { reset: true });
                              } else {
                                setFeedSearchInput('');
                                setFeedSearchResults([]);
                                setSelectedFeedId(feed.id);
                                if (!feedPosts[feed.id] || feedPosts[feed.id].length === 0) {
                                  fetchFeedPosts(feed.id, feed.query, { reset: true });
                                }
                              }
                            }

                            feedDragStartRef.current = null;
                            setFeedDrag(null);
                          };

                          feedDragCleanupRef.current = () => {
                            document.removeEventListener('pointermove', onMove);
                            document.removeEventListener('pointerup', onUp);
                          };
                          document.addEventListener('pointermove', onMove);
                          document.addEventListener('pointerup', onUp);
                        }}
                        className={`px-4 py-2 rounded-full text-sm font-medium transition-all group select-none touch-none ${
                          isDragging
                            ? 'opacity-30 scale-95'
                            : isActive
                            ? ('bg-[#967abc] text-white shadow-lg')
                            : ( 'bg-[#1c1b26] text-[#9e98aa] hover:bg-[#1d1b2d]')
                        }`}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="pointer-events-none">{feed.name}</span>
                          {isActive && loadingFeeds[feed.id] && <Loader2 className="w-3 h-3 animate-spin pointer-events-none" />}
                          <span
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              setNewFeedName(feed.name);
                              setNewFeedQuery(feed.query);
                              setEditingFeedId(feed.id);
                              setShowAddFeedModal(true);
                            }}
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-white/20 rounded pointer-events-auto"
                          >
                            <Pencil className="w-3 h-3" />
                          </span>
                        </span>
                      </button>
                      {/* Insert indicator after last item */}
                      {insertAfter && (
                        <div className={`transition-all duration-200 ease-out rounded-full 'w-1 h-8 bg-[#967abc] mx-1`} />
                      )}
                    </div>
                  );
                })}
                <button
                  onClick={() => { setEditingFeedId(null); setNewFeedName(''); setNewFeedQuery(''); setShowAddFeedModal(true); }}
                  className={`p-2 rounded-full text-sm transition-all bg-[#1c1b26] text-[#9e98aa] hover:bg-[#1d1b2d]`}
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              {/* Floating ghost pill */}
              {feedDrag && createPortal(
                <div
                  className={`fixed z-[9999] pointer-events-none px-4 py-2 rounded-full text-sm font-medium shadow-2xl bg-[#967abc] text-white`}
                  style={{
                    left: feedDrag.ghostX - feedDrag.ghostWidth / 2,
                    top: feedDrag.ghostY - feedDrag.ghostHeight / 2,
                    width: feedDrag.ghostWidth,
                    height: feedDrag.ghostHeight,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transform: 'scale(1.08)',
                    transition: 'transform 100ms ease',
                  }}
                >
                  {feedDrag.ghostLabel}
                </div>,
                document.body
              )}

              {/* Feed content */}
              {feedSearchInput && !feedSearchLoading && feedSearchResults.length === 0 ? (
                <div className={`text-center py-20 text-[#4c4b5a]`}>
                  <Search className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>No results found</p>
                </div>
              ) : feedSearchInput || feedSearchLoading ? (
                feedSearchLoading ? (
                  <Masonry breakpointCols={{ default: feedDetailOpen && selectedFeedPost ? Math.max(2, gridColumns - 2) : gridColumns, 700: 2, 500: 1 }} className="flex w-auto gap-3" columnClassName="flex flex-col gap-3">
                    {Array.from({ length: gridColumns * 2 }).map((_, i) => (
                      <SkeletonFeedPost key={`search-skeleton-${i}`} index={i} dark={true} />
                    ))}
                  </Masonry>
                ) : (
                  <Masonry breakpointCols={{ default: feedDetailOpen && selectedFeedPost ? Math.max(2, gridColumns - 2) : gridColumns, 700: 2, 500: 1 }} className="flex w-auto gap-3" columnClassName="flex flex-col gap-3">
                    {feedSearchResults.map((post) => (
                      <FeedPostItem
                        key={post.id}
                        post={post}
                        feedId={-1}
                        downloaded={downloadedE621Ids.has(post.id)}
                        busy={!!feedActionBusy[post.id]}
                        onFavorite={ensureFavorite}
                        onSelect={(p) => {
                          const idx = feedSearchResults.findIndex(fp => fp.id === p.id);
                          setFeedPostIndex(idx >= 0 ? idx : 0);
                          setSelectedFeedPost(p);
                          setFeedDetailOpen(true);
                        }}
                      />
                    ))}
                  </Masonry>
                )
              ) : selectedFeedId && feeds.find(f => f.id === selectedFeedId) ? (
                (() => {
                  const feed = feeds.find(f => f.id === selectedFeedId)!;
                  return feedPosts[feed.id] && feedPosts[feed.id].length > 0 ? (
                    <>
                  <Masonry breakpointCols={{ default: feedDetailOpen && selectedFeedPost ? Math.max(2, gridColumns - 2) : gridColumns, 700: 2, 500: 1 }} className="flex w-auto gap-3" columnClassName="flex flex-col gap-3">
                        {feedPosts[feed.id].map((post) => (
                          <FeedPostItem
                            key={post.id}
                            post={post}
                            feedId={feed.id}
                            downloaded={downloadedE621Ids.has(post.id)}
                            busy={!!feedActionBusy[post.id]}
                            onFavorite={ensureFavorite}
                            onSelect={(p) => {
                              const idx = (feedPosts[feed.id] || []).findIndex(fp => fp.id === p.id);
                              setFeedPostIndex(idx >= 0 ? idx : 0);
                              setSelectedFeedPost(p);
                              setFeedDetailOpen(true);
                            }}
                          />
                        ))}
                      </Masonry>
                      <InfiniteSentinel
                        disabled={!e621CredInfo.username || !e621CredInfo.has_api_key || !!loadingFeeds[feed.id] || !!feedPaging[feed.id]?.done}
                        onVisible={() => fetchFeedPosts(feed.id, feed.query)}
                      />
                      {feedPaging[feed.id]?.done && <div className={`text-center text-sm py-4 text-[#4c4b5a]`}>End of results</div>}
                    </>
                  ) : loadingFeeds[feed.id] ? (
                  <Masonry breakpointCols={{ default: feedDetailOpen && selectedFeedPost ? Math.max(2, gridColumns - 2) : gridColumns, 700: 2, 500: 1 }} className="flex w-auto gap-3" columnClassName="flex flex-col gap-3">
                      {Array.from({ length: gridColumns * 2 }).map((_, i) => (
                        <SkeletonFeedPost key={`feed-skeleton-${i}`} index={i} dark={true} />
                      ))}
                    </Masonry>
                  ) : (
                    <div className={`text-center py-20 italic text-[#4c4b5a]`}>"Nobody here but us dergs"</div>
                  );
                })()
              ) : (
                <div className={`text-center py-20 text-[#4c4b5a]`}>
                  {feeds.length > 0 ? (
                    <p className="text-xl mb-2">Select a feed or search above</p>
                  ) : (
                    <>
                      <Rss className="w-16 h-16 mx-auto mb-4 opacity-50" />
                      <p className="text-xl">No feeds yet</p>
                      <p className="text-sm mt-2">Click the + button above to create one</p>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Detail pane */}
          {feedDetailOpen && selectedFeedPost && (
            <>
              <ResizeHandle onDrag={handleFeedDetailResize} />
              <div style={{ width: feedDetailWidth, maxWidth: '60vw', minWidth: 300 }} className="flex-shrink-0 flex flex-col h-full bg-[#161621] border-l border-[#1d1b2d]">

                {/* Everything below header scrolls together */}
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {/* Media */}
                  <div className="relative bg-[#0a0a12] flex items-center justify-center overflow-hidden" style={{ height: 'calc(100vh - 120px)', minHeight: '300px' }}>
                    {/* Blurred background */}
                    {selectedFeedPost && selectedFeedPost.file.ext !== 'webm' && selectedFeedPost.file.ext !== 'mp4' && (
                      <div
                        className="absolute inset-0 scale-110 blur-3xl opacity-20"
                        style={{ backgroundImage: `url(${selectedFeedPost.sample.url || selectedFeedPost.file.url || ''})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
                      />
                    )}
                    <button
                      onClick={() => {
                        setFeedDetailOpen(false);
                        setSelectedFeedPost(null);
                      }}
                      className="absolute top-2 right-2 z-20 p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    {feedImageLoading && (
                      <div className="absolute inset-0 flex items-center justify-center z-10">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#967abc]" />
                      </div>
                    )}
                    {selectedFeedPost.file.ext === 'webm' || selectedFeedPost.file.ext === 'mp4' ? (
                      <video
                        ref={feedDetailVideoRef}
                        key={selectedFeedPost.id}
                        src={selectedFeedPost.file.url || selectedFeedPost.sample.url || ''}
                        controls
                        autoPlay
                        playsInline
                        loop={!waitForVideoEnd || !feedSlideshow}
                        muted={globalMute || autoMuteVideos || feedViewerOverlay}
                        className={`max-w-full max-h-full object-contain transition-opacity duration-200 ${feedFadeIn ? "opacity-100" : "opacity-0"} ${feedViewerOverlay ? 'opacity-0 pointer-events-none' : ''}`}
                        onCanPlay={(e) => {
                          if (feedViewerOverlay) return;
                          if (!globalMute && !autoMuteVideos) e.currentTarget.volume = 1.0;
                        }}
                        onLoadedMetadata={(e) => {
                          if (savedFeedVideoTimeRef.current > 0) {
                            e.currentTarget.currentTime = savedFeedVideoTimeRef.current;
                            savedFeedVideoTimeRef.current = 0;
                          }
                        }}
                        onLoadedData={() => setFeedImageLoading(false)}
                        onError={() => setFeedImageLoading(false)}
                        onEnded={() => { if (!feedViewerOverlay && waitForVideoEnd && feedSlideshow) goToNextFeedPost(); }}
                      />
                    ) : (
                      <img
                        src={selectedFeedPost.sample.url || selectedFeedPost.file.url || selectedFeedPost.preview.url || ''}
                        alt=""
                        className={`max-w-full max-h-full object-contain transition-opacity duration-200 ${feedFadeIn ? "opacity-100" : "opacity-0"}`}
                        onLoad={() => setFeedImageLoading(false)}
                        referrerPolicy="no-referrer"
                      />
                    )}
                  </div>

                  {/* Controls - sticky */}
                  <div className="sticky bottom-0 z-10 p-3 border-t border-[#1d1b2d] bg-[#161621] flex items-center justify-center gap-1.5">
                    <button onClick={goToPrevFeedPost} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded transition-colors"><ChevronLeft className="w-4 h-4" /></button>
                    <button onClick={() => setFeedSlideshow(!feedSlideshow)} className="p-1.5 bg-[#967abc] hover:bg-[#967abc]/80 rounded transition-colors">{feedSlideshow ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}</button>
                    <div className="relative" ref={speedSliderRef}>
                      <button
                        onClick={() => setShowSpeedSlider(prev => !prev)}
                        className="p-1.5 rounded bg-[#1d1b2d] hover:bg-[#4c4b5a] text-xs font-mono text-[#9e98aa] hover:text-white transition-colors"
                      >
                        {slideshowSpeed / 1000}s
                      </button>
                      {showSpeedSlider && (
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-900/95 backdrop-blur border border-gray-700/50 shadow-xl animate-in fade-in zoom-in-95 duration-100">
                          <input
                            type="range"
                            min={1}
                            max={15}
                            step={1}
                            value={slideshowSpeed / 1000}
                            onChange={(e) => setSlideshowSpeed(Number(e.target.value) * 1000)}
                            className="w-28 h-1.5 cursor-pointer accent-[#967abc]"
                          />
                          <span className="text-[10px] font-mono text-[#9e98aa] w-6 text-right">{slideshowSpeed / 1000}s</span>
                        </div>
                      )}
                    </div>
                    <button onClick={() => setAutoMuteVideos(!autoMuteVideos)} className={`p-1.5 rounded transition-colors ${autoMuteVideos ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-[#1d1b2d] hover:bg-[#4c4b5a]'}`}>{autoMuteVideos ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}</button>
                    <button onClick={() => setWaitForVideoEnd(!waitForVideoEnd)} className={`p-1.5 rounded transition-colors ${waitForVideoEnd ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-[#1d1b2d] hover:bg-[#4c4b5a]'}`}><Clock className="w-4 h-4" /></button>
                    <button
                      onClick={() => ensureFavorite(selectedFeedId ?? -1, selectedFeedPost)}
                      disabled={!!feedActionBusy[selectedFeedPost.id]}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-colors ${
                        selectedFeedPost.is_favorited
                          ? 'bg-yellow-500 text-yellow-900'
                          : 'bg-[#967abc] hover:bg-[#967abc]/80 text-white'
                      } ${feedActionBusy[selectedFeedPost.id] ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                      {feedActionBusy[selectedFeedPost.id] ? <Loader2 className="w-4 h-4 animate-spin" /> : <Star className={`w-4 h-4 ${selectedFeedPost.is_favorited ? 'fill-current' : ''}`} />}
                      {selectedFeedPost.is_favorited ? 'Unfavorite' : 'Save'}
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          if (!document.fullscreenElement) {
                            const isFeedVideo = selectedFeedPost.file.ext === 'webm' || selectedFeedPost.file.ext === 'mp4';
                            if (isFeedVideo && feedDetailVideoRef.current) {
                              savedFeedVideoTimeRef.current = feedDetailVideoRef.current.currentTime;
                              feedDetailVideoRef.current.pause();
                            }
                            await document.documentElement.requestFullscreen();
                            setFeedViewerOverlay(true);
                          } else {
                            const isFeedVideo = selectedFeedPost.file.ext === 'webm' || selectedFeedPost.file.ext === 'mp4';
                            if (isFeedVideo && feedFullscreenVideoRef.current) {
                              savedFeedVideoTimeRef.current = feedFullscreenVideoRef.current.currentTime;
                            }
                            await document.exitFullscreen();
                            setFeedViewerOverlay(false);
                          }
                        } catch (err) { console.warn("Fullscreen failed:", err); }
                      }}
                      className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded transition-colors"
                      title="Fullscreen"
                    >
                      <Maximize className="w-4 h-4" />
                    </button>
                    <button onClick={goToNextFeedPost} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded transition-colors"><ChevronRight className="w-4 h-4" /></button>
                  </div>
                  {/* Info & Tags */}
                  <div className="p-4">
                    {downloadedE621Ids.has(selectedFeedPost.id) && (
                      <div className="absolute top-2 left-2 z-10 bg-green-500/80 text-white p-1.5 rounded-full pointer-events-none">
                        <Database className="w-3.5 h-3.5" />
                      </div>
                    )}

                    <div className="mb-4 pb-3 border-b border-[#1d1b2d]">
                      <div className="flex items-center gap-1.5 mb-2">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wider bg-blue-600">E6</span>
                        <span className="text-sm font-medium truncate text-white">
                          {selectedFeedPost.tags.artist.filter(a => !ARTIST_DENY_LIST.includes(a)).join(", ") || "Unknown"}
                        </span>
                      </div>
                      <div className="flex gap-3 text-xs text-[#9e98aa]">
                        <span>⭐ {selectedFeedPost.fav_count}</span>
                        <span>Score: {selectedFeedPost.score.total}</span>
                        <span className={`font-bold uppercase ${selectedFeedPost.rating === 'e' ? 'text-red-400' : selectedFeedPost.rating === 'q' ? 'text-yellow-400' : 'text-green-400'}`}>
                          {selectedFeedPost.rating === 'e' ? 'Explicit' : selectedFeedPost.rating === 'q' ? 'Questionable' : 'Safe'}
                        </span>
                      </div>
                    </div>

                    {selectedFeedPost.sources && selectedFeedPost.sources.length > 0 && (
                      <div className="mb-4 pb-3 border-b border-[#1d1b2d]">
                        <h4 className="text-xs font-semibold uppercase tracking-wider mb-2 text-[#9e98aa]">Sources</h4>
                        <div className="space-y-1">
                          {selectedFeedPost.sources.map((source, i) => (
                            <button key={i} onClick={() => openExternalUrl(source)} className="block text-xs truncate text-[#967abc] hover:text-[#967abc]/80" title={source}>
                              {getSocialMediaName(source)}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <h4 className="text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-2 text-[#9e98aa]"><Tag className="w-3.5 h-3.5" /> Tags</h4>
                    <TagSection title="Artists" tags={selectedFeedPost.tags.artist} color="text-yellow-400" onTagClick={(tag) => { setFeedSearchInput(tag); searchFeedPosts(tag); setFeedDetailOpen(false); setSelectedFeedPost(null); }} />
                    <TagSection title="Copyrights" tags={selectedFeedPost.tags.copyright} color="text-pink-400" onTagClick={(tag) => { setFeedSearchInput(tag); searchFeedPosts(tag); setFeedDetailOpen(false); setSelectedFeedPost(null); }} />
                    <TagSection title="Characters" tags={selectedFeedPost.tags.character} color="text-green-400" onTagClick={(tag) => { setFeedSearchInput(tag); searchFeedPosts(tag); setFeedDetailOpen(false); setSelectedFeedPost(null); }} />
                    <TagSection title="Species" tags={selectedFeedPost.tags.species} color="text-red-400" onTagClick={(tag) => { setFeedSearchInput(tag); searchFeedPosts(tag); setFeedDetailOpen(false); setSelectedFeedPost(null); }} />
                    <TagSection title="General" tags={selectedFeedPost.tags.general} color="text-blue-300" onTagClick={(tag) => { setFeedSearchInput(tag); searchFeedPosts(tag); setFeedDetailOpen(false); setSelectedFeedPost(null); }} />
                    <TagSection title="Meta" tags={selectedFeedPost.tags.meta} color="text-gray-400" onTagClick={(tag) => { setFeedSearchInput(tag); searchFeedPosts(tag); setFeedDetailOpen(false); setSelectedFeedPost(null); }} />
                    <TagSection title="Lore" tags={selectedFeedPost.tags.lore} color="text-purple-300" onTagClick={(tag) => { setFeedSearchInput(tag); searchFeedPosts(tag); setFeedDetailOpen(false); setSelectedFeedPost(null); }} />
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Add/Edit Feed Modal */}
          {showAddFeedModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/60" onClick={() => { setShowAddFeedModal(false); setEditingFeedId(null); setNewFeedName(''); setNewFeedQuery(''); }} />
              <div className={`relative z-10 w-full max-w-xl rounded-xl p-6 bg-[#161621] border border-[#1d1b2d]`}>
                <h2 className="text-xl font-bold mb-4">{editingFeedId ? 'Edit Feed' : 'Add New Feed'}</h2>
                <div className="space-y-4">
                  <div>
                    <label className={`text-sm mb-1 block text-[#9e98aa]`}>Feed Name</label>
                    <input type="text" placeholder="e.g., Cute Foxes" value={newFeedName} onChange={(e) => setNewFeedName(e.target.value)} className={`w-full px-4 py-2 rounded-xl focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]`} />
                  </div>
                  <div>
                    <label className={`text-sm mb-1 block text-[#9e98aa]`}>Search Query</label>
                    <input type="text" placeholder="e.g., fox cute rating:s score:>200" value={newFeedQuery} onChange={(e) => setNewFeedQuery(e.target.value)} className={`w-full px-4 py-2 rounded-xl focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]`} />
                    <p className={`text-xs mt-1 text-[#4c4b5a]`}>Use e621 search syntax.</p>
                  </div>
                  <div className="flex justify-between">
                    {editingFeedId ? (
                      <button
                        onClick={() => {
                          removeFeed(editingFeedId);
                          if (selectedFeedId === editingFeedId) setSelectedFeedId(null);
                          setShowAddFeedModal(false);
                          setEditingFeedId(null);
                          setNewFeedName('');
                          setNewFeedQuery('');
                        }}
                        className="px-4 py-2 rounded-xl text-red-400 hover:bg-red-600 hover:text-white transition-colors"
                      >
                        Delete Feed
                      </button>
                    ) : <div />}
                    <div className="flex gap-3">
                      <button onClick={() => { setNewFeedName(''); setNewFeedQuery(''); setShowAddFeedModal(false); setEditingFeedId(null); }} className={`px-4 py-2 rounded-xl bg-[#1d1b2d] hover:bg-[#4c4b5a]`}>Cancel</button>
                      <button
                        onClick={() => {
                          if (!newFeedQuery.trim()) { toast("Please enter a search query.", "error"); return; }
                          if (editingFeedId) {
                            saveFeeds(feeds.map(f => f.id === editingFeedId ? { ...f, name: newFeedName.trim() || newFeedQuery, query: newFeedQuery.trim() } : f));
                          } else {
                            const feed = { id: Date.now(), name: newFeedName.trim() || newFeedQuery, query: newFeedQuery.trim() };
                            saveFeeds([...feeds, feed]);
                            setSelectedFeedId(feed.id);
                            fetchFeedPosts(feed.id, feed.query, { reset: true });
                          }
                          setNewFeedQuery(''); setNewFeedName(''); setShowAddFeedModal(false); setEditingFeedId(null);
                        }}
                        className={`px-4 py-2 rounded-xl bg-[#967abc] hover:bg-[#967abc]/80`}
                      >
                        {editingFeedId ? 'Save Changes' : 'Create Feed'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {/* Comics Tab */}
      {activeTab === 'comics' && (
        <div className={`flex-1 overflow-hidden flex flex-col w-full min-w-0 bg-[#0f0f17]`}>
          {selectedPool ? (
      // Comic reader view
            <div className="flex-1 relative overflow-hidden flex flex-col w-full min-w-0">
              {/* Floating Header */}
              <div className="absolute top-0 left-0 right-0 z-20 p-4 pointer-events-none flex justify-between items-start">
                {/* Back & Info Card */}
                <div className={`pointer-events-auto flex items-center gap-3 p-2.5 pr-5 rounded-2xl backdrop-blur-md border shadow-xl bg-[#161621]/80 border-[#1d1b2d]`}>
                  <button onClick={closePool} className={`p-2 rounded-xl transition-colors hover:bg-[#1d1b2d] text-white`}>
                    <ArrowLeft className="w-5 h-5" />
                  </button>
                  <div>
                    <h2 className="font-bold text-sm tracking-wide text-white drop-shadow-md">{selectedPool.name}</h2>
                    <p className={`text-xs font-medium drop-shadow-md text-[#9e98aa]`}>
                      Pool #{selectedPool.pool_id} • {poolPosts.filter(p => p.item_id !== 0).length} local • {poolPosts.length} total
                    </p>
                  </div>
                </div>

                {/* Controls Card */}
                <div className={`pointer-events-auto flex items-center gap-2 p-2 rounded-2xl backdrop-blur-md border shadow-xl bg-[#161621]/80 border-[#1d1b2d]`}>
                  <button onClick={() => setComicScale(s => Math.max(10, s - 10))} className={`p-2 rounded-xl text-white hover:bg-[#1d1b2d]`}>
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <span className="text-sm font-medium w-12 text-center text-white drop-shadow-md">{comicScale}%</span>
                  <button onClick={() => setComicScale(s => Math.min(100, s + 10))} className={`p-2 rounded-xl text-white hover:bg-[#1d1b2d]`}>
                    <ZoomIn className="w-4 h-4" />
                  </button>
                  <div className="w-px h-6 bg-gray-500/50 mx-1" />
                  <button onClick={() => setComicAutoscroll(!comicAutoscroll)} className={`p-2 rounded-xl flex items-center gap-1.5 transition-colors text-white ${comicAutoscroll ? ('bg-[#967abc]') : ('hover:bg-[#1d1b2d]')}`}>
                    {comicAutoscroll ? <Pause className="w-4 h-4" /> : <ChevronsDown className="w-4 h-4" />}
                  </button>
                  {comicAutoscroll && (
                    <input
                      type="range"
                      min="0.5"
                      max="5"
                      step="0.5"
                      value={comicAutoscrollSpeed}
                      onChange={(e) => setComicAutoscrollSpeed(Number(e.target.value))}
                      className={`w-20 cursor-pointer mr-2 accent-[#967abc]`}
                    />
                  )}
                </div>
              </div>

              {/* Comic pages */}
              <div ref={comicContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden w-full min-w-0">
                {poolPostsLoading ? (
                  <div className="flex items-center justify-center py-20">
                    <Loader2 className={`w-8 h-8 animate-spin text-[#967abc]`} />
                  </div>
                ) : poolPosts.length === 0 ? (
                  <div className={`text-center py-20 text-[#4c4b5a]`}>
                    <BookOpen className="w-16 h-16 mx-auto mb-4 opacity-30" />
                    <p>No pages from this pool in your library</p>
                    <p className="text-sm mt-2">Favorite more posts from this pool on e621</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center py-4 w-full min-w-0 px-0" style={{ gap: '2px' }}>
                    {poolPosts.map((post) => (
                      <ComicPage
                        key={`${post.source_id}-${post.position}`}
                        post={post}
                        comicScale={comicScale}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            // Pool grid view
            <div className={`flex-1 overflow-y-auto overflow-x-hidden p-4 w-full min-w-0`}>
              <div className="flex items-center justify-between gap-4 mb-4">
                <h2 className="text-xl font-bold flex-shrink-0">Comics & Pools</h2>
                
                <div className="flex gap-2 flex-shrink-0">
                  {pools.length > 0 && !poolsLoading && (
                    <button
                      onClick={handleClearPoolsCache}
                      className={`p-2 rounded-xl transition-colors bg-[#1d1b2d] hover:bg-red-900/50 text-[#9e98aa] hover:text-red-400`}
                      title="Clear Cache"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  )}
                  <button
                    onClick={loadPools}
                    disabled={poolsLoading}
                    className={`relative overflow-hidden flex items-center justify-center min-w-[40px] px-3 py-2 rounded-xl transition-colors (poolsLoading ? 'bg-[#1c1b26] border border-[#1d1b2d] text-[#9e98aa]' : 'bg-[#1d1b2d] hover:bg-[#4c4b5a] text-[#9e98aa]')`}
                    title="Scan Favorites for Pools"
                  >
                    {poolsLoading && poolScanProgress ? (
                      <>
                        <div 
                          className={`absolute left-0 top-0 bottom-0 opacity-20 transition-all duration-300 bg-[#967abc]`}
                          style={{ width: `${(poolScanProgress.current / poolScanProgress.total) * 100}%` }}
                        />
                        <span className="relative z-10 text-xs font-mono font-medium flex items-center gap-2">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          {poolScanProgress.current} / {poolScanProgress.total} unscanned
                        </span>
                      </>
                    ) : poolsLoading ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 11-9-9c2.52 0 4.93 1 6.74 2.74L21 8V3"/><path d="M21 3v5h-5"/></svg>
                    )}
                  </button>
                </div>
              </div>

              {/* Grid or Empty State */}
              {filteredPools.length === 0 && !poolsLoading ? (
                <div className={`text-center py-20 text-[#4c4b5a]`}>
                  <BookOpen className="w-16 h-16 mx-auto mb-4 opacity-30" />
                  <p className="text-xl mb-2">Comics & Pools</p>
                  <p className="text-sm mb-6">Scan your e621 favorites to find pools (comics, series, etc.)</p>
                  <button
                    onClick={loadPools}
                    className={`px-6 py-3 rounded-xl text-white font-medium flex items-center gap-2 mx-auto bg-[#967abc] hover:bg-[#967abc]/80`}
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 11-9-9c2.52 0 4.93 1 6.74 2.74L21 8V3"/><path d="M21 3v5h-5"/></svg>
                    Start Scan
                  </button>
                </div>
              ) : filteredPools.length === 0 && poolsLoading ? (
                 <div className={`text-center py-20 text-[#4c4b5a]`}>
                   <BookOpen className="w-16 h-16 mx-auto mb-4 opacity-10 animate-pulse" />
                   <p>Looking for comics...</p>
                 </div>
              ) : (
                <Masonry
                  breakpointCols={{
                    default: gridColumns,
                    1400: Math.max(1, gridColumns - 1),
                    1000: Math.max(1, gridColumns - 2),
                    700: 2,
                    500: 1,
                  }}
                  className="flex w-auto gap-3"
                  columnClassName="flex flex-col gap-3"
                >
                  {filteredPools.map((pool) => (
                    <div
                      key={pool.pool_id}
                      onClick={() => openPool(pool)}
                      className={`group cursor-pointer rounded-lg overflow-hidden border transition-all bg-[#161621] border-[#1d1b2d] hover:border-[#967abc]`}
                    >
                      <PoolCover pool={pool} />
                      <div className={`p-3 bg-[#161621]`}>
                        <h3 className="font-medium text-sm truncate">{pool.name}</h3>
                        <p className={`text-xs mt-1 text-[#4c4b5a]`}>{pool.post_count} pages</p>
                      </div>
                    </div>
                  ))}
                </Masonry>
              )}
            </div>
          )}
        </div>
      )}
      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowSettings(false)} />
          <div className="relative z-10 w-full max-w-3xl h-[85vh] rounded-xl flex overflow-hidden bg-[#161621] border border-[#1d1b2d]">

            {/* Sidebar */}
            <div className="w-44 flex-shrink-0 border-r border-[#1d1b2d] p-3 flex flex-col bg-[#131320]">
              <div className="flex-1 space-y-1">
                {([
                  { id: 'general' as const, label: 'General', icon: Settings },
                  { id: 'credentials' as const, label: 'Accounts', icon: Database },
                  { id: 'security' as const, label: 'Security', icon: Shield },
                  { id: 'maintenance' as const, label: 'Maintenance', icon: RefreshCw },
                ]).map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setSettingsTab(tab.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2.5 transition-colors ${
                      settingsTab === tab.id
                        ? 'bg-[#967abc]/20 text-[#967abc] font-medium'
                        : 'text-[#9e98aa] hover:text-white hover:bg-[#1d1b2d]'
                    }`}
                  >
                    <tab.icon className="w-4 h-4 flex-shrink-0" />
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="text-[10px] text-[#4c4b5a] pt-3 border-t border-[#1d1b2d]">
                TailBurrow v{APP_VERSION}
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 flex flex-col min-w-0">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-[#1d1b2d] flex-shrink-0">
                <h2 className="text-lg font-semibold capitalize">{settingsTab === 'credentials' ? 'Accounts' : settingsTab}</h2>
                <button onClick={() => setShowSettings(false)} className="text-[#9e98aa] hover:text-white"><X className="w-5 h-5" /></button>
              </div>

              {/* Tab Content */}
              <div className="flex-1 overflow-y-auto p-5 space-y-5">

                {/* ════════ GENERAL TAB ════════ */}
                {settingsTab === 'general' && (
                  <>
                    {/* Library */}
                    <div>
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-[#9e98aa] mb-3">Library</h3>
                      <div className="text-xs text-gray-200 break-all rounded-xl p-2.5 bg-[#0f0f17] border border-[#1d1b2d] mb-3">
                        {libraryRoot || "(not set)"}
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <button onClick={changeLibraryRoot} className="px-4 py-2 rounded-xl text-sm bg-[#967abc] hover:bg-[#967abc]/80">Change Library</button>
                        <button onClick={() => { setShowSettings(false); loadTrash(); }} className="px-4 py-2 rounded-xl text-sm flex items-center gap-2 bg-[#1d1b2d] hover:bg-[#4c4b5a]">
                          <Trash2 className="w-3.5 h-3.5" />Trash ({trashCount})
                        </button>
                        <button
                          onClick={() => {
                            setConfirmModal({
                              title: "Unload Library",
                              message: "Unload the current library?",
                              okLabel: "Yes, unload",
                              onConfirm: async () => {
                                try {
                                  await invoke("clear_library_root");
                                  setLibraryRoot(""); setItems([]); setTotalDatabaseItems(0); setHasMoreItems(true);
                                  setPools([]); setSelectedPool(null); setPoolPosts([]);
                                  setShowSettings(false);
                                } catch (e) {
                                  toast("Failed to unload: " + String(e), "error");
                                }
                              },
                            });
                          }}
                          className="px-4 py-2 rounded-xl text-sm bg-red-900/50 hover:bg-red-600 text-red-200 hover:text-white"
                        >
                          Unload
                        </button>
                      </div>
                    </div>

                    {/* Viewer */}
                    <div className="border-t border-[#1d1b2d] pt-5">
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-[#9e98aa] mb-3">Viewer</h3>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="text-xs text-[#9e98aa] mb-1 block">Default sort order</label>
                          <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="w-full px-3 py-2 rounded-xl text-sm focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]">
                            <option value="default">Default</option><option value="random">Random</option><option value="score">Score</option><option value="newest">Newest</option><option value="oldest">Oldest</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-xs text-[#9e98aa] mb-1 block">Items per batch</label>
                          <select value={itemsPerPage} onChange={(e) => handlePageSizeChange(Number(e.target.value))} className="w-full px-3 py-2 rounded-xl text-sm focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]">
                            <option value={50}>50</option><option value={100}>100 (Recommended)</option><option value={200}>200</option><option value={500}>500</option><option value={1000}>1000</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-xs text-[#9e98aa] mb-1 block flex justify-between"><span>Grid Columns</span><span className="font-mono text-[#967abc]">{gridColumns}</span></label>
                          <input type="range" min="1" max="8" value={gridColumns} onChange={(e) => { const val = Number(e.target.value); setGridColumns(val); localStorage.setItem('grid_columns', String(val)); }} className="w-full cursor-pointer accent-[#967abc] mt-1" />
                        </div>
                        <div className="row-span-2">
                          <label className="text-xs text-[#9e98aa] mb-1 block">Blacklist (Feeds Only)</label>
                          <textarea value={blacklist} onChange={(e) => setBlacklist(e.target.value)} placeholder="Tags to hide..." className="w-full px-3 py-2 rounded-xl h-20 min-h-[42px] focus:outline-none text-sm resize-y bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]" />
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {/* ════════ CREDENTIALS TAB ════════ */}
                {settingsTab === 'credentials' && (
                  <>
                    {/* e621 */}
                    <div>
                      <div className="flex items-center mb-3">
                        <h3 className="text-sm font-semibold uppercase tracking-wider text-[#9e98aa]">e621</h3>
                        <HelpTooltip text={<div>1. Go to e621.net<br />2. Click <b>Settings</b> (top right)<br />3. Go to <b>Basic &gt; Account &gt; API Keys</b><br />4. Generate/Copy your API Key</div>} />
                      </div>

                      {e621CredInfo.has_api_key && !isEditingE621 ? (
                        <div className="flex items-center justify-between p-3 rounded-xl mb-3 bg-[#0f0f17] border border-green-900/50">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-green-500" />
                            <span className="text-sm text-gray-300">Credentials saved ({e621CredInfo.username})</span>
                          </div>
                          <div className="flex gap-2">
                            <button onClick={() => setIsEditingE621(true)} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded text-[#9e98aa] hover:text-white" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                            <button
                              onClick={() => {
                                setConfirmModal({
                                  title: "Clear Credentials",
                                  message: "Clear e621 credentials?",
                                  okLabel: "Clear",
                                  onConfirm: async () => {
                                    await invoke("e621_clear_credentials");
                                    setApiUsername(""); setApiKey("");
                                    await refreshE621CredInfo();
                                  },
                                });
                              }}
                              className="p-1.5 bg-red-900/50 hover:bg-red-600 rounded text-red-200 hover:text-white" title="Clear"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="mb-3 animate-in fade-in slide-in-from-top-2 duration-200">
                          <div className="flex gap-2 mb-2">
                            <input type="text" placeholder="Username" value={apiUsername} onChange={(e) => setApiUsername(e.target.value)} className="flex-1 px-3 py-2 rounded-xl text-sm focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]" />
                            <input type="password" placeholder="API Key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="flex-1 px-3 py-2 rounded-xl text-sm focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]" />
                          </div>
                          <div className="flex gap-2">
                            <button onClick={async () => { await saveE621Credentials(); setIsEditingE621(false); }} className="px-4 py-2 rounded-xl text-sm bg-[#967abc] hover:bg-[#967abc]/80">Save</button>
                            {e621CredInfo.has_api_key && <button onClick={() => setIsEditingE621(false)} className="px-4 py-2 rounded-xl text-sm bg-[#1d1b2d] hover:bg-[#4c4b5a]">Cancel</button>}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* FurAffinity */}
                    <div className="border-t border-[#1d1b2d] pt-5">
                      <div className="flex items-center mb-3">
                        <h3 className="text-sm font-semibold uppercase tracking-wider text-[#9e98aa]">FurAffinity</h3>
                        <HelpTooltip text={<div>1. Login to FurAffinity in browser<br />2. Press <b>F12</b> (Dev Tools) &gt; <b>Application</b> tab<br />3. Under <b>Cookies</b>, find <b>furaffinity.net</b><br />4. Copy values for <b>a</b> and <b>b</b></div>} />
                      </div>

                      {faCredsSet && !isEditingFA ? (
                        <div className="flex items-center justify-between p-3 rounded-xl mb-3 bg-[#0f0f17] border border-green-900/50">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-green-500" />
                            <span className="text-sm text-gray-300">Cookies saved</span>
                          </div>
                          <div className="flex gap-2">
                            <button onClick={() => setIsEditingFA(true)} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded text-[#9e98aa] hover:text-white" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                            <button
                              onClick={() => {
                                setConfirmModal({
                                  title: "Clear Cookies",
                                  message: "Clear FurAffinity cookies?",
                                  okLabel: "Clear",
                                  onConfirm: () => { setFaCredsSet(false); setFaCreds({ a: '', b: '' }); setIsEditingFA(true); },
                                });
                              }}
                              className="p-1.5 bg-red-900/50 hover:bg-red-600 rounded text-red-200 hover:text-white" title="Clear"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="mb-3 animate-in fade-in slide-in-from-top-2 duration-200">
                          <div className="flex gap-2 mb-2">
                            <input type="text" placeholder="Cookie A" value={faCreds.a} onChange={e => setFaCreds(prev => ({ ...prev, a: e.target.value }))} className="flex-1 px-3 py-2 rounded-xl text-sm bg-[#1c1b26] border border-[#1d1b2d]" />
                            <input type="text" placeholder="Cookie B" value={faCreds.b} onChange={e => setFaCreds(prev => ({ ...prev, b: e.target.value }))} className="flex-1 px-3 py-2 rounded-xl text-sm bg-[#1c1b26] border border-[#1d1b2d]" />
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={async () => {
                                if (!faCreds.a || !faCreds.b) { toast("Enter both cookies.", "error"); return; }
                                await invoke("fa_set_credentials", { a: faCreds.a, b: faCreds.b });
                                setFaCredsSet(true); await refreshFaCreds(); setIsEditingFA(false); setFaCreds({ a: '', b: '' });
                              }}
                              className="px-4 py-2 rounded-xl text-sm bg-[#967abc] hover:bg-[#967abc]/80"
                            >Save</button>
                            {faCredsSet && <button onClick={() => setIsEditingFA(false)} className="px-4 py-2 rounded-xl text-sm bg-[#1d1b2d] hover:bg-[#4c4b5a]">Cancel</button>}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* ════════ SECURITY TAB ════════ */}
                {settingsTab === 'security' && (
                  <>
                    {/* App Lock */}
                    <div>
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-[#9e98aa] mb-1">App Lock</h3>
                      <p className="text-xs text-[#4c4b5a] mb-3">Require a PIN to open the app. Auto-locks when window loses focus.</p>

                      {hasLock ? (
                        <div>
                          <div className="flex items-center gap-2 p-3 rounded-xl mb-3 bg-[#0f0f17] border border-green-900/50">
                            <div className="w-2 h-2 rounded-full bg-green-500" />
                            <span className="text-sm text-gray-300">Lock is enabled</span>
                          </div>
                          <div className="flex gap-2">
                            <input type="password" placeholder="Current PIN" value={lockRemovePin} onChange={(e) => setLockRemovePin(e.target.value)} className="flex-1 px-3 py-2 rounded-xl text-sm focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]" />
                            <button onClick={handleRemoveLock} className="px-4 py-2 rounded-xl text-sm bg-red-600 hover:bg-red-700">Remove Lock</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <input type="password" placeholder="New PIN (min 4)" value={lockNewPin} onChange={(e) => setLockNewPin(e.target.value)} className="flex-1 px-3 py-2 rounded-xl text-sm focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]" />
                          <input type="password" placeholder="Confirm PIN" value={lockConfirmPin} onChange={(e) => setLockConfirmPin(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSetLock(); }} className="flex-1 px-3 py-2 rounded-xl text-sm focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]" />
                          <button onClick={handleSetLock} className="px-4 py-2 rounded-xl text-sm bg-[#967abc] hover:bg-[#967abc]/80">Set Lock</button>
                        </div>
                      )}
                    </div>

                    {/* Safe Mode PIN */}
                    {hasLock && (
                      <div className="border-t border-[#1d1b2d] pt-5">
                        <h3 className="text-sm font-semibold uppercase tracking-wider text-[#9e98aa] mb-1">Safe Mode PIN</h3>
                        <p className="text-xs text-[#4c4b5a] mb-3">A separate PIN that opens the app showing only safe-rated content. No visible indicator.</p>
                        <div className="flex gap-2">
                          <input type="password" placeholder="Safe PIN (min 4)" value={safePinInput} onChange={(e) => setSafePinInput(e.target.value)} className="flex-1 px-3 py-2 rounded-xl text-sm focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]" />
                          <button
                            onClick={async () => {
                              if (safePinInput.length < 4) { toast("PIN must be at least 4 characters.", "error"); return; }
                              try { await invoke("set_safe_pin", { pin: safePinInput }); setSafePinInput(''); toast("Safe mode PIN set.", "success"); } catch (e) { toast(String(e), "error"); }
                            }}
                            className="px-4 py-2 rounded-xl text-sm bg-[#967abc] hover:bg-[#967abc]/80"
                          >Set</button>
                          <button
                            onClick={async () => {
                              if (!safePinInput) { toast("Enter current safe PIN to remove.", "error"); return; }
                              try { await invoke("clear_safe_pin", { pin: safePinInput }); setSafePinInput(''); toast("Safe mode PIN removed.", "success"); } catch (e) { toast(String(e), "error"); }
                            }}
                            className="px-4 py-2 rounded-xl text-sm bg-red-600 hover:bg-red-700"
                          >Remove</button>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* ════════ MAINTENANCE TAB ════════ */}
                {settingsTab === 'maintenance' && (
                  <>
                    {/* e621 sync */}
                      <div className="rounded-xl border border-[#1d1b2d] bg-[#1c1b26] p-3 mt-3">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-[#9e98aa] mb-2">e621 Sync</h4>
                        <div className="space-y-2">
                          <div className="flex gap-2 items-center">
                            <input type="text" placeholder="Limit (optional)" value={syncMaxNew} onChange={(e) => setSyncMaxNew(e.target.value)} className="flex-1 px-3 py-2 rounded-xl text-sm focus:outline-none bg-[#0f0f17] border border-[#1d1b2d] focus:border-[#967abc]" />
                            <button onClick={startSync} disabled={!!syncStatus?.running || !e621CredInfo.has_api_key} className="px-4 py-2 rounded-xl text-sm bg-[#967abc] hover:bg-[#967abc]/80 disabled:opacity-40 disabled:cursor-not-allowed">
                              {syncStatus?.running ? "Syncing..." : "Start"}
                            </button>
                            {syncStatus?.running && <button onClick={cancelSync} className="px-3 py-2 rounded-xl text-sm bg-red-600 hover:bg-red-700">Stop</button>}
                          </div>
                          <label className="flex items-center gap-2 text-xs text-[#9e98aa] cursor-pointer">
                            <input
                              type="checkbox"
                              checked={syncFullMode}
                              onChange={(e) => setSyncFullMode(e.target.checked)}
                              className="w-4 h-4 rounded bg-[#1d1b2d] border-[#4c4b5a] text-[#967abc] focus:ring-[#967abc]"
                            />
                            Full sync (don't stop early when catching up)
                          </label>
                        </div>
                        {syncStatus && (syncStatus.running || syncStatus.scanned_pages > 0) && (
                          <div className="mt-3 text-xs text-[#9e98aa] space-y-0.5">
                            <div>Pages: {syncStatus.scanned_pages} • Posts: {syncStatus.scanned_posts}</div>
                            <div>Skipped: {syncStatus.skipped_existing} • Downloaded: {syncStatus.downloaded_ok}</div>
                            <div>Failed: {syncStatus.failed_downloads} • Unavailable: {syncStatus.unavailable}</div>
                            {syncStatus.last_error && <div className="text-red-300 break-words">Error: {syncStatus.last_error}</div>}
                            <button onClick={loadUnavailable} className="mt-1 text-[#967abc] hover:underline text-xs">View unavailable →</button>
                          </div>
                        )}
                      </div>

                      {/* FA sync */}
                      <div className="rounded-xl border border-[#1d1b2d] bg-[#1c1b26] p-3 mt-3">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-[#9e98aa] mb-2">FurAffinity Sync</h4>
                        <div className="flex gap-2 items-center">
                          <input type="text" placeholder="Limit (optional)" value={faLimit} onChange={(e) => setFaLimit(e.target.value)} className="flex-1 px-3 py-2 rounded-xl text-sm focus:outline-none bg-[#0f0f17] border border-[#1d1b2d] focus:border-[#967abc]" />
                          <button onClick={startFaSync} disabled={faStatus?.running || (!faCredsSet && !isEditingFA)} className="px-4 py-2 rounded-xl text-sm bg-[#967abc] hover:bg-[#967abc]/80 disabled:opacity-40 disabled:cursor-not-allowed">
                            {faStatus?.running ? "Syncing..." : "Start"}
                          </button>
                          {faStatus?.running && <button onClick={cancelFaSync} className="px-3 py-2 rounded-xl text-sm bg-red-600 hover:bg-red-700">Stop</button>}
                        </div>
                        {faStatus && (faStatus.running || faStatus.scanned > 0) && (
                          <div className="mt-3 text-xs text-[#9e98aa] space-y-0.5">
                            <div>{faStatus.current_message}</div>
                            <div>Scanned: {faStatus.scanned} • Skip URL: {faStatus.skipped_url} • Skip MD5: {faStatus.skipped_md5}</div>
                            <div className="text-purple-400">Upgraded to e621: {faStatus.upgraded}</div>
                            <div className="text-green-400">FA Exclusives: {faStatus.imported}</div>
                            <div>Errors: {faStatus.errors}</div>
                          </div>
                        )}
                      </div>
                    {/* Find Duplicates */}
                    <div className="rounded-xl border border-[#1d1b2d] bg-[#1c1b26] p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm flex items-center gap-2"><Search className="w-4 h-4 text-blue-400" />Find Duplicates</h4>
                          <p className="text-xs text-[#4c4b5a] mt-1">Scan library for files with matching MD5 hashes.</p>
                        </div>
                        <button onClick={findDuplicates} disabled={dupLoading} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#1d1b2d] hover:bg-[#4c4b5a] text-[#9e98aa] hover:text-white disabled:opacity-40 flex items-center gap-1.5 flex-shrink-0 ml-3">
                          {dupLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                          {dupLoading ? 'Scanning...' : 'Scan'}
                        </button>
                      </div>

                      {dupGroups.length > 0 && (
                        <div className="mt-3 space-y-2">
                          <div className="text-xs text-[#9e98aa]">Found {dupGroups.length} duplicate group{dupGroups.length !== 1 ? 's' : ''}</div>
                          <div className="max-h-64 overflow-y-auto space-y-2">
                            {dupGroups.map((group) => (
                              <div key={group.md5} className="rounded-lg bg-[#0f0f17] border border-[#1d1b2d] p-3">
                                <div className="text-[10px] font-mono text-[#4c4b5a] mb-2">MD5: {group.md5}</div>
                                <div className="space-y-1.5">
                                  {group.items.map((item, idx) => (
                                    <div key={item.item_id} className="flex items-center justify-between text-xs">
                                      <div className="flex items-center gap-2 min-w-0">
                                        <span className={`px-1.5 py-0.5 rounded font-bold uppercase text-[9px] tracking-wider ${
                                          item.source === 'e621' ? 'bg-blue-600' : item.source === 'local' ? 'bg-emerald-600' : 'bg-orange-600'
                                        }`}>
                                          {item.source === 'e621' ? 'E6' : item.source === 'local' ? 'LC' : 'FA'}
                                        </span>
                                        <span className="text-gray-300 truncate">#{item.source_id}</span>
                                        <span className="text-[#4c4b5a]">.{item.ext}</span>
                                      </div>
                                      {idx > 0 && (
                                        <button
                                          onClick={() => trashDuplicate(item.item_id)}
                                          className="px-2 py-1 rounded text-[10px] bg-red-900/40 hover:bg-red-600 text-red-300 hover:text-white transition-colors flex-shrink-0 ml-2"
                                        >
                                          Trash
                                        </button>
                                      )}
                                      {idx === 0 && (
                                        <span className="text-[10px] text-green-400 flex-shrink-0 ml-2">Keep</span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Check Deleted Posts */}
                    <div className="rounded-xl border border-[#1d1b2d] bg-[#1c1b26] p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm flex items-center gap-2"><Trash2 className="w-4 h-4 text-yellow-400" />Check Deleted Posts</h4>
                          <p className="text-xs text-[#4c4b5a] mt-1">Find e621 favorites that were deleted. Auto-tags by reason (AI, artist request, paysite).</p>
                        </div>
                        <button
                          onClick={() => { setDeletedResults([]); startDeletedCheck(); }}
                          disabled={!!deletedCheckStatus?.running || !e621CredInfo.has_api_key}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#1d1b2d] hover:bg-[#4c4b5a] text-[#9e98aa] hover:text-white disabled:opacity-40 flex items-center gap-1.5 flex-shrink-0 ml-3"
                        >
                          {deletedCheckStatus?.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                          {deletedCheckStatus?.running ? 'Checking...' : 'Start'}
                        </button>
                      </div>

                      {/* Progress */}
                      {deletedCheckStatus && deletedCheckStatus.running && (
                        <div className="mt-3">
                          <div className="flex justify-between text-[10px] text-[#9e98aa] mb-1">
                            <span>{deletedCheckStatus.message}</span>
                          {deletedCheckStatus.total > 0 && (
                            <span>
                              {deletedCheckStatus.current}/{deletedCheckStatus.total}
                              {(() => {
                                const eta = formatETA(deletedCheckStatus.started_at, deletedCheckStatus.current, deletedCheckStatus.total);
                                return eta ? ` • ${eta}` : '';
                              })()}
                            </span>
                          )}
                          </div>
                          {deletedCheckStatus.total > 0 && (
                            <div className="w-full h-1.5 bg-[#0f0f17] rounded-full overflow-hidden">
                              <div className="h-full bg-yellow-500 transition-all duration-300" style={{ width: `${(deletedCheckStatus.current / deletedCheckStatus.total) * 100}%` }} />
                            </div>
                          )}
                        </div>
                      )}

                      {/* Summary message */}
                      {deletedCheckStatus && !deletedCheckStatus.running && deletedCheckStatus.message && (
                        <div className="text-xs text-[#9e98aa] mt-3">{deletedCheckStatus.message}</div>
                      )}

                      {/* Results */}
                      {!deletedCheckStatus?.running && deletedResults.length > 0 && (
                        <div className="mt-3 space-y-2">
                          <div className="max-h-52 overflow-y-auto space-y-1.5 rounded-lg bg-[#0f0f17] border border-[#1d1b2d] p-2">
                            {deletedResults.map((info) => (
                              <div key={info.post_id} className="flex items-center justify-between text-xs px-2 py-1.5 rounded-lg bg-[#1c1b26]">
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                  <span className="text-[#4c4b5a] flex-shrink-0">#{info.post_id}</span>
                                  <span className="text-gray-300 truncate">{info.reason}</span>
                                </div>
                                <span className={`flex-shrink-0 ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                                  info.tag_applied === 'ai_generated' ? 'bg-red-900/50 text-red-300'
                                    : info.tag_applied === 'artist_requested_deletion' ? 'bg-yellow-900/50 text-yellow-300'
                                    : info.tag_applied === 'paysite_content' ? 'bg-orange-900/50 text-orange-300'
                                    : 'bg-gray-700 text-gray-400'
                                }`}>
                                  {info.tag_applied === 'ai_generated' ? 'AI'
                                    : info.tag_applied === 'artist_requested_deletion' ? 'Artist'
                                    : info.tag_applied === 'paysite_content' ? 'Paysite'
                                    : 'Deleted'}
                                </span>
                              </div>
                            ))}
                          </div>

                          {/* Unfavorite button */}
                          <div className="flex items-center gap-3 pt-1">
                            {unfavoritingDeleted ? (
                              <div className="flex-1">
                                <div className="flex justify-between text-[10px] text-[#9e98aa] mb-1">
                                  <span>Unfavoriting on e621...</span>
                                  <span>{unfavoriteProgress.current}/{unfavoriteProgress.total}</span>
                                </div>
                                <div className="w-full h-1.5 bg-[#0f0f17] rounded-full overflow-hidden">
                                  <div className="h-full bg-purple-500 transition-all duration-300" style={{ width: `${(unfavoriteProgress.current / unfavoriteProgress.total) * 100}%` }} />
                                </div>
                              </div>
                            ) : (
                              <button
                                onClick={() => {
                                  setConfirmModal({
                                    title: "Unfavorite Deleted Posts",
                                    message: `Remove ${deletedResults.length} deleted post(s) from your e621 favorites? This only removes the favorite on e621 — your local files are kept.`,
                                    okLabel: "Unfavorite All",
                                    onConfirm: unfavoriteDeletedPosts,
                                  });
                                }}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#967abc] hover:bg-[#967abc]/80 text-white flex items-center gap-1.5"
                              >
                                <Star className="w-3.5 h-3.5" />
                                Unfavorite {deletedResults.length} on e621
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Update Metadata */}
                    <div className="rounded-xl border border-[#1d1b2d] bg-[#1c1b26] p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm flex items-center gap-2"><RefreshCw className="w-4 h-4 text-green-400" />Update Metadata</h4>
                          <p className="text-xs text-[#4c4b5a] mt-1">Re-fetch scores, fav counts, and tags from e621 for all library items.</p>
                        </div>
                        <button
                          onClick={startMetadataUpdate}
                          disabled={!!metaUpdateStatus?.running || !e621CredInfo.has_api_key}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#1d1b2d] hover:bg-[#4c4b5a] text-[#9e98aa] hover:text-white disabled:opacity-40 flex items-center gap-1.5 flex-shrink-0 ml-3"
                        >
                          {metaUpdateStatus?.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                          {metaUpdateStatus?.running ? 'Updating...' : 'Start'}
                        </button>
                      </div>
                      {metaUpdateStatus && (
                        <div className="mt-3">
                          {metaUpdateStatus.running && metaUpdateStatus.total > 0 && (
                            <div>
                              <div className="flex justify-between text-[10px] text-[#9e98aa] mb-1">
                                <span>{metaUpdateStatus.message}</span>
                                <span>{metaUpdateStatus.current}/{metaUpdateStatus.total}</span>
                              </div>
                              <div className="w-full h-1.5 bg-[#0f0f17] rounded-full overflow-hidden">
                                <div className="h-full bg-green-500 transition-all duration-300" style={{ width: `${(metaUpdateStatus.current / metaUpdateStatus.total) * 100}%` }} />
                              </div>
                            </div>
                          )}
                          {!metaUpdateStatus.running && metaUpdateStatus.message && (
                            <div className="text-xs text-[#9e98aa]">{metaUpdateStatus.message}</div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Enrich from e621 */}
                    <div className="rounded-xl border border-[#1d1b2d] bg-[#1c1b26] p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm flex items-center gap-2"><Star className="w-4 h-4 text-purple-400" />Enrich from e621</h4>
                          <p className="text-xs text-[#4c4b5a] mt-1">Check FurAffinity and local imports against e621 by MD5 and visual similarity (IQDB). Imports tags, scores, and sources. Upgrades to the higher-resolution version when available.</p>
                        </div>
                        <button
                          onClick={startFaUpgrade}
                          disabled={!!faUpgradeStatus?.running || !e621CredInfo.has_api_key}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#1d1b2d] hover:bg-[#4c4b5a] text-[#9e98aa] hover:text-white disabled:opacity-40 flex items-center gap-1.5 flex-shrink-0 ml-3"
                        >
                          {faUpgradeStatus?.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Star className="w-3.5 h-3.5" />}
                          {faUpgradeStatus?.running ? 'Checking...' : 'Start'}
                        </button>
                      </div>
                      {faUpgradeStatus && (
                        <div className="mt-3">
                          {faUpgradeStatus.running && faUpgradeStatus.total > 0 && (
                            <div>
                              <div className="flex justify-between text-[10px] text-[#9e98aa] mb-1">
                                <span>{faUpgradeStatus.message}</span>
                                <span>{faUpgradeStatus.current}/{faUpgradeStatus.total}</span>
                              </div>
                              <div className="w-full h-1.5 bg-[#0f0f17] rounded-full overflow-hidden">
                                <div className="h-full bg-purple-500 transition-all duration-300" style={{ width: `${(faUpgradeStatus.current / faUpgradeStatus.total) * 100}%` }} />
                              </div>
                            </div>
                          )}
                          {!faUpgradeStatus.running && faUpgradeStatus.message && (
                            <div className="text-xs text-[#9e98aa]">{faUpgradeStatus.message}</div>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Unavailable Modal (nested, stays as-is) */}
          {showUnavailable && (
            <div className="fixed inset-0 z-[51] flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/60" onClick={() => setShowUnavailable(false)} />
              <div className="relative z-10 w-full max-w-3xl rounded-xl p-5 bg-[#161621] border border-[#1d1b2d]">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold">Unavailable favorites</h2>
                  <button onClick={() => setShowUnavailable(false)} className="text-[#9e98aa] hover:text-white"><X className="w-5 h-5" /></button>
                </div>
                <div className="max-h-[60vh] overflow-y-auto space-y-3">
                  {unavailableList.length === 0 ? (
                    <div className="text-[#4c4b5a]">No unavailable posts recorded.</div>
                  ) : (
                    unavailableList.map((u) => (
                      <div key={`${u.source}:${u.source_id}`} className="rounded-xl p-3 bg-[#0f0f17] border border-[#1d1b2d]">
                        <div className="text-sm text-gray-200">
                          <span className="text-[#9e98aa]">{u.source}</span> #{u.source_id} <span className="text-[#4c4b5a]">• {u.reason} • {u.seen_at}</span>
                        </div>
                        <div className="mt-2 text-xs space-y-1">
                          {u.sources.length > 0 ? u.sources.map((s, i) => (
                            <div key={i}><button onClick={() => openExternalUrl(s)} className="underline break-all text-[#967abc]">{s}</button></div>
                          )) : <div className="text-[#4c4b5a]">No source links.</div>}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Edit Metadata Modal */}
      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowEditModal(false)} />
          <div className={`relative z-10 w-full max-w-2xl max-h-[90vh] rounded-xl flex flex-col shadow-2xl bg-[#161621] border border-[#1d1b2d]`}>
            <div className={`flex items-center justify-between p-5 border-b border-[#1d1b2d]`}>
              <h2 className="text-xl font-bold">Edit Post Metadata</h2>
              <button onClick={() => setShowEditModal(false)} className={`text-[#9e98aa] hover:text-white`}><X className="w-5 h-5" /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Rating */}
              <div>
                <h3 className="text-sm font-semibold text-gray-400 mb-2 uppercase tracking-wider">Rating</h3>
                <div className="flex gap-4">
                  {(['s', 'q', 'e'] as const).map(r => (
                    <label key={r} className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" name="rating" checked={editingRating === r} onChange={() => setEditingRating(r)} className="w-4 h-4 text-purple-600 bg-gray-700 border-gray-600 focus:ring-purple-500" />
                      <span className="capitalize">{r === 's' ? 'Safe' : r === 'q' ? 'Questionable' : 'Explicit'}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Sources */}
              <div>
                <h3 className="text-sm font-semibold text-gray-400 mb-2 uppercase tracking-wider">Sources</h3>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text" placeholder="Paste URL..."
                    value={newSourceInput}
                    onChange={(e) => setNewSourceInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newSourceInput.trim()) {
                        e.preventDefault();
                        if (!editingSources.includes(newSourceInput.trim())) setEditingSources([...editingSources, newSourceInput.trim()]);
                        setNewSourceInput("");
                      }
                    }}
                    className={`flex-1 px-3 py-2 rounded-xl focus:outline-none text-sm bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]`}
                  />
                  <button onClick={() => { if (newSourceInput.trim() && !editingSources.includes(newSourceInput.trim())) { setEditingSources([...editingSources, newSourceInput.trim()]); setNewSourceInput(""); } }} className={`px-3 py-2 rounded-xl text-sm bg-[#1d1b2d] hover:bg-[#4c4b5a]`}>Add</button>
                </div>
                <div className="space-y-1">
                  {editingSources.map((src, i) => (
                    <div key={i} className={`flex items-center justify-between px-3 py-2 rounded-xl bg-[#0f0f17] border border-[#1d1b2d]`}>
                      <a href={src} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:underline truncate mr-2">{src}</a>
                      <button onClick={() => setEditingSources(prev => prev.filter(s => s !== src))} className="text-gray-500 hover:text-red-400"><X className="w-4 h-4" /></button>
                    </div>
                  ))}
                  {editingSources.length === 0 && <p className="text-xs text-gray-500 italic">No sources linked.</p>}
                </div>
              </div>

              {/* Tags */}
              <div>
                <h3 className="text-sm font-semibold text-gray-400 mb-2 uppercase tracking-wider">Tags</h3>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text" placeholder="Add tag..."
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newTagInput.trim()) {
                        e.preventDefault();
                        const t = newTagInput.trim().toLowerCase();
                        if (!editingTags.includes(t)) setEditingTags([...editingTags, t]);
                        setNewTagInput("");
                      }
                    }}
                    className={`flex-1 px-3 py-2 rounded-xl focus:outline-none text-sm bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]`}
                  />
                  <button onClick={() => { const t = newTagInput.trim().toLowerCase(); if (t && !editingTags.includes(t)) { setEditingTags([...editingTags, t]); setNewTagInput(""); } }} className={`px-3 py-2 rounded-xl text-sm bg-[#1d1b2d] hover:bg-[#4c4b5a]`}>Add</button>
                </div>
                <div className={`flex flex-wrap gap-2 p-3 rounded-xl min-h-[100px] content-start bg-[#0f0f17] border border-[#1d1b2d]`}>
                  {editingTags.map(tag => (
                    <span key={tag} className={`px-2.5 py-1 rounded-full text-sm flex items-center gap-1 bg-[#967abc]/20 border border-[#967abc]/30`}>
                      {tag}
                      <button onClick={() => setEditingTags(prev => prev.filter(t => t !== tag))} className="hover:text-red-400 ml-1"><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className={`flex justify-end gap-2 p-5 border-t border-[#1d1b2d]}`}>
              <button onClick={() => setShowEditModal(false)} className={`px-4 py-2 rounded-xl bg-[#1d1b2d] hover:bg-[#4c4b5a]`}>Cancel</button>
              <button onClick={saveMetadata} className={`px-6 py-2 rounded-xl font-bold bg-[#967abc] hover:bg-[#967abc]/80`}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {/* Trash Modal */}
      {showTrashModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowTrashModal(false)} />
          <div className={`relative z-10 w-full max-w-4xl max-h-[90vh] rounded-xl flex flex-col bg-[#161621] border border-[#1d1b2d]`}>
            <div className={`flex items-center justify-between p-5 border-b flex-shrink-0 border-[#1d1b2d]`}>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Trash2 className={`w-5 h-5 text-[#9e98aa]`} />
                Trash
              </h2>
              <div className="flex gap-2">
                <button onClick={handleEmptyTrash} disabled={trashedItems.length === 0} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-xl disabled:opacity-50 text-sm font-medium">Empty Trash</button>
                <button onClick={() => setShowTrashModal(false)} className={`text-[#9e98aa] hover:text-white`}><X className="w-5 h-5" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {trashedItems.length > 0 ? (
                <Masonry breakpointCols={4} className="flex w-auto gap-3" columnClassName="flex flex-col gap-3">
                  {trashedItems.map((item) => {
                    const isVid = ["mp4", "webm"].includes((item.ext || "").toLowerCase());
                    return (
                      <div key={item.item_id} className={`relative group rounded-lg overflow-hidden border bg-[#1c1b26] border-[#1d1b2d]`}>
                        {isVid ? (
                          <video src={item.url} className="w-full h-auto object-cover opacity-60" />
                        ) : (
                          <img src={item.url} className="w-full h-auto object-cover opacity-60" loading="lazy" alt="" />
                        )}
                        <div className="absolute inset-0 flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 bg-black/50 transition-opacity">
                          <button onClick={() => handleRestore(item.item_id)} className="p-2 bg-green-600 hover:bg-green-700 rounded-full text-white" title="Restore"><Undo className="w-5 h-5" /></button>
                        </div>
                        <div className={`absolute bottom-0 left-0 right-0 p-1.5 text-xs text-center bg-[#0f0f17]/80 text-[#9e98aa]`}>
                          {item.source} #{item.source_id}
                        </div>
                      </div>
                    );
                  })}
                </Masonry>
              ) : (
                <div className={`text-center py-20 text-[#4c4b5a]`}>
                  <Trash2 className="w-16 h-16 mx-auto mb-4 opacity-20" />
                  <p>Trash is empty</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2 text-xs border-t flex-shrink-0 bg-[#161621] border-[#1d1b2d] text-[#4c4b5a]">
        <span>TailBurrow v{APP_VERSION}</span>
        <span>{itemCount} loaded • {totalDatabaseItems} total</span>
        <button onClick={loadTrash} className={`flex items-center gap-1.5 transition-colors hover:text-[#967abc]`}>
          <Trash2 className="w-3.5 h-3.5" />
          Trash ({trashCount})
        </button>
      </div>

      <AutoscrollWidget
        active={true}
        autoscroll={autoscroll}
        setAutoscroll={setAutoscroll}
        autoscrollSpeed={autoscrollSpeed}
        setAutoscrollSpeed={setAutoscrollSpeed}
        hidden={shouldHideAutoscroll}
        rightOffset={
          (activeTab === 'viewer' && libraryDetailOpen && currentItem) ? libraryDetailWidth + 6 :
          (activeTab === 'feeds' && feedDetailOpen && selectedFeedPost) ? feedDetailWidth + 6 :
          0
        }
      />
      {/* Bulk Tag Modal */}
      {showBulkTagModal && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowBulkTagModal(false)} />
          <div className="relative z-10 w-full max-w-md rounded-xl p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150 bg-[#161621] border border-[#1d1b2d]">
            <h3 className="text-lg font-bold mb-2">
              {bulkTagMode === 'add' ? 'Add Tag to' : 'Remove Tag from'} {selectedItemIds.size} Items
            </h3>
            <p className="text-sm text-[#9e98aa] mb-4">
              {bulkTagMode === 'add'
                ? 'This tag will be added to all selected items.'
                : 'This tag will be removed from all selected items.'}
            </p>
            <input
              type="text"
              placeholder="Enter tag..."
              value={bulkTagInput}
              onChange={(e) => setBulkTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (bulkTagMode === 'add') bulkAddTag();
                  else bulkRemoveTag();
                }
              }}
              autoFocus
              className="w-full px-4 py-2.5 rounded-xl mb-4 focus:outline-none bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc] text-white placeholder-[#4c4b5a]"
            />
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowBulkTagModal(false)}
                className="px-4 py-2 rounded-xl transition-colors bg-[#1d1b2d] hover:bg-[#4c4b5a]"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (bulkTagMode === 'add') bulkAddTag();
                  else bulkRemoveTag();
                }}
                disabled={!bulkTagInput.trim()}
                className={`px-4 py-2 rounded-xl font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  bulkTagMode === 'add'
                    ? 'bg-[#967abc] hover:bg-[#967abc]/80 text-white'
                    : 'bg-red-600 hover:bg-red-700 text-white'
                }`}
              >
                {bulkTagMode === 'add' ? 'Add Tag' : 'Remove Tag'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Import Modal */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowImportModal(false)} />
          <div className="relative z-10 w-full max-w-2xl max-h-[90vh] rounded-xl flex flex-col shadow-2xl bg-[#161621] border border-[#1d1b2d]">
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b border-[#1d1b2d] flex-shrink-0">
              <h2 className="text-xl font-bold flex items-center gap-2">
                <Upload className="w-5 h-5 text-emerald-400" />
                Import Files
              </h2>
              <button onClick={() => setShowImportModal(false)} className="text-[#9e98aa] hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* File List */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-[#9e98aa] uppercase tracking-wider">
                    Files ({importFiles.length})
                  </h3>
                  <button
                    onClick={selectImportFiles}
                    className="px-3 py-1.5 text-xs rounded-lg bg-[#1d1b2d] hover:bg-[#4c4b5a] text-[#9e98aa] hover:text-white transition-colors flex items-center gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add More
                  </button>
                </div>
                <div className="space-y-1.5 max-h-48 overflow-y-auto rounded-xl bg-[#0f0f17] border border-[#1d1b2d] p-2">
                  {importFiles.map((filePath, i) => {
                    const fileName = filePath.split(/[/\\]/).pop() || filePath;
                    const fileExt = (fileName.split('.').pop() || '').toLowerCase();
                    const isVid = ['mp4', 'webm'].includes(fileExt);
                    return (
                      <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[#1c1b26] group">
                        {/* Small preview */}
                        <div className="w-10 h-10 rounded overflow-hidden flex-shrink-0 bg-[#0f0f17]">
                          {isVid ? (
                            <div className="w-full h-full flex items-center justify-center">
                              <Play className="w-4 h-4 text-[#4c4b5a]" />
                            </div>
                          ) : (
                            <img
                              src={convertFileSrc(filePath)}
                              alt=""
                              className="w-full h-full object-cover"
                              onError={(e) => { e.currentTarget.style.display = 'none'; }}
                            />
                          )}
                        </div>
                        <span className="text-sm text-gray-300 truncate flex-1" title={filePath}>
                          {fileName}
                        </span>
                        <button
                          onClick={() => setImportFiles(prev => prev.filter((_, idx) => idx !== i))}
                          className="opacity-0 group-hover:opacity-100 text-[#4c4b5a] hover:text-red-400 transition-all flex-shrink-0"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
                  {importFiles.length === 0 && (
                    <div className="text-center py-6 text-[#4c4b5a] text-sm">
                      No files selected
                    </div>
                  )}
                </div>
              </div>

              {/* Rating */}
              <div>
                <h3 className="text-sm font-semibold text-[#9e98aa] uppercase tracking-wider mb-2">Rating</h3>
                <div className="flex gap-4">
                  {(['s', 'q', 'e'] as const).map(r => (
                    <label key={r} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="import-rating"
                        checked={importRating === r}
                        onChange={() => setImportRating(r)}
                        className="w-4 h-4 text-purple-600 bg-gray-700 border-gray-600 focus:ring-purple-500"
                      />
                      <span className={`capitalize ${r === 'e' ? 'text-red-400' : r === 'q' ? 'text-yellow-400' : 'text-green-400'}`}>
                        {r === 's' ? 'Safe' : r === 'q' ? 'Questionable' : 'Explicit'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Tags */}
              <div>
                <h3 className="text-sm font-semibold text-[#9e98aa] uppercase tracking-wider mb-2">Tags</h3>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    placeholder="Add tag..."
                    value={importTagInput}
                    onChange={(e) => setImportTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && importTagInput.trim()) {
                        e.preventDefault();
                        const t = importTagInput.trim().toLowerCase();
                        if (!importTags.includes(t)) setImportTags(prev => [...prev, t]);
                        setImportTagInput('');
                      }
                    }}
                    className="flex-1 px-3 py-2 rounded-xl focus:outline-none text-sm bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]"
                  />
                  <button
                    onClick={() => {
                      const t = importTagInput.trim().toLowerCase();
                      if (t && !importTags.includes(t)) { setImportTags(prev => [...prev, t]); setImportTagInput(''); }
                    }}
                    className="px-3 py-2 rounded-xl text-sm bg-[#1d1b2d] hover:bg-[#4c4b5a]"
                  >
                    Add
                  </button>
                </div>
                {importTags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {importTags.map(tag => (
                      <span key={tag} className="px-2.5 py-1 rounded-full text-xs flex items-center gap-1 bg-[#967abc]/20 border border-[#967abc]/30">
                        {tag}
                        <button onClick={() => setImportTags(prev => prev.filter(t => t !== tag))} className="hover:text-red-400 ml-0.5">
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Sources */}
              <div>
                <h3 className="text-sm font-semibold text-[#9e98aa] uppercase tracking-wider mb-2">Source Links (optional)</h3>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    placeholder="Paste URL..."
                    value={importSourceInput}
                    onChange={(e) => setImportSourceInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && importSourceInput.trim()) {
                        e.preventDefault();
                        if (!importSources.includes(importSourceInput.trim())) setImportSources(prev => [...prev, importSourceInput.trim()]);
                        setImportSourceInput('');
                      }
                    }}
                    className="flex-1 px-3 py-2 rounded-xl focus:outline-none text-sm bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]"
                  />
                  <button
                    onClick={() => {
                      if (importSourceInput.trim() && !importSources.includes(importSourceInput.trim())) {
                        setImportSources(prev => [...prev, importSourceInput.trim()]);
                        setImportSourceInput('');
                      }
                    }}
                    className="px-3 py-2 rounded-xl text-sm bg-[#1d1b2d] hover:bg-[#4c4b5a]"
                  >
                    Add
                  </button>
                </div>
                {importSources.length > 0 && (
                  <div className="space-y-1">
                    {importSources.map((src, i) => (
                      <div key={i} className="flex items-center justify-between px-3 py-2 rounded-xl bg-[#0f0f17] border border-[#1d1b2d]">
                        <span className="text-xs text-blue-400 truncate mr-2">{src}</span>
                        <button onClick={() => setImportSources(prev => prev.filter(s => s !== src))} className="text-gray-500 hover:text-red-400">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 p-5 border-t border-[#1d1b2d] flex-shrink-0">
              <button
                onClick={() => setShowImportModal(false)}
                className="px-4 py-2 rounded-xl bg-[#1d1b2d] hover:bg-[#4c4b5a] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={importFiles.length === 0 || importLoading}
                className="px-6 py-2 rounded-xl font-bold bg-emerald-600 hover:bg-emerald-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {importLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4" />
                    Import {importFiles.length} File{importFiles.length !== 1 ? 's' : ''}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmModal && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setConfirmModal(null)} />
          <div className={`relative z-10 w-full max-w-md rounded-xl p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150 bg-[#161621] border border-[#1d1b2d]`}>
            <h3 className="text-lg font-bold mb-2">{confirmModal.title}</h3>
            <p className={`text-sm mb-6 text-[#9e98aa]}`}>{confirmModal.message}</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmModal(null)}
                className={`px-4 py-2 rounded-xl transition-colors bg-[#1d1b2d] hover:bg-[#4c4b5a]`}
              >
                {confirmModal.cancelLabel || 'Cancel'}
              </button>
              <button
                onClick={() => { confirmModal.onConfirm(); setConfirmModal(null); }}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 font-medium transition-colors"
              >
                {confirmModal.okLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default function FavoritesViewer() {
  return (
    <ErrorBoundary>
      <FavoritesViewerInner />
    </ErrorBoundary>
  );
}