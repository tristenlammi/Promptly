import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PhotoBucket } from "@/api/photos";

/** Where in the timeline: a month, and how far through it (0 to 1). */
export interface TimelinePosition {
  index: number;
  within: number;
}

const YEAR_ROOM = 20; // px a year's label needs
const LABEL_GAP = 16; // labels closer than this would touch
const IDLE_MS = 900; // the month label stays this long after scrolling stops

/**
 * Where each month sits on the rail, from 0 to 1, with a final 1 closing the
 * last month. Every year gets room for its label first; what's left goes by
 * photo count, so a busy year is easier to drag through without a quiet one
 * being squeezed to nothing.
 */
export function railLayout(months: PhotoBucket[], height: number): number[] {
  if (!months.length || height <= 0) return [0, 1];
  const total = months.reduce((a, b) => a + b.count, 0) || 1;
  const weight = (b: PhotoBucket) => (b.count / total) * 0.85 + 0.15 / months.length;

  const years = new Map<string, PhotoBucket[]>();
  for (const b of months) {
    const y = b.month.slice(0, 4);
    years.set(y, [...(years.get(y) ?? []), b]);
  }
  const room = Math.min(YEAR_ROOM, (height * 0.7) / years.size);
  const spare = height - room * years.size;

  const tops: number[] = [];
  let y = 0;
  for (const list of years.values()) {
    const share = list.reduce((a, b) => a + weight(b), 0);
    const yearHeight = room + spare * share;
    let inYear = 0;
    for (const b of list) {
      tops.push((y + yearHeight * inYear) / height);
      inYear += weight(b) / share;
    }
    y += yearHeight;
  }
  tops.push(1);
  return tops;
}

/** The first month of each year, leaving out labels that would collide. */
export function yearLabels(months: PhotoBucket[], tops: number[], height: number): { year: string; top: number }[] {
  const out: { year: string; top: number }[] = [];
  let last = -Infinity;
  let year = "";
  months.forEach((b, i) => {
    const y = b.month.slice(0, 4);
    if (y === year) return;
    year = y;
    const px = tops[i] * height;
    if (px - last >= LABEL_GAP && px <= height - 12) {
      out.push({ year: y, top: px });
      last = px;
    }
  });
  return out;
}

/** Years down the right edge, with a marker for where you are. Drag or click to
 *  move, or use the arrow keys. It replaces the browser's own scrollbar here. */
export function TimelineScrubber({
  months,
  scroller,
  label,
  position,
  onSeek,
}: {
  months: PhotoBucket[];
  scroller: React.RefObject<HTMLElement | null>;
  label: (month: string) => string;
  position: () => TimelinePosition;
  onSeek: (at: TimelinePosition) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [pos, setPos] = useState<TimelinePosition>({ index: 0, within: 0 });
  const [hover, setHover] = useState<TimelinePosition | null>(null);
  const [dragging, setDragging] = useState(false);
  const [moving, setMoving] = useState(false);
  // The month the arrow keys are on: the last months can't all reach the top of
  // the screen, so the scroll position alone would stop them short.
  const [keyed, setKeyed] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setHeight(e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tops = useMemo(() => railLayout(months, height), [months, height]);
  const labels = useMemo(() => yearLabels(months, tops, height), [months, tops, height]);

  // Follow the page, at most once a frame.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    let idle: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      setMoving(true);
      clearTimeout(idle);
      idle = setTimeout(() => setMoving(false), IDLE_MS);
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          setPos(position());
        });
      }
    };
    setPos(position());
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      clearTimeout(idle);
    };
  }, [scroller, position, months]);

  const at = useCallback(
    (clientY: number): TimelinePosition => {
      const rect = ref.current!.getBoundingClientRect();
      const f = Math.min(Math.max((clientY - rect.top) / (rect.height || 1), 0), 0.9999);
      let index = 0;
      while (index + 1 < months.length && tops[index + 1] <= f) index++;
      const span = tops[index + 1] - tops[index] || 1;
      return { index, within: Math.min(Math.max((f - tops[index]) / span, 0), 1) };
    },
    [months.length, tops],
  );

  // A drag asks for one move a frame, however fast the pointer goes.
  const pending = useRef<TimelinePosition | null>(null);
  const frame = useRef(0);
  const seekSoon = (to: TimelinePosition) => {
    pending.current = to;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (pending.current) onSeek(pending.current);
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const fraction = (p: TimelinePosition) => {
    const start = tops[p.index] ?? 0;
    return start + p.within * ((tops[p.index + 1] ?? 1) - start);
  };

  const current = keyed ?? pos.index;
  const marker = dragging && hover ? hover : keyed !== null ? { index: keyed, within: 0 } : pos;
  const shown = hover ?? (moving ? marker : null);
  const stepTo = (index: number) => {
    const i = Math.min(Math.max(index, 0), months.length - 1);
    setKeyed(i);
    onSeek({ index: i, within: 0 });
  };

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="Jump to a date"
      aria-valuemin={0}
      aria-valuemax={months.length - 1}
      aria-valuenow={current}
      aria-valuetext={months[current] ? label(months[current].month) : undefined}
      className="group absolute bottom-2 right-0 top-2 w-10 cursor-ns-resize touch-none select-none rounded-l-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const to = at(e.clientY);
        setKeyed(null);
        setDragging(true);
        setHover(to);
        onSeek(to);
      }}
      onPointerMove={(e) => {
        const to = at(e.clientY);
        setHover(to);
        if (dragging) seekSoon(to);
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onPointerLeave={() => {
        if (!dragging) setHover(null);
      }}
      // The rail sits over the page: the wheel should still scroll it.
      onWheel={(e) => {
        setKeyed(null);
        scroller.current?.scrollBy({ top: e.deltaY });
      }}
      onKeyDown={(e) => {
        const to =
          e.key === "ArrowDown" ? current + 1
          : e.key === "ArrowUp" ? current - 1
          : e.key === "PageDown" ? current + 12
          : e.key === "PageUp" ? current - 12
          : e.key === "Home" ? 0
          : e.key === "End" ? months.length - 1
          : null;
        if (to === null) return;
        e.preventDefault();
        stepTo(to);
      }}
    >
      {labels.map((y) => (
        <span
          key={y.year}
          className="pointer-events-none absolute right-1.5 text-[10px] font-medium leading-3 text-[var(--text-muted)] group-hover:text-[var(--text)]"
          style={{ top: y.top }}
        >
          {y.year}
        </span>
      ))}
      <span
        data-scrubber-marker
        className="pointer-events-none absolute right-0 h-0.5 w-6 -translate-y-1/2 rounded-full bg-[var(--accent)]"
        style={{ top: `${fraction(marker) * 100}%` }}
      />
      {shown && months[shown.index] && (
        <span
          className="pointer-events-none absolute right-11 -translate-y-1/2 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs font-medium text-[var(--text)] shadow"
          style={{ top: `${fraction(shown) * 100}%` }}
        >
          {label(months[shown.index].month)}
        </span>
      )}
    </div>
  );
}
