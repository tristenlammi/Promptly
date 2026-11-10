import { CalendarClock, Check } from "lucide-react";
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { cn } from "@/utils/cn";

/*
 * Swipe a task row with a finger: right ticks it off, left offers another
 * day. Touch (and pen) only — a mouse gets the row's hover button instead.
 * Up-and-down still scrolls the page (touch-action: pan-y); the swipe only
 * takes over once the finger has clearly gone sideways.
 */

const SLOP = 10;

export function SwipeRow({ enabled, onDone, onLater, children }: { enabled: boolean; onDone: () => void; onLater: () => void; children: ReactNode }) {
  const [dx, setDx] = useState(0);
  const [active, setActive] = useState(false);
  const start = useRef<{ x: number; y: number; id: number; locked: boolean | null; width: number } | null>(null);
  const armed = useRef(0);
  const swallowClick = useRef(false);

  const threshold = (width: number) => Math.min(96, Math.max(64, width * 0.28));

  const reset = () => {
    start.current = null;
    armed.current = 0;
    setActive(false);
    setDx(0);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || e.pointerType === "mouse" || !e.isPrimary) return;
    // The reorder grip has its own drag.
    if ((e.target as HTMLElement).closest("[data-no-swipe]")) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, locked: null, width: e.currentTarget.offsetWidth };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (s.locked === null) {
      if (Math.abs(mx) < SLOP && Math.abs(my) < SLOP) return;
      s.locked = Math.abs(mx) > Math.abs(my) * 1.3;
      if (!s.locked) {
        start.current = null;
        return;
      }
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer is already gone */
      }
      setActive(true);
    }
    // Past the trigger point the row drags more slowly: it's "caught".
    const t = threshold(s.width);
    const over = Math.abs(mx) - t;
    const eased = over > 0 ? Math.sign(mx) * (t + over * 0.35) : mx;
    const side = mx > t ? 1 : mx < -t ? -1 : 0;
    if (side !== armed.current) {
      armed.current = side;
      if (side) {
        try {
          navigator.vibrate?.(8);
        } catch {
          /* not supported */
        }
      }
    }
    setDx(eased);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const side = s.locked ? armed.current : 0;
    if (s.locked) {
      // The finger lifting would otherwise count as a tap on the row.
      swallowClick.current = true;
      window.setTimeout(() => (swallowClick.current = false), 350);
    }
    reset();
    if (side > 0) onDone();
    else if (side < 0) onLater();
  };

  const side = armed.current;
  return (
    <div
      className={cn("tasks-swipe", active && "is-swiping")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={reset}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {active && dx > 0 && (
        <div className={cn("tasks-swipe-under justify-start bg-[var(--success)]", side > 0 && "is-armed")} aria-hidden>
          <Check className="h-5 w-5" strokeWidth={3} />
          <span>Done</span>
        </div>
      )}
      {active && dx < 0 && (
        <div className={cn("tasks-swipe-under justify-end bg-[var(--accent-strong,var(--accent))]", side < 0 && "is-armed")} aria-hidden>
          <span>Later</span>
          <CalendarClock className="h-5 w-5" />
        </div>
      )}
      <div className="tasks-swipe-content" style={dx ? { transform: `translateX(${dx}px)` } : undefined}>
        {children}
      </div>
    </div>
  );
}
