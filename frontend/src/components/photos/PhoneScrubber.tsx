import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ChevronsUpDown } from "lucide-react";

import type { PhotoBucket } from "@/api/photos";
import { cn } from "@/utils/cn";

import type { TimelinePosition } from "./TimelineScrubber";

const IDLE_MS = 1400; // the handle stays this long after scrolling stops
const HANDLE = 48; // px tall: an easy thing to catch with a thumb
const PAD = 8;

/**
 * The date scrubber for phones: a handle on the right edge that appears as
 * you scroll. Drag it to fly through the years; a bubble beside it says
 * which month you are at. (Big screens have the rail, TimelineScrubber.)
 */
export function PhoneScrubber({
  months,
  scroller,
  label,
  position,
}: {
  months: PhotoBucket[];
  scroller: RefObject<HTMLElement | null>;
  label: (month: string) => string;
  position: () => TimelinePosition;
}) {
  const [shown, setShown] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [top, setTop] = useState(PAD);
  const [text, setText] = useState("");
  const idle = useRef(0);
  const drag = useRef<{ grab: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const sync = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const room = el.scrollHeight - el.clientHeight;
    const travel = el.clientHeight - HANDLE - PAD * 2;
    setTop(PAD + (room > 0 ? el.scrollTop / room : 0) * Math.max(travel, 0));
    const at = months[position().index];
    if (at) setText(label(at.month));
  }, [scroller, months, position, label]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      sync();
      // Nothing to scrub through on a page that barely scrolls.
      if (el.scrollHeight < el.clientHeight * 2.5) return;
      setShown(true);
      window.clearTimeout(idle.current);
      idle.current = window.setTimeout(() => !drag.current && setShown(false), IDLE_MS);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.clearTimeout(idle.current);
    };
  }, [scroller, sync]);

  const moveTo = (clientY: number) => {
    const el = scroller.current;
    const rail = box.current?.getBoundingClientRect();
    if (!el || !rail || !drag.current) return;
    const travel = rail.height - HANDLE - PAD * 2;
    const f = Math.min(Math.max((clientY - rail.top - drag.current.grab - PAD) / Math.max(travel, 1), 0), 1);
    el.scrollTop = f * (el.scrollHeight - el.clientHeight);
  };

  return (
    <div ref={box} aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12">
      <div
        className={cn(
          "absolute right-0 flex items-center transition-opacity duration-200",
          shown || dragging ? "pointer-events-auto opacity-100" : "opacity-0",
        )}
        style={{ top, height: HANDLE }}
      >
        {text && (shown || dragging) && (
          <span
            className={cn(
              "pointer-events-none mr-2 whitespace-nowrap rounded-full bg-[var(--text)] px-3 py-1.5 text-xs font-medium text-[var(--bg)] shadow-lg transition-transform duration-150",
              dragging ? "scale-110" : "scale-100",
            )}
          >
            {text}
          </span>
        )}
        <div
          className="flex h-12 w-10 touch-none items-center justify-center"
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { grab: e.clientY - e.currentTarget.getBoundingClientRect().top };
            setDragging(true);
          }}
          onPointerMove={(e) => drag.current && moveTo(e.clientY)}
          onPointerUp={() => {
            drag.current = null;
            setDragging(false);
            window.clearTimeout(idle.current);
            idle.current = window.setTimeout(() => setShown(false), IDLE_MS);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
        >
          <span
            className={cn(
              "flex h-11 w-7 items-center justify-center rounded-l-full border border-r-0 border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] shadow-md",
              dragging && "bg-[var(--accent)] text-white",
            )}
            style={{ marginRight: -6 }}
          >
            <ChevronsUpDown className="h-4 w-4" />
          </span>
        </div>
      </div>
    </div>
  );
}
