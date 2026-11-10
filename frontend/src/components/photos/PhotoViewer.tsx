import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  ImageDown,
  Info,
  Loader2,
  MoreHorizontal,
  Pause,
  SlidersHorizontal,
  Play,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import { thumbHashToDataURL } from "thumbhash";

import { filesApi, type SignedUrls } from "@/api/files";
import { mediaApi } from "@/api/files";
import { photosApi, type PhotoItem } from "@/api/photos";
import { porchTrashWarning } from "@/api/porch";
import { MediaDetails } from "@/components/files/MediaDetails";
import { LinkedSection } from "@/components/links/LinkedSection";
import { PeopleInPhoto } from "@/components/photos/PeopleInPhoto";
import { PhotoEditor } from "@/components/photos/PhotoEditor";
import { PopMenu, PopMenuItem } from "@/components/photos/PopMenu";
import { SendToSheet } from "@/components/share/SendToSheet";
import { ItemButton, Sheet } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import "./photos.css";

/**
 * The photo viewer (WP-9.3, Part E PH-1): full screen, through the
 * timeline with arrows, keys or a swipe (the photo follows your finger and
 * the next one slides in; it opens growing from its tile); wheel, pinch or double-click to
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

const GAP = 16;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

function calm(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Where a photo's tile sits on the page behind, as a transform that puts
 * the full-screen photo over it. Null when the tile isn't on screen.
 */
function tileTransform(photo: PhotoItem, stage: HTMLElement): string | null {
  if (!photo.width || !photo.height) return null;
  const tile = Array.from(document.querySelectorAll<HTMLElement>(`[data-photo="${photo.id}"]`))
    .map((el) => el.getBoundingClientRect())
    .find((r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth);
  if (!tile) return null;
  const s = stage.getBoundingClientRect();
  if (!s.width || !s.height) return null;
  const ratio = photo.width / photo.height;
  const w = Math.min(s.width, s.height * ratio);
  const h = w / ratio;
  const scale = Math.max(tile.width / w, tile.height / h);
  const x = tile.left + tile.width / 2 - (s.left + s.width / 2);
  const y = tile.top + tile.height / 2 - (s.top + s.height / 2);
  return `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
}

type Undo = { key: number; text: string; run: () => Promise<void> };

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
  const [ended, setEnded] = useState(false);
  const qc = useQueryClient();
  const { data: links } = useLinks(photo?.id);

  // What moves: the track slides sideways under a finger, the wrap follows
  // a swipe down (and grows from the tile on opening), the backdrop and the
  // buttons fade with it.
  const root = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const chrome = useRef<HTMLDivElement>(null);
  const sliding = useRef(false);
  const closing = useRef(false);
  const live = useRef({ items, index, onClose });
  live.current = { items, index, onClose };

  /** Close: the photo shrinks back to its tile when that is on screen. */
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const { items: list, index: at, onClose: done } = live.current;
    const el = root.current;
    if (!el || calm() || typeof el.animate !== "function") return done();
    const ms = 190;
    const to = list[at] && column.current ? tileTransform(list[at], column.current) : null;
    el.animate([{ opacity: 0 }], { duration: ms, easing: "ease-in", fill: "forwards" });
    if (to) wrap.current?.animate([{ transform: to }], { duration: ms, easing: EASE, fill: "forwards" });
    window.setTimeout(done, ms);
  }, []);

  // Opening: the photo grows from its tile (or just fades in).
  useLayoutEffect(() => {
    const w = wrap.current;
    if (!w || calm() || typeof w.animate !== "function") return;
    const opts = { duration: 240, easing: EASE };
    const from = live.current.items[live.current.index] && column.current ? tileTransform(live.current.items[live.current.index], column.current) : null;
    backdrop.current?.animate([{ opacity: 0 }, { opacity: 1 }], opts);
    chrome.current?.animate([{ opacity: 0 }, { opacity: 1 }], opts);
    if (from) w.animate([{ transform: from }, { transform: "none" }], opts);
    else w.animate([{ opacity: 0, transform: "scale(0.97)" }, { opacity: 1, transform: "none" }], opts);
  }, []);

  // A new photo in the middle: the track is back at rest, with no slide.
  useLayoutEffect(() => {
    sliding.current = false;
    if (!track.current) return;
    track.current.style.transition = "none";
    track.current.style.transform = "";
  }, [photo?.id]);

  const go = useCallback(
    async (dir: 1 | -1) => {
      const next = index + dir;
      if (next >= 0 && next < items.length) {
        setIndex(next);
        return;
      }
      const more = await loadMore(dir, items[index].id).catch(() => null);
      if (!more) return;
      if (!more.length) {
        // Nothing after this one: the Next arrow goes away.
        if (dir === 1) setEnded(true);
        return;
      }
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

  /** Move on with a slide (arrows, keys, the end of a swipe). */
  const step = useCallback(
    (dir: 1 | -1) => {
      if (sliding.current) return;
      const t = track.current;
      const has = dir === 1 ? index < items.length - 1 : index > 0;
      if (!has || !t || calm()) {
        if (t) {
          t.style.transition = `transform 200ms ${EASE}`;
          t.style.transform = "";
        }
        void go(dir);
        return;
      }
      sliding.current = true;
      t.style.transition = `transform 220ms ${EASE}`;
      t.style.transform = `translate3d(${-dir * (t.clientWidth + GAP)}px, 0, 0)`;
      window.setTimeout(() => {
        if (!sliding.current) return;
        sliding.current = false;
        setIndex((i) => Math.max(0, Math.min(i + dir, live.current.items.length - 1)));
      }, 220);
    },
    [go, index, items.length],
  );

  // A finger on the photo: sideways it carries the photo (the next one
  // peeks in); downwards the photo follows and the page shows through.
  const onDrag = (axis: "x" | "y", d: number) => {
    if (sliding.current || closing.current) return;
    if (axis === "x") {
      const t = track.current;
      if (!t) return;
      // Nothing before the first photo: it gives a little, then holds.
      const end = d > 0 && index === 0;
      t.style.transition = "none";
      t.style.transform = `translate3d(${end ? d * 0.3 : d}px, 0, 0)`;
    } else {
      const w = wrap.current;
      if (!w) return;
      const fade = String(Math.max(0, 1 - d / 400));
      w.style.transition = "none";
      w.style.transform = `translate3d(0, ${d}px, 0) scale(${Math.max(0.6, 1 - d / 1200)})`;
      if (backdrop.current) {
        backdrop.current.style.transition = "none";
        backdrop.current.style.opacity = fade;
      }
      if (chrome.current) {
        chrome.current.style.transition = "none";
        chrome.current.style.opacity = fade;
      }
    }
  };

  const onRelease = (axis: "x" | "y", d: number, flick: boolean) => {
    if (sliding.current || closing.current) return;
    if (axis === "x") {
      const t = track.current;
      if (Math.abs(d) > 60 || (flick && Math.abs(d) > 24)) step(d < 0 ? 1 : -1);
      else if (t) {
        t.style.transition = `transform 200ms ${EASE}`;
        t.style.transform = "";
      }
    } else if (d > 120 || (flick && d > 50)) {
      close();
    } else {
      for (const el of [wrap.current, backdrop.current, chrome.current]) {
        if (!el) continue;
        el.style.transition = `transform 200ms ${EASE}, opacity 200ms ease-out`;
        el.style.transform = "";
        el.style.opacity = "";
      }
    }
  };

  // A slideshow moves on by itself — a photo after 4 s, a video after its
  // length (at most 30 s) — and stops at the end. Space pauses it.
  const [playing, setPlaying] = useState(slideshow);
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [trashWarn, setTrashWarn] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [pop, setPop] = useState(0);
  const [undo, setUndo] = useState<Undo | null>(null);
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

  // "Undo" stays a few seconds, then goes.
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 8000);
    return () => window.clearTimeout(t);
  }, [undo]);

  // Keys: ← → to move, Esc to close, I for info, F to favourite, A to
  // archive, Delete for the trash.
  const actRef = useRef<(what: "favorite" | "archive" | "trash") => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || sending || trashWarn || menu || (e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === "ArrowRight") step(1);
      else if (key === "ArrowLeft") step(-1);
      else if (key === "Escape") close();
      else if (key === "i") setInfo((v) => !v);
      else if (key === "f") actRef.current("favorite");
      else if (key === "a") actRef.current("archive");
      else if (key === "Delete") actRef.current("trash");
      else if (key === " " && slideshow) {
        e.preventDefault();
        setPlaying((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, close, slideshow, editing, sending, trashWarn, menu]);

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
  const mine = photo.mine !== false;

  /** Out of the viewer's list. With nothing left, the viewer closes. */
  const takeOut = (gone: PhotoItem): boolean => {
    const next = items.filter((p) => p.id !== gone.id);
    onChanged();
    if (!next.length) {
      onClose();
      return false;
    }
    setItems(next);
    setIndex((i) => Math.min(i, next.length - 1));
    return true;
  };

  /** Gone, with a way back: in the viewer while it is open, else a toast. */
  const goneWithUndo = (gone: PhotoItem, text: string, back: () => Promise<unknown>) => {
    const at = index;
    if (takeOut(gone)) {
      setUndo({
        key: Date.now(),
        text,
        run: async () => {
          await back();
          const cur = live.current.items;
          if (!cur.some((p) => p.id === gone.id)) {
            const i = Math.min(at, cur.length);
            setItems([...cur.slice(0, i), gone, ...cur.slice(i)]);
            setIndex(i);
          }
          onChanged();
        },
      });
    } else {
      toast.success(text, {
        action: {
          label: "Undo",
          onClick: () => void back().then(onChanged).catch((e) => toast.error(apiErrorMessage(e, "Couldn't undo that."))),
        },
      });
    }
  };

  const act = async (what: "favorite" | "archive" | "trash", sure = false) => {
    if (!mine) return;
    try {
      if (what === "favorite") {
        // The heart flips at once; it flips back if the server says no.
        const now = !photo.favorite;
        const flip = (to: boolean) => setItems((cur) => cur.map((p) => (p.id === photo.id ? { ...p, favorite: to } : p)));
        flip(now);
        if (now) setPop((n) => n + 1);
        try {
          await (now ? filesApi.starFile(photo.id) : filesApi.unstarFile(photo.id));
        } catch (e) {
          flip(!now);
          throw e;
        }
        onChanged();
      } else if (what === "archive") {
        const to = !photo.archived;
        await photosApi.archive([photo.id], to);
        goneWithUndo({ ...photo }, to ? "Archived. It's under Archive." : "Back in Photos.", () => photosApi.archive([photo.id], !to));
      } else {
        // In Porch posts: say so first (the viewer sits above dialogs, so a sheet).
        const warn = sure ? null : await porchTrashWarning([photo.id]);
        if (warn) {
          setTrashWarn(warn);
          return;
        }
        await filesApi.bulkTrash({ file_ids: [photo.id], folder_ids: [] });
        goneWithUndo({ ...photo }, "Moved to the trash.", () => filesApi.restoreFile(photo.id));
      }
    } catch (e) {
      toast.error(apiErrorMessage(e, "That didn't work."));
    }
  };
  actRef.current = (what) => void act(what);

  const downloadEdited = () =>
    void photosApi.downloadEdited(photo.id, photo.filename).catch((e) => toast.error(apiErrorMessage(e, "Couldn't download it.")));
  const download = () => {
    if (!links?.original) return;
    const a = document.createElement("a");
    a.href = links.original;
    a.download = "";
    a.click();
  };

  const when = new Date(photo.taken_local);
  const title = when.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  // 40px, so a thumb finds them.
  const btn = "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white/90 transition hover:bg-white/10 hover:text-white";
  // On a phone these wait under "⋯".
  const wide = cn(btn, "hidden sm:flex");
  const before = items[index - 1];
  const after = items[index + 1];

  return createPortal(
    <div ref={root} role="dialog" aria-modal="true" aria-label="Photo viewer" className="fixed inset-0 z-[60] flex text-white">
      <div ref={backdrop} aria-hidden className="absolute inset-0 bg-black" />
      <div ref={column} className="relative min-w-0 flex-1">
        <div ref={wrap} className="absolute inset-0 overflow-hidden">
          <div ref={track} className="absolute inset-0">
            {before && <Peek key={before.id} photo={before} side={-1} />}
            <Stage key={photo.id} photo={photo} onDrag={onDrag} onRelease={onRelease} />
            {after && <Peek key={after.id} photo={after} side={1} />}
          </div>
        </div>

        <div ref={chrome} className="pointer-events-none absolute inset-0">
          <div className="absolute inset-x-0 top-0 flex items-center gap-0.5 bg-gradient-to-b from-black/70 to-transparent px-1.5 pb-8 pt-1.5">
            <button type="button" aria-label="Close" title="Close (Esc)" onClick={close} className={cn(btn, "pointer-events-auto")}>
              <X className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1 px-1">
              <p className="truncate text-sm font-medium">{title}</p>
              <p className="truncate text-xs text-white/70">{time}</p>
            </div>
            <div className="pointer-events-auto flex items-center">
              {slideshow && (
                <button type="button" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"} onClick={() => setPlaying((v) => !v)} className={btn}>
                  {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                </button>
              )}
              {mine && (
                <button
                  type="button"
                  aria-label={photo.favorite ? "Unfavourite" : "Favourite"}
                  title={photo.favorite ? "Unfavourite (F)" : "Favourite (F)"}
                  aria-pressed={photo.favorite}
                  onClick={() => void act("favorite")}
                  className={btn}
                >
                  <Heart key={pop} className={cn("h-5 w-5", photo.favorite && "fill-current", pop > 0 && photo.favorite && "photos-heart-pop")} />
                </button>
              )}
              <button type="button" aria-label="Info" title="Info (I)" aria-pressed={info} onClick={() => setInfo((v) => !v)} className={btn}>
                <Info className="h-5 w-5" />
              </button>
              {photo.kind === "image" && (
                <button type="button" aria-label={mine ? "Edit" : "Mark up"} title={mine ? "Edit" : "Mark up and copy"} onClick={() => { setPlaying(false); setEditing(true); }} className={btn}>
                  <SlidersHorizontal className="h-5 w-5" />
                </button>
              )}
              <button type="button" aria-label="Send to…" title="Send to a room or person" onClick={() => { setPlaying(false); setSending(true); }} className={wide}>
                <Send className="h-5 w-5" />
              </button>
              {links?.original && (
                <a href={links.original} download aria-label="Download" title="Download" className={wide}>
                  <Download className="h-5 w-5" />
                </a>
              )}
              {photo.edited && (
                <button type="button" aria-label="Download edited" title="Download the edited photo" className={wide} onClick={downloadEdited}>
                  <ImageDown className="h-5 w-5" />
                </button>
              )}
              {/* Someone else's (family library, shared album): theirs to change. */}
              {mine && (
                <>
                  <button type="button" aria-label={photo.archived ? "Unarchive" : "Archive"} title={photo.archived ? "Unarchive (A)" : "Archive (A)"} onClick={() => void act("archive")} className={wide}>
                    {photo.archived ? <ArchiveRestore className="h-5 w-5" /> : <Archive className="h-5 w-5" />}
                  </button>
                  <button type="button" aria-label="Move to trash" title="Move to trash (Delete)" onClick={() => void act("trash")} className={btn}>
                    <Trash2 className="h-5 w-5" />
                  </button>
                </>
              )}
              <button
                ref={menuButton}
                type="button"
                aria-label="More"
                title="More"
                aria-haspopup="menu"
                aria-expanded={menu}
                onClick={() => setMenu((v) => !v)}
                className={cn(btn, "sm:hidden")}
              >
                <MoreHorizontal className="h-5 w-5" />
              </button>
              <PopMenu open={menu} anchor={menuButton} onClose={() => setMenu(false)} label="More" dark>
                <PopMenuItem dark icon={<Send className="h-4 w-4" />} onSelect={() => { setMenu(false); setPlaying(false); setSending(true); }}>
                  Send to…
                </PopMenuItem>
                {links?.original && (
                  <PopMenuItem dark icon={<Download className="h-4 w-4" />} onSelect={() => { setMenu(false); download(); }}>
                    Download
                  </PopMenuItem>
                )}
                {photo.edited && (
                  <PopMenuItem dark icon={<ImageDown className="h-4 w-4" />} onSelect={() => { setMenu(false); downloadEdited(); }}>
                    Download edited
                  </PopMenuItem>
                )}
                {mine && (
                  <PopMenuItem
                    dark
                    icon={photo.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                    onSelect={() => { setMenu(false); void act("archive"); }}
                  >
                    {photo.archived ? "Unarchive" : "Archive"}
                  </PopMenuItem>
                )}
              </PopMenu>
            </div>
          </div>

          {index > 0 && (
            <button type="button" aria-label="Previous" title="Previous (←)" onClick={() => step(-1)} className="pointer-events-auto absolute left-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60 sm:block">
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}
          {!(ended && index >= items.length - 1) && (
            <button type="button" aria-label="Next" title="Next (→)" onClick={() => step(1)} className="pointer-events-auto absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60 sm:block">
              <ChevronRight className="h-6 w-6" />
            </button>
          )}

          {undo && (
            <div className="absolute inset-x-0 bottom-6 z-20 flex justify-center px-4">
              <div key={undo.key} role="status" className="photos-bar-in pointer-events-auto flex items-center gap-1 rounded-full bg-neutral-800/95 py-1 pl-4 pr-1 text-sm text-white shadow-xl ring-1 ring-white/10">
                <span className="min-w-0 truncate">{undo.text}</span>
                <button
                  type="button"
                  className="flex min-h-10 items-center rounded-full px-3 font-semibold text-[var(--accent)] hover:bg-white/10"
                  onClick={() => {
                    const u = undo;
                    setUndo(null);
                    void u.run().catch((e) => toast.error(apiErrorMessage(e, "Couldn't undo that.")));
                  }}
                >
                  Undo
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {info && <InfoPanel photo={photo} onClose={() => setInfo(false)} />}
      <Sheet
        open={!!trashWarn}
        onClose={() => setTrashWarn(null)}
        title="Move this photo to the trash?"
        size="sm"
        footer={
          <>
            <ItemButton variant="secondary" data-autofocus onClick={() => setTrashWarn(null)}>
              Cancel
            </ItemButton>
            <ItemButton
              variant="danger"
              onClick={() => {
                setTrashWarn(null);
                void act("trash", true);
              }}
            >
              Move to trash
            </ItemButton>
          </>
        }
      >
        <p className="text-sm text-[var(--text)]">{trashWarn}</p>
      </Sheet>
      <SendToSheet
        open={sending}
        onClose={() => setSending(false)}
        target={{ kind: "photo", id: photo.id, title: photo.filename }}
        canGrant={mine}
      />
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
          onSavedAsNew={(item) => {
            setEditing(false);
            // The new photo, right after the original.
            if (item) {
              setItems((cur) => {
                const at = cur.findIndex((p) => p.id === photo.id);
                return [...cur.slice(0, at + 1), item, ...cur.slice(at + 1).filter((p) => p.id !== item.id)];
              });
              setIndex((i) => i + 1);
            }
            onChanged();
          }}
        />
      )}
    </div>,
    document.body,
  );
}

/** The photo before or after, waiting just off the edge for a swipe. */
function Peek({ photo, side }: { photo: PhotoItem; side: 1 | -1 }) {
  const { data: links } = useLinks(photo.id);
  const src = (photo.kind === "image" ? links?.preview : links?.poster) ?? photo.thumb;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
      style={{ transform: `translate3d(calc(${side * 100}% + ${side * GAP}px), 0, 0)` }}
    >
      {src ? <img src={src} alt="" draggable={false} className="max-h-full max-w-full object-contain" /> : null}
    </div>
  );
}

type Gesture = {
  dist: number;
  scale: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
  pinch: boolean;
  axis: "x" | "y" | "none" | null;
  at: number;
};

/** One photo or video, zoomable; a drag on it is handed up to the viewer. */
function Stage({
  photo,
  onDrag,
  onRelease,
}: {
  photo: PhotoItem;
  onDrag: (axis: "x" | "y", d: number) => void;
  /** ``flick``: a quick, short swipe. */
  onRelease: (axis: "x" | "y", d: number, flick: boolean) => void;
}) {
  const { data: links } = useLinks(photo.id, photo.kind === "video");
  const placeholder = blur(photo.thumbhash);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const box = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
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

  /** The drag is over (or became a pinch): let the viewer settle. */
  const letGo = (g: Gesture | null, d = 0, flick = false) => {
    if (g && (g.axis === "x" || g.axis === "y")) onRelease(g.axis, d, flick);
    if (g) g.axis = "none";
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
        // A second finger: whatever the first was dragging goes back.
        if (pts.length === 2) letGo(gesture.current);
        gesture.current = {
          dist: pts.length === 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
          scale: view.scale,
          startX: e.clientX,
          startY: e.clientY,
          x: view.x,
          y: view.y,
          moved: false,
          pinch: pts.length === 2,
          axis: pts.length === 2 ? "none" : null,
          at: performance.now(),
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
        if (g.pinch) return;
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;
        if (Math.hypot(dx, dy) > 6) g.moved = true;
        if (zoomed) {
          setView((v) => ({ ...v, x: g.x + dx, y: g.y + dy }));
          return;
        }
        // Across moves on; down closes (a phone gesture). The first few
        // pixels decide which, and it stays that way.
        if (!g.axis && Math.hypot(dx, dy) > 8) {
          g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : dy > 0 && e.pointerType === "touch" ? "y" : "none";
        }
        if (g.axis === "x") onDrag("x", dx);
        else if (g.axis === "y") onDrag("y", Math.max(0, dy));
      }}
      onPointerUp={(e) => {
        const g = gesture.current;
        const wasPinch = pointers.current.size > 1;
        pointers.current.delete(e.pointerId);
        if (!g) return;
        if (wasPinch || g.pinch || zoomed) {
          letGo(g);
          if (!pointers.current.size) gesture.current = null;
          return;
        }
        const d = g.axis === "x" ? e.clientX - g.startX : Math.max(0, e.clientY - g.startY);
        letGo(g, d, performance.now() - g.at < 250);
        gesture.current = null;
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        letGo(gesture.current);
        if (!pointers.current.size) gesture.current = null;
      }}
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
          "absolute bottom-6 left-4 rounded-full border border-white/70 px-2.5 py-1 text-xs font-semibold tracking-wide text-white backdrop-blur",
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
      <LinkedSection thing={{ kind: "photo", id: photo.id }} className="mt-4" />
    </aside>
  );
}
