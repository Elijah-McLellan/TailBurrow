import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Search, Upload, Play, Pause, ChevronLeft, ChevronRight,
  X, Tag, Trash2, Rss, Plus, Star, Maximize, Settings,
  Database, Loader2, Volume2, VolumeX, Clock, Pencil,
  RefreshCw, Info, Undo, ArrowDownCircle
} from "lucide-react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog, confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import Masonry from "react-masonry-css";

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
          className={`flex items-start gap-3 px-4 py-3 rounded-lg shadow-xl border backdrop-blur-sm animate-in slide-in-from-right fade-in duration-200 cursor-pointer ${
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

function parsePositiveInt(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return undefined as any; // signals invalid
  return n;
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

const TagSection = ({ title, tags, color, onTagClick }: { title: string; tags: string[]; color: string; onTagClick: (t: string) => void }) => {
  if (!tags || tags.length === 0) return null;
  return (
    <div className="mb-2">
      <div className={`text-[10px] uppercase font-bold tracking-wider mb-1 ${color}`}>{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {tags.sort().map(tag => (
          <button key={tag} onClick={() => onTagClick(tag)} className={`px-2 py-0.5 rounded text-xs hover:bg-gray-700 transition-colors ${color.replace('text-', 'text-opacity-80 text-')} border border-gray-700`}>
            {tag}
          </button>
        ))}
      </div>
    </div>
  );
};

const Thumbnail = ({ item, className }: { item: LibraryItem; className?: string }) => {
  const [src, setSrc] = useState<string>("");
  const fileRel = item.file_rel;
  const fallbackUrl = item.url;
  const ext = (item.ext || "").toLowerCase();

  useEffect(() => {
    let active = true;

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

  if (!src) return <div className={`bg-gray-800 animate-pulse ${className}`} />;
  return <img src={src} className={className} loading="lazy" alt="" />;
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

const GridItem = React.memo(({ item, index, onSelect }: {
  item: LibraryItem;
  index: number;
  onSelect: (index: number) => void;
}) => {
  const isVid = ["mp4", "webm"].includes((item.ext || "").toLowerCase());

  return (
    <div
      onClick={() => onSelect(index)}
      className="relative group cursor-pointer bg-gray-800 rounded-lg overflow-hidden border border-gray-700 hover:border-purple-500 transition-all"
    >
      {isVid ? (
        <div className="relative">
          <video
            src={item.url}
            className="w-full h-auto object-cover"
            muted
            loop
            onMouseOver={e => { e.currentTarget.play().catch(() => {}); }}
            onMouseOut={e => { e.currentTarget.pause(); }}
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

const FeedPostItem = React.memo(({ post, feedId, downloaded, busy, onFavorite, onOpenUrl }: {
  post: E621Post;
  feedId: number;
  downloaded: boolean;
  busy: boolean;
  onFavorite: (feedId: number, post: E621Post) => void;
  onOpenUrl: (url: string) => void;
}) => {
  const isRemoteFav = post.is_favorited;
  const imageUrl = post.sample.url || post.file.url || post.preview.url;
  const sourceUrl = `https://e621.net/posts/${post.id}`;
  const artists = post.tags.artist;
  const w = post.sample.width || post.file.width || 1;
  const h = post.sample.height || post.file.height || 1;

  return (
    <div className="relative group bg-gray-700 rounded overflow-hidden">
      {downloaded && (
        <div className="absolute top-2 left-2 z-20 bg-gray-900/70 text-gray-200 px-2 py-1 rounded flex items-center gap-1">
          <Database className="w-4 h-4" />
        </div>
      )}
      {imageUrl ? (
        <>
          <img
            src={imageUrl}
            alt=""
            className="w-full object-cover rounded"
            style={{ aspectRatio: `${w} / ${h}` }}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
          <button
            onClick={() => onFavorite(feedId, post)}
            disabled={busy}
            className={`absolute top-2 right-2 p-2 rounded-full transition z-20 ${isRemoteFav ? "bg-yellow-500 text-yellow-900" : "bg-gray-900/70 text-gray-300 hover:bg-gray-900/90"} ${busy ? "opacity-60 cursor-not-allowed" : ""}`}
          >
            {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Star className={`w-5 h-5 ${isRemoteFav ? "fill-current" : ""}`} />}
          </button>
          <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col items-center justify-center gap-2 z-10 bg-black/50">
            <p className="text-xs text-white">Score: {post.score.total} | ❤️ {post.fav_count}</p>
            {artists.length > 0 && <p className="text-xs text-gray-300">{artists.slice(0, 2).join(", ")}</p>}
            <button onClick={() => onOpenUrl(sourceUrl)} className="px-3 py-1 bg-purple-600 hover:bg-purple-700 rounded text-xs text-white">
              View Source
            </button>
          </div>
        </>
      ) : (
        <div className="w-full h-48 flex items-center justify-center bg-gray-800">
          <p className="text-gray-500 text-sm">No image</p>
        </div>
      )}
    </div>
  );
});

const AutoscrollWidget = ({ active, autoscroll, setAutoscroll, autoscrollSpeed, setAutoscrollSpeed, hidden }: {
  active: boolean; autoscroll: boolean; setAutoscroll: (v: boolean) => void;
  autoscrollSpeed: number; setAutoscrollSpeed: (v: number) => void; hidden: boolean;
}) => {
  if (!active || hidden) return null;

  if (!autoscroll) {
    return (
      <button onClick={() => setAutoscroll(true)} className="fixed bottom-6 right-6 p-3 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-full shadow-lg border border-gray-600 transition-all z-40" title="Start Autoscroll">
        <ArrowDownCircle className="w-6 h-6" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 bg-gray-900/90 backdrop-blur border border-gray-600 rounded-xl shadow-xl p-3 flex flex-col items-center gap-2 z-40 animate-in fade-in slide-in-from-bottom-4">
      <div className="h-32 w-8 relative flex justify-center">
        <input type="range" min="1" max="10" step="0.5" {...{ orient: "vertical" } as any} value={autoscrollSpeed} onChange={(e) => setAutoscrollSpeed(Number(e.target.value))} className="absolute w-32 h-8 -rotate-90 origin-center top-12 accent-green-500 cursor-pointer" />
      </div>
      <button onClick={() => setAutoscroll(false)} className="p-2 bg-red-600 hover:bg-red-700 rounded-full text-white shadow-md" title="Stop">
        <Pause className="w-5 h-5" />
      </button>
      <span className="text-[10px] font-mono text-gray-400">{autoscrollSpeed}x</span>
    </div>
  );
};

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

  // Settings & System
  const [showSettings, setShowSettings] = useState(false);
  const [libraryRoot, setLibraryRoot] = useState("");
  const [syncMaxNew, setSyncMaxNew] = useState<string>("");
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [unavailableList, setUnavailableList] = useState<UnavailableDto[]>([]);

  // Paging
  const [initialLoading, setInitialLoading] = useState(true);
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

  // FurAffinity
  const [faCreds, setFaCreds] = useState<FACreds>({ a: '', b: '' });
  const [faStatus, setFaStatus] = useState<FASyncStatus | null>(null);
  const [filterSource, setFilterSource] = useState('all');
  const [isEditingFA, setIsEditingFA] = useState(false);
  const [faCredsSet, setFaCredsSet] = useState(false);
  const [faLimit, setFaLimit] = useState("");

  // --- DERIVED STATE (stable) ---
  const currentItem = items[currentIndex] || null;
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

  const downloadedE621Ids = useMemo(
    () => new Set(items.filter(it => it.source === "e621").map(it => Number(it.source_id))),
    [items]
  );

  const allTags = useMemo(() => {
    const tagCounts = new Map<string, number>();
    items.forEach(item => {
      item.tags?.forEach(tag => {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      });
    });
    return Array.from(tagCounts.entries())
      .sort(([, a], [, b]) => b - a)
      .map(([tag]) => tag);
  }, [items]);

  // --- CORE DATA ---
  const loadData = useCallback(async (append: boolean, overrides?: { pageSize?: number }) => {
    const requestId = ++loadRequestIdRef.current;
    const limit = overrides?.pageSize ?? itemsPerPage;

    try {
      const offset = append ? itemsRef.current.length : 0;
      const combinedSearch = [searchTags, ...selectedTags].join(" ").trim();
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
    }
  }, [itemsPerPage, searchTags, selectedTags, filterSource, sortOrder]);

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
        setCurrentIndex(prev => (prev + 1) % itemCount);
        requestAnimationFrame(() => setFadeIn(true));
      }, FADE_DURATION_MS);
    } else {
      setCurrentIndex(prev => (prev + 1) % itemCount);
    }
  }, [viewerOverlay, pokeHud, itemCount]);

  const goToPrev = useCallback((manual = false) => {
    if (viewerOverlay && manual) pokeHud();
    if (viewerOverlay) {
      setFadeIn(false);
      setTimeout(() => {
        setCurrentIndex(prev => (prev - 1 + itemCount) % itemCount);
        requestAnimationFrame(() => setFadeIn(true));
      }, FADE_DURATION_MS);
    } else {
      setCurrentIndex(prev => (prev - 1 + itemCount) % itemCount);
    }
  }, [viewerOverlay, pokeHud, itemCount]);

  // --- SYNC ---
  const refreshSyncStatus = useCallback(async () => {
    setSyncStatus(await invoke<SyncStatus>("e621_sync_status"));
  }, []);

  const startSync = useCallback(async () => {
    const n = parsePositiveInt(syncMaxNew);
    if (n === undefined) { toast("Stop-after-N must be a positive number or blank.", "error"); return; }
    await invoke("e621_sync_start", { maxNewDownloads: n });
    syncWasRunningRef.current = true;
    await refreshSyncStatus();
  }, [syncMaxNew, refreshSyncStatus]);

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
    toast("Saved e621 credentials.", "success");
  }, [apiUsername, apiKey, refreshE621CredInfo]);

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

    setFeedPaging(prev => {
      const current = prev[feedId];
      if (!reset && (current?.done || /\border:random\b/i.test(query))) return prev;
      return prev;
    });

    if (!reset) {
      const currentPaging = feedPaging[feedId];
      if (currentPaging?.done || /\border:random\b/i.test(query)) return;
    }

    loadingFeedsRef.current = { ...loadingFeedsRef.current, [feedId]: true };
    setLoadingFeeds(prev => ({ ...prev, [feedId]: true }));

    try {
      const currentPaging = feedPaging[feedId];
      const pageParam = (!reset && currentPaging?.beforeId) ? `b${currentPaging.beforeId}` : "1";
      const data = await invoke<{ posts: E621Post[] }>("e621_fetch_posts", { tags: query, limit: FEED_PAGE_LIMIT, page: pageParam });
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
  }, [e621CredInfo, credWarned, feedPaging, blacklist]);

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
      setFeedPosts(prev => ({
        ...prev,
        [feedId]: (prev[feedId] || []).map((p) => p.id === id ? { ...p, is_favorited: true } : p),
      }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setFeedActionBusy(prev => ({ ...prev, [id]: false }));
    }
  }, [downloadedE621Ids, loadData]);

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

  const toggleFullscreen = useCallback(async () => {
    if (viewerOverlay) pokeHud();
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (e) {
      console.warn("Fullscreen request failed:", e);
    }
  }, [viewerOverlay, pokeHud]);

  const openExternalUrl = useCallback(async (url: string) => {
    try { await openUrl(url); } catch (e) { console.error("Failed to open URL:", e); toast("Failed to open link.", "error"); }
  }, []);

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
  }, []);

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

    const n = parsePositiveInt(faLimit);
    if (n === undefined) { toast("Limit must be a positive number or blank.", "error"); return; }

    await invoke("fa_start_sync", { limit: n });

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
  }, [faCredsSet, faCreds, faLimit, loadData]);

  const cancelFaSync = useCallback(async () => {
    await invoke("fa_cancel_sync");
  }, []);

  // --- EFFECTS ---

  // Init
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      setInitialLoading(true);
      try {
        await loadData(false);
        await refreshLibraryRoot();
        loadFeeds();
        await refreshE621CredInfo();
        await refreshFaCreds();
      } catch (error) {
        if (!cancelled) console.error("Failed to initialize:", error);
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    };
    init();
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
  }, [activeTab, viewerOverlay, pokeHud, goToPrev, goToNext, openEditModal, showSettings, showEditModal, showTrashModal, showAddFeedModal, viewMode, toggleFullscreen]);

  // HUD management
  useEffect(() => { if (viewerOverlay) pokeHud(); }, [viewerOverlay, pokeHud]);
  useEffect(() => {
    return () => {
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
      if (faSyncIntervalRef.current) clearInterval(faSyncIntervalRef.current);
    };
  }, []);

  // Fullscreen exit handler
  useEffect(() => {
    const handler = () => { if (!document.fullscreenElement && viewerOverlay) setViewerOverlay(false); };
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, [viewerOverlay]);

  // Persist preferences
  useEffect(() => { try { localStorage.setItem('preferred_sort_order', sortOrder); } catch { /* ignore */ } }, [sortOrder]);
  useEffect(() => { localStorage.setItem('blacklist_tags', blacklist); }, [blacklist]);

  // Slideshow (removed currentIndex from deps to avoid timer reset) uses timeout so video-wait is re-evaluated each slide
  useEffect(() => {
    if (!isSlideshow || itemCount === 0) return;
    if (waitForVideoEnd && isVideo) return;

    const timeout = setTimeout(() => {
      setFadeIn(false);
      setTimeout(() => {
        setCurrentIndex(prev => (prev + 1) % itemCount);
        requestAnimationFrame(() => setFadeIn(true));
      }, FADE_DURATION_MS);
    }, slideshowSpeed);

    return () => clearTimeout(timeout);
  }, [isSlideshow, slideshowSpeed, itemCount, waitForVideoEnd, isVideo, currentIndex]);

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

    const abortControllers: Array<() => void> = [];

    preloadIndexes.forEach(idx => {
      const item = items[idx];
      if (!item || imageCacheRef.current[item.url] || ["mp4", "webm"].includes((item.ext || "").toLowerCase())) return;
      const img = new Image();
      img.src = item.url;
      img.onload = () => { imageCacheRef.current[item.url] = true; };
      abortControllers.push(() => { img.src = ""; img.onload = null; });
    });

    return () => { abortControllers.forEach(fn => fn()); };
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
    const key = `${sortOrder}|${filterSource}|${selectedTags.join(",")}`;
    if (filterKeyRef.current === key) return; // Skip initial
    if (filterKeyRef.current === "") { filterKeyRef.current = key; return; } // first mount
    filterKeyRef.current = key;

    if (!initialLoading) {
      setItems([]);
      setHasMoreItems(true);
      loadData(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortOrder, filterSource, selectedTags]);

  // Autoscroll
  useEffect(() => {
    if (!autoscroll) return;
    let frameId: number;
    const scroll = () => {
      window.scrollBy(0, autoscrollSpeed);
      frameId = requestAnimationFrame(scroll);
    };
    frameId = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frameId);
  }, [autoscroll, autoscrollSpeed]);

  // --- RENDER HELPERS ---
  const handleGridItemSelect = useCallback((index: number) => {
    setCurrentIndex(index);
    setViewMode('single');
  }, []);

  const shouldHideAutoscroll = showSettings || showEditModal || showTrashModal || (activeTab === 'viewer' && viewMode === 'single');
  // --- RENDER ---
  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <div className="border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex items-center justify-between pt-4">
            <div className="flex gap-4">
              <button onClick={() => setActiveTab('viewer')} className={`px-4 py-2 font-medium border-b-2 transition ${activeTab === 'viewer' ? 'border-purple-500 text-purple-400' : 'border-transparent text-gray-400 hover:text-gray-300'}`}>Viewer</button>
              <button onClick={() => setActiveTab('feeds')} className={`px-4 py-2 font-medium border-b-2 transition flex items-center gap-2 ${activeTab === 'feeds' ? 'border-purple-500 text-purple-400' : 'border-transparent text-gray-400 hover:text-gray-300'}`}><Rss className="w-4 h-4" />Feeds</button>
            </div>
            <button onClick={() => setShowSettings(true)} className="p-2 text-gray-400 hover:text-gray-200" title="Settings"><Settings className="w-5 h-5" /></button>
          </div>
        </div>
      </div>

      {/* Viewer Tab */}
      {activeTab === 'viewer' && (
        <>
          <div className="border-b border-gray-700">
            <div className="max-w-7xl mx-auto p-4">
              <div className="flex gap-4 items-center flex-wrap">
                <div className="flex-1 min-w-[200px] relative">
                  <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search tags (e.g. fox -male rating:s)"
                    value={searchTags}
                    onChange={(e) => setSearchTags(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setItems([]);
                        setHasMoreItems(true);
                        loadData(false);
                      }
                    }}
                    className="w-full pl-10 pr-4 py-2 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-purple-500"
                  />
                </div>
                <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="px-4 py-2 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-purple-500">
                  <option value="default">Default Order</option>
                  <option value="random">Random</option>
                  <option value="score">By Score</option>
                  <option value="newest">Newest First</option>
                  <option value="oldest">Oldest First</option>
                </select>
                <select value={filterSource} onChange={(e) => setFilterSource(e.target.value)} className="px-4 py-2 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-purple-500">
                  <option value="all">All Sources</option>
                  <option value="e621">e621 Only</option>
                  <option value="furaffinity">FurAffinity Only</option>
                </select>
                <div className="text-gray-400 text-sm">
                  Loaded {itemCount} <span className="mx-1">•</span> Total {totalDatabaseItems}
                </div>
              </div>
              {selectedTags.length > 0 && (
                <div className="mt-3 flex gap-2 flex-wrap">
                  {selectedTags.map(tag => (
                    <button key={tag} onClick={() => toggleTag(tag)} className="px-3 py-1 bg-purple-600 hover:bg-purple-700 rounded-full text-sm flex items-center gap-1">
                      {tag}<X className="w-3 h-3" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {initialLoading ? (
            <div className="max-w-7xl mx-auto p-12 flex items-center justify-center">
              <Loader2 className="w-10 h-10 animate-spin text-purple-500" />
              <span className="ml-3 text-gray-400">Loading library...</span>
            </div>
          ) : itemCount > 0 ? (
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
                          <div className={viewerOverlay ? "w-full h-full flex items-center justify-center bg-black" : "w-full h-[75vh] flex items-center justify-center bg-black rounded-lg overflow-hidden relative"}>
                            {isVideo ? (
                              <video
                                key={currentItem.url}
                                src={currentItem.url}
                                controls
                                autoPlay
                                loop={!waitForVideoEnd || !isSlideshow}
                                muted={autoMuteVideos}
                                className={`w-full h-auto object-contain transition-opacity duration-300 ${viewerOverlay ? 'max-h-full' : 'max-h-[70vh]'} ${fadeIn ? "opacity-100" : "opacity-0"}`}
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
                                className={`w-full h-auto object-contain transition-opacity duration-200 ${viewerOverlay ? 'max-h-full' : 'max-h-[70vh]'} ${fadeIn ? "opacity-100" : "opacity-0"}`}
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
                                <select value={slideshowSpeed} onChange={(e) => setSlideshowSpeed(Number(e.target.value))} className="px-3 py-2 bg-gray-700 border border-gray-600 rounded">
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
                            <button key={i} onClick={() => toggleTag(tag)} className={`px-2 py-1 rounded text-xs ${selectedTags.includes(tag) ? 'bg-purple-600' : 'bg-gray-700 hover:bg-gray-600'}`}>
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
                          <div className="space-y-1">
                            {allTags.slice(0, 50).map(tag => (
                              <button key={tag} onClick={() => toggleTag(tag)} className={`w-full text-left px-2 py-1 rounded text-sm hover:bg-gray-700 ${selectedTags.includes(tag) ? 'bg-purple-600' : ''}`}>
                                {tag}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Empty State */
            <div className="text-center py-20 text-gray-400">
              {!libraryRoot ? (
                <div className="animate-in fade-in zoom-in duration-300">
                  <Database className="w-20 h-20 mx-auto mb-6 text-purple-500 opacity-80" />
                  <h2 className="text-3xl font-bold text-white mb-3">Welcome!</h2>
                  <p className="text-gray-400 mb-8 max-w-md mx-auto">
                    To get started, select a folder where your favorites will be stored.
                    <br /><span className="text-sm opacity-75">(You can create a new empty folder or select an existing one)</span>
                  </p>
                  <button onClick={changeLibraryRoot} className="px-8 py-4 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-bold text-lg shadow-lg hover:shadow-purple-500/20 transition-all transform hover:-translate-y-1">
                    Select Library Folder
                  </button>
                </div>
              ) : (
                <div>
                  <Upload className="w-16 h-16 mx-auto mb-4 opacity-50" />
                  <p className="text-xl font-semibold text-gray-200">Library is Ready</p>
                  <p className="text-sm mt-2 mb-6 text-gray-400">
                    Your database is set up at:<br />
                    <span className="font-mono text-xs bg-gray-800 px-2 py-1 rounded mt-1 inline-block">{libraryRoot}</span>
                  </p>
                  <div className="p-4 bg-gray-800 rounded-lg max-w-md mx-auto border border-gray-700">
                    <p className="text-sm mb-3">Go to <b>Settings → e621</b> to log in and sync your favorites.</p>
                    <button onClick={() => setShowSettings(true)} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors">Open Settings</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Feeds Tab */}
      {activeTab === 'feeds' && (
        <div className="max-w-7xl mx-auto p-4">
          <div className="flex justify-center items-center gap-2 mb-6 flex-wrap">
            {feeds.map((feed) => (
              <button
                key={feed.id}
                onClick={() => {
                  setSelectedFeedId(feed.id);
                  if (!feedPosts[feed.id] || feedPosts[feed.id].length === 0) {
                    fetchFeedPosts(feed.id, feed.query, { reset: true });
                  }
                }}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${selectedFeedId === feed.id ? 'bg-purple-600 text-white shadow-lg scale-105' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
              >
                {feed.name}
              </button>
            ))}
            <button
              onClick={() => { setEditingFeedId(null); setNewFeedName(''); setNewFeedQuery(''); setShowAddFeedModal(true); }}
              className="px-4 py-2 rounded-full text-sm font-medium bg-gray-800 text-gray-300 hover:bg-gray-700 transition-all flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />Add Feed
            </button>
          </div>

          {selectedFeedId && feeds.find(f => f.id === selectedFeedId) ? (
            <div className="bg-gray-800 rounded-lg p-4">
              {(() => {
                const feed = feeds.find(f => f.id === selectedFeedId)!;
                return (
                  <>
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h2 className="text-2xl font-bold">{feed.name}</h2>
                        <p className="text-sm text-gray-400 mt-1">{feed.query}</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => fetchFeedPosts(feed.id, feed.query, { reset: true })} disabled={loadingFeeds[feed.id]} title="Refresh" className="p-2 bg-gray-700 hover:bg-gray-600 rounded">
                          {loadingFeeds[feed.id] ? <Loader2 className="w-5 h-5 animate-spin" /> : <RefreshCw className="w-5 h-5" />}
                        </button>
                        <button onClick={() => { setNewFeedName(feed.name); setNewFeedQuery(feed.query); setEditingFeedId(feed.id); setShowAddFeedModal(true); }} className="p-2 bg-gray-700 hover:bg-gray-600 rounded" title="Edit feed"><Pencil className="w-5 h-5" /></button>
                        <button onClick={() => { removeFeed(feed.id); setSelectedFeedId(null); }} className="p-2 bg-red-600 hover:bg-red-700 rounded" title="Delete feed"><Trash2 className="w-5 h-5" /></button>
                      </div>
                    </div>

                    {feedPosts[feed.id] && feedPosts[feed.id].length > 0 ? (
                      <>
                        <Masonry breakpointCols={{ default: gridColumns, 700: 2, 500: 1 }} className="flex w-auto gap-3" columnClassName="flex flex-col gap-3">
                          {feedPosts[feed.id].map((post) => (
                            <FeedPostItem
                              key={post.id}
                              post={post}
                              feedId={feed.id}
                              downloaded={downloadedE621Ids.has(post.id)}
                              busy={!!feedActionBusy[post.id]}
                              onFavorite={ensureFavorite}
                              onOpenUrl={openExternalUrl}
                            />
                          ))}
                        </Masonry>
                        <InfiniteSentinel
                          disabled={!e621CredInfo.username || !e621CredInfo.has_api_key || !!loadingFeeds[feed.id] || !!feedPaging[feed.id]?.done}
                          onVisible={() => fetchFeedPosts(feed.id, feed.query)}
                        />
                        {feedPaging[feed.id]?.done && <div className="text-center text-gray-500 text-sm py-4">End of results</div>}
                      </>
                    ) : (
                      <div className="text-center py-20 text-gray-400 italic">"Nobody here but us dergs"</div>
                    )}
                  </>
                );
              })()}
            </div>
          ) : null}

          {!selectedFeedId && feeds.length > 0 && <div className="text-center py-20 text-gray-400"><p className="text-xl mb-2">Select a feed to view posts</p></div>}
          {feeds.length === 0 && (
            <div className="text-center py-20 text-gray-400">
              <Rss className="w-16 h-16 mx-auto mb-4 opacity-50" />
              <p className="text-xl">No feeds yet</p>
              <p className="text-sm mt-2">Click the "Add Feed" button above to get started</p>
            </div>
          )}

          {/* Add/Edit Feed Modal */}
          {showAddFeedModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/60" onClick={() => { setShowAddFeedModal(false); setEditingFeedId(null); setNewFeedName(''); setNewFeedQuery(''); }} />
              <div className="relative z-10 w-full max-w-xl bg-gray-800 border border-gray-700 rounded-lg p-6">
                <h2 className="text-2xl font-bold mb-4">{editingFeedId ? 'Edit Feed' : 'Add New Feed'}</h2>
                <div className="space-y-4">
                  <div>
                    <label className="text-sm text-gray-400 mb-1 block">Feed Name</label>
                    <input type="text" placeholder="e.g., Cute Foxes" value={newFeedName} onChange={(e) => setNewFeedName(e.target.value)} className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500" />
                  </div>
                  <div>
                    <label className="text-sm text-gray-400 mb-1 block">Search Query</label>
                    <input type="text" placeholder="e.g., fox cute rating:s score:>200" value={newFeedQuery} onChange={(e) => setNewFeedQuery(e.target.value)} className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500" />
                    <p className="text-xs text-gray-500 mt-1">Use e621 search syntax.</p>
                  </div>
                  <div className="flex gap-3 justify-end">
                    <button onClick={() => { setNewFeedName(''); setNewFeedQuery(''); setShowAddFeedModal(false); setEditingFeedId(null); }} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded">Cancel</button>
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
                      className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded"
                    >
                      {editingFeedId ? 'Save Changes' : 'Create Feed'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowSettings(false)} />
          <div className="relative z-10 w-full max-w-xl max-h-[90vh] bg-gray-800 border border-gray-700 rounded-lg flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-gray-700 flex-shrink-0">
              <h2 className="text-lg font-semibold">Settings</h2>
              <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-gray-200"><X className="w-5 h-5" /></button>
            </div>
            <div className="overflow-y-auto p-5 space-y-4">
              {/* Library */}
              <div>
                <h3 className="text-lg font-semibold mb-2">Library</h3>
                <div className="text-sm text-gray-400 mb-1">Library folder</div>
                <div className="text-xs text-gray-200 break-all bg-gray-900 border border-gray-700 rounded p-2">{libraryRoot || "(not set)"}</div>
                <div className="flex gap-2 mt-3">
                  <button onClick={changeLibraryRoot} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded">Change/Create Library</button>
                  <button onClick={() => { setShowSettings(false); loadTrash(); }} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded flex items-center gap-2">
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
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded"
                  >
                    Unload Library
                  </button>
                </div>
              </div>

              {/* Viewer Settings */}
              <div className="border-t border-gray-700 pt-4">
                <h3 className="text-lg font-semibold mb-2">Viewer</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm text-gray-400 mb-1 block">Default sort order</label>
                    <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500">
                      <option value="default">Default</option><option value="random">Random</option><option value="score">Score</option><option value="newest">Newest</option><option value="oldest">Oldest</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm text-gray-400 mb-1 block">Items per batch</label>
                    <select value={itemsPerPage} onChange={(e) => handlePageSizeChange(Number(e.target.value))} className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500">
                      <option value={50}>50</option><option value={100}>100 (Recommended)</option><option value={200}>200</option><option value={500}>500</option><option value={1000}>1000</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm text-gray-400 mb-1 block flex justify-between"><span>Grid Columns</span><span className="font-mono text-purple-400">{gridColumns}</span></label>
                    <div className="flex items-center h-[42px]">
                      <input type="range" min="1" max="8" value={gridColumns} onChange={(e) => { const val = Number(e.target.value); setGridColumns(val); localStorage.setItem('grid_columns', String(val)); }} className="w-full accent-purple-600 cursor-pointer" />
                    </div>
                  </div>
                  <div className="row-span-2">
                    <label className="text-sm text-gray-400 mb-1 block">Blacklist (Feeds Only)</label>
                    <textarea value={blacklist} onChange={(e) => setBlacklist(e.target.value)} placeholder="Tags to hide..." className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded h-[42px] min-h-[42px] focus:outline-none focus:border-purple-500 text-sm resize-y" />
                  </div>
                </div>
              </div>

              {/* e621 Settings */}
              <div className="border-t border-gray-700 pt-4">
                <div className="flex items-center mb-2">
                  <h3 className="text-lg font-semibold">e621</h3>
                  <HelpTooltip text={<div>1. Go to e621.net<br />2. Click <b>Settings</b> (top right)<br />3. Go to <b>Basic &gt; Account &gt; API Keys</b><br />4. Generate/Copy your API Key</div>} />
                </div>
                <div className="text-xs text-gray-400 mb-2">Used for Feeds, Favoriting, and Syncing your Favorites.</div>

                {e621CredInfo.has_api_key && !isEditingE621 ? (
                  <div className="flex items-center justify-between bg-gray-900 p-3 rounded border border-green-900/50 mb-3">
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
                      <input type="text" placeholder="Username" value={apiUsername} onChange={(e) => setApiUsername(e.target.value)} className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500" />
                      <input type="password" placeholder="API Key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500" />
                    </div>
                    <div className="flex gap-2">
                      <button onClick={async () => { await saveE621Credentials(); setIsEditingE621(false); }} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded">Save Credentials</button>
                      {e621CredInfo.has_api_key && <button onClick={() => setIsEditingE621(false)} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded">Cancel</button>}
                    </div>
                  </div>
                )}

                <div className="flex gap-2 items-center">
                  <input type="text" placeholder="Limit (optional)" value={syncMaxNew} onChange={(e) => setSyncMaxNew(e.target.value)} className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500" />
                  <button onClick={startSync} disabled={!!syncStatus?.running || (!e621CredInfo.has_api_key && !isEditingE621)} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded disabled:opacity-50">
                    {syncStatus?.running ? "Scanning..." : "Start Import"}
                  </button>
                  {syncStatus?.running && <button onClick={cancelSync} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded">Stop</button>}
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
                  <div className="relative z-10 w-full max-w-3xl bg-gray-800 border border-gray-700 rounded-lg p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-lg font-semibold">Unavailable favorites</h2>
                      <button onClick={() => setShowUnavailable(false)} className="text-gray-400 hover:text-gray-200"><X className="w-5 h-5" /></button>
                    </div>
                    <div className="max-h-[60vh] overflow-y-auto space-y-3">
                      {unavailableList.length === 0 ? (
                        <div className="text-gray-400">No unavailable posts recorded.</div>
                      ) : (
                        unavailableList.map((u) => (
                          <div key={`${u.source}:${u.source_id}`} className="bg-gray-900 border border-gray-700 rounded p-3">
                            <div className="text-sm text-gray-200">
                              <span className="text-gray-400">{u.source}</span> #{u.source_id} <span className="text-gray-500">• {u.reason}</span> <span className="text-gray-500">• {u.seen_at}</span>
                            </div>
                            <div className="mt-2 text-xs text-gray-300 space-y-1">
                              {u.sources.length > 0 ? u.sources.map((s, i) => (
                                <div key={i}><button onClick={() => openExternalUrl(s)} className="text-purple-400 underline break-all cursor-pointer bg-transparent border-none p-0 text-left">{s}</button></div>
                              )) : <div className="text-gray-500">No source links.</div>}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* FurAffinity Settings */}
              <div className="border-t border-gray-700 pt-4 mt-4">
                <div className="flex items-center mb-2">
                  <h3 className="text-lg font-semibold">FurAffinity</h3>
                  <HelpTooltip text={<div>1. Login to FurAffinity in browser<br />2. Press <b>F12</b> (Dev Tools) &gt; <b>Application</b> tab<br />3. Under <b>Cookies</b>, find <b>furaffinity.net</b><br />4. Copy values for <b>a</b> and <b>b</b></div>} />
                </div>

                {faCredsSet && !isEditingFA ? (
                  <div className="flex items-center justify-between bg-gray-900 p-3 rounded border border-green-900/50 mb-3">
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
                      <input type="text" placeholder="Cookie A" value={faCreds.a} onChange={e => setFaCreds(prev => ({ ...prev, a: e.target.value }))} className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded" />
                      <input type="text" placeholder="Cookie B" value={faCreds.b} onChange={e => setFaCreds(prev => ({ ...prev, b: e.target.value }))} className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded" />
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
                        className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded"
                      >
                        Save Cookies
                      </button>
                      {faCredsSet && <button onClick={() => setIsEditingFA(false)} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded">Cancel</button>}
                    </div>
                  </div>
                )}

                <div className="flex gap-2 items-center">
                  <input type="text" placeholder="Limit (optional)" value={faLimit} onChange={(e) => setFaLimit(e.target.value)} className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500" />
                  <button onClick={startFaSync} disabled={faStatus?.running || (!faCredsSet && !isEditingFA)} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded disabled:opacity-50">
                    {faStatus?.running ? "Scanning..." : "Start Import"}
                  </button>
                  {faStatus?.running && <button onClick={cancelFaSync} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded">Stop</button>}
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
            </div>
          </div>
        </div>
      )}

      {/* Edit Metadata Modal */}
      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowEditModal(false)} />
          <div className="relative z-10 w-full max-w-2xl max-h-[90vh] bg-gray-800 border border-gray-700 rounded-lg flex flex-col shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-gray-700">
              <h2 className="text-xl font-bold">Edit Post Metadata</h2>
              <button onClick={() => setShowEditModal(false)} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
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
                    className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500 text-sm"
                  />
                  <button onClick={() => { if (newSourceInput.trim() && !editingSources.includes(newSourceInput.trim())) { setEditingSources([...editingSources, newSourceInput.trim()]); setNewSourceInput(""); } }} className="px-3 py-2 bg-gray-600 hover:bg-gray-500 rounded text-sm">Add</button>
                </div>
                <div className="space-y-1">
                  {editingSources.map((src, i) => (
                    <div key={i} className="flex items-center justify-between bg-gray-900/50 px-3 py-2 rounded border border-gray-700">
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
                    className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500 text-sm"
                  />
                  <button onClick={() => { const t = newTagInput.trim().toLowerCase(); if (t && !editingTags.includes(t)) { setEditingTags([...editingTags, t]); setNewTagInput(""); } }} className="px-3 py-2 bg-gray-600 hover:bg-gray-500 rounded text-sm">Add</button>
                </div>
                <div className="flex flex-wrap gap-2 p-3 bg-gray-900/50 rounded border border-gray-700 min-h-[100px] content-start">
                  {editingTags.map(tag => (
                    <span key={tag} className="px-2 py-1 bg-purple-900/30 border border-purple-500/30 rounded text-sm flex items-center gap-1">
                      {tag}
                      <button onClick={() => setEditingTags(prev => prev.filter(t => t !== tag))} className="hover:text-red-400 ml-1"><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 p-5 border-t border-gray-700">
              <button onClick={() => setShowEditModal(false)} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded">Cancel</button>
              <button onClick={saveMetadata} className="px-6 py-2 bg-purple-600 hover:bg-purple-700 rounded font-bold">Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {/* Trash Modal */}
      {showTrashModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowTrashModal(false)} />
          <div className="relative z-10 w-full max-w-4xl max-h-[90vh] bg-gray-800 border border-gray-700 rounded-lg flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-gray-700 flex-shrink-0">
              <h2 className="text-lg font-semibold flex items-center gap-2"><Trash2 className="w-5 h-5 text-gray-400" />Trash Manager</h2>
              <div className="flex gap-2">
                <button onClick={handleEmptyTrash} disabled={trashedItems.length === 0} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded disabled:opacity-50 text-sm font-medium">Empty Trash</button>
                <button onClick={() => setShowTrashModal(false)} className="text-gray-400 hover:text-gray-200"><X className="w-5 h-5" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {trashedItems.length > 0 ? (
                <Masonry breakpointCols={4} className="flex w-auto gap-3" columnClassName="flex flex-col gap-3">
                  {trashedItems.map((item) => {
                    const isVid = ["mp4", "webm"].includes((item.ext || "").toLowerCase());
                    return (
                      <div key={item.item_id} className="relative group bg-gray-700 rounded overflow-hidden border border-gray-600">
                        {isVid ? (
                          <video src={item.url} className="w-full h-auto object-cover opacity-60" />
                        ) : (
                          <img src={item.url} className="w-full h-auto object-cover opacity-60" loading="lazy" alt="" />
                        )}
                        <div className="absolute inset-0 flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 bg-black/50 transition-opacity">
                          <button onClick={() => handleRestore(item.item_id)} className="p-2 bg-green-600 hover:bg-green-700 rounded-full text-white" title="Restore"><Undo className="w-5 h-5" /></button>
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 p-1 bg-black/60 text-xs text-gray-300 text-center">
                          {item.source} #{item.source_id}
                        </div>
                      </div>
                    );
                  })}
                </Masonry>
              ) : (
                <div className="text-center py-20 text-gray-500">
                  <Trash2 className="w-16 h-16 mx-auto mb-4 opacity-20" />
                  <p>Trash is empty</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <AutoscrollWidget
        active={true}
        autoscroll={autoscroll}
        setAutoscroll={setAutoscroll}
        autoscrollSpeed={autoscrollSpeed}
        setAutoscrollSpeed={setAutoscrollSpeed}
        hidden={shouldHideAutoscroll}
      />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}