import { useEffect, useRef, useState, type ReactNode } from "react";

const MAX_SCALE = 8;

/**
 * A zoomable, swipeable stage for a picture in the Files preview. The
 * gestures are the Photos viewer's (components/photos/PhotoViewer.tsx,
 * copied here so Files does not reach into Photos): wheel, pinch or
 * double-click to zoom, drag to pan while zoomed, swipe across for the
 * next or last file, and on a phone swipe down to close.
 */
export function ZoomStage({
  children,
  onSwipe,
  onClose,
  onZoomChange,
}: {
  children: ReactNode;
  /** 1 = next, -1 = previous. */
  onSwipe?: (dir: 1 | -1) => void;
  onClose?: () => void;
  onZoomChange?: (zoomed: boolean) => void;
}) {
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    dist: number;
    scale: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    pinched: boolean;
  } | null>(null);
  const zoomed = view.scale > 1.01;

  const zoomChanged = useRef(onZoomChange);
  zoomChanged.current = onZoomChange;
  useEffect(() => {
    zoomChanged.current?.(zoomed);
  }, [zoomed]);

  const zoomAt = (clientX: number, clientY: number, next: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
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
      className={
        "absolute inset-0 flex touch-none select-none items-center justify-center overflow-hidden " +
        (zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in")
      }
      onWheel={(e) => zoomAt(e.clientX, e.clientY, view.scale * Math.exp(-e.deltaY * 0.0025))}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a")) return;
        zoomAt(e.clientX, e.clientY, zoomed ? 1 : 2.5);
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button, a")) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const pts = [...pointers.current.values()];
        gesture.current = {
          dist: pts.length === 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
          scale: view.scale,
          startX: e.clientX,
          startY: e.clientY,
          x: view.x,
          y: view.y,
          pinched: pts.length > 1 || (gesture.current?.pinched ?? false),
        };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const g = gesture.current;
        if (!pointers.current.has(e.pointerId) || !g) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const pts = [...pointers.current.values()];
        if (pts.length === 2 && g.dist > 0) {
          const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          zoomAt((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, (g.scale * d) / g.dist);
          return;
        }
        if (zoomed && pts.length === 1 && !g.pinched) {
          setView((v) => ({ ...v, x: g.x + e.clientX - g.startX, y: g.y + e.clientY - g.startY }));
        }
      }}
      onPointerUp={(e) => {
        const g = gesture.current;
        pointers.current.delete(e.pointerId);
        if (pointers.current.size > 0) return;
        gesture.current = null;
        setDragging(false);
        if (!g || g.pinched || zoomed) return;
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;
        // A swipe across moves on; a swipe down closes (a phone gesture).
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) onSwipe?.(dx < 0 ? 1 : -1);
        else if (dy > 120 && Math.abs(dy) > Math.abs(dx) && e.pointerType === "touch") onClose?.();
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        if (pointers.current.size === 0) {
          gesture.current = null;
          setDragging(false);
        }
      }}
    >
      <div
        className="flex h-full w-full items-center justify-center p-2 md:p-4"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          transition: dragging ? "none" : "transform 120ms ease-out",
        }}
      >
        {children}
      </div>
    </div>
  );
}
