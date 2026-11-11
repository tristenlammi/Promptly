import { ArrowDown, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/utils/cn";

const TRIGGER = 64;
const MAX = 96;

/**
 * Pull to refresh on a phone: drag the page down from its very top and let
 * go. Returns how far it's pulled (px) and whether it's refreshing, for
 * ``PullIndicator`` to draw.
 */
export function usePullToRefresh(scroller: HTMLElement | null, onRefresh: () => Promise<unknown>, enabled: boolean): { pull: number; refreshing: boolean } {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const run = useRef(onRefresh);
  run.current = onRefresh;
  const busy = useRef(false);

  useEffect(() => {
    if (!scroller || !enabled) return;
    let startY: number | null = null;
    let startX = 0;
    let dist = 0;
    const start = (e: TouchEvent) => {
      startY = scroller.scrollTop <= 0 && e.touches.length === 1 && !busy.current ? e.touches[0].clientY : null;
      startX = e.touches[0]?.clientX ?? 0;
      dist = 0;
    };
    const move = (e: TouchEvent) => {
      if (startY === null) return;
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;
      // Scrolled away, or a sideways swipe (the stories row, a carousel): not a pull.
      if (scroller.scrollTop > 0 || (dist === 0 && Math.abs(dx) > Math.abs(dy))) {
        startY = null;
        dist = 0;
        setPull(0);
        return;
      }
      dist = dy > 0 ? Math.min(MAX, dy * 0.5) : 0;
      setPull(dist);
    };
    const end = () => {
      if (startY === null) return;
      startY = null;
      const go = dist >= TRIGGER;
      dist = 0;
      setPull(0);
      if (!go) return;
      busy.current = true;
      setRefreshing(true);
      void Promise.resolve()
        .then(() => run.current())
        .catch(() => undefined)
        .finally(() => {
          busy.current = false;
          setRefreshing(false);
        });
    };
    scroller.addEventListener("touchstart", start, { passive: true });
    scroller.addEventListener("touchmove", move, { passive: true });
    scroller.addEventListener("touchend", end);
    scroller.addEventListener("touchcancel", end);
    return () => {
      scroller.removeEventListener("touchstart", start);
      scroller.removeEventListener("touchmove", move);
      scroller.removeEventListener("touchend", end);
      scroller.removeEventListener("touchcancel", end);
    };
  }, [scroller, enabled]);

  return { pull, refreshing };
}

/** The strip that opens at the top of the page as you pull. */
export function PullIndicator({ pull, refreshing }: { pull: number; refreshing: boolean }) {
  const ready = pull >= TRIGGER;
  const height = refreshing ? 48 : pull;
  return (
    <div
      aria-hidden={!refreshing}
      role={refreshing ? "status" : undefined}
      className={cn("flex items-end justify-center overflow-hidden text-xs text-[var(--text-muted)]", pull === 0 && "transition-[height] duration-200 motion-reduce:transition-none")}
      style={{ height }}
    >
      {(refreshing || pull > 8) && (
        <span className="flex h-12 items-center gap-2">
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--accent-text)] motion-reduce:animate-none" aria-hidden />
          ) : (
            <ArrowDown className={cn("h-4 w-4 transition-transform duration-150 motion-reduce:transition-none", ready && "rotate-180 text-[var(--accent-text)]")} aria-hidden />
          )}
          {refreshing ? "Refreshing…" : ready ? "Let go to refresh" : "Pull to refresh"}
        </span>
      )}
    </div>
  );
}
