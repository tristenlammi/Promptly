import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Heart, Play } from "lucide-react";
import { thumbHashToDataURL } from "thumbhash";

import type { PhotoItem } from "@/api/photos";
import { cn } from "@/utils/cn";

import "./photos.css";

/** One photo in a grid (WP-9.2): the blur until its tile arrives, video
 *  length / LIVE / favourite badges, and selection (tick, Shift, a long
 *  press on a phone). Photos and albums share it. */

function placeholder(hash: string | null): string | undefined {
  if (!hash) return undefined;
  try {
    return thumbHashToDataURL(Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

function duration(ms: number | null): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function PhotoTile({
  photo,
  width,
  height,
  selected = false,
  selecting = false,
  onToggle,
  onOpen,
}: {
  photo: PhotoItem;
  width: number;
  height: number;
  selected?: boolean;
  selecting?: boolean;
  /** Leave it out where photos can't be picked: no tick, a tap just opens. */
  onToggle?: (p: PhotoItem, range: boolean) => void;
  onOpen: (p: PhotoItem) => void;
}) {
  const blur = useMemo(() => placeholder(photo.thumbhash), [photo.thumbhash]);
  const [loaded, setLoaded] = useState(false);
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  // The heart pops when you favourite it, not every time the tile scrolls in.
  const wasFavorite = useRef(photo.favorite);
  const [pop, setPop] = useState(false);
  useEffect(() => {
    if (photo.favorite && !wasFavorite.current) setPop(true);
    if (!photo.favorite) setPop(false);
    wasFavorite.current = photo.favorite;
  }, [photo.favorite]);

  const label = `${photo.kind === "video" ? "Video" : "Photo"}, ${new Date(photo.taken_local).toLocaleString()}`;
  // A plain frame holding two buttons side by side — open (the picture)
  // and select (the tick) — never one inside the other (PH-7 a11y).
  return (
    <div
      data-photo={photo.id}
      className={cn(
        "group relative shrink-0 overflow-hidden rounded-sm",
        selected ? "bg-[var(--accent-soft)]" : "bg-[var(--hover)]",
      )}
      style={{
        width,
        height,
        // The blur until the tile arrives; a plain mat around a selected one.
        backgroundImage: blur && !selected ? `url(${blur})` : undefined,
        backgroundSize: "cover",
      }}
    >
      <button
        type="button"
        aria-label={label}
        aria-pressed={selecting ? selected : undefined}
        className="absolute inset-0 block h-full w-full cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
        onClick={(e) => {
          if (press.current?.fired) {
            press.current = null;
            return;
          }
          if (onToggle && (selecting || e.shiftKey || e.metaKey || e.ctrlKey)) onToggle(photo, e.shiftKey);
          else onOpen(photo);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onOpen(photo);
          }
          if (e.key === " " && onToggle) {
            e.preventDefault();
            onToggle(photo, e.shiftKey);
          }
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== "touch" || !onToggle) return;
          const start = { x: e.clientX, y: e.clientY };
          const timer = window.setTimeout(() => {
            if (press.current) press.current.fired = true;
            onToggle(photo, false);
            navigator.vibrate?.(10);
          }, 450);
          press.current = { timer, ...start, fired: false };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) {
            window.clearTimeout(p.timer);
            press.current = null;
          }
        }}
        onPointerUp={() => press.current && !press.current.fired && window.clearTimeout(press.current.timer)}
        onContextMenu={(e) => press.current?.fired && e.preventDefault()}
      >
        {photo.thumb && (
          <img
            src={photo.thumb}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setLoaded(true)}
            className={cn(
              "h-full w-full object-cover transition-[opacity,transform] duration-200",
              loaded ? "opacity-100" : "opacity-0",
              selected && "scale-[0.88] rounded-md",
            )}
          />
        )}
      </button>
      {photo.kind === "video" && (
        <span className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded bg-black/55 px-1 py-0.5 text-xs font-medium leading-none text-white">
          <Play className="h-3 w-3 fill-current" />
          {duration(photo.duration_ms)}
        </span>
      )}
      {photo.live && (
        <span className="pointer-events-none absolute right-1.5 top-1.5 rounded bg-black/55 px-1 py-0.5 text-xs font-semibold leading-none tracking-wide text-white">
          LIVE
        </span>
      )}
      {photo.favorite && (
        <Heart
          className={cn("pointer-events-none absolute bottom-1.5 left-1.5 h-4 w-4 fill-white text-white drop-shadow", pop && "photos-heart-pop")}
          aria-label="Favourite"
        />
      )}
      {onToggle && <button
        type="button"
        aria-label={selected ? "Deselect" : "Select"}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(photo, e.shiftKey);
        }}
        // A 40px corner to hit, around a smaller circle to look at.
        className={cn(
          "group/tick absolute left-0 top-0 z-10 flex h-10 w-10 items-start justify-start p-1.5 outline-none",
          !selecting && "photos-tick-idle",
        )}
      >
        <span
          className={cn(
            "flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 transition",
            selected
              ? "border-[var(--accent)] bg-[var(--accent-strong)] text-white opacity-100"
              : "border-white/90 bg-black/25 text-transparent opacity-0 group-hover:opacity-100 group-hover/tick:bg-black/45 group-hover/tick:text-white",
            selecting && !selected && "opacity-100",
          )}
        >
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </span>
      </button>}
    </div>
  );
}
