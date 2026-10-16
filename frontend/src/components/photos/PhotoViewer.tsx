import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Heart,
  Info,
  Loader2,
  Pause,
  SlidersHorizontal,
  Play,
  Trash2,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import { thumbHashToDataURL } from "thumbhash";

import { filesApi, type SignedUrls } from "@/api/files";
import { mediaApi } from "@/api/files";
import { photosApi, type PhotoItem } from "@/api/photos";
import { MediaDetails } from "@/components/files/MediaDetails";
import { PeopleInPhoto } from "@/components/photos/PeopleInPhoto";
import { PhotoEditor } from "@/components/photos/PhotoEditor";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * The photo viewer (WP-9.3, Part E PH-1): full screen, through the
 * timeline with arrows, keys or a swipe; wheel, pinch or double-click to
 * zoom (the original replaces the preview when zoomed in, for pictures a
 * browser can show as they are); videos play and seek; a Live Photo or a
 * motion photo plays its moment of video while you press (or hover) LIVE;
 * the info panel has the date, place and camera — correctable — and who
 * can see it.
 */

const BROWSER_IMAGES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const MAX_SCALE = 8;

function blur(hash: string | null): string | undefined {
  if (!hash) return undefined;
  try {
    return thumbHashToDataURL(Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

function useLinks(id: string | null | undefined, poll = false) {
  return useQuery({
    queryKey: ["signed-urls", id],
    queryFn: () => filesApi.signedUrls(id!),
    enabled: !!id,
    staleTime: 10 * 60_000,
    // A video still being made playable: look again shortly.
    refetchInterval: (q) => {
      const d = q.state.data as SignedUrls | undefined;
      return poll && d && !d.video && (d.state === "pending" || d.state === "processing" || d.state === null) ? 4000 : false;
    },
  });
}

export function PhotoViewer({
  items: initial,
  startId,
  loadMore,
  onClose,
  onChanged,
  slideshow = false,
}: {
  items: PhotoItem[];
  startId: string;
  /** Start playing: each photo a few seconds, a video to its end (a memory). */
  slideshow?: boolean;
  /** The next or previous month's photos, when the viewer reaches an end. */
  loadMore: (dir: 1 | -1, edgeId: string) => Promise<PhotoItem[]>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [items, setItems] = useState(initial);
  const [index, setIndex] = useState(() => Math.max(0, initial.findIndex((p) => p.id === startId)));
  const [info, setInfo] = useState(() => window.innerWidth >= 1024 && localStorage.getItem("photos.info") === "1");
  const photo = items[index];
  const qc = useQueryClient();

  const go = useCallback(
    async (dir: 1 | -1) => {
      const next = index + dir;
      if (next >= 0 && next < items.length) {
        setIndex(next);
        return;
      }
      const more = await loadMore(dir, items[index].id).catch(() => [] as PhotoItem[]);
      if (!more.length) return;
      if (dir === 1) {
        setItems((cur) => [...cur, ...more.filter((m) => !cur.some((c) => c.id === m.id))]);
        setIndex(index + 1);
      } else {
        const fresh = more.filter((m) => !items.some((c) => c.id === m.id));
        setItems((cur) => [...fresh, ...cur]);
        setIndex(index + fresh.length - 1);
      }
    },
    [index, items, loadMore],
  );

  // A slideshow moves on by itself — a photo after 4 s, a video after its
  // length (at most 30 s) — and stops at the end. Space pauses it.
  const [playing, setPlaying] = useState(slideshow);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const p = items[index];
    if (!playing || !p) return;
    if (index >= items.length - 1) {
      const t = window.setTimeout(() => setPlaying(false), 4000);
      return () => window.clearTimeout(t);
    }
    const ms = p.kind === "video" ? Math.min(Math.max(p.duration_ms ?? 8000, 3000), 30_000) : 4000;
    const t = window.setTimeout(() => setIndex((i) => Math.min(i + 1, items.length - 1)), ms);
    return () => window.clearTimeout(t);
  }, [playing, index, items]);

  // Keys: ← → to move, Esc to close, i for info.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || (e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowRight") void go(1);
      else if (e.key === "ArrowLeft") void go(-1);
      else if (e.key === "Escape") onClose();
      else if (e.key === "i") setInfo((v) => !v);
      else if (e.key === " " && slideshow) {
        e.preventDefault();
        setPlaying((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose, slideshow, editing]);

  // The next and previous photos load while you look at this one.
  useEffect(() => {
    for (const p of [items[index + 1], items[index - 1]]) {
      if (!p) continue;
      void qc.prefetchQuery({ queryKey: ["signed-urls", p.id], queryFn: () => filesApi.signedUrls(p.id), staleTime: 10 * 60_000 })
        .then(() => {
          const l = qc.getQueryData<SignedUrls>(["signed-urls", p.id]);
          if (p.kind === "image" && l?.preview) new Image().src = l.preview;
        });
    }
  }, [index, items, qc]);

  useEffect(() => {
    try {
      localStorage.setItem("photos.info", info ? "1" : "0");
    } catch {
      /* private window */
    }
  }, [info]);

  if (!photo) return null;

  const remove = () => {
    setItems((cur) => {
      const next = cur.filter((p) => p.id !== photo.id);
      if (!next.length) onClose();
      setIndex((i) => Math.min(i, Math.max(next.length - 1, 0)));
      return next;
    });
    onChanged();
  };

  const act = async (what: "favorite" | "archive" | "trash") => {
    try {
      if (what === "favorite") {
        await (photo.favorite ? filesApi.unstarFile(photo.id) : filesApi.starFile(photo.id));
        setItems((cur) => cur.map((p) => (p.id === photo.id ? { ...p, favorite: !p.favorite } : p)));
        onChanged();
      } else if (what === "archive") {
        await photosApi.archive([photo.id], !photo.archived);
        toast.success(photo.archived ? "Back in Photos." : "Archived — it's under Archive.");
        remove();
      } else {
        await filesApi.bulkTrash({ file_ids: [photo.id], folder_ids: [] });
        toast.success("Moved to the trash.");
        remove();
      }
    } catch (e) {
      toast.error(apiErrorMessage(e, "That didn't work."));
    }
  };

  const when = new Date(photo.taken_local);
  const title = when.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const btn = "rounded-full p-2 text-white/90 transition hover:bg-white/10 hover:text-white";

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Photo viewer" className="fixed inset-0 z-[60] flex bg-black text-white">
      <div className="relative min-w-0 flex-1">
        <Stage key={photo.id} photo={photo} onSwipe={(d) => void go(d)} onClose={onClose} />

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-1 bg-gradient-to-b from-black/70 to-transparent px-2 pb-8 pt-2">
          <button type="button" aria-label="Close" onClick={onClose} className={cn(btn, "pointer-events-auto")}>
            <X className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1 px-1">
            <p className="truncate text-sm font-medium">{title}</p>
            <p className="truncate text-xs text-white/70">{time}</p>
          </div>
          <div className="pointer-events-auto flex items-center">
            {slideshow && (
              <button type="button" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((v) => !v)} className={btn}>
                {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
              </button>
            )}
            {photo.mine !== false && (
            <button type="button" aria-label={photo.favorite ? "Unfavourite" : "Favourite"} aria-pressed={photo.favorite} onClick={() => void act("favorite")} className={btn}>
              <Heart className={cn("h-5 w-5", photo.favorite && "fill-current")} />
            </button>
            )}
            <button type="button" aria-label="Info" aria-pressed={info} onClick={() => setInfo((v) => !v)} className={btn}>
              <Info className="h-5 w-5" />
            </button>
            {photo.kind === "image" && photo.mine !== false && (
              <button type="button" aria-label="Edit" onClick={() => { setPlaying(false); setEditing(true); }} className={btn}>
                <SlidersHorizontal className="h-5 w-5" />
              </button>
            )}
            <DownloadButton id={photo.id} className={btn} />
            {photo.edited && (
              <button type="button" aria-label="Download edited" title="Download edited" className={cn(btn, "hidden sm:block")}
                onClick={() => void photosApi.downloadEdited(photo.id, photo.filename).catch((e) => toast.error(apiErrorMessage(e, "Couldn't download it.")))}>
                <Download className="h-5 w-5" />
                <span className="sr-only">edited</span>
              </button>
            )}
            {/* Someone else's (family library, shared album): theirs to change. */}
            {photo.mine !== false && (
              <>
                <button type="button" aria-label={photo.archived ? "Unarchive" : "Archive"} onClick={() => void act("archive")} className={cn(btn, "hidden sm:block")}>
                  {photo.archived ? <ArchiveRestore className="h-5 w-5" /> : <Archive className="h-5 w-5" />}
                </button>
                <button type="button" aria-label="Move to trash" onClick={() => void act("trash")} className={btn}>
                  <Trash2 className="h-5 w-5" />
                </button>
              </>
            )}
          </div>
        </div>

        {index > 0 && (
          <button type="button" aria-label="Previous" onClick={() => void go(-1)} className="absolute left-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60 sm:block">
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        <button type="button" aria-label="Next" onClick={() => void go(1)} className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60 sm:block">
          <ChevronRight className="h-6 w-6" />
        </button>
      </div>

      {info && <InfoPanel photo={photo} onClose={() => setInfo(false)} />}
      {editing && (
        <PhotoEditor
          photo={photo}
          onClose={() => setEditing(false)}
          onSaved={(item) => {
            setEditing(false);
            if (item) setItems((cur) => cur.map((p) => (p.id === item.id ? { ...p, ...item } : p)));
            void qc.invalidateQueries({ queryKey: ["signed-urls", photo.id] });
            onChanged();
          }}
        />
      )}
    </div>,
    document.body,
  );
}

function DownloadButton({ id, className }: { id: string; className: string }) {
  const { data } = useLinks(id);
  if (!data?.original) return null;
  return (
    <a href={data.original} download aria-label="Download" className={cn(className, "pointer-events-auto")}>
      <Download className="h-5 w-5" />
    </a>
  );
}

/** One photo or video, zoomable, swipeable. */
function Stage({ photo, onSwipe, onClose }: { photo: PhotoItem; onSwipe: (dir: 1 | -1) => void; onClose: () => void }) {
  const { data: links } = useLinks(photo.id, photo.kind === "video");
  const placeholder = blur(photo.thumbhash);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const box = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; scale: number; startX: number; startY: number; x: number; y: number; moved: boolean } | null>(null);
  const zoomed = view.scale > 1.01;
  // Zoomed in: the original's full detail — not for an edited photo (PH-7).
  const original = !!links?.original && !links?.edited && BROWSER_IMAGES.has(photo.mime?.toLowerCase());
  const src = photo.kind === "image" ? ((zoomed && original ? links?.original : links?.preview) ?? links?.preview ?? photo.thumb) : null;

  const zoomAt = (clientX: number, clientY: number, next: number) => {
    const rect = box.current!.getBoundingClientRect();
    const cx = clientX - rect.left - rect.width / 2;
    const cy = clientY - rect.top - rect.height / 2;
    setView((v) => {
      const s = Math.min(MAX_SCALE, Math.max(1, next));
      if (s === 1) return { scale: 1, x: 0, y: 0 };
      const k = s / v.scale;
      return { scale: s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  };

  return (
    <div
      ref={box}
      className="absolute inset-0 flex touch-none select-none items-center justify-center overflow-hidden"
      onWheel={(e) => {
        if (photo.kind !== "image") return;
        zoomAt(e.clientX, e.clientY, view.scale * Math.exp(-e.deltaY * 0.0025));
      }}
      onDoubleClick={(e) => photo.kind === "image" && zoomAt(e.clientX, e.clientY, zoomed ? 1 : 2.5)}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button, a, video")) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const pts = [...pointers.current.values()];
        gesture.current = {
          dist: pts.length === 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
          scale: view.scale,
          startX: e.clientX,
          startY: e.clientY,
          x: view.x,
          y: view.y,
          moved: false,
        };
      }}
      onPointerMove={(e) => {
        if (!pointers.current.has(e.pointerId) || !gesture.current) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const g = gesture.current;
        const pts = [...pointers.current.values()];
        if (pts.length === 2 && g.dist > 0 && photo.kind === "image") {
          const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          zoomAt((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, (g.scale * d) / g.dist);
          g.moved = true;
          return;
        }
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;
        if (Math.hypot(dx, dy) > 6) g.moved = true;
        if (zoomed) setView((v) => ({ ...v, x: g.x + dx, y: g.y + dy }));
      }}
      onPointerUp={(e) => {
        const g = gesture.current;
        const wasPinch = pointers.current.size > 1;
        pointers.current.delete(e.pointerId);
        if (!g || wasPinch || zoomed) return;
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;
        // A swipe across moves on; a swipe down closes (a phone gesture).
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) onSwipe(dx < 0 ? 1 : -1);
        else if (dy > 120 && Math.abs(dy) > Math.abs(dx) && e.pointerType === "touch") onClose();
        gesture.current = null;
      }}
      onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
    >
      {photo.kind === "video" ? (
        links?.video ? (
          <video
            key={links.video}
            src={links.video}
            poster={links.poster ?? undefined}
            controls
            autoPlay
            playsInline
            aria-label={photo.filename}
            className="max-h-full max-w-full"
          />
        ) : (
          <div className="flex flex-col items-center gap-3 text-sm text-white/80">
            {links?.poster ? <img src={links.poster} alt="" className="max-h-[70vh] max-w-full opacity-60" /> : null}
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Getting the video ready to play…
            </span>
          </div>
        )
      ) : (
        <div
          className="relative flex h-full w-full items-center justify-center"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transition: gesture.current ? "none" : "transform 120ms ease-out" }}
        >
          {src ? (
            <img
              src={src}
              alt={photo.filename}
              draggable={false}
              className="max-h-full max-w-full object-contain"
              style={{ backgroundImage: placeholder ? `url(${placeholder})` : undefined, backgroundSize: "cover" }}
            />
          ) : placeholder ? (
            <img src={placeholder} alt="" className="max-h-[80vh] max-w-full object-contain blur-sm" style={{ aspectRatio: photo.width && photo.height ? `${photo.width} / ${photo.height}` : undefined }} />
          ) : (
            <Loader2 className="h-6 w-6 animate-spin text-white/60" />
          )}
        </div>
      )}
      {photo.kind === "image" && !zoomed && <LiveClip photo={photo} links={links} />}
    </div>
  );
}

/** A Live Photo's or motion photo's moment of video, while LIVE is held. */
function LiveClip({ photo, links }: { photo: PhotoItem; links: SignedUrls | undefined }) {
  const { data: details } = useQuery({
    queryKey: ["file-media", photo.id],
    queryFn: () => mediaApi.get(photo.id),
    enabled: photo.live,
    staleTime: 5 * 60_000,
  });
  const pairId = photo.live ? details?.live_pair_file_id ?? null : null;
  const { data: pair } = useLinks(pairId);
  // A motion photo carries its clip as its own video rendition.
  const clip = pair?.video ?? links?.video ?? null;
  const [playing, setPlaying] = useState(false);
  if (!clip) return null;
  return (
    <>
      {playing && (
        <video
          src={clip}
          autoPlay
          playsInline
          onEnded={() => setPlaying(false)}
          className="pointer-events-none absolute inset-0 m-auto max-h-full max-w-full object-contain"
        />
      )}
      <button
        type="button"
        aria-label="Play the Live Photo"
        aria-pressed={playing}
        onPointerDown={(e) => {
          e.stopPropagation();
          setPlaying(true);
        }}
        onPointerUp={() => setPlaying(false)}
        onPointerLeave={() => setPlaying(false)}
        onMouseEnter={() => setPlaying(true)}
        onKeyDown={(e) => (e.key === " " || e.key === "Enter") && setPlaying((v) => !v)}
        className={cn(
          "absolute bottom-6 left-4 rounded-full border border-white/70 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-white backdrop-blur",
          playing ? "bg-white/30" : "bg-black/40",
        )}
      >
        LIVE
      </button>
    </>
  );
}

function InfoPanel({ photo, onClose }: { photo: PhotoItem; onClose: () => void }) {
  const { data: file } = useQuery({ queryKey: ["file", photo.id], queryFn: () => filesApi.getFile(photo.id) });
  const grantees = file?.sharing?.grantees ?? [];
  const links = file?.sharing?.public_links ?? 0;
  const who =
    grantees.length === 0 && !links
      ? "Only you"
      : [
          grantees.length ? `${grantees.map((g) => g.username).slice(0, 3).join(", ")}${grantees.length > 3 ? ` and ${grantees.length - 3} more` : ""}` : null,
          links ? `anyone with ${links === 1 ? "its link" : `one of its ${links} links`} (without the location)` : null,
        ]
          .filter(Boolean)
          .join(", and ");
  return (
    <aside
      aria-label="Photo info"
      className="absolute inset-x-0 bottom-0 z-10 max-h-[60vh] overflow-y-auto rounded-t-2xl bg-[var(--surface)] p-4 text-[var(--text)] lg:static lg:max-h-none lg:w-80 lg:shrink-0 lg:rounded-none lg:border-l lg:border-[var(--border)]"
    >
      <div className="mb-2 flex items-center">
        <h2 className="flex-1 text-sm font-semibold">Info</h2>
        <button type="button" aria-label="Close info" onClick={onClose} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="break-all text-xs text-[var(--text-muted)]">{photo.filename}</p>
      <div className="text-xs">
        <MediaDetails fileId={photo.id} />
        <PeopleInPhoto fileId={photo.id} />
      </div>
      <div className="mt-4 space-y-1 text-xs">
        <p className="font-medium">Who can see it</p>
        <p className="text-[var(--text-muted)]">{file ? who : "…"}</p>
      </div>
      <Link
        to={`/files/f/${photo.id}`}
        className="mt-4 inline-flex items-center gap-1.5 text-xs text-[var(--accent-text)] hover:underline"
      >
        <FolderOpen className="h-3.5 w-3.5" /> Show in Files
      </Link>
    </aside>
  );
}
