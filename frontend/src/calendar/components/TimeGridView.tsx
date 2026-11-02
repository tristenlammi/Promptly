import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "@/utils/cn";

import { beginPress, snap15 } from "../drag";
import { addDays, fmt, hourLabel, sameDay, shortTime, startOfDay, timeRange } from "../dates";
import { layoutDay, layoutSpans, lookStyle, onDay, withTimes, type ViewEvent } from "../model";
import { EventChip, openFrom, type OpenEvent } from "./EventChip";
import { TaskMarker } from "./ExtrasChips";

const HOUR = 48;
const GUTTER = 52;
const LANE = 22;
const MIN_LEN = 15 * 60_000;

/** A timed event being dragged: where it would land. */
interface GridDrag {
  v: ViewEvent;
  mode: "move" | "resize";
  origin: { day: number; min: number };
  start: Date;
  end: Date;
}

/** An all-day / multi-day bar being moved by whole days. */
interface DayDrag {
  v: ViewEvent;
  origin: number;
  shift: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Week / day: an all-day row over an hour grid. */
export function TimeGridView({
  from,
  days,
  events,
  compact,
  onOpen,
  onCreate,
  onDay,
  onMove,
}: {
  from: Date;
  days: number;
  events: ViewEvent[];
  compact: boolean;
  onOpen: OpenEvent;
  onCreate: (start: Date, allDay: boolean) => void;
  onDay: (d: Date) => void;
  /** An event was dragged to [start, end). */
  onMove: (v: ViewEvent, start: Date, end: Date) => void;
}) {
  const cols = useMemo(() => Array.from({ length: days }, (_, i) => addDays(from, i)), [from, days]);
  const [dayDrag, setDayDragState] = useState<DayDrag | null>(null);
  const spanEvents = useMemo(() => {
    const all = events.filter((v) => v.spanning);
    if (!dayDrag?.shift) return all;
    return all.map((v) => (v.ev.id === dayDrag.v.ev.id ? withTimes(v, addDays(v.start, dayDrag.shift), addDays(v.end, dayDrag.shift)) : v));
  }, [events, dayDrag]);
  const spans = useMemo(() => layoutSpans(spanEvents, from, days), [spanEvents, from, days]);
  // Timed tasks are markers, not blocks.
  const timed = useMemo(() => events.filter((v) => !v.extra), [events]);
  const markers = useMemo(() => events.filter((v) => v.extra && !v.spanning), [events]);
  const lanes = spans.reduce((m, s) => Math.max(m, s.lane + 1), 0);
  const [expanded, setExpanded] = useState(false);
  const shownLanes = expanded || lanes <= 3 ? lanes : 2;
  const hiddenSpans = lanes > shownLanes ? spans.filter((s) => s.lane >= shownLanes).length : 0;
  const now = useNow();
  const scroller = useRef<HTMLDivElement>(null);
  // The hour grid's scrollbar narrows it: pad the header to match.
  const [sbw, setSbw] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSbw(el.offsetWidth - el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Open at ~7am (or a bit before now, when that's later in the day).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const showsToday = cols.some((d) => sameDay(d, new Date()));
    const h = showsToday ? Math.max(7, Math.min(new Date().getHours() - 2, 16)) : 7;
    el.scrollTop = h * HOUR;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from.getTime(), days]);

  const gridCols = { gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` };

  // ---- dragging timed events (move / resize), auto-scrolling at the edges
  const grid = useRef<HTMLDivElement>(null);
  const allDayRow = useRef<HTMLDivElement>(null);
  const [drag, setDragState] = useState<GridDrag | null>(null);
  const dragRef = useRef<GridDrag | null>(null);
  const setDrag = (d: GridDrag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const lastPt = useRef<{ x: number; y: number } | null>(null);

  const slotAt = (x: number, y: number) => {
    const r = grid.current!.getBoundingClientRect();
    return { day: clamp(Math.floor((x - r.left) / (r.width / days)), 0, days - 1), min: clamp(((y - r.top) / HOUR) * 60, 0, 24 * 60) };
  };
  const follow = (x: number, y: number) => {
    const d = dragRef.current;
    if (!d || !grid.current) return;
    lastPt.current = { x, y };
    const s = slotAt(x, y);
    let start = d.v.start;
    let end: Date;
    if (d.mode === "move") {
      const startMin = d.v.start.getHours() * 60 + d.v.start.getMinutes();
      const min = clamp(snap15(startMin + s.min - d.origin.min), 0, 24 * 60 - 15);
      start = startOfDay(addDays(d.v.start, s.day - d.origin.day));
      start.setMinutes(min);
      end = new Date(start.getTime() + (d.v.end.getTime() - d.v.start.getTime()));
    } else {
      const at = startOfDay(addDays(from, s.day));
      at.setMinutes(snap15(s.min));
      end = at.getTime() - start.getTime() < MIN_LEN ? new Date(start.getTime() + MIN_LEN) : at;
    }
    if (start.getTime() !== d.start.getTime() || end.getTime() !== d.end.getTime()) setDrag({ ...d, start, end });
  };
  const pressBlock = (e: ReactPointerEvent<HTMLElement>, v: ViewEvent, mode: GridDrag["mode"]) => {
    if (!v.ev.can_edit || v.extra) return;
    if (mode === "resize") e.stopPropagation();
    beginPress(e, {
      cursor: mode === "resize" ? "ns-resize" : "grabbing",
      start: (x, y) => {
        lastPt.current = { x, y };
        setDrag({ v, mode, origin: slotAt(x, y), start: v.start, end: v.end });
      },
      move: follow,
      drop: () => {
        const d = dragRef.current;
        setDrag(null);
        if (d) onMove(d.v, d.start, d.end);
      },
      cancel: () => setDrag(null),
    });
  };
  const dragging = !!drag;
  useEffect(() => {
    if (!dragging) return;
    let raf = 0;
    const tick = () => {
      const el = scroller.current;
      const p = lastPt.current;
      if (el && p) {
        const r = el.getBoundingClientRect();
        const edge = 44;
        let dy = 0;
        if (p.y < r.top + edge) dy = -Math.ceil((r.top + edge - p.y) / 3);
        else if (p.y > r.bottom - edge) dy = Math.ceil((p.y - (r.bottom - edge)) / 3);
        if (dy) {
          const before = el.scrollTop;
          el.scrollTop += dy;
          if (el.scrollTop !== before) follow(p.x, p.y);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  // ---- dragging all-day / multi-day bars by whole days
  const dayDragRef = useRef<DayDrag | null>(null);
  const setDayDrag = (d: DayDrag | null) => {
    dayDragRef.current = d;
    setDayDragState(d);
  };
  const dayAt = (x: number) => {
    const r = allDayRow.current!.getBoundingClientRect();
    return clamp(Math.floor((x - r.left) / (r.width / days)), 0, days - 1);
  };
  const pressSpan = (e: ReactPointerEvent<HTMLElement>, v: ViewEvent) => {
    if (!v.ev.can_edit || v.extra) return;
    beginPress(e, {
      start: (x) => setDayDrag({ v, origin: dayAt(x), shift: 0 }),
      move: (x) => {
        const d = dayDragRef.current;
        if (d && d.shift !== dayAt(x) - d.origin) setDayDrag({ ...d, shift: dayAt(x) - d.origin });
      },
      drop: () => {
        const d = dayDragRef.current;
        setDayDrag(null);
        if (d?.shift) onMove(d.v, addDays(d.v.start, d.shift), addDays(d.v.end, d.shift));
      },
      cancel: () => setDayDrag(null),
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Day headers + all-day row */}
      <div className="shrink-0 border-b border-[var(--border)]" style={{ paddingRight: sbw }}>
        <div className="flex">
          <div style={{ width: GUTTER }} className="shrink-0" />
          <div className="grid flex-1" style={gridCols}>
            {cols.map((d, i) => {
              const isToday = sameDay(d, now);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onDay(d)}
                  disabled={days === 1}
                  className="flex flex-col items-center gap-0.5 py-1.5 disabled:cursor-default"
                >
                  <span className={cn("text-[11px] font-medium uppercase", isToday ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]")}>
                    {fmt(d, { weekday: compact && days > 1 ? "narrow" : "short" })}
                  </span>
                  <span
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-full text-base font-semibold tabular-nums",
                      isToday ? "bg-[var(--item-accent)] text-white" : "text-[var(--text)]",
                    )}
                  >
                    {d.getDate()}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex">
          <div style={{ width: GUTTER }} className="flex shrink-0 items-start justify-end pr-2 pt-1 text-[10px] text-[var(--text-muted)]">
            {lanes > 3 ? (
              <button type="button" onClick={() => setExpanded((x) => !x)} className="rounded px-1 hover:bg-[var(--hover)] hover:text-[var(--text)]">
                {expanded ? "less" : `+${hiddenSpans}`}
              </button>
            ) : (
              "all-day"
            )}
          </div>
          <div ref={allDayRow} className="relative flex-1" style={{ height: Math.max(1, shownLanes) * LANE + 6 }}>
            <div className="absolute inset-0 grid" style={gridCols}>
              {cols.map((d, i) => (
                <div
                  key={i}
                  onClick={() => onCreate(startOfDay(d), true)}
                  className={cn(
                    "cursor-pointer border-l border-[var(--border)] hover:bg-[var(--hover)]",
                    dayDrag && i === clamp(dayDrag.origin + dayDrag.shift, 0, days - 1) && "bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)]",
                  )}
                />
              ))}
            </div>
            {spans
              .filter((s) => s.lane < shownLanes)
              .map((s) => (
                <div
                  key={s.v.ev.id}
                  onPointerDown={(e) => pressSpan(e, s.v)}
                  className={cn(
                    "absolute select-none px-[2px] [-webkit-touch-callout:none]",
                    dayDrag?.v.ev.id === s.v.ev.id && "z-20 drop-shadow-[0_4px_10px_rgba(0,0,0,0.25)]",
                  )}
                  style={{ top: 3 + s.lane * LANE, height: LANE - 2, left: `${(s.col / days) * 100}%`, width: `${(s.span / days) * 100}%` }}
                >
                  <EventChip v={s.v} onOpen={onOpen} continuesLeft={s.v.start < from} continuesRight={s.v.end > addDays(from, days)} />
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Hour grid */}
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="flex" style={{ height: 24 * HOUR }}>
          <div style={{ width: GUTTER }} className="relative shrink-0">
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-[var(--text-muted)]" style={{ top: (i + 1) * HOUR }}>
                {hourLabel(i + 1)}
              </span>
            ))}
          </div>
          <div ref={grid} className="relative grid flex-1" style={gridCols}>
            {/* hour lines */}
            <div className="pointer-events-none absolute inset-0">
              {Array.from({ length: 24 }, (_, i) => (
                <div key={i} className="border-t border-[var(--border)]" style={{ height: HOUR }} />
              ))}
            </div>
            {cols.map((d, i) => (
              <DayColumn
                key={i}
                day={d}
                events={timed}
                markers={markers}
                now={now}
                onOpen={onOpen}
                onCreate={onCreate}
                narrow={compact && days > 1}
                drag={drag}
                onPress={pressBlock}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DayColumn({
  day,
  events,
  markers,
  now,
  onOpen,
  onCreate,
  narrow,
  drag,
  onPress,
}: {
  day: Date;
  events: ViewEvent[];
  markers: ViewEvent[];
  now: Date;
  onOpen: OpenEvent;
  onCreate: (start: Date, allDay: boolean) => void;
  narrow: boolean;
  drag: GridDrag | null;
  onPress: (e: ReactPointerEvent<HTMLElement>, v: ViewEvent, mode: GridDrag["mode"]) => void;
}) {
  const items = useMemo(() => layoutDay(events, day), [events, day]);
  const isToday = sameDay(day, now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(startOfDay(day), 1).getTime();
  // Timed tasks, nudged down a little when they'd sit on top of each other.
  const taskMarks = useMemo(() => {
    let prev = -Infinity;
    return markers
      .filter((v) => onDay(v, day))
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((v) => {
        const top = Math.max(((v.start.getTime() - dayStart) / 3_600_000) * HOUR, prev + 19);
        prev = top;
        return { v, top };
      });
  }, [markers, day, dayStart]);
  // Where the dragged event would land, on this day.
  let ghost: { top: number; height: number } | null = null;
  if (drag && drag.start.getTime() < dayEnd && drag.end.getTime() > dayStart) {
    const top = ((Math.max(drag.start.getTime(), dayStart) - dayStart) / 3_600_000) * HOUR;
    const bottom = ((Math.min(drag.end.getTime(), dayEnd) - dayStart) / 3_600_000) * HOUR;
    ghost = { top, height: Math.max(HOUR / 4, bottom - top) };
  }

  return (
    <div
      className="relative border-l border-[var(--border)]"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const min = Math.floor(((e.clientY - r.top) / HOUR) * 2) * 30;
        const start = startOfDay(day);
        start.setMinutes(Math.max(0, Math.min(min, 23 * 60 + 30)));
        onCreate(start, false);
      }}
    >
      {items.map(({ v, top, bottom, col, cols }) => {
        const { style, className } = lookStyle(v);
        const h = ((bottom - top) / 60) * HOUR;
        const short = h < 34;
        const lifted = drag?.v.ev.id === v.ev.id;
        // The resize handle sits on the day the event ends.
        const resizable = v.ev.can_edit && v.end.getTime() <= dayEnd;
        return (
          <button
            key={v.ev.id}
            type="button"
            onClick={(e) => openFrom(e, v, onOpen)}
            onPointerDown={(e) => onPress(e, v, "move")}
            aria-label={`${v.ev.title}, ${shortTime(v.start)} – ${shortTime(v.end)}`}
            className={cn(
              "group/block absolute select-none overflow-hidden rounded-md px-1.5 text-left text-[11px] leading-tight shadow-[0_0_0_1px_var(--bg)] transition-opacity [-webkit-touch-callout:none] hover:z-10 hover:brightness-95",
              short ? "py-0" : "py-1",
              lifted && "opacity-40",
              className,
            )}
            style={{
              ...style,
              top: (top / 60) * HOUR + 1,
              height: h - 2,
              left: `calc(${(col / cols) * 100}% + 1px)`,
              width: `calc(${(1 / cols) * 100}% - 3px)`,
            }}
          >
            {short ? (
              <span className="block truncate">
                <span className="font-semibold">{v.ev.title}</span>
                {!narrow && <span className="opacity-80">, {shortTime(v.start)}</span>}
              </span>
            ) : (
              <>
                <span className="block truncate font-semibold">{v.ev.title}</span>
                <span className="block truncate opacity-80">
                  {shortTime(v.start)} – {shortTime(v.end)}
                </span>
                {v.ev.location && !narrow && <span className="block truncate opacity-80">{v.ev.location}</span>}
              </>
            )}
            {resizable && (
              <span
                aria-hidden
                onPointerDown={(e) => onPress(e, v, "resize")}
                className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize [@media(pointer:coarse)]:h-3 after:absolute after:bottom-[2px] after:left-1/2 after:h-[3px] after:w-6 after:-translate-x-1/2 after:rounded-full after:bg-current after:opacity-0 after:transition group-hover/block:after:opacity-50"
              />
            )}
          </button>
        );
      })}
      {taskMarks.map(({ v, top }) => (
        <TaskMarker key={v.ev.id} v={v} onOpen={onOpen} top={top} narrow={narrow} />
      ))}
      {drag && ghost && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute left-[1px] right-[3px] z-30 overflow-hidden rounded-md px-1.5 py-1 text-[11px] leading-tight shadow-[0_8px_24px_rgba(0,0,0,0.28)] ring-2 ring-[var(--bg)]",
            lookStyle(drag.v).className.replace("line-through", ""),
          )}
          style={{ ...lookStyle(drag.v).style, top: ghost.top + 1, height: ghost.height - 2 }}
        >
          <span className="block truncate font-semibold">{drag.v.ev.title}</span>
          <span className="block truncate tabular-nums">{timeRange(drag.start, drag.end)}</span>
        </div>
      )}
      {isToday && (
        <div className="pointer-events-none absolute left-0 right-0 z-20" style={{ top: (nowMin / 60) * HOUR }}>
          <div className="relative h-[2px] bg-[#EA4335]">
            <span className="absolute -left-[5px] -top-[4px] h-[10px] w-[10px] rounded-full bg-[#EA4335]" />
          </div>
        </div>
      )}
    </div>
  );
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}
