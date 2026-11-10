import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

import type { PorchMedia } from "@/api/porch";
import { cn } from "@/utils/cn";

interface View {
  s: number;
  x: number;
  y: number;
}

const REST: View = { s: 1, x: 0, y: 0 };
const MAX = 5;

/**
 * A post's photos, full screen: pinch, double-tap or the mouse wheel to zoom,
 * drag to move around, swipe (or the arrows) for the next one, swipe down or
 * Esc to close. Started from the Rooms lightbox, with zoom added.
 */
export function PhotoLightbox({
  photos,
  index,
  onIndex,
  onClose,
}: {
  photos: PorchMedia[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const m = photos[index];
  const n = photos.length;
  const [view, setView] = useState<View>(REST);
  // A swipe at rest: sideways for the next photo, down to close.
  const [pull, setPull] = useState({ x: 0, y: 0 });
  const [moving, setMoving] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const g = useRef<{
    kind: "pan" | "pinch" | "swipe";
    from: View;
    start: { x: number; y: number };
    dist: number;
    moved: boolean;
    onPhoto: boolean;
  } | null>(null);
  const lastTap = useRef(0);

  // The sharp one loads behind the preview already on screen.
  const [sharp, setSharp] = useState<string | null>(null);
  useEffect(() => {
    setSharp(null);
    setView(REST);
    setPull({ x: 0, y: 0 });
    const full = m?.full;
    if (!full) return;
    let off = false;
    const img = new Image();
    img.onload = () => {
      if (!off) setSharp(full);
    };
    img.src = full;
    return () => {
      off = true;
    };
  }, [m?.id, m?.full]);

  const go = useCallback(
    (i: number) => {
      if (i >= 0 && i < n) onIndex(i);
    },
    [n, onIndex],
  );

  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    return () => back?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowLeft") go(index - 1);
      else if (e.key === "ArrowRight") go(index + 1);
      else if (e.key === "+" || e.key === "=") setView((v) => clamp({ ...v, s: v.s * 1.5 }, stage.current));
      else if (e.key === "-") setView((v) => clamp({ ...v, s: v.s / 1.5 }, stage.current));
      else if (e.key === "Tab") {
        // Keep the keyboard inside the photo view.
        const items = Array.from(stage.current?.parentElement?.querySelectorAll<HTMLElement>("button, a[href]") ?? []);
        if (!items.length) return;
        const at = items.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [index, go, onClose]);

  if (!m) return null;

  /** A point on screen, measured from the middle of the stage. */
  const fromCentre = (p: { x: number; y: number }) => {
    const r = stage.current?.getBoundingClientRect();
    return r ? { x: p.x - r.left - r.width / 2, y: p.y - r.top - r.height / 2 } : p;
  };
  /** Zoom to ``s`` keeping the point under the finger where it is. */
  const zoomAt = (from: View, s: number, was: { x: number; y: number }, now = was): View => {
    const k = s / from.s;
    return clamp({ s, x: now.x - (was.x - from.x) * k, y: now.y - (was.y - from.y) * k }, stage.current);
  };
  const two = () => {
    const [a, b] = Array.from(pts.current.values());
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: fromCentre({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) };
  };

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, a")) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const onPhoto = (e.target as HTMLElement).tagName === "IMG";
    setMoving(true);
    if (pts.current.size === 2) {
      const t = two();
      g.current = { kind: "pinch", from: viewRef.current, start: t.mid, dist: t.dist, moved: true, onPhoto };
    } else if (pts.current.size === 1) {
      g.current = { kind: viewRef.current.s > 1 ? "pan" : "swipe", from: viewRef.current, start: { x: e.clientX, y: e.clientY }, dist: 1, moved: false, onPhoto };
    }
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const cur = g.current;
    if (!cur || !pts.current.has(e.pointerId)) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (cur.kind === "pinch" && pts.current.size >= 2) {
      const t = two();
      const s = Math.max(1, Math.min(MAX, (cur.from.s * t.dist) / cur.dist));
      setView(zoomAt(cur.from, s, cur.start, t.mid));
      return;
    }
    const dx = e.clientX - cur.start.x;
    const dy = e.clientY - cur.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 8) cur.moved = true;
    if (!cur.moved) return;
    if (cur.kind === "pan") setView(clamp({ s: cur.from.s, x: cur.from.x + dx, y: cur.from.y + dy }, stage.current));
    else if (cur.kind === "swipe") {
      // One direction at a time, and no dragging past the first or last photo.
      if (Math.abs(dx) > Math.abs(dy)) setPull({ x: (dx > 0 && index === 0) || (dx < 0 && index === n - 1) ? dx / 4 : dx, y: 0 });
      else setPull({ x: 0, y: Math.max(0, dy) });
    }
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const cur = g.current;
    if (!pts.current.delete(e.pointerId) || !cur) return;
    if (pts.current.size === 1) {
      // One finger of a pinch lifted: carry on moving the photo with the other.
      const [p] = Array.from(pts.current.values());
      g.current = { kind: "pan", from: viewRef.current, start: p, dist: 1, moved: true, onPhoto: cur.onPhoto };
      return;
    }
    if (pts.current.size > 0) return;
    g.current = null;
    setMoving(false);
    if (viewRef.current.s < 1.05) setView(REST);
    if (cur.kind === "swipe" && cur.moved) {
      const dx = e.clientX - cur.start.x;
      const dy = e.clientY - cur.start.y;
      setPull({ x: 0, y: 0 });
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 60) go(index + (dx < 0 ? 1 : -1));
      else if (dy > 110 && dy > Math.abs(dx)) onClose();
      return;
    }
    if (cur.moved) return;
    // A tap: twice on the photo zooms in or back out; beside it closes.
    if (!cur.onPhoto) {
      onClose();
      return;
    }
    const now = Date.now();
    if (now - lastTap.current < 320) {
      lastTap.current = 0;
      const at = fromCentre({ x: e.clientX, y: e.clientY });
      setView((v) => (v.s > 1 ? REST : zoomAt(v, 2.5, at)));
    } else lastTap.current = now;
  };

  const src = sharp ?? m.preview ?? m.full ?? m.thumb ?? undefined;
  const tagged = (m.tags ?? []).filter((t) => t.status === "approved").map((t) => t.user.name);
  const alt = (m.alt_text || (n > 1 ? `Photo ${index + 1} of ${n}` : "Photo")) + (tagged.length ? `. With ${tagged.join(", ")}.` : "");
  const btn =
    "flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";
  const fade = Math.max(0.35, 1 - pull.y / 400);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={n > 1 ? `Photo ${index + 1} of ${n}` : "Photo"}
      className="porch-lightbox fixed inset-0 z-[90] flex flex-col"
      style={{ background: `rgba(0,0,0,${0.92 * fade})` }}
    >
      <div className="flex items-center justify-between gap-2 p-3 pt-safe">
        <span className="px-1 text-sm tabular-nums text-white/80" aria-hidden>
          {n > 1 ? `${index + 1} of ${n}` : ""}
        </span>
        <div className="flex gap-2">
          {m.full && (
            <a href={m.full} download aria-label="Save this photo" title="Save" className={btn}>
              <Download className="h-5 w-5" aria-hidden />
            </a>
          )}
          <button ref={closeBtn} type="button" aria-label="Close" onClick={onClose} className={btn}>
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </div>
      <div
        ref={stage}
        className="relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden pb-safe"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onWheel={(e) => {
          const at = fromCentre({ x: e.clientX, y: e.clientY });
          setView((v) => zoomAt(v, Math.max(1, Math.min(MAX, v.s * Math.exp(-e.deltaY * 0.002))), at));
        }}
      >
        {src ? (
          <img
            key={m.id}
            src={src}
            alt={alt}
            draggable={false}
            className={cn("max-h-full max-w-full object-contain", !moving && "transition-transform duration-200 ease-out motion-reduce:transition-none", view.s > 1 ? "cursor-grab" : "cursor-zoom-in")}
            style={{ transform: `translate3d(${view.x + pull.x}px, ${view.y + pull.y}px, 0) scale(${view.s})` }}
          />
        ) : (
          <p className="text-sm text-white/80">This photo is still being prepared.</p>
        )}
        {index > 0 && (
          <button type="button" aria-label="Previous photo" onClick={() => go(index - 1)} className={cn(btn, "absolute left-3 top-1/2 hidden -translate-y-1/2 md:flex")}>
            <ChevronLeft className="h-6 w-6" aria-hidden />
          </button>
        )}
        {index < n - 1 && (
          <button type="button" aria-label="Next photo" onClick={() => go(index + 1)} className={cn(btn, "absolute right-3 top-1/2 hidden -translate-y-1/2 md:flex")}>
            <ChevronRight className="h-6 w-6" aria-hidden />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Keep the zoom in range and the photo from being dragged off the screen. */
function clamp(v: View, stage: HTMLElement | null): View {
  const s = Math.max(1, Math.min(MAX, v.s));
  if (s === 1) return REST;
  const w = stage?.clientWidth ?? window.innerWidth;
  const h = stage?.clientHeight ?? window.innerHeight;
  const mx = ((s - 1) * w) / 2;
  const my = ((s - 1) * h) / 2;
  return { s, x: Math.max(-mx, Math.min(mx, v.x)), y: Math.max(-my, Math.min(my, v.y)) };
}
