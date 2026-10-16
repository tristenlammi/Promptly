import { useMemo, useRef, useState } from "react";
import { Check, Heart, Play } from "lucide-react";
import { thumbHashToDataURL } from "thumbhash";

import type { PhotoItem } from "@/api/photos";
import { cn } from "@/utils/cn";

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
  selected,
  selecting,
  onToggle,
  onOpen,
}: {
  photo: PhotoItem;
  width: number;
  height: number;
  selected: boolean;
  selecting: boolean;
  onToggle: (p: PhotoItem, range: boolean) => void;
  onOpen: (p: PhotoItem) => void;
}) {
  const blur = useMemo(() => placeholder(photo.thumbhash), [photo.thumbhash]);
  const [loaded, setLoaded] = useState(false);
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);

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
          if (selecting || e.shiftKey || e.metaKey || e.ctrlKey) onToggle(photo, e.shiftKey);
          else onOpen(photo);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onOpen(photo);
          }
          if (e.key === " ") {
            e.preventDefault();
            onToggle(photo, e.shiftKey);
          }
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== "touch") return;
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
        <span className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded bg-black/55 px-1 py-0.5 text-[10px] font-medium text-white">
          <Play className="h-2.5 w-2.5 fill-current" />
          {duration(photo.duration_ms)}
        </span>
      )}
      {photo.live && (
        <span className="pointer-events-none absolute right-1.5 top-1.5 rounded bg-black/55 px-1 py-0.5 text-[9px] font-semibold tracking-wide text-white">
          LIVE
        </span>
      )}
      {photo.favorite && (
        <Heart className="pointer-events-none absolute bottom-1.5 left-1.5 h-3.5 w-3.5 fill-white text-white drop-shadow" aria-label="Favourite" />
      )}
      <button
        type="button"
        aria-label={selected ? "Deselect" : "Select"}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(photo, e.shiftKey);
        }}
        className={cn(
          "absolute left-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border transition",
          selected
            ? "border-[var(--accent)] bg-[var(--accent)] text-white opacity-100"
            : "border-white/90 bg-black/20 text-transparent opacity-0 group-hover:opacity-100",
          selecting && !selected && "opacity-100",
        )}
      >
        <Check className="h-3 w-3" />
      </button>
    </div>
  );
}
