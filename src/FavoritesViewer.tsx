import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Search, Upload, Play, Pause, ChevronLeft, ChevronRight,
  X, Tag, Trash2, Rss, Plus, Star, Maximize, Settings,
  Database, Loader2, LayoutGrid, Volume2, VolumeX, Clock, Pencil,
  Info, Undo, ChevronsDown, BookOpen, ArrowLeft, ZoomIn, ZoomOut
} from "lucide-react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog, confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import Masonry from "react-masonry-css";

const APP_VERSION = "0.2.4";
const TOAST_DURATION_MS = 4000;

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
const INFINITE_SCROLL_MARGIN = "800px 0px";
const FEED_PAGE_LIMIT = 50;

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
  tags: string[];
  artists: string[];
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
  unavailable: number; last_error?: string | null;
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

// ─── HELPERS ─────────────────────────────────────────────────
function mapItemDto(r: ItemDto): LibraryItem {
  return {
    item_id: r.item_id,
    source: r.source,
    source_id: r.source_id,
    remote_url: r.remote_url,
    url: convertFileSrc(r.file_abs),
    file_rel: r.file_rel,
    ext: r.ext,
    tags: r.tags || [],
    artist: r.artists || [],
    sources: r.sources || [],
    rating: r.rating,
    fav_count: r.fav_count,
    score: { total: r.score_total ?? 0 },
    timestamp: r.timestamp,
    tags_general: r.tags_general || [],
    tags_artist: r.tags_artist || [],
    tags_copyright: r.tags_copyright || [],
    tags_character: r.tags_character || [],
    tags_species: r.tags_species || [],
    tags_meta: r.tags_meta || [],
    tags_lore: r.tags_lore || [],
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

function parsePositiveInt(s: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = s.trim();
  if (trimmed === "") return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return { ok: false };
  return { ok: true, value: n };
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

    if (["mp4", "webm", "gif"].includes(ext)) {
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

const GridItem = React.memo(({ item, index, onSelect, isSelected }: {
  item: LibraryItem;
  index: number;
  onSelect: (index: number) => void;
  isSelected?: boolean;
}) => {
  const isVid = ["mp4", "webm"].includes((item.ext || "").toLowerCase());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
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

  return (
    <div
      onClick={() => onSelect(index)}
      className={`relative group cursor-pointer bg-gray-800 rounded-lg overflow-hidden transition-all ${isSelected ? 'ring-2 ring-purple-500 border border-purple-500' : 'border border-gray-700 hover:border-purple-500'}`}    >
      {isVid ? (
        <div className="relative">
          <video
            ref={videoRef}
            src={item.url}
            className="w-full h-auto object-cover"
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
        <Thumbnail item={item} className="w-full h-auto object-cover" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3 pointer-events-none">
        <div className="flex items-center gap-1.5 mb-1">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${item.source === 'e621' ? 'bg-blue-600' : 'bg-orange-600'}`}>
            {item.source === 'e621' ? 'E6' : 'FA'}
          </span>
          <span className="text-white text-sm font-medium truncate">
            {(() => {
              const artists = (item.artist && item.artist.length > 0)
                ? item.artist
                : item.tags_artist;
              const filtered = (artists || []).filter(a =>
                !['conditional_dnp', 'sound_warning', 'unknown_artist', 'epilepsy_warning'].includes(a)
              );
              return filtered.length > 0 ? filtered.join(", ") : "Unknown";
            })()}
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
  const artists = post.tags.artist.filter(a => !['conditional_dnp', 'sound_warning', 'unknown_artist', 'epilepsy_warning'].includes(a));
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

const AutoscrollWidget = ({ active, autoscroll, setAutoscroll, autoscrollSpeed, setAutoscrollSpeed, hidden, isStudio }: {
  active: boolean; autoscroll: boolean; setAutoscroll: (v: boolean) => void;
  autoscrollSpeed: number; setAutoscrollSpeed: (v: number) => void; hidden: boolean; isStudio?: boolean;
}) => {
  if (!active || hidden) return null;

  if (!autoscroll) {
    return (
      <button
        onClick={() => setAutoscroll(true)}
        className={`fixed bottom-12 right-4 px-3 py-2 rounded-xl shadow-lg border transition-all z-40 flex items-center gap-2 text-xs font-medium ${
          isStudio
            ? 'bg-[#161621] hover:bg-[#1d1b2d] text-[#9e98aa] hover:text-white border-[#1d1b2d]'
            : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white border-gray-600'
        }`}
        title="Start Autoscroll"
      >
        <ChevronsDown className="w-4 h-4" />
        Scroll
      </button>
    );
  }

  return (
    <div className={`fixed bottom-12 right-4 backdrop-blur border rounded-xl shadow-xl z-40 animate-in fade-in slide-in-from-bottom-4 ${
      isStudio ? 'bg-[#161621]/95 border-[#1d1b2d]' : 'bg-gray-900/95 border-gray-600'
    }`}>
      <div className="flex items-center gap-2 p-2">
        <button
          onClick={() => setAutoscroll(false)}
          className={`p-1.5 rounded-lg transition-colors ${isStudio ? 'hover:bg-[#1d1b2d] text-red-400' : 'hover:bg-gray-700 text-red-400'}`}
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
          className={`w-24 h-1.5 cursor-pointer ${isStudio ? 'accent-[#967abc]' : 'accent-purple-500'}`}
        />
        <span className={`text-[10px] font-mono w-6 text-right ${isStudio ? 'text-[#9e98aa]' : 'text-gray-400'}`}>{autoscrollSpeed}x</span>
      </div>
    </div>
  );
};

// ─── RESIZE HANDLE ───────────────────────────────────────────
const ResizeHandle = ({ onDrag }: { onDrag: (clientX: number) => void }) => {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMouseMove = (ev: MouseEvent) => onDrag(ev.clientX);
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
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

const skeletonWidths = [75, 60, 85, 70, 90, 65, 80, 72, 88, 68, 77, 83, 62, 95, 71];

const SkeletonTagList = ({ count = 10 }: { count?: number }) => (
  <div className="space-y-1">
    {Array.from({ length: count }).map((_, i) => (
      <Skeleton key={i} className="h-7" style={{ width: `${skeletonWidths[i % skeletonWidths.length]}%` }} />
    ))}
  </div>
);

// ─── MAIN COMPONENT ──────────────────────────────────────────
export default function FavoritesViewer() {

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
  const [sortOrder, setSortOrder] = useState(() => localStorage.getItem('preferred_sort_order') || 'default');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [fadeIn, setFadeIn] = useState(true);
  const [imageLoading, setImageLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'grid' | 'single'>('grid');

  // Slideshow
  const [isSlideshow, setIsSlideshow] = useState(false);
  const [slideshowSpeed, setSlideshowSpeed] = useState(5000);
  const [autoMuteVideos, setAutoMuteVideos] = useState(false);
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
  const [feedSearchInput, setFeedSearchInput] = useState('');
  const [feedSearchResults, setFeedSearchResults] = useState<E621Post[]>([]);
  const [feedSearchLoading, setFeedSearchLoading] = useState(false);
  const [selectedFeedPost, setSelectedFeedPost] = useState<E621Post | null>(null);
  const [feedDetailWidth, setFeedDetailWidth] = useState(() =>
    Number(localStorage.getItem('feed_detail_width') || 500)
  );
  const feedsContainerRef = useRef<HTMLDivElement>(null);

  // Settings & System
  const [showSettings, setShowSettings] = useState(false);
  const [libraryRoot, setLibraryRoot] = useState("");
  const [syncMaxNew, setSyncMaxNew] = useState<string>("");
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [unavailableList, setUnavailableList] = useState<UnavailableDto[]>([]);

  // Paging
  const [initialLoading, setInitialLoading] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreItems, setHasMoreItems] = useState(true);
  const [totalDatabaseItems, setTotalDatabaseItems] = useState(0);
  const [itemsPerPage, setItemsPerPage] = useState(() => Number(localStorage.getItem('items_per_page') || 100));
  const loadingRef = useRef(false);
  const loadRequestIdRef = useRef(0); // For cancellation
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
  const [viewerLayout, setViewerLayout] = useState<'classic' | 'studio'>(() =>
    (localStorage.getItem('viewer_layout') as 'classic' | 'studio') || 'classic'
  );
  const [leftPanelWidth, setLeftPanelWidth] = useState(() =>
    Number(localStorage.getItem('left_panel_width') || 350)
  );
  const [rightPanelWidth, setRightPanelWidth] = useState(() =>
    Number(localStorage.getItem('right_panel_width') || 280)
  );
  const studioContainerRef = useRef<HTMLDivElement>(null);

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


  // --- DERIVED STATE (stable) ---
  const isStudio = viewerLayout === 'studio';
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
  const isVideo = ext === "mp4" || ext === "webm";

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    hasMoreRef.current = hasMoreItems;
  }, [hasMoreItems]);

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

const allTagsCache = useRef<{ length: number; tags: string[] }>({ length: 0, tags: [] });

  const allTags = useMemo(() => {
    // Only needed in grid mode
    if (viewMode !== 'grid') return allTagsCache.current.tags;

    // Skip recomputation if item count hasn't changed significantly (within 10%)
    const cachedLen = allTagsCache.current.length;
    const currentLen = items.length;
    if (cachedLen > 0 && Math.abs(currentLen - cachedLen) / cachedLen < 0.1) {
      return allTagsCache.current.tags;
    }

    // Sample up to 500 items for performance (still representative for popular tags)
    const sampleSize = Math.min(items.length, 500);
    const step = items.length <= sampleSize ? 1 : Math.floor(items.length / sampleSize);

    const tagCounts = new Map<string, number>();
    for (let i = 0; i < items.length && tagCounts.size < 5000; i += step) {
      const item = items[i];
      item.tags?.forEach(tag => {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      });
    }

    const result = Array.from(tagCounts.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 100) // Only need top 100, UI shows 50
      .map(([tag]) => tag);

    allTagsCache.current = { length: currentLen, tags: result };
    return result;
  }, [items, viewMode]);

  // --- CORE DATA ---
  const loadData = useCallback(async (append: boolean, overrides?: { pageSize?: number }) => {
    const requestId = ++loadRequestIdRef.current;
    const limit = overrides?.pageSize ?? itemsPerPage;

    if (!append) {
      setIsSearching(true);
    }

    try {
      const offset = append ? itemsRef.current.length : 0;
      let combinedSearch = [searchTags, ...selectedTags].join(" ").trim();
      if (safeMode && !combinedSearch.includes("rating:")) {
        combinedSearch = combinedSearch ? `${combinedSearch} rating:s` : "rating:s";
      }
      const rows = await invoke<ItemDto[]>("list_items", {
        limit,
        offset,
        search: combinedSearch,
        source: filterSource,
        order: sortOrder,
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
  }, [itemsPerPage, searchTags, selectedTags, filterSource, sortOrder, toast, safeMode]);

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
    if (viewerOverlay) {
      setFadeIn(false);
      setTimeout(() => {
        setCurrentIndex(prev => {
          const len = itemsRef.current.length;
          return len === 0 ? 0 : (prev + 1) % len;
        });
        requestAnimationFrame(() => setFadeIn(true));
      }, FADE_DURATION_MS);
    } else {
      setCurrentIndex(prev => {
        const len = itemsRef.current.length;
        return len === 0 ? 0 : (prev + 1) % len;
      });
    }
  }, [viewerOverlay, pokeHud]);

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

  // --- SYNC ---
  const refreshSyncStatus = useCallback(async () => {
    setSyncStatus(await invoke<SyncStatus>("e621_sync_status"));
  }, []);

  const startSync = useCallback(async () => {
    const parsed = parsePositiveInt(syncMaxNew);
    if (!parsed.ok) { toast("Stop-after-N must be a positive number or blank.", "error"); return; }
    await invoke("e621_sync_start", { maxNewDownloads: parsed.value });
    syncWasRunningRef.current = true;
    await refreshSyncStatus();
  }, [syncMaxNew, refreshSyncStatus, toast]);

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

  const ensureFavorite = useCallback(async (feedId: number, post: E621Post) => {
    const id = post.id;
    try {
      setFeedActionBusy(prev => ({ ...prev, [id]: true }));
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
      if (feedId === -1) {
        setFeedSearchResults(prev => prev.map(p => p.id === id ? { ...p, is_favorited: true } : p));
      } else {
        setFeedPosts(prev => ({
          ...prev,
          [feedId]: (prev[feedId] || []).map((p) => p.id === id ? { ...p, is_favorited: true } : p),
        }));
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
    await loadData(false);
  }, [refreshLibraryRoot, loadData]);

  // const toggleFullscreen = useCallback(async () => {
  //   if (viewerOverlay) pokeHud();
  //   try {
  //     if (!document.fullscreenElement) {
  //       await document.documentElement.requestFullscreen();
  //     } else {
  //       await document.exitFullscreen();
  //     }
  //   } catch (e) {
  //     console.warn("Fullscreen request failed:", e);
  //   }
  // }, [viewerOverlay, pokeHud]);

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

  const toggleTag = useCallback((tag: string) => {
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

  const handleEmptyTrash = useCallback(async () => {
    const ok = await confirmDialog(
      "Permanently delete all items in trash? This cannot be undone.",
      { title: "Empty Trash", okLabel: "Delete Forever", cancelLabel: "Cancel" }
    );
    if (!ok) return;
    await invoke("empty_trash");
    setTrashedItems([]);
    setTrashCount(0);
  }, []);

  const loadPools = useCallback(async () => {
    if (!e621CredInfo.username || !e621CredInfo.has_api_key) {
      toast("Set e621 credentials in Settings first.", "error");
      return;
    }
    setPoolsLoading(true);
    setPoolScanProgress({ current: 0, total: 0 });
    
    try {
      // 1. Get all local IDs instantly
      const localIds = await invoke<number[]>("get_all_e621_ids");
      
      if (localIds.length === 0) {
        setPoolsLoading(false);
        setPoolScanProgress(null);
        return;
      }
      
      setPoolScanProgress({ current: 0, total: localIds.length });
      
      // Keep track of pools we already know so we don't re-fetch them
      const knownPools = new Set<number>();
      pools.forEach(p => knownPools.add(p.pool_id));
      
            // 2. Scan them in batches of 100
      for (let i = 0; i < localIds.length; i += 100) {
        const chunk = localIds.slice(i, i + 100);
        
        try {
          const foundPoolIds = await invoke<number[]>("check_posts_for_pools", { ids: chunk });
          
          for (const pid of foundPoolIds) {
            if (!knownPools.has(pid)) {
              knownPools.add(pid);
              // Fetch pool cover immediately so it pops into the grid real-time
              const poolInfo = await invoke<PoolInfo | null>("fetch_pool_info", { poolId: pid });
              if (poolInfo) {
                setPools(prev => {
                  const next = [...prev, poolInfo];
                  next.sort((a, b) => a.name.localeCompare(b.name));
                  // Fire-and-forget save to cache so it persists instantly
                  invoke("save_pools_cache", { pools: next }).catch(console.error);
                  return next;
                });
              }
            }
          }
        } catch (err) {
          console.warn("Chunk scan error", err);
        }
        
        // Update progress bar
        setPoolScanProgress({ current: Math.min(i + 100, localIds.length), total: localIds.length });
      }
    } catch (e) {
      toast("Failed to scan pools: " + String(e), "error");
    } finally {
      setPoolsLoading(false);
      setPoolScanProgress(null);
    }
  }, [e621CredInfo, toast, pools]);

  const openPool = useCallback(async (pool: PoolInfo) => {
    setSelectedPool(pool);
    setPoolPostsLoading(true);
    try {
      const posts = await invoke<PoolPost[]>("get_pool_posts", { poolId: pool.pool_id });
      setPoolPosts(posts);
    } catch (e) {
      toast("Failed to load pool posts: " + String(e), "error");
    } finally {
      setPoolPostsLoading(false);
    }
  }, [toast]);

  const closePool = useCallback(() => {
    setSelectedPool(null);
    setPoolPosts([]);
    setComicAutoscroll(false);
  }, []);


  const handleUnlock = useCallback(async () => {
    setPinError('');
    try {
      // Check safe PIN first
      const isSafe = await invoke<boolean>("verify_safe_pin", { pin: pinInput });
      if (isSafe) {
        setSafeMode(true);
        setIsLocked(false);
        setPinInput('');
        return;
      }

      const ok = await invoke<boolean>("verify_app_lock", { pin: pinInput });
      if (ok) {
        setSafeMode(false);
        setIsLocked(false);
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
        await loadData(false);
        await refreshLibraryRoot();
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
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;

      const key = e.key.toLowerCase();

      if (e.key === "Escape") {
        e.preventDefault();
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
        if (viewMode === 'single') { setViewMode('grid'); return; }
      }

      if (key === "s") { e.preventDefault(); setShowSettings(prev => !prev); }
      if (key === "l" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (hasLock) {
          setIsLocked(true);
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
                await document.documentElement.requestFullscreen();
                setViewerOverlay(true);
              } else {
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
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab, viewerOverlay, pokeHud, goToPrev, goToNext, openEditModal, showSettings, showEditModal, showTrashModal, showAddFeedModal, viewMode]);

  // HUD management
  useEffect(() => { if (viewerOverlay) pokeHud(); }, [viewerOverlay, pokeHud]);
  useEffect(() => {
    return () => {
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
      if (faSyncIntervalRef.current) clearInterval(faSyncIntervalRef.current);
    };
  }, []);

  // Auto-lock on OS lock (screen lock / sleep)
  useEffect(() => {
    if (!hasLock) return;
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        setIsLocked(true);
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
    const handler = () => { if (!document.fullscreenElement && viewerOverlay) setViewerOverlay(false); };
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, [viewerOverlay]);

  // Persist preferences
  useEffect(() => { try { localStorage.setItem('preferred_sort_order', sortOrder); } catch { /* ignore */ } }, [sortOrder]);
  useEffect(() => { localStorage.setItem('blacklist_tags', blacklist); }, [blacklist]);
  useEffect(() => { localStorage.setItem('viewer_layout', viewerLayout); }, [viewerLayout]);

  useEffect(() => {
    document.documentElement.style.backgroundColor = isStudio ? '#0f0f17' : '#111827';
    document.body.style.backgroundColor = isStudio ? '#0f0f17' : '#111827';
    return () => {
      document.documentElement.style.backgroundColor = '';
      document.body.style.backgroundColor = '';
    };
  }, [isStudio]);

  // Slideshow (removed currentIndex from deps to avoid timer reset) uses timeout so video-wait is re-evaluated each slide
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
    setImageLoading(true);
  }, [currentIndex]);

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
    const threshold = Math.max(0, itemCount - 20);
    if (hasMoreItems && !isLoadingMore && currentIndex >= threshold && itemCount > 0) {
      loadMoreItems();
    }
  }, [currentIndex, itemCount, hasMoreItems, isLoadingMore, loadMoreItems]);

  // Reload when filters change
  const filterKeyRef = useRef("");
  useEffect(() => {
    const key = `${sortOrder}|${filterSource}|${selectedTags.join(",")}|${safeMode}`;
    if (filterKeyRef.current === key) return; // Skip initial
    if (filterKeyRef.current === "") { filterKeyRef.current = key; return; } // first mount
    filterKeyRef.current = key;

    if (!initialLoading) {
      setItems([]);
      setHasMoreItems(true);
      loadData(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortOrder, filterSource, selectedTags, safeMode]);

  // Autoscroll
  const autoscrollTargetRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!autoscroll) return;
    let frameId: number;
    const scroll = () => {
      if (isStudio || activeTab === 'feeds') {
        // Find the scrollable container
        if (!autoscrollTargetRef.current) {
          const candidates = document.querySelectorAll('.overflow-y-auto');
          for (const el of candidates) {
            if (el.scrollHeight > el.clientHeight) {
              autoscrollTargetRef.current = el as HTMLElement;
              break;
            }
          }
        }
        autoscrollTargetRef.current?.scrollBy(0, autoscrollSpeed);
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
  }, [autoscroll, autoscrollSpeed, isStudio, activeTab]);

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

  // --- RENDER HELPERS ---
  const handleGridItemSelect = useCallback((index: number) => {
    setCurrentIndex(index);
    setViewMode('single');
  }, []);

  const handleStudioItemSelect = useCallback((index: number) => {
    setCurrentIndex(index);
  }, []);

  const handleLeftResize = useCallback((clientX: number) => {
    if (!studioContainerRef.current) return;
    const rect = studioContainerRef.current.getBoundingClientRect();
    const newWidth = Math.max(200, Math.min(clientX - rect.left, rect.width * 0.5));
    setLeftPanelWidth(newWidth);
    localStorage.setItem('left_panel_width', String(Math.round(newWidth)));
  }, []);
  
  const handleRightResize = useCallback((clientX: number) => {
    if (!studioContainerRef.current) return;
    const rect = studioContainerRef.current.getBoundingClientRect();
    const newWidth = Math.max(200, Math.min(rect.right - clientX, rect.width * 0.4));
    setRightPanelWidth(newWidth);
    localStorage.setItem('right_panel_width', String(Math.round(newWidth)));
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
    <div className={isStudio ? "h-screen flex flex-col overflow-hidden bg-[#0f0f17] text-white" : "min-h-screen flex flex-col bg-gray-900 text-white"}>
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
      {/* Header */}
      <div className={`border-b flex-shrink-0 ${isStudio ? 'border-[#1d1b2d] bg-[#161621]' : 'border-gray-700'}`}>
        <div className={isStudio ? "px-4" : "max-w-7xl mx-auto px-4"}>
          <div className="flex items-center gap-4 py-2">
            <div className="flex gap-1 flex-shrink-0">
              <button onClick={() => setActiveTab('viewer')} className={`px-3 py-1.5 font-medium border-b-2 transition flex items-center gap-1.5 text-sm ${activeTab === 'viewer' ? (isStudio ? 'border-[#967abc] text-[#967abc]' : 'border-purple-500 text-purple-400') : (isStudio ? 'border-transparent text-[#9e98aa] hover:text-white' : 'border-transparent text-gray-400 hover:text-gray-300')}`}><LayoutGrid className="w-3.5 h-3.5" />Viewer</button>
              <button onClick={() => setActiveTab('feeds')} className={`px-3 py-1.5 font-medium border-b-2 transition flex items-center gap-1.5 text-sm ${activeTab === 'feeds' ? (isStudio ? 'border-[#967abc] text-[#967abc]' : 'border-purple-500 text-purple-400') : (isStudio ? 'border-transparent text-[#9e98aa] hover:text-white' : 'border-transparent text-gray-400 hover:text-gray-300')}`}><Rss className="w-3.5 h-3.5" />e621</button>
              <button onClick={() => setActiveTab('comics')} className={`px-3 py-1.5 font-medium border-b-2 transition flex items-center gap-1.5 text-sm ${activeTab === 'comics' ? (isStudio ? 'border-[#967abc] text-[#967abc]' : 'border-purple-500 text-purple-400') : (isStudio ? 'border-transparent text-[#9e98aa] hover:text-white' : 'border-transparent text-gray-400 hover:text-gray-300')}`}><BookOpen className="w-3.5 h-3.5" />Comics</button>
            </div>

            <div className="flex flex-1 items-center gap-2 min-w-0">
              {activeTab === 'viewer' || activeTab === 'comics' ? (
                <>
                  <div className="flex-1 min-w-[150px] relative">
                    <Search className={`absolute left-3 top-2 w-3.5 h-3.5 ${isStudio ? 'text-[#4c4b5a]' : 'text-gray-400'}`} />
                    <input
                      type="text"
                      placeholder={activeTab === 'comics' ? "Search comics by name or pool:12345" : "Search tags..."}
                      value={activeTab === 'comics' ? comicSearchInput : searchTags}
                      onChange={(e) => {
                        if (activeTab === 'comics') {
                          setComicSearchInput(e.target.value);
                        } else {
                          setSearchTags(e.target.value);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && activeTab === 'viewer') {
                          setItems([]);
                          setHasMoreItems(true);
                          loadData(false);
                        }
                      }}
                      className={`w-full pl-9 pr-3 py-1.5 text-sm rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc] text-white placeholder-[#4c4b5a]' : 'bg-gray-800 border border-gray-700 focus:border-purple-500'}`}
                    />
                  </div>
                  {activeTab === 'viewer' && (
                    <>
                      <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className={`px-3 py-1.5 text-sm rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-800 border border-gray-700 focus:border-purple-500'}`}>
                        <option value="default">Default</option>
                        <option value="random">Random</option>
                        <option value="score">Score</option>
                        <option value="newest">Newest</option>
                        <option value="oldest">Oldest</option>
                      </select>
                      <select value={filterSource} onChange={(e) => setFilterSource(e.target.value)} className={`px-3 py-1.5 text-sm rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-800 border border-gray-700 focus:border-purple-500'}`}>
                        <option value="all">All</option>
                        <option value="e621">e621</option>
                        <option value="furaffinity">FurAffinity</option>
                      </select>
                    </>
                  )}
                </>
              ) : (
                <div className="flex-1 min-w-[150px] relative">
                  <Search className={`absolute left-3 top-2 w-3.5 h-3.5 ${isStudio ? 'text-[#4c4b5a]' : 'text-gray-400'}`} />
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
                    className={`w-full pl-9 pr-3 py-1.5 text-sm rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc] text-white placeholder-[#4c4b5a]' : 'bg-gray-800 border border-gray-700 focus:border-purple-500'}`}
                  />
                </div>
              )}
            </div>

            <button onClick={() => setShowSettings(true)} className={`p-1.5 flex-shrink-0 ${isStudio ? 'text-[#9e98aa] hover:text-white' : 'text-gray-400 hover:text-gray-200'}`} title="Settings"><Settings className="w-4 h-4" /></button>
          </div>
        </div>
      </div>

      {/* Viewer Tab */}
      {activeTab === 'viewer' && (
        <>
          {selectedTags.length > 0 && (
            <div className={`px-4 py-2 flex gap-2 flex-wrap border-b flex-shrink-0 ${isStudio ? 'border-[#1d1b2d] bg-[#161621]' : 'border-gray-700'}`}>
              {selectedTags.map(tag => (
                <button key={tag} onClick={() => toggleTag(tag)} className={`px-3 py-1 rounded-full text-sm flex items-center gap-1 ${isStudio ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-purple-600 hover:bg-purple-700'}`}>
                  {tag}<X className="w-3 h-3" />
                </button>
              ))}
            </div>
          )}

          {(initialLoading || isSearching) ? (
            <div className={`${isStudio ? 'px-4 flex-1 overflow-hidden' : 'max-w-7xl mx-auto'} p-4`}>
              <Masonry
                breakpointCols={{ default: gridColumns, 700: 2, 500: 1 }}
                className="flex w-auto gap-3"
                columnClassName="flex flex-col gap-3"
              >
                {Array.from({ length: gridColumns * 3 }).map((_, i) => (
                  <SkeletonGridItem key={`init-skeleton-${i}`} index={i} dark={isStudio} />
                ))}
              </Masonry>
            </div>
            ) : itemCount > 0 ? (
            viewerLayout === 'studio' ? (
              <div ref={studioContainerRef} className="flex flex-1 overflow-hidden">
                {/* Left Panel - Grid */}
                <div style={{ width: leftPanelWidth }} className="overflow-y-auto flex-shrink-0 border-r border-[#1d1b2d] bg-[#0f0f17]">
                  <div className="p-2">
                    <Masonry
                      breakpointCols={Math.max(1, Math.floor(leftPanelWidth / 180))}
                      className="flex w-auto gap-2"
                      columnClassName="flex flex-col gap-2"
                    >
                      {items.map((item, index) => (
                        <GridItem key={item.item_id} item={item} index={index} onSelect={handleStudioItemSelect} isSelected={index === currentIndex} />
                      ))}
                      {isLoadingMore && Array.from({ length: Math.max(1, Math.floor(leftPanelWidth / 180)) * 2 }).map((_, i) => (
                        <SkeletonGridItem key={`skeleton-${i}`} index={i} dark />
                      ))}
                    </Masonry>
                    {hasMoreItems && <InfiniteSentinel onVisible={loadMoreItems} disabled={isLoadingMore} />}
                  </div>
                </div>

                <ResizeHandle onDrag={handleLeftResize} />

                {/* Center Panel - Viewer */}
                <div className="flex-1 flex flex-col overflow-hidden min-w-[200px] bg-[#0f0f17]">
                  <div
                    className={viewerOverlay ? "fixed inset-0 z-50 bg-black" : "flex-1 flex flex-col overflow-hidden min-h-0"}
                    onMouseMove={() => viewerOverlay && pokeHud()}
                    onMouseDown={() => viewerOverlay && pokeHud()}
                    onWheel={() => viewerOverlay && pokeHud()}
                    onTouchStart={() => viewerOverlay && pokeHud()}
                  >
                    {currentItem ? (
                      <div className={viewerOverlay ? "relative w-full h-full" : "relative flex-1 flex flex-col min-h-0 overflow-hidden"}>
                        {imageLoading && (
                          <div className="absolute inset-0 flex items-center justify-center z-10">
                            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#967abc]" />
                          </div>
                        )}
                        {viewerOverlay && (
                          <>
                            <div className="absolute inset-y-0 left-0 w-1/2 z-0 cursor-pointer" onClick={() => goToPrev(true)} />
                            <div className="absolute inset-y-0 right-0 w-1/2 z-0 cursor-pointer" onClick={() => goToNext(true)} />
                          </>
                        )}
                        <div className={viewerOverlay ? "w-full h-full flex items-center justify-center bg-black" : "flex-1 h-0 flex items-center justify-center bg-[#0a0a12] overflow-hidden"}>
                          {isVideo ? (
                            <video
                              key={currentItem.url}
                              src={currentItem.url}
                              controls
                              autoPlay
                              loop={!waitForVideoEnd || !isSlideshow}
                              muted={autoMuteVideos}
                              className={`object-contain transition-opacity duration-300 ${viewerOverlay ? 'w-full h-full' : 'max-w-full max-h-full'} ${fadeIn ? "opacity-100" : "opacity-0"}`}
                              style={viewerOverlay ? { pointerEvents: 'none' } : undefined}
                              onLoadedData={(e) => { if (!autoMuteVideos) e.currentTarget.volume = 1.0; setImageLoading(false); }}
                              onError={() => setImageLoading(false)}
                              onEnded={() => { if (waitForVideoEnd && isSlideshow) goToNext(); }}
                            />
                          ) : (
                            <img
                              key={currentItem.url}
                              src={currentItem.url}
                              alt=""
                              className={`object-contain transition-opacity duration-200 ${viewerOverlay ? 'w-full h-full' : 'max-w-full max-h-full'} ${fadeIn ? "opacity-100" : "opacity-0"}`}
                              onLoad={() => setImageLoading(false)}
                              onError={(e) => {
                                setImageLoading(false);
                                e.currentTarget.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect fill='%23374151' width='400' height='300'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' fill='%239CA3AF' font-size='20'%3EImage not found%3C/text%3E%3C/svg%3E";
                              }}
                            />
                          )}
                        </div>

                        {/* Controls */}
                        <div
                          className={viewerOverlay
                            ? ["absolute bottom-6 left-1/2 -translate-x-1/2", "transition-all duration-300 ease-out", showHud ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"].join(" ")
                            : "p-2 bg-[#161621] border-t border-[#1d1b2d] flex-shrink-0"
                          }
                          onMouseEnter={() => { if (viewerOverlay) { hudHoverRef.current = true; setShowHud(true); } }}
                          onMouseLeave={() => { if (viewerOverlay) { hudHoverRef.current = false; scheduleHudHide(); } }}
                        >
                          <div
                            className={viewerOverlay ? "relative z-20 px-6 py-4 bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-700/50 shadow-2xl" : ""}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center justify-center gap-1.5">
                              <button onClick={() => goToPrev(true)} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded"><ChevronLeft className="w-4 h-4" /></button>
                              <button onClick={() => setIsSlideshow(!isSlideshow)} className="p-1.5 bg-[#967abc] hover:bg-[#967abc]/80 rounded">{isSlideshow ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}</button>
                              <select value={slideshowSpeed} onChange={(e) => setSlideshowSpeed(Number(e.target.value))} className="px-2 py-1.5 bg-[#1d1b2d] border border-[#4c4b5a] rounded-xl text-sm">
                                <option value={1000}>1s</option><option value={3000}>3s</option><option value={5000}>5s</option><option value={10000}>10s</option>
                              </select>
                              <button onClick={() => setAutoMuteVideos(!autoMuteVideos)} className={`p-1.5 rounded ${autoMuteVideos ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-[#1d1b2d] hover:bg-[#4c4b5a]'}`}>{autoMuteVideos ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}</button>
                              <button onClick={() => setWaitForVideoEnd(!waitForVideoEnd)} className={`p-1.5 rounded ${waitForVideoEnd ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-[#1d1b2d] hover:bg-[#4c4b5a]'}`}><Clock className="w-4 h-4" /></button>
                              <button onClick={async () => {
                                try {
                                  if (!document.fullscreenElement) { await document.documentElement.requestFullscreen(); setViewerOverlay(true); }
                                  else { await document.exitFullscreen(); setViewerOverlay(false); }
                                } catch (err) { console.warn("Fullscreen failed:", err); }
                              }} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded"><Maximize className="w-4 h-4" /></button>
                              {!viewerOverlay && <button onClick={deleteCurrentItem} className="p-1.5 bg-[#1d1b2d] hover:bg-red-600 rounded text-[#9e98aa] hover:text-white transition-colors"><Trash2 className="w-4 h-4" /></button>}
                              {!viewerOverlay && <button onClick={openEditModal} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded text-[#9e98aa] hover:text-white"><Pencil className="w-4 h-4" /></button>}
                              <button onClick={() => goToNext(true)} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded"><ChevronRight className="w-4 h-4" /></button>
                              <span className="text-xs text-[#4c4b5a] ml-1">{currentIndex + 1}/{itemCount}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex-1 flex items-center justify-center text-[#4c4b5a]">
                        <div className="text-center">
                          <Database className="w-12 h-12 mx-auto mb-3 opacity-30" />
                          <p>Select an item to view</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <ResizeHandle onDrag={handleRightResize} />

                {/* Right Panel - Tags & Info */}
                <div style={{ width: rightPanelWidth }} className="overflow-y-auto flex-shrink-0 bg-[#161621] border-l border-[#1d1b2d] p-4">
                  {currentItem ? (
                    <>
                      <div className="mb-4 pb-3 border-b border-[#1d1b2d]">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wider flex-shrink-0 ${currentItem.source === 'e621' ? 'bg-blue-600' : 'bg-orange-600'}`}>
                              {currentItem.source === 'e621' ? 'E6' : 'FA'}
                            </span>
                            <span className="text-sm font-medium truncate text-white">
                              {(() => {
                                const artists = (currentItem.artist && currentItem.artist.length > 0) ? currentItem.artist : currentItem.tags_artist;
                                const filtered = (artists || []).filter(a => !['conditional_dnp', 'sound_warning', 'unknown_artist', 'epilepsy_warning'].includes(a));
                                return filtered.length > 0 ? filtered.join(", ") : "Unknown";
                              })()}
                            </span>
                          </div>
                          <button onClick={openEditModal} className="p-1.5 bg-[#1d1b2d] hover:bg-[#4c4b5a] rounded text-[#9e98aa] hover:text-white transition-colors flex-shrink-0" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                        </div>
                        <div className="flex gap-3 text-xs text-[#9e98aa]">
                          <span>⭐ {currentItem.fav_count || 0}</span>
                          <span>Score: {currentItem.score.total}</span>
                          <span className={`font-bold uppercase ${currentItem.rating === 'e' ? 'text-red-400' : currentItem.rating === 'q' ? 'text-yellow-400' : 'text-green-400'}`}>
                            {currentItem.rating === 'e' ? 'Explicit' : currentItem.rating === 'q' ? 'Questionable' : 'Safe'}
                          </span>
                        </div>
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
                      <TagSection title="Artists" tags={currentItem.tags_artist} color="text-yellow-400" onTagClick={toggleTag} />
                      <TagSection title="Copyrights" tags={currentItem.tags_copyright} color="text-pink-400" onTagClick={toggleTag} />
                      <TagSection title="Characters" tags={currentItem.tags_character} color="text-green-400" onTagClick={toggleTag} />
                      <TagSection title="Species" tags={currentItem.tags_species} color="text-red-400" onTagClick={toggleTag} />
                      <TagSection title="General" tags={currentItem.tags_general} color="text-blue-300" onTagClick={toggleTag} />
                      <TagSection title="Meta" tags={currentItem.tags_meta} color="text-gray-400" onTagClick={toggleTag} />
                      <TagSection title="Lore" tags={currentItem.tags_lore} color="text-purple-300" onTagClick={toggleTag} />
                    </>
                  ) : (
                    <div className="text-[#4c4b5a] text-center mt-10">
                      <Tag className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      <p className="text-sm">Select an item to see tags</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
            <div className="max-w-7xl mx-auto p-4">
              {viewMode === 'grid' ? (
                <>
                  <Masonry
                    breakpointCols={{ default: gridColumns, 700: 2, 500: 1 }}
                    className="flex w-auto gap-3"
                    columnClassName="flex flex-col gap-3"
                  >
                    {items.map((item, index) => (
                      <GridItem
                        key={item.item_id}
                        item={item}
                        index={index}
                        onSelect={handleGridItemSelect}
                      />
                    ))}
                    {isLoadingMore && Array.from({ length: gridColumns * 2 }).map((_, i) => (
                      <SkeletonGridItem key={`skeleton-${i}`} index={i} />
                    ))}
                  </Masonry>
                  {hasMoreItems && (
                    <InfiniteSentinel onVisible={loadMoreItems} disabled={isLoadingMore} />
                  )}
                </>
              ) : (
                /* Single View */
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
                  <div className="lg:col-span-3">
                    <div
                      className={viewerOverlay ? "fixed inset-0 z-50 bg-black" : "bg-gray-800 rounded-lg overflow-hidden"}
                      onMouseMove={() => viewerOverlay && pokeHud()}
                      onMouseDown={() => viewerOverlay && pokeHud()}
                      onWheel={() => viewerOverlay && pokeHud()}
                      onTouchStart={() => viewerOverlay && pokeHud()}
                    >
                      {currentItem && (
                        <div className={viewerOverlay ? "relative w-full h-full" : "relative bg-black"}>
                        {imageLoading && (
                            <div className="absolute inset-0 flex items-center justify-center z-10">
                              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500" />
                            </div>
                          )}
                          {viewerOverlay && (
                            <>
                              <div className="absolute inset-y-0 left-0 w-1/2 z-0 cursor-pointer" onClick={() => goToPrev(true)} />
                              <div className="absolute inset-y-0 right-0 w-1/2 z-0 cursor-pointer" onClick={() => goToNext(true)} />
                            </>
                          )}
                          <div className={viewerOverlay ? "w-full h-full flex items-center justify-center bg-black" : "w-full h-[70vh] flex items-center justify-center bg-gray-950 rounded-t-lg overflow-hidden relative"}>
                            {isVideo ? (
                              <video
                                key={currentItem.url}
                                src={currentItem.url}
                                controls
                                autoPlay
                                loop={!waitForVideoEnd || !isSlideshow}
                                muted={autoMuteVideos}
                                className={`max-w-full max-h-full object-contain transition-opacity duration-300 ${fadeIn ? "opacity-100" : "opacity-0"}`}
                                style={viewerOverlay ? { pointerEvents: 'none' } : undefined}
                                onLoadedData={(e) => { if (!autoMuteVideos) e.currentTarget.volume = 1.0; setImageLoading(false); }}
                                onError={() => { setImageLoading(false); console.error("Video load error"); }}
                                onEnded={() => { if (waitForVideoEnd && isSlideshow) goToNext(); }}
                              />
                            ) : (
                              <img
                                key={currentItem.url}
                                src={currentItem.url}
                                alt="Favorite"
                                className={`object-contain transition-opacity duration-300 ${viewerOverlay ? 'w-full h-full' : 'max-w-full max-h-[70vh]'} ${fadeIn ? "opacity-100" : "opacity-0"}`}
                                onLoad={() => setImageLoading(false)}
                                onError={(e) => {
                                  setImageLoading(false);
                                  e.currentTarget.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect fill='%23374151' width='400' height='300'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' fill='%239CA3AF' font-size='20'%3EImage not found%3C/text%3E%3C/svg%3E";
                                }}
                              />
                            )}
                          </div>

                          {/* Controls Bar */}
                          <div
                            className={viewerOverlay
                              ? [
                                "absolute bottom-6 left-1/2 -translate-x-1/2",
                                "transition-all duration-300 ease-out",
                                showHud ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none",
                              ].join(" ")
                              : "p-4 bg-gray-800 border-t border-gray-700"
                            }
                            onMouseEnter={() => { if (viewerOverlay) { hudHoverRef.current = true; setShowHud(true); } }}
                            onMouseLeave={() => { if (viewerOverlay) { hudHoverRef.current = false; scheduleHudHide(); } }}
                          >
                            <div
                              className={viewerOverlay ? "relative z-20 px-6 py-4 bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-700/50 shadow-2xl" : ""}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="flex items-center justify-center gap-2">
                                {!viewerOverlay && <button onClick={() => goToPrev(true)} className="p-2 bg-gray-700 hover:bg-gray-600 rounded"><ChevronLeft className="w-5 h-5" /></button>}
                                <button onClick={() => setIsSlideshow(!isSlideshow)} className="p-2 bg-purple-600 hover:bg-purple-700 rounded">{isSlideshow ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}</button>
                                <select value={slideshowSpeed} onChange={(e) => setSlideshowSpeed(Number(e.target.value))} className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-xl">
                                  <option value={1000}>1s</option><option value={3000}>3s</option><option value={5000}>5s</option><option value={10000}>10s</option>
                                </select>
                                <button onClick={() => setAutoMuteVideos(!autoMuteVideos)} className={`p-2 rounded ${autoMuteVideos ? 'bg-purple-600 hover:bg-purple-700' : 'bg-gray-700 hover:bg-gray-600'}`} title="Mute all videos">{autoMuteVideos ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}</button>
                                <button onClick={() => setWaitForVideoEnd(!waitForVideoEnd)} className={`p-2 rounded ${waitForVideoEnd ? 'bg-purple-600 hover:bg-purple-700' : 'bg-gray-700 hover:bg-gray-600'}`} title="Wait for videos to finish"><Clock className="w-5 h-5" /></button>
                                <button onClick={async () => {
                                  try {
                                    if (!document.fullscreenElement) {
                                      await document.documentElement.requestFullscreen();
                                      setViewerOverlay(true);
                                    } else {
                                      await document.exitFullscreen();
                                      setViewerOverlay(false);
                                    }
                                  } catch (e) {
                                    console.warn("Fullscreen request failed:", e);
                                  }
                                }} className="p-2 bg-gray-700 hover:bg-gray-600 rounded" title={viewerOverlay ? "Exit full viewer" : "Full viewer"}><Maximize className="w-5 h-5" /></button>                                
                                {!viewerOverlay && <button onClick={deleteCurrentItem} className="p-2 bg-gray-700 hover:bg-red-600 rounded text-gray-400 hover:text-white transition-colors" title="Move to trash"><Trash2 className="w-5 h-5" /></button>}
                                {!viewerOverlay && <button onClick={() => goToNext(true)} className="p-2 bg-gray-700 hover:bg-gray-600 rounded"><ChevronRight className="w-5 h-5" /></button>}
                              </div>
                              {!viewerOverlay && <div className="text-center text-gray-400 text-sm mt-4">{currentIndex + 1} / {itemCount}</div>}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Item Info Bar */}
                    {currentItem && (
                      <div className="mt-4 bg-gray-800 rounded-lg p-4">
                        <div className="text-sm text-gray-400 mb-2">
                          {currentItem.source === 'e621' && (
                            <button onClick={() => openExternalUrl(`https://e621.net/posts/${currentItem.source_id}`)} className="text-purple-400 hover:text-purple-300 underline cursor-pointer bg-transparent border-none p-0">
                              e621
                            </button>
                          )}
                          {currentItem.sources && currentItem.sources.length > 0 && (() => {
                            const otherSources = currentItem.sources.filter(s =>
                              currentItem.source !== 'e621' || !s.includes('e621.net/posts')
                            );
                            return otherSources.slice(0, 3).map((source, i) => (
                              <span key={i}>
                                {(i > 0 || currentItem.source === 'e621') && ' • '}
                                <button onClick={() => openExternalUrl(source)} className="text-purple-400 hover:text-purple-300 underline cursor-pointer bg-transparent border-none p-0" title={source}>
                                  {getSocialMediaName(source)}
                                </button>
                              </span>
                            ));
                          })()}
                          {(() => {
                            const validArtists = (currentItem.artist || []).filter(a =>
                              !['conditional_dnp', 'sound_warning', 'unknown_artist', 'epilepsy_warning'].includes(a)
                            );
                            if (validArtists.length === 0) return null;
                            return (
                              <span>
                                {' • Artist: '}
                                {validArtists.map((artist, i) => (
                                  <span key={i}>
                                    {i > 0 && ', '}
                                    <button onClick={() => openExternalUrl(`https://e621.net/posts?tags=${artist}`)} className="text-purple-400 hover:text-purple-300 underline cursor-pointer bg-transparent border-none p-0">
                                      {artist}
                                    </button>
                                  </span>
                                ))}
                              </span>
                            );
                          })()}
                        </div>
                        <div className="flex flex-wrap gap-2 items-center">
                          <button onClick={openEditModal} className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 hover:text-white transition-colors" title="Edit Post">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          {[...(currentItem.tags || [])].sort((a, b) => a.localeCompare(b)).map((tag, i) => (
                            <button key={i} onClick={() => toggleTag(tag)}                             className={`px-2.5 py-1 rounded-full text-xs ${selectedTags.includes(tag) ? 'bg-purple-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'}`}>
                              {tag}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Sidebar */}
                  <div className="lg:col-span-1">
                    <div className="bg-gray-800 rounded-lg p-4 h-full max-h-[80vh] overflow-y-auto">
                      {viewMode === 'single' && currentItem ? (
                        <>
                          <h3 className="text-lg font-semibold mb-3 flex items-center gap-2"><Tag className="w-4 h-4" /> Tags</h3>
                          <TagSection title="Artists" tags={currentItem.tags_artist} color="text-yellow-400" onTagClick={toggleTag} />
                          <TagSection title="Copyrights" tags={currentItem.tags_copyright} color="text-pink-400" onTagClick={toggleTag} />
                          <TagSection title="Characters" tags={currentItem.tags_character} color="text-green-400" onTagClick={toggleTag} />
                          <TagSection title="Species" tags={currentItem.tags_species} color="text-red-400" onTagClick={toggleTag} />
                          <TagSection title="General" tags={currentItem.tags_general} color="text-blue-300" onTagClick={toggleTag} />
                          <TagSection title="Meta" tags={currentItem.tags_meta} color="text-gray-400" onTagClick={toggleTag} />
                          <TagSection title="Lore" tags={currentItem.tags_lore} color="text-purple-300" onTagClick={toggleTag} />
                        </>
                      ) : (
                        <>
                          <h3 className="text-lg font-semibold mb-3 flex items-center gap-2"><Tag className="w-4 h-4" /> Popular Tags</h3>
                          {(initialLoading || isSearching) ? (
                            <SkeletonTagList count={15} />
                          ) : (
                            <div className="space-y-1">
                              {allTags.slice(0, 50).map(tag => (
                              <button key={tag} onClick={() => toggleTag(tag)} className={`w-full text-left px-2 py-1 rounded text-sm hover:bg-gray-700 ${selectedTags.includes(tag) ? 'bg-purple-600' : ''}`}>
                                {tag}
                              </button>
                            ))}
                          </div>
                           )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
            )
          ) : (
            /* Empty State */
            <div className="text-center py-20 text-gray-400">
              {!libraryRoot ? (
                <div className="animate-in fade-in zoom-in duration-300">
                  <Database className={`w-20 h-20 mx-auto mb-6 opacity-80 ${isStudio ? 'text-[#967abc]' : 'text-purple-500'}`} />
                  <h2 className="text-3xl font-bold text-white mb-3">Welcome!</h2>
                  <p className={`mb-8 max-w-md mx-auto ${isStudio ? 'text-[#9e98aa]' : 'text-gray-400'}`}>
                    To get started, select a folder where your favorites will be stored.
                    <br /><span className="text-sm opacity-75">(You can create a new empty folder or select an existing one)</span>
                  </p>
                  <button onClick={changeLibraryRoot} className={`px-8 py-4 text-white rounded-xl font-bold text-lg shadow-lg transition-all transform hover:-translate-y-1 ${isStudio ? 'bg-[#967abc] hover:bg-[#967abc]/80 hover:shadow-[#967abc]/20' : 'bg-purple-600 hover:bg-purple-700 hover:shadow-purple-500/20'}`}>
                    Select Library Folder
                  </button>
                </div>
              ) : (
                <div>
                  <Upload className="w-16 h-16 mx-auto mb-4 opacity-50" />
                  <p className="text-xl font-semibold text-gray-200">Library is Ready</p>
                  <p className={`text-sm mt-2 mb-6 ${isStudio ? 'text-[#9e98aa]' : 'text-gray-400'}`}>
                    Your database is set up at:<br />
                    <span className={`font-mono text-xs px-2 py-1 rounded-lg mt-1 inline-block ${isStudio ? 'bg-[#1c1b26]' : 'bg-gray-800'}`}>{libraryRoot}</span>
                  </p>
                  <div className={`p-4 rounded-xl max-w-md mx-auto border ${isStudio ? 'bg-[#161621] border-[#1d1b2d]' : 'bg-gray-800 border-gray-700'}`}>
                    <p className="text-sm mb-3">Go to <b>Settings → e621</b> to log in and sync your favorites.</p>
                    <button onClick={() => setShowSettings(true)} className={`px-4 py-2 rounded-xl text-white transition-colors ${isStudio ? 'bg-[#1d1b2d] hover:bg-[#4c4b5a]' : 'bg-gray-700 hover:bg-gray-600'}`}>Open Settings</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Feeds Tab */}
      {activeTab === 'feeds' && (
        <div ref={feedsContainerRef} className={`flex-1 flex overflow-hidden ${isStudio ? 'bg-[#0f0f17]' : ''}`}>
          {/* Feed grid pane */}
          <div className={`${selectedFeedPost ? 'flex-shrink-0' : 'flex-1'} overflow-y-auto`} style={selectedFeedPost ? { width: `calc(100% - ${feedDetailWidth}px - 6px)` } : undefined}>
            <div className={isStudio ? "p-4" : "max-w-7xl mx-auto p-4"}>
              {/* Feed pills */}
              <div className="flex justify-center items-center gap-2 mb-4 flex-wrap">
                {feeds.map((feed) => {
                  const isActive = selectedFeedId === feed.id && !feedSearchInput;
                  return (
                    <button
                      key={feed.id}
                      onClick={() => {
                        if (isActive) {
                          fetchFeedPosts(feed.id, feed.query, { reset: true });
                        } else {
                          setFeedSearchInput('');
                          setFeedSearchResults([]);
                          setSelectedFeedPost(null);
                          setSelectedFeedId(feed.id);
                          if (!feedPosts[feed.id] || feedPosts[feed.id].length === 0) {
                            fetchFeedPosts(feed.id, feed.query, { reset: true });
                          }
                        }
                      }}
                      className={`px-4 py-2 rounded-full text-sm font-medium transition-all group ${
                        isActive
                          ? (isStudio ? 'bg-[#967abc] text-white shadow-lg' : 'bg-purple-600 text-white shadow-lg')
                          : (isStudio ? 'bg-[#1c1b26] text-[#9e98aa] hover:bg-[#1d1b2d]' : 'bg-gray-800 text-gray-300 hover:bg-gray-700')
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        {feed.name}
                        {isActive && loadingFeeds[feed.id] && <Loader2 className="w-3 h-3 animate-spin" />}
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            setNewFeedName(feed.name);
                            setNewFeedQuery(feed.query);
                            setEditingFeedId(feed.id);
                            setShowAddFeedModal(true);
                          }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-white/20 rounded"
                        >
                          <Pencil className="w-3 h-3" />
                        </span>
                      </span>
                    </button>
                  );
                })}
                <button
                  onClick={() => { setEditingFeedId(null); setNewFeedName(''); setNewFeedQuery(''); setShowAddFeedModal(true); }}
                  className={`p-2 rounded-full text-sm transition-all ${isStudio ? 'bg-[#1c1b26] text-[#9e98aa] hover:bg-[#1d1b2d]' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              {/* Feed content */}
              {feedSearchInput && !feedSearchLoading && feedSearchResults.length === 0 ? (
                <div className={`text-center py-20 ${isStudio ? 'text-[#4c4b5a]' : 'text-gray-400'}`}>
                  <Search className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>No results found</p>
                </div>
              ) : feedSearchInput || feedSearchLoading ? (
                feedSearchLoading ? (
                  <Masonry breakpointCols={{ default: selectedFeedPost ? Math.max(2, gridColumns - 2) : gridColumns, 700: 2, 500: 1 }} className="flex w-auto gap-3" columnClassName="flex flex-col gap-3">
                    {Array.from({ length: gridColumns * 2 }).map((_, i) => (
                      <SkeletonFeedPost key={`search-skeleton-${i}`} index={i} dark={isStudio} />
                    ))}
                  </Masonry>
                ) : (
                  <Masonry breakpointCols={{ default: selectedFeedPost ? Math.max(2, gridColumns - 2) : gridColumns, 700: 2, 500: 1 }} className="flex w-auto gap-3" columnClassName="flex flex-col gap-3">
                    {feedSearchResults.map((post) => (
                      <FeedPostItem
                        key={post.id}
                        post={post}
                        feedId={-1}
                        downloaded={downloadedE621Ids.has(post.id)}
                        busy={!!feedActionBusy[post.id]}
                        onFavorite={ensureFavorite}
                        onSelect={setSelectedFeedPost}
                      />
                    ))}
                  </Masonry>
                )
              ) : selectedFeedId && feeds.find(f => f.id === selectedFeedId) ? (
                (() => {
                  const feed = feeds.find(f => f.id === selectedFeedId)!;
                  return feedPosts[feed.id] && feedPosts[feed.id].length > 0 ? (
                    <>
                      <Masonry breakpointCols={{ default: selectedFeedPost ? Math.max(2, gridColumns - 2) : gridColumns, 700: 2, 500: 1 }} className="flex w-auto gap-3" columnClassName="flex flex-col gap-3">
                        {feedPosts[feed.id].map((post) => (
                          <FeedPostItem
                            key={post.id}
                            post={post}
                            feedId={feed.id}
                            downloaded={downloadedE621Ids.has(post.id)}
                            busy={!!feedActionBusy[post.id]}
                            onFavorite={ensureFavorite}
                            onSelect={setSelectedFeedPost}
                          />
                        ))}
                      </Masonry>
                      <InfiniteSentinel
                        disabled={!e621CredInfo.username || !e621CredInfo.has_api_key || !!loadingFeeds[feed.id] || !!feedPaging[feed.id]?.done}
                        onVisible={() => fetchFeedPosts(feed.id, feed.query)}
                      />
                      {feedPaging[feed.id]?.done && <div className={`text-center text-sm py-4 ${isStudio ? 'text-[#4c4b5a]' : 'text-gray-500'}`}>End of results</div>}
                    </>
                  ) : loadingFeeds[feed.id] ? (
                    <Masonry breakpointCols={{ default: selectedFeedPost ? Math.max(2, gridColumns - 2) : gridColumns, 700: 2, 500: 1 }} className="flex w-auto gap-3" columnClassName="flex flex-col gap-3">
                      {Array.from({ length: gridColumns * 2 }).map((_, i) => (
                        <SkeletonFeedPost key={`feed-skeleton-${i}`} index={i} dark={isStudio} />
                      ))}
                    </Masonry>
                  ) : (
                    <div className={`text-center py-20 italic ${isStudio ? 'text-[#4c4b5a]' : 'text-gray-400'}`}>"Nobody here but us dergs"</div>
                  );
                })()
              ) : (
                <div className={`text-center py-20 ${isStudio ? 'text-[#4c4b5a]' : 'text-gray-400'}`}>
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
          {selectedFeedPost && (
            <>
              <ResizeHandle onDrag={handleFeedDetailResize} />
              <div style={{ width: feedDetailWidth }} className={`flex-shrink-0 overflow-y-auto ${isStudio ? 'bg-[#161621] border-l border-[#1d1b2d]' : 'bg-gray-800 border-l border-gray-700'}`}>
                <div className="p-4">
                  {/* Close button */}
                  <button
                    onClick={() => setSelectedFeedPost(null)}
                    className={`mb-3 p-1.5 rounded-lg transition-colors ${isStudio ? 'hover:bg-[#1d1b2d] text-[#9e98aa] hover:text-white' : 'hover:bg-gray-700 text-gray-400 hover:text-white'}`}
                  >
                    <X className="w-4 h-4" />
                  </button>

                  {/* Image/Video */}
                  <div className={`rounded-lg overflow-hidden mb-4 ${isStudio ? 'bg-[#0a0a12]' : 'bg-black'}`}>
                    {selectedFeedPost.file.ext === 'webm' || selectedFeedPost.file.ext === 'mp4' ? (
                      <video
                        key={selectedFeedPost.id}
                        src={selectedFeedPost.file.url || selectedFeedPost.sample.url || ''}
                        controls
                        autoPlay
                        loop
                        className="w-full h-auto"
                      />
                    ) : (
                      <img
                        src={selectedFeedPost.sample.url || selectedFeedPost.file.url || selectedFeedPost.preview.url || ''}
                        alt=""
                        className="w-full h-auto"
                        referrerPolicy="no-referrer"
                      />
                    )}
                  </div>

                  {/* Info */}
                  <div className={`mb-4 pb-3 border-b ${isStudio ? 'border-[#1d1b2d]' : 'border-gray-700'}`}>
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wider bg-blue-600">E6</span>
                      <span className="text-sm font-medium truncate text-white">
                        {(() => {
                          const artists = selectedFeedPost.tags.artist.filter(a => !['conditional_dnp', 'sound_warning', 'unknown_artist', 'epilepsy_warning'].includes(a));
                          return artists.length > 0 ? artists.join(", ") : "Unknown";
                        })()}
                      </span>
                    </div>
                    <div className={`flex gap-3 text-xs ${isStudio ? 'text-[#9e98aa]' : 'text-gray-400'}`}>
                      <span>⭐ {selectedFeedPost.fav_count}</span>
                      <span>Score: {selectedFeedPost.score.total}</span>
                      <span className={`font-bold uppercase ${selectedFeedPost.rating === 'e' ? 'text-red-400' : selectedFeedPost.rating === 'q' ? 'text-yellow-400' : 'text-green-400'}`}>
                        {selectedFeedPost.rating === 'e' ? 'Explicit' : selectedFeedPost.rating === 'q' ? 'Questionable' : 'Safe'}
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2 mb-4">
                    <button
                      onClick={() => ensureFavorite(selectedFeedId ?? -1, selectedFeedPost)}
                      disabled={!!feedActionBusy[selectedFeedPost.id]}
                      className={`flex-1 px-3 py-2 rounded-xl text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
                        selectedFeedPost.is_favorited
                          ? 'bg-yellow-500 text-yellow-900'
                          : (isStudio ? 'bg-[#967abc] hover:bg-[#967abc]/80 text-white' : 'bg-purple-600 hover:bg-purple-700 text-white')
                      } ${feedActionBusy[selectedFeedPost.id] ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                      {feedActionBusy[selectedFeedPost.id] ? <Loader2 className="w-4 h-4 animate-spin" /> : <Star className={`w-4 h-4 ${selectedFeedPost.is_favorited ? 'fill-current' : ''}`} />}
                      {selectedFeedPost.is_favorited ? 'Favorited' : 'Favorite & Download'}
                    </button>
                    <button
                      onClick={() => openExternalUrl(`https://e621.net/posts/${selectedFeedPost.id}`)}
                      className={`px-3 py-2 rounded-xl text-sm ${isStudio ? 'bg-[#1d1b2d] hover:bg-[#4c4b5a] text-[#9e98aa]' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}
                    >
                      Open
                    </button>
                  </div>

                  {downloadedE621Ids.has(selectedFeedPost.id) && (
                    <div className={`flex items-center gap-2 text-xs mb-4 px-3 py-2 rounded-xl ${isStudio ? 'bg-[#1d1b2d] text-[#9e98aa]' : 'bg-gray-700 text-gray-400'}`}>
                      <Database className="w-3.5 h-3.5" />
                      Already in library
                    </div>
                  )}

                  {/* Sources */}
                  {selectedFeedPost.sources && selectedFeedPost.sources.length > 0 && (
                    <div className={`mb-4 pb-3 border-b ${isStudio ? 'border-[#1d1b2d]' : 'border-gray-700'}`}>
                      <h4 className={`text-xs font-semibold uppercase tracking-wider mb-2 ${isStudio ? 'text-[#9e98aa]' : 'text-gray-400'}`}>Sources</h4>
                      <div className="space-y-1">
                        {selectedFeedPost.sources.map((source, i) => (
                          <button key={i} onClick={() => openExternalUrl(source)} className={`block text-xs truncate ${isStudio ? 'text-[#967abc] hover:text-[#967abc]/80' : 'text-purple-400 hover:text-purple-300'}`} title={source}>
                            {getSocialMediaName(source)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Tags */}
                  <h4 className={`text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-2 ${isStudio ? 'text-[#9e98aa]' : 'text-gray-400'}`}><Tag className="w-3.5 h-3.5" /> Tags</h4>
                  <TagSection title="Artists" tags={selectedFeedPost.tags.artist} color="text-yellow-400" onTagClick={(tag) => { setFeedSearchInput(tag); searchFeedPosts(tag); setSelectedFeedPost(null); }} />
                  <TagSection title="Copyrights" tags={selectedFeedPost.tags.copyright} color="text-pink-400" onTagClick={(tag) => { setFeedSearchInput(tag); searchFeedPosts(tag); setSelectedFeedPost(null); }} />
                  <TagSection title="Characters" tags={selectedFeedPost.tags.character} color="text-green-400" onTagClick={(tag) => { setFeedSearchInput(tag); searchFeedPosts(tag); setSelectedFeedPost(null); }} />
                  <TagSection title="Species" tags={selectedFeedPost.tags.species} color="text-red-400" onTagClick={(tag) => { setFeedSearchInput(tag); searchFeedPosts(tag); setSelectedFeedPost(null); }} />
                  <TagSection title="General" tags={selectedFeedPost.tags.general} color="text-blue-300" onTagClick={(tag) => { setFeedSearchInput(tag); searchFeedPosts(tag); setSelectedFeedPost(null); }} />
                  <TagSection title="Meta" tags={selectedFeedPost.tags.meta} color="text-gray-400" onTagClick={(tag) => { setFeedSearchInput(tag); searchFeedPosts(tag); setSelectedFeedPost(null); }} />
                  <TagSection title="Lore" tags={selectedFeedPost.tags.lore} color="text-purple-300" onTagClick={(tag) => { setFeedSearchInput(tag); searchFeedPosts(tag); setSelectedFeedPost(null); }} />
                </div>
              </div>
            </>
          )}

          {/* Add/Edit Feed Modal */}
          {showAddFeedModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/60" onClick={() => { setShowAddFeedModal(false); setEditingFeedId(null); setNewFeedName(''); setNewFeedQuery(''); }} />
              <div className={`relative z-10 w-full max-w-xl rounded-xl p-6 ${isStudio ? 'bg-[#161621] border border-[#1d1b2d]' : 'bg-gray-800 border border-gray-700'}`}>
                <h2 className="text-xl font-bold mb-4">{editingFeedId ? 'Edit Feed' : 'Add New Feed'}</h2>
                <div className="space-y-4">
                  <div>
                    <label className={`text-sm mb-1 block ${isStudio ? 'text-[#9e98aa]' : 'text-gray-400'}`}>Feed Name</label>
                    <input type="text" placeholder="e.g., Cute Foxes" value={newFeedName} onChange={(e) => setNewFeedName(e.target.value)} className={`w-full px-4 py-2 rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`} />
                  </div>
                  <div>
                    <label className={`text-sm mb-1 block ${isStudio ? 'text-[#9e98aa]' : 'text-gray-400'}`}>Search Query</label>
                    <input type="text" placeholder="e.g., fox cute rating:s score:>200" value={newFeedQuery} onChange={(e) => setNewFeedQuery(e.target.value)} className={`w-full px-4 py-2 rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`} />
                    <p className={`text-xs mt-1 ${isStudio ? 'text-[#4c4b5a]' : 'text-gray-500'}`}>Use e621 search syntax.</p>
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
                      <button onClick={() => { setNewFeedName(''); setNewFeedQuery(''); setShowAddFeedModal(false); setEditingFeedId(null); }} className={`px-4 py-2 rounded-xl ${isStudio ? 'bg-[#1d1b2d] hover:bg-[#4c4b5a]' : 'bg-gray-700 hover:bg-gray-600'}`}>Cancel</button>
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
                        className={`px-4 py-2 rounded-xl ${isStudio ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-purple-600 hover:bg-purple-700'}`}
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
        <div className={`flex-1 overflow-hidden flex flex-col ${isStudio ? 'bg-[#0f0f17]' : ''}`}>
                    {selectedPool ? (
            // Comic reader view
            <div className="flex-1 relative overflow-hidden flex flex-col">
              
              {/* Floating Header */}
              <div className="absolute top-0 left-0 right-0 z-20 p-4 pointer-events-none flex justify-between items-start">
                {/* Back & Info Card */}
                <div className={`pointer-events-auto flex items-center gap-3 p-2.5 pr-5 rounded-2xl backdrop-blur-md border shadow-xl ${isStudio ? 'bg-[#161621]/80 border-[#1d1b2d]' : 'bg-gray-900/80 border-gray-700'}`}>
                  <button onClick={closePool} className={`p-2 rounded-xl transition-colors ${isStudio ? 'hover:bg-[#1d1b2d] text-white' : 'hover:bg-gray-700 text-white'}`}>
                    <ArrowLeft className="w-5 h-5" />
                  </button>
                  <div>
                    <h2 className="font-bold text-sm tracking-wide text-white drop-shadow-md">{selectedPool.name}</h2>
                    <p className={`text-xs font-medium drop-shadow-md ${isStudio ? 'text-[#9e98aa]' : 'text-gray-300'}`}>
                      Pool #{selectedPool.pool_id} • {poolPosts.filter(p => p.item_id !== 0).length} local • {poolPosts.length} total
                    </p>
                  </div>
                </div>

                {/* Controls Card */}
                <div className={`pointer-events-auto flex items-center gap-2 p-2 rounded-2xl backdrop-blur-md border shadow-xl ${isStudio ? 'bg-[#161621]/80 border-[#1d1b2d]' : 'bg-gray-900/80 border-gray-700'}`}>
                  <button onClick={() => setComicScale(s => Math.max(25, s - 25))} className={`p-2 rounded-xl text-white ${isStudio ? 'hover:bg-[#1d1b2d]' : 'hover:bg-gray-700'}`}>
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <span className="text-sm font-medium w-12 text-center text-white drop-shadow-md">{comicScale}%</span>
                  <button onClick={() => setComicScale(s => Math.min(100, s + 25))} className={`p-2 rounded-xl text-white ${isStudio ? 'hover:bg-[#1d1b2d]' : 'hover:bg-gray-700'}`}>
                    <ZoomIn className="w-4 h-4" />
                  </button>
                  <div className="w-px h-6 bg-gray-500/50 mx-1" />
                  <button onClick={() => setComicAutoscroll(!comicAutoscroll)} className={`p-2 rounded-xl flex items-center gap-1.5 transition-colors text-white ${comicAutoscroll ? (isStudio ? 'bg-[#967abc]' : 'bg-purple-600') : (isStudio ? 'hover:bg-[#1d1b2d]' : 'hover:bg-gray-700')}`}>
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
                      className={`w-20 cursor-pointer mr-2 ${isStudio ? 'accent-[#967abc]' : 'accent-purple-500'}`}
                    />
                  )}
                </div>
              </div>

              {/* Comic pages */}
              <div ref={comicContainerRef} className="flex-1 overflow-y-auto">
                {poolPostsLoading ? (
                  <div className="flex items-center justify-center py-20">
                    <Loader2 className={`w-8 h-8 animate-spin ${isStudio ? 'text-[#967abc]' : 'text-purple-500'}`} />
                  </div>
                ) : poolPosts.length === 0 ? (
                  <div className={`text-center py-20 ${isStudio ? 'text-[#4c4b5a]' : 'text-gray-500'}`}>
                    <BookOpen className="w-16 h-16 mx-auto mb-4 opacity-30" />
                    <p>No pages from this pool in your library</p>
                    <p className="text-sm mt-2">Favorite more posts from this pool on e621</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center py-4" style={{ gap: '2px' }}>
                    {poolPosts.map((post) => {
                      const isVideo = ['mp4', 'webm'].includes(post.ext.toLowerCase());
                      return (
                        <div key={`${post.source_id}-${post.position}`} style={{ width: `${comicScale}%`, maxWidth: '100%' }} className="relative">
                          {post.item_id === 0 && (
                            <div className="absolute top-2 right-2 z-10 bg-black/70 text-xs px-2 py-1 rounded-full text-gray-300 pointer-events-none">
                              Remote
                            </div>
                          )}
                          {isVideo ? (
                            <video
                              src={post.item_id === 0 ? post.file_abs : convertFileSrc(post.file_abs)}
                              controls
                              className="w-full h-auto"
                              style={{ backgroundColor: isStudio ? '#0a0a12' : '#000' }}
                            />
                          ) : (
                            <img
                              src={post.item_id === 0 ? post.file_abs : convertFileSrc(post.file_abs)}
                              alt={`Page ${post.position + 1}`}
                              className="w-full h-auto"
                              loading="lazy"
                              style={{ backgroundColor: isStudio ? '#0a0a12' : '#000' }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            // Pool grid view
            <div className="flex-1 overflow-y-auto p-4">
              <div className="flex items-center justify-between gap-4 mb-4">
                <h2 className="text-xl font-bold flex-shrink-0">Comics & Pools</h2>
                <button
                  onClick={loadPools}
                  disabled={poolsLoading}
                  className={`p-2 flex-shrink-0 rounded-xl transition-colors ${isStudio ? 'bg-[#1d1b2d] hover:bg-[#4c4b5a] text-[#9e98aa]' : 'bg-gray-700 hover:bg-gray-600 text-gray-400'}`}
                  title="Scan Favorites for Pools"
                >
                  {poolsLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 11-9-9c2.52 0 4.93 1 6.74 2.74L21 8V3"/><path d="M21 3v5h-5"/></svg>}
                </button>
              </div>

              {poolsLoading ? (
                <div className="flex flex-col items-center justify-center py-20">
                  <Loader2 className={`w-10 h-10 animate-spin mb-4 ${isStudio ? 'text-[#967abc]' : 'text-purple-500'}`} />
                  <p className={`${isStudio ? 'text-[#9e98aa]' : 'text-gray-400'}`}>
                    {poolScanProgress 
                      ? `Scanning posts... ${poolScanProgress.current} / ${poolScanProgress.total}`
                      : 'Scanning your favorites for pools...'}
                  </p>
                  {poolScanProgress && (
                    <div className={`w-64 h-2 mt-4 rounded-full overflow-hidden ${isStudio ? 'bg-[#1d1b2d]' : 'bg-gray-700'}`}>
                      <div 
                        className={`h-full transition-all duration-300 ${isStudio ? 'bg-[#967abc]' : 'bg-purple-500'}`}
                        style={{ width: `${poolScanProgress.total > 0 ? (poolScanProgress.current / poolScanProgress.total) * 100 : 0}%` }}
                      />
                    </div>
                  )}
                  {pools.length > 0 && (
                    <p className={`text-sm mt-4 ${isStudio ? 'text-[#4c4b5a]' : 'text-gray-500'}`}>
                      Found {pools.length} pools so far
                    </p>
                  )}
                </div>
              ) : pools.length === 0 ? (
                <div className={`text-center py-20 ${isStudio ? 'text-[#4c4b5a]' : 'text-gray-500'}`}>
                  <BookOpen className="w-16 h-16 mx-auto mb-4 opacity-30" />
                  <p className="text-xl mb-2">Comics & Pools</p>
                  <p className="text-sm mb-6">Scan your e621 favorites to find pools (comics, series, etc.)</p>
                  <button
                    onClick={loadPools}
                    className={`px-6 py-3 rounded-xl font-medium ${isStudio ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-purple-600 hover:bg-purple-700'}`}
                  >
                    Scan for Pools
                  </button>
                </div>
              ) : (
                <Masonry
                  breakpointCols={{ default: gridColumns, 700: 2, 500: 1 }}
                  className="flex w-auto gap-3"
                  columnClassName="flex flex-col gap-3"
                >
                  {filteredPools.map((pool) => (
                    <div
                      key={pool.pool_id}
                      onClick={() => openPool(pool)}
                      className={`group cursor-pointer rounded-lg overflow-hidden border transition-all ${isStudio ? 'bg-[#161621] border-[#1d1b2d] hover:border-[#967abc]' : 'bg-gray-800 border-gray-700 hover:border-purple-500'}`}
                    >
                      {pool.cover_url ? (
                        ['mp4', 'webm'].includes(pool.cover_ext.toLowerCase()) ? (
                          <video
                            src={pool.cover_url.startsWith('/') || pool.cover_url.startsWith('C:') ? convertFileSrc(pool.cover_url) : pool.cover_url}
                            className="w-full h-auto object-cover"
                            muted
                          />
                        ) : (
                          <img
                            src={pool.cover_url.startsWith('/') || pool.cover_url.startsWith('C:') ? convertFileSrc(pool.cover_url) : pool.cover_url}
                            alt={pool.name}
                            className="w-full h-auto object-cover"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        )
                      ) : (
                        <div className={`w-full aspect-[3/4] flex items-center justify-center ${isStudio ? 'bg-[#1d1b2d]' : 'bg-gray-700'}`}>
                          <BookOpen className="w-12 h-12 opacity-30" />
                        </div>
                      )}
                      <div className={`p-3 ${isStudio ? 'bg-[#161621]' : 'bg-gray-800'}`}>
                        <h3 className="font-medium text-sm truncate">{pool.name}</h3>
                        <p className={`text-xs mt-1 ${isStudio ? 'text-[#4c4b5a]' : 'text-gray-500'}`}>{pool.post_count} pages</p>
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
          <div className={`relative z-10 w-full max-w-xl max-h-[90vh] rounded-xl flex flex-col ${isStudio ? 'bg-[#161621] border border-[#1d1b2d]' : 'bg-gray-800 border border-gray-700'}`}>
            <div className={`flex items-center justify-between p-5 border-b flex-shrink-0 ${isStudio ? 'border-[#1d1b2d]' : 'border-gray-700'}`}>
              <h2 className="text-lg font-semibold">Settings</h2>
              <button onClick={() => setShowSettings(false)} className={`${isStudio ? 'text-[#9e98aa] hover:text-white' : 'text-gray-400 hover:text-gray-200'}`}><X className="w-5 h-5" /></button>
            </div>
            <div className="overflow-y-auto p-5 space-y-4">
              {/* Library */}
              <div>
                <h3 className="text-lg font-semibold mb-2">Library</h3>
                <div className="text-sm text-gray-400 mb-1">Library folder</div>
                <div className={`text-xs text-gray-200 break-all rounded-xl p-2 ${isStudio ? 'bg-[#0f0f17] border border-[#1d1b2d]' : 'bg-gray-900 border border-gray-700'}`}>{libraryRoot || "(not set)"}</div>
                <div className="flex gap-2 mt-3">
                  <button onClick={changeLibraryRoot} className={`px-4 py-2 rounded-xl ${isStudio ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-purple-600 hover:bg-purple-700'}`}>Change/Create Library</button>
                  <button onClick={() => { setShowSettings(false); loadTrash(); }} className={`px-4 py-2 rounded-xl flex items-center gap-2 ${isStudio ? 'bg-[#1d1b2d] hover:bg-[#4c4b5a]' : 'bg-gray-700 hover:bg-gray-600'}`}>
                    <Trash2 className="w-4 h-4" />Trash ({trashCount})
                  </button>
                  <button
                    onClick={async () => {
                      const ok = await confirmDialog("Unload the current library?", { title: "Unload Library", okLabel: "Yes, unload", cancelLabel: "Cancel" });
                      if (!ok) return;
                      try {
                        await invoke("clear_library_root");
                        setLibraryRoot(""); setItems([]); setTotalDatabaseItems(0); setHasMoreItems(true);
                        setShowSettings(false);
                      } catch (e) {
                        console.error("Failed to unload:", e);
                        toast("Failed to unload: " + String(e), "error");
                      }
                    }}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-xl"
                  >
                    Unload Library
                  </button>
                </div>
              </div>

              {/* Viewer Settings */}
              <div className={`border-t pt-4 ${isStudio ? 'border-[#1d1b2d]' : 'border-gray-700'}`}>
                <h3 className="text-lg font-semibold mb-2">Viewer</h3>
                  <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm text-gray-400 mb-1 block">Layout</label>
                    <select value={viewerLayout} onChange={(e) => setViewerLayout(e.target.value as 'classic' | 'studio')} className={`w-full px-4 py-2 rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`}>
                      <option value="classic">Classic</option>
                      <option value="studio">Studio (Three-pane)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm text-gray-400 mb-1 block">Default sort order</label>
                    <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className={`w-full px-4 py-2 rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`}>
                      <option value="default">Default</option><option value="random">Random</option><option value="score">Score</option><option value="newest">Newest</option><option value="oldest">Oldest</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm text-gray-400 mb-1 block">Items per batch</label>
                    <select value={itemsPerPage} onChange={(e) => handlePageSizeChange(Number(e.target.value))} className={`w-full px-4 py-2 rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`}>
                      <option value={50}>50</option><option value={100}>100 (Recommended)</option><option value={200}>200</option><option value={500}>500</option><option value={1000}>1000</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm text-gray-400 mb-1 block flex justify-between"><span>Grid Columns</span><span className="font-mono text-purple-400">{gridColumns}</span></label>
                    <div className="flex items-center h-[42px]">
                      <input type="range" min="1" max="8" value={gridColumns} onChange={(e) => { const val = Number(e.target.value); setGridColumns(val); localStorage.setItem('grid_columns', String(val)); }} className={`w-full cursor-pointer ${isStudio ? 'accent-[#967abc]' : 'accent-purple-600'}`} />
                    </div>
                  </div>
                  <div className="row-span-2">
                    <label className="text-sm text-gray-400 mb-1 block">Blacklist (Feeds Only)</label>
                    <textarea value={blacklist} onChange={(e) => setBlacklist(e.target.value)} placeholder="Tags to hide..." className={`w-full px-3 py-2 rounded-xl h-[42px] min-h-[42px] focus:outline-none text-sm resize-y ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`} />
                  </div>
                </div>
              </div>

              {/* e621 Settings */}
              <div className={`border-t pt-4 ${isStudio ? 'border-[#1d1b2d]' : 'border-gray-700'}`}>
                <div className="flex items-center mb-2">
                  <h3 className="text-lg font-semibold">e621</h3>
                  <HelpTooltip text={<div>1. Go to e621.net<br />2. Click <b>Settings</b> (top right)<br />3. Go to <b>Basic &gt; Account &gt; API Keys</b><br />4. Generate/Copy your API Key</div>} />
                </div>
                <div className="text-xs text-gray-400 mb-2">Used for Feeds, Favoriting, and Syncing your Favorites.</div>

                {e621CredInfo.has_api_key && !isEditingE621 ? (
                  <div className={`flex items-center justify-between p-3 rounded-xl mb-3 ${isStudio ? 'bg-[#0f0f17] border border-green-900/50' : 'bg-gray-900 border border-green-900/50'}`}>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      <span className="text-sm text-gray-300">Credentials Saved ({e621CredInfo.username})</span>
                    </div>
                    <button
                      onClick={async () => {
                        const ok = await confirmDialog("Clear e621 credentials?", { title: "Clear", okLabel: "Clear", cancelLabel: "Cancel" });
                        if (ok) {
                          await invoke("e621_clear_credentials");
                          setApiUsername(""); setApiKey("");
                          await refreshE621CredInfo();
                        }
                      }}
                      className="p-1.5 bg-red-900/50 hover:bg-red-600 rounded text-red-200 hover:text-white" title="Clear Credentials"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="mb-3 animate-in fade-in slide-in-from-top-2 duration-200">
                    <div className="flex gap-2 mb-2">
                      <input type="text" placeholder="Username" value={apiUsername} onChange={(e) => setApiUsername(e.target.value)} className={`flex-1 px-4 py-2 rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`} />
                      <input type="password" placeholder="API Key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className={`flex-1 px-4 py-2 rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`} />
                    </div>
                    <div className="flex gap-2">
                      <button onClick={async () => { await saveE621Credentials(); setIsEditingE621(false); }} className={`px-4 py-2 rounded-xl ${isStudio ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-purple-600 hover:bg-purple-700'}`}>Save Credentials</button>
                      {e621CredInfo.has_api_key && <button onClick={() => setIsEditingE621(false)} className={`px-4 py-2 rounded-xl ${isStudio ? 'bg-[#1d1b2d] hover:bg-[#4c4b5a]' : 'bg-gray-700 hover:bg-gray-600'}`}>Cancel</button>}
                    </div>
                  </div>
                )}

                <div className="flex gap-2 items-center">
                  <input type="text" placeholder="Limit (optional)" value={syncMaxNew} onChange={(e) => setSyncMaxNew(e.target.value)} className={`flex-1 px-4 py-2 rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`} />
                  <button onClick={startSync} disabled={!!syncStatus?.running || (!e621CredInfo.has_api_key && !isEditingE621)} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded disabled:opacity-50">
                    {syncStatus?.running ? "Scanning..." : "Start Import"}
                  </button>
                  {syncStatus?.running && <button onClick={cancelSync} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-xl">Stop</button>}
                </div>

                {syncStatus && (syncStatus.running || syncStatus.scanned_pages > 0) && (
                  <div className="mt-3 text-sm text-gray-300 space-y-1">
                    <div>Scanned: {syncStatus.scanned_pages} pages, {syncStatus.scanned_posts} posts</div>
                    <div>Skipped: {syncStatus.skipped_existing}</div>
                    <div>Downloaded: {syncStatus.downloaded_ok}</div>
                    <div>Failed: {syncStatus.failed_downloads}</div>
                    <div>Unavailable: {syncStatus.unavailable}</div>
                    {syncStatus.last_error && <div className="text-red-300 break-words">Error: {syncStatus.last_error}</div>}
                    <button onClick={loadUnavailable} className="mt-2 px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm">View unavailable</button>
                  </div>
                )}
              </div>

              {/* Unavailable Modal */}
              {showUnavailable && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                  <div className="absolute inset-0 bg-black/60" onClick={() => setShowUnavailable(false)} />
                  <div className={`relative z-10 w-full max-w-3xl rounded-xl p-5 ${isStudio ? 'bg-[#161621] border border-[#1d1b2d]' : 'bg-gray-800 border border-gray-700'}`}>
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-lg font-semibold">Unavailable favorites</h2>
                      <button onClick={() => setShowUnavailable(false)} className={`${isStudio ? 'text-[#9e98aa] hover:text-white' : 'text-gray-400 hover:text-gray-200'}`}><X className="w-5 h-5" /></button>
                    </div>
                    <div className="max-h-[60vh] overflow-y-auto space-y-3">
                      {unavailableList.length === 0 ? (
                        <div className={isStudio ? 'text-[#4c4b5a]' : 'text-gray-400'}>No unavailable posts recorded.</div>
                      ) : (
                        unavailableList.map((u) => (
                          <div key={`${u.source}:${u.source_id}`} className={`rounded-xl p-3 ${isStudio ? 'bg-[#0f0f17] border border-[#1d1b2d]' : 'bg-gray-900 border border-gray-700'}`}>
                            <div className="text-sm text-gray-200">
                              <span className={isStudio ? 'text-[#9e98aa]' : 'text-gray-400'}>{u.source}</span> #{u.source_id} <span className={isStudio ? 'text-[#4c4b5a]' : 'text-gray-500'}>• {u.reason}</span> <span className={isStudio ? 'text-[#4c4b5a]' : 'text-gray-500'}>• {u.seen_at}</span>
                            </div>
                            <div className="mt-2 text-xs space-y-1">
                              {u.sources.length > 0 ? u.sources.map((s, i) => (
                                <div key={i}><button onClick={() => openExternalUrl(s)} className={`underline break-all cursor-pointer bg-transparent border-none p-0 text-left ${isStudio ? 'text-[#967abc]' : 'text-purple-400'}`}>{s}</button></div>
                              )) : <div className={isStudio ? 'text-[#4c4b5a]' : 'text-gray-500'}>No source links.</div>}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* FurAffinity Settings */}
              <div className={`border-t pt-4 mt-4 ${isStudio ? 'border-[#1d1b2d]' : 'border-gray-700'}`}>
                <div className="flex items-center mb-2">
                  <h3 className="text-lg font-semibold">FurAffinity</h3>
                  <HelpTooltip text={<div>1. Login to FurAffinity in browser<br />2. Press <b>F12</b> (Dev Tools) &gt; <b>Application</b> tab<br />3. Under <b>Cookies</b>, find <b>furaffinity.net</b><br />4. Copy values for <b>a</b> and <b>b</b></div>} />
                </div>

                {faCredsSet && !isEditingFA ? (
                  <div className={`flex items-center justify-between p-3 rounded-xl mb-3 ${isStudio ? 'bg-[#0f0f17] border border-green-900/50' : 'bg-gray-900 border border-green-900/50'}`}>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      <span className="text-sm text-gray-300">Cookies Saved</span>
                    </div>
                    <button
                      onClick={async () => {
                        const ok = await confirmDialog("Clear FurAffinity cookies?", { title: "Clear", okLabel: "Clear", cancelLabel: "Cancel" });
                        if (ok) { setFaCredsSet(false); setFaCreds({ a: '', b: '' }); setIsEditingFA(true); }
                      }}
                      className="p-1.5 bg-red-900/50 hover:bg-red-600 rounded text-red-200 hover:text-white" title="Clear Cookies"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="mb-3 animate-in fade-in slide-in-from-top-2 duration-200">
                    <div className="flex gap-2 mb-2">
                      <input type="text" placeholder="Cookie A" value={faCreds.a} onChange={e => setFaCreds(prev => ({ ...prev, a: e.target.value }))} className={`flex-1 px-4 py-2 rounded-xl ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d]' : 'bg-gray-700 border border-gray-600'}`} />
                      <input type="text" placeholder="Cookie B" value={faCreds.b} onChange={e => setFaCreds(prev => ({ ...prev, b: e.target.value }))} className={`flex-1 px-4 py-2 rounded-xl ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d]' : 'bg-gray-700 border border-gray-600'}`} />
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={async () => {
                          if (!faCreds.a || !faCreds.b) { toast("Enter both cookies.", "error"); return; }
                          await invoke("fa_set_credentials", { a: faCreds.a, b: faCreds.b });
                          setFaCredsSet(true);
                          await refreshFaCreds();
                          setIsEditingFA(false);
                          setFaCreds({ a: '', b: '' });
                        }}
                        className={`px-4 py-2 rounded-xl ${isStudio ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-purple-600 hover:bg-purple-700'}`}
                      >
                        Save Cookies
                      </button>
                      {faCredsSet && <button onClick={() => setIsEditingFA(false)} className={`px-4 py-2 rounded-xl ${isStudio ? 'bg-[#1d1b2d] hover:bg-[#4c4b5a]' : 'bg-gray-700 hover:bg-gray-600'}`}>Cancel</button>}
                    </div>
                  </div>
                )}

                <div className="flex gap-2 items-center">
                  <input type="text" placeholder="Limit (optional)" value={faLimit} onChange={(e) => setFaLimit(e.target.value)} className={`flex-1 px-4 py-2 rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`} />
                  <button onClick={startFaSync} disabled={faStatus?.running || (!faCredsSet && !isEditingFA)} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded disabled:opacity-50">
                    {faStatus?.running ? "Scanning..." : "Start Import"}
                  </button>
                  {faStatus?.running && <button onClick={cancelFaSync} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-xl">Stop</button>}
                </div>

                {faStatus && (faStatus.running || faStatus.scanned > 0) && (
                  <div className="mt-3 text-sm text-gray-300 space-y-1">
                    <div>Status: {faStatus.current_message}</div>
                    <div>Scanned: {faStatus.scanned}</div>
                    <div>Skipped (URL): {faStatus.skipped_url}</div>
                    <div>Skipped (MD5): {faStatus.skipped_md5}</div>
                    <div className="text-purple-400">Upgraded to e621: {faStatus.upgraded}</div>
                    <div className="text-green-400">FA Exclusives: {faStatus.imported}</div>
                    <div>Errors: {faStatus.errors}</div>
                  </div>
                )}
              </div>
              {/* App Lock */}
              <div className={`border-t pt-4 mt-4 ${isStudio ? 'border-[#1d1b2d]' : 'border-gray-700'}`}>
                <h3 className="text-lg font-semibold mb-2">App Lock</h3>
                <p className={`text-xs mb-3 ${isStudio ? 'text-[#4c4b5a]' : 'text-gray-500'}`}>
                  Require a PIN to open the app. Auto-locks when window loses focus.
                </p>

                {hasLock ? (
                  <div>
                    <div className={`flex items-center gap-2 p-3 rounded-xl mb-3 ${isStudio ? 'bg-[#0f0f17] border border-green-900/50' : 'bg-gray-900 border border-green-900/50'}`}>
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      <span className={`text-sm ${isStudio ? 'text-[#9e98aa]' : 'text-gray-300'}`}>Lock is enabled</span>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        placeholder="Current PIN"
                        value={lockRemovePin}
                        onChange={(e) => setLockRemovePin(e.target.value)}
                        className={`flex-1 px-4 py-2 rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`}
                      />
                      <button onClick={handleRemoveLock} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-xl">
                        Remove Lock
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      type="password"
                      placeholder="New PIN (min 4)"
                      value={lockNewPin}
                      onChange={(e) => setLockNewPin(e.target.value)}
                      className={`flex-1 px-4 py-2 rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`}
                    />
                    <input
                      type="password"
                      placeholder="Confirm PIN"
                      value={lockConfirmPin}
                      onChange={(e) => setLockConfirmPin(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSetLock(); }}
                      className={`flex-1 px-4 py-2 rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`}
                    />
                    <button onClick={handleSetLock} className={`px-4 py-2 rounded-xl ${isStudio ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-purple-600 hover:bg-purple-700'}`}>
                      Set Lock
                    </button>
                  </div>
                )}

                {hasLock && (
                  <div className={`mt-4 pt-4 border-t ${isStudio ? 'border-[#1d1b2d]' : 'border-gray-700'}`}>
                    <h4 className="text-sm font-semibold mb-1">Safe Mode PIN</h4>
                    <p className={`text-xs mb-3 ${isStudio ? 'text-[#4c4b5a]' : 'text-gray-500'}`}>
                      A separate PIN that opens the app showing only safe-rated content. No visible indicator.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        placeholder="Safe PIN (min 4)"
                        value={safePinInput}
                        onChange={(e) => setSafePinInput(e.target.value)}
                        className={`flex-1 px-4 py-2 rounded-xl focus:outline-none ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`}
                      />
                      <button
                        onClick={async () => {
                          if (safePinInput.length < 4) { toast("PIN must be at least 4 characters.", "error"); return; }
                          try {
                            await invoke("set_safe_pin", { pin: safePinInput });
                            setSafePinInput('');
                            toast("Safe mode PIN set.", "success");
                          } catch (e) { toast(String(e), "error"); }
                        }}
                        className={`px-4 py-2 rounded-xl ${isStudio ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-purple-600 hover:bg-purple-700'}`}
                      >
                        Set
                      </button>
                      <button
                        onClick={async () => {
                          if (!safePinInput) { toast("Enter current safe PIN to remove.", "error"); return; }
                          try {
                            await invoke("clear_safe_pin", { pin: safePinInput });
                            setSafePinInput('');
                            toast("Safe mode PIN removed.", "success");
                          } catch (e) { toast(String(e), "error"); }
                        }}
                        className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Metadata Modal */}
      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowEditModal(false)} />
          <div className={`relative z-10 w-full max-w-2xl max-h-[90vh] rounded-xl flex flex-col shadow-2xl ${isStudio ? 'bg-[#161621] border border-[#1d1b2d]' : 'bg-gray-800 border border-gray-700'}`}>
            <div className={`flex items-center justify-between p-5 border-b ${isStudio ? 'border-[#1d1b2d]' : 'border-gray-700'}`}>
              <h2 className="text-xl font-bold">Edit Post Metadata</h2>
              <button onClick={() => setShowEditModal(false)} className={`${isStudio ? 'text-[#9e98aa] hover:text-white' : 'text-gray-400 hover:text-white'}`}><X className="w-5 h-5" /></button>
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
                    className={`flex-1 px-3 py-2 rounded-xl focus:outline-none text-sm ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`}
                  />
                  <button onClick={() => { if (newSourceInput.trim() && !editingSources.includes(newSourceInput.trim())) { setEditingSources([...editingSources, newSourceInput.trim()]); setNewSourceInput(""); } }} className={`px-3 py-2 rounded-xl text-sm ${isStudio ? 'bg-[#1d1b2d] hover:bg-[#4c4b5a]' : 'bg-gray-600 hover:bg-gray-500'}`}>Add</button>
                </div>
                <div className="space-y-1">
                  {editingSources.map((src, i) => (
                    <div key={i} className={`flex items-center justify-between px-3 py-2 rounded-xl ${isStudio ? 'bg-[#0f0f17] border border-[#1d1b2d]' : 'bg-gray-900/50 border border-gray-700'}`}>
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
                    className={`flex-1 px-3 py-2 rounded-xl focus:outline-none text-sm ${isStudio ? 'bg-[#1c1b26] border border-[#1d1b2d] focus:border-[#967abc]' : 'bg-gray-700 border border-gray-600 focus:border-purple-500'}`}
                  />
                  <button onClick={() => { const t = newTagInput.trim().toLowerCase(); if (t && !editingTags.includes(t)) { setEditingTags([...editingTags, t]); setNewTagInput(""); } }} className={`px-3 py-2 rounded-xl text-sm ${isStudio ? 'bg-[#1d1b2d] hover:bg-[#4c4b5a]' : 'bg-gray-600 hover:bg-gray-500'}`}>Add</button>
                </div>
                <div className={`flex flex-wrap gap-2 p-3 rounded-xl min-h-[100px] content-start ${isStudio ? 'bg-[#0f0f17] border border-[#1d1b2d]' : 'bg-gray-900/50 border border-gray-700'}`}>
                  {editingTags.map(tag => (
                    <span key={tag} className={`px-2.5 py-1 rounded-full text-sm flex items-center gap-1 ${isStudio ? 'bg-[#967abc]/20 border border-[#967abc]/30' : 'bg-purple-900/30 border border-purple-500/30'}`}>
                      {tag}
                      <button onClick={() => setEditingTags(prev => prev.filter(t => t !== tag))} className="hover:text-red-400 ml-1"><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className={`flex justify-end gap-2 p-5 border-t ${isStudio ? 'border-[#1d1b2d]' : 'border-gray-700'}`}>
              <button onClick={() => setShowEditModal(false)} className={`px-4 py-2 rounded-xl ${isStudio ? 'bg-[#1d1b2d] hover:bg-[#4c4b5a]' : 'bg-gray-700 hover:bg-gray-600'}`}>Cancel</button>
              <button onClick={saveMetadata} className={`px-6 py-2 rounded-xl font-bold ${isStudio ? 'bg-[#967abc] hover:bg-[#967abc]/80' : 'bg-purple-600 hover:bg-purple-700'}`}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {/* Trash Modal */}
      {showTrashModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowTrashModal(false)} />
          <div className={`relative z-10 w-full max-w-4xl max-h-[90vh] rounded-xl flex flex-col ${isStudio ? 'bg-[#161621] border border-[#1d1b2d]' : 'bg-gray-800 border border-gray-700'}`}>
            <div className={`flex items-center justify-between p-5 border-b flex-shrink-0 ${isStudio ? 'border-[#1d1b2d]' : 'border-gray-700'}`}>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Trash2 className={`w-5 h-5 ${isStudio ? 'text-[#9e98aa]' : 'text-gray-400'}`} />
                Trash
              </h2>
              <div className="flex gap-2">
                <button onClick={handleEmptyTrash} disabled={trashedItems.length === 0} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-xl disabled:opacity-50 text-sm font-medium">Empty Trash</button>
                <button onClick={() => setShowTrashModal(false)} className={`${isStudio ? 'text-[#9e98aa] hover:text-white' : 'text-gray-400 hover:text-gray-200'}`}><X className="w-5 h-5" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {trashedItems.length > 0 ? (
                <Masonry breakpointCols={4} className="flex w-auto gap-3" columnClassName="flex flex-col gap-3">
                  {trashedItems.map((item) => {
                    const isVid = ["mp4", "webm"].includes((item.ext || "").toLowerCase());
                    return (
                      <div key={item.item_id} className={`relative group rounded-lg overflow-hidden border ${isStudio ? 'bg-[#1c1b26] border-[#1d1b2d]' : 'bg-gray-700 border-gray-600'}`}>
                        {isVid ? (
                          <video src={item.url} className="w-full h-auto object-cover opacity-60" />
                        ) : (
                          <img src={item.url} className="w-full h-auto object-cover opacity-60" loading="lazy" alt="" />
                        )}
                        <div className="absolute inset-0 flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 bg-black/50 transition-opacity">
                          <button onClick={() => handleRestore(item.item_id)} className="p-2 bg-green-600 hover:bg-green-700 rounded-full text-white" title="Restore"><Undo className="w-5 h-5" /></button>
                        </div>
                        <div className={`absolute bottom-0 left-0 right-0 p-1.5 text-xs text-center ${isStudio ? 'bg-[#0f0f17]/80 text-[#9e98aa]' : 'bg-black/60 text-gray-300'}`}>
                          {item.source} #{item.source_id}
                        </div>
                      </div>
                    );
                  })}
                </Masonry>
              ) : (
                <div className={`text-center py-20 ${isStudio ? 'text-[#4c4b5a]' : 'text-gray-500'}`}>
                  <Trash2 className="w-16 h-16 mx-auto mb-4 opacity-20" />
                  <p>Trash is empty</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className={`flex items-center justify-between px-4 py-2 text-xs border-t flex-shrink-0 ${isStudio ? 'bg-[#161621] border-[#1d1b2d] text-[#4c4b5a]' : 'bg-gray-800 border-gray-700 text-gray-500 mt-auto'}`}>
        <span>TailBurrow v{APP_VERSION}</span>
        <span>{itemCount} loaded • {totalDatabaseItems} total</span>
        <button onClick={loadTrash} className={`flex items-center gap-1.5 transition-colors ${isStudio ? 'hover:text-[#967abc]' : 'hover:text-white'}`}>
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
        isStudio={isStudio}
      />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}