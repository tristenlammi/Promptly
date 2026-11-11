import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { CalTask } from "@/api/calendar";
import { Skeleton } from "@/components/shared/Skeleton";
import { cn } from "@/utils/cn";

import { beginPress, snap15, stretchDays } from "../drag";
import { addDays, fmt, hourLabel, localZone, sameDay, shortTime, startOfDay, timeRange, uses12h, zoneCity, zoneNote, zoneShort } from "../dates";
import { layoutDay, layoutSpans, lookStyle, onDay, withTimes, type ViewEvent } from "../model";
import { EventChip, openFrom, type OpenEvent } from "./EventChip";
import { AppointmentMarker, TaskMarker } from "./ExtrasChips";

const HOUR = 48;
const GUTTER = 52;
/** The extra hour column for a second time zone. */
const GUTTER2 = 44;
const LANE = 22;
const MIN_LEN = 15 * 60_000;
/** How long a task dragged onto the grid is planned for. */
const PLAN_MIN = 60;

/** A timed event being dragged (or a task being planned): where it would land. */
interface GridDrag {
  v: ViewEvent;
  mode: "move" | "resize" | "resize-start" | "plan";
  origin: { day: number; min: number };
  start: Date;
  end: Date;
  /** Planning a task: the pointer is over the hour grid (else it drops nowhere). */
  over?: boolean;
}

/** "9 am" / "09:00" as the clock reads in ``tz`` (a half-hour zone shows its minutes). */
function hourIn(d: Date, tz: string): string {
  try {
    if (!uses12h()) return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    const s = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit", hourCycle: "h12" }).format(d);
    return s.replace(/:00(?=\D|$)/, "").replace(/\s?([AP])M$/i, (_m, p: string) => " " + p.toLowerCase() + "m");
  } catch {
    return "";
  }
}

/** An all-day / multi-day bar being moved by whole days. */
interface DayDrag {
  v: ViewEvent;
  origin: number;
  shift: number;
  /** Stretching one end instead of moving the whole bar. */
  edge?: "start" | "end";
}

/** A new event being drawn on the hour grid (minutes on one day). */
interface Make {
  day: number;
  a: number;
  b: number;
}

/** The slot a new event is being made for (drawn, or waiting in the quick-add bubble). */
export interface DraftSlot {
  start: Date;
  end: Date;
  allDay: boolean;
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
  onPlanTask,
  secondTz,
  draft,
  loading,
}: {
  from: Date;
  days: number;
  events: ViewEvent[];
  compact: boolean;
  onOpen: OpenEvent;
  /** An empty slot was clicked, or a stretch of time drawn: [start, end) and where on screen. */
  onCreate: (start: Date, allDay: boolean, end?: Date, anchor?: DOMRect) => void;
  onDay: (d: Date) => void;
  /** The new event waiting in the quick-add bubble (shown in place). */
  draft?: DraftSlot | null;
  /** Events are still arriving: show placeholder blocks. */
  loading?: boolean;
  /** An event was dragged to [start, end). */
  onMove: (v: ViewEvent, start: Date, end: Date) => void;
  /** A task chip was dragged onto the hour grid: plan it for [start, end). */
  onPlanTask?: (t: CalTask, start: Date, end: Date) => void;
  /** Show a second column of hours in this zone (IANA name). */
  secondTz?: string;
}) {
  const tz2 = secondTz && secondTz !== localZone() ? secondTz : "";
  const gutter = tz2 ? GUTTER + GUTTER2 : GUTTER;
  const cols = useMemo(() => Array.from({ length: days }, (_, i) => addDays(from, i)), [from, days]);
  const [dayDrag, setDayDragState] = useState<DayDrag | null>(null);
  const spanEvents = useMemo(() => {
    const all = events.filter((v) => v.spanning);
    if (!dayDrag?.shift) return all;
    const to = stretchDays(dayDrag.v, dayDrag.shift, dayDrag.edge);
    return all.map((v) => (v.ev.id === dayDrag.v.ev.id ? withTimes(v, to.start, to.end) : v));
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
  // ---- drawing a new event on empty time
  const [make, setMakeState] = useState<Make | null>(null);
  const makeRef = useRef<Make | null>(null);
  const setMake = (m: Make | null) => {
    makeRef.current = m;
    setMakeState(m);
  };
  /** Where a slot sits on screen (the quick-add bubble opens beside it). */
  const slotRect = (day: number, fromMin: number, toMin: number) => {
    const r = grid.current!.getBoundingClientRect();
    const w = r.width / days;
    return new DOMRect(r.left + day * w, r.top + (fromMin / 60) * HOUR, w, ((toMin - fromMin) / 60) * HOUR);
  };
  const createAt = (day: number, fromMin: number, toMin: number) => {
    const a = clamp(fromMin, 0, 24 * 60 - 15);
    const b = clamp(toMin, a + 15, 24 * 60);
    const start = startOfDay(cols[day]);
    start.setMinutes(a);
    const end = startOfDay(cols[day]);
    end.setMinutes(b);
    onCreate(start, false, end, slotRect(day, a, b));
  };
  const pressEmpty = (e: ReactPointerEvent<HTMLElement>, day: number) => {
    // Only empty time: a press on an event is that event's.
    if (e.target !== e.currentTarget) return;
    beginPress(e, {
      cursor: "ns-resize",
      start: (x, y) => {
        lastPt.current = { x, y };
        const a = Math.floor(slotAt(x, y).min / 15) * 15;
        setMake({ day, a, b: a });
      },
      move: follow,
      drop: () => {
        const m = makeRef.current;
        setMake(null);
        if (!m) return;
        const lo = Math.min(m.a, m.b);
        const hi = Math.max(m.a, m.b);
        // A press that never stretched is an hour, like a click.
        createAt(m.day, lo, hi - lo < 15 ? lo + 60 : hi);
      },
      cancel: () => setMake(null),
    });
  };

  const follow = (x: number, y: number) => {
    const m = makeRef.current;
    if (m && grid.current) {
      lastPt.current = { x, y };
      const b = snap15(slotAt(x, y).min);
      if (b !== m.b) setMake({ ...m, b });
      return;
    }
    const d = dragRef.current;
    if (!d || !grid.current) return;
    lastPt.current = { x, y };
    const s = slotAt(x, y);
    if (d.mode === "plan") {
      const sr = scroller.current!.getBoundingClientRect();
      const gr = grid.current.getBoundingClientRect();
      const over = y >= sr.top && y <= sr.bottom && x >= gr.left && x <= gr.right;
      const start = startOfDay(addDays(from, s.day));
      start.setMinutes(clamp(snap15(s.min - PLAN_MIN / 2), 0, 24 * 60 - PLAN_MIN));
      const end = new Date(start.getTime() + PLAN_MIN * 60_000);
      if (over !== d.over || start.getTime() !== d.start.getTime()) setDrag({ ...d, start, end, over });
      return;
    }
    let start = d.v.start;
    let end: Date;
    if (d.mode === "resize-start") {
      end = d.v.end;
      const at = startOfDay(addDays(from, s.day));
      at.setMinutes(snap15(s.min));
      start = end.getTime() - at.getTime() < MIN_LEN ? new Date(end.getTime() - MIN_LEN) : at;
    } else if (d.mode === "move") {
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
    const resizing = mode === "resize" || mode === "resize-start";
    if (resizing) e.stopPropagation();
    beginPress(e, {
      cursor: resizing ? "ns-resize" : "grabbing",
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
  const dragging = !!drag || !!make;
  useEffect(() => {
    if (!dragging) return;
    let raf = 0;
    const tick = () => {
      const el = scroller.current;
      const p = lastPt.current;
      const planning = dragRef.current?.mode === "plan";
      if (el && p) {
        const r = el.getBoundingClientRect();
        // A task on its way down from the all-day row doesn't scroll the hours.
        if (planning && (p.y < r.top || p.y > r.bottom)) {
          raf = requestAnimationFrame(tick);
          return;
        }
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
  // A task chip dragged down onto the hours: plan it there.
  const pressTask = (e: ReactPointerEvent<HTMLElement>, v: ViewEvent, task: CalTask) => {
    beginPress(e, {
      start: (x, y) => {
        lastPt.current = { x, y };
        setDrag({ v: { ...v, allDay: false, spanning: false }, mode: "plan", origin: { day: 0, min: 0 }, start: v.start, end: v.start, over: false });
        follow(x, y);
      },
      move: follow,
      drop: () => {
        const d = dragRef.current;
        setDrag(null);
        if (d?.over) onPlanTask?.(task, d.start, d.end);
      },
      cancel: () => setDrag(null),
    });
  };
  const pressSpan = (e: ReactPointerEvent<HTMLElement>, v: ViewEvent, edge?: "start" | "end") => {
    if (edge) e.stopPropagation();
    else if (v.extra?.kind === "task" && onPlanTask) return pressTask(e, v, v.extra.task);
    if (!v.ev.can_edit || v.extra) return;
    beginPress(e, {
      cursor: edge ? "ew-resize" : "grabbing",
      start: (x) => setDayDrag({ v, origin: dayAt(x), shift: 0, edge }),
      move: (x) => {
        const d = dayDragRef.current;
        if (d && d.shift !== dayAt(x) - d.origin) setDayDrag({ ...d, shift: dayAt(x) - d.origin });
      },
      drop: () => {
        const d = dayDragRef.current;
        setDayDrag(null);
        if (!d?.shift) return;
        const to = stretchDays(d.v, d.shift, d.edge);
        onMove(d.v, to.start, to.end);
      },
      cancel: () => setDayDrag(null),
    });
  };

  // The slot being drawn, or the one waiting in the quick-add bubble.
  let pending: DraftSlot | null = draft ?? null;
  if (make) {
    const lo = Math.min(make.a, make.b);
    const hi = Math.max(Math.max(make.a, make.b), lo + 15);
    const start = startOfDay(cols[make.day]);
    start.setMinutes(lo);
    const end = startOfDay(cols[make.day]);
    end.setMinutes(hi);
    pending = { start, end, allDay: false };
  }
  const tightCols = compact && days > 3;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Day headers + all-day row */}
      <div className="shrink-0 border-b border-[var(--border)]" style={{ paddingRight: sbw }}>
        <div className="flex">
          <div style={{ width: gutter }} className="flex shrink-0 items-end justify-end pb-1 text-xs font-medium uppercase leading-none text-[var(--text-muted)]">
            {tz2 && (
              <>
                <span style={{ width: GUTTER2 }} className="truncate pr-1 text-right" title={`${zoneCity(tz2)} time`}>
                  {zoneShort(tz2, from)}
                </span>
                <span style={{ width: GUTTER }} className="truncate pr-2 text-right" title="Your time">
                  {zoneShort(localZone(), from)}
                </span>
              </>
            )}
          </div>
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
                  <span className={cn("text-xs font-medium uppercase", isToday ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]")}>
                    {fmt(d, { weekday: tightCols ? "narrow" : "short" })}
                  </span>
                  <span
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-full text-base font-semibold tabular-nums",
                      isToday ? "bg-[var(--item-accent-fill)] text-white" : "text-[var(--text)]",
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
          <div style={{ width: gutter }} className="flex shrink-0 items-start justify-end pr-2 pt-1 text-xs text-[var(--text-muted)]">
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
                  onClick={(e) => onCreate(startOfDay(d), true, undefined, e.currentTarget.getBoundingClientRect())}
                  className={cn(
                    "cursor-pointer border-l border-[var(--border)] hover:bg-[var(--hover)]",
                    dayDrag && !dayDrag.edge && i === clamp(dayDrag.origin + dayDrag.shift, 0, days - 1) && "bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)]",
                    pending?.allDay && sameDay(pending.start, d) && "bg-[color-mix(in_srgb,var(--item-accent)_22%,transparent)]",
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
                    drag?.mode === "plan" && drag.v.ev.id === s.v.ev.id && "opacity-40",
                  )}
                  style={{ top: 3 + s.lane * LANE, height: LANE - 2, left: `${(s.col / days) * 100}%`, width: `${(s.span / days) * 100}%` }}
                >
                  <EventChip v={s.v} onOpen={onOpen} continuesLeft={s.v.start < from} continuesRight={s.v.end > addDays(from, days)} />
                  {/* Stretch it over more (or fewer) days from either end. */}
                  {s.v.ev.can_edit && !s.v.extra && s.v.start >= from && (
                    <span aria-hidden onPointerDown={(e) => pressSpan(e, s.v, "start")} className="absolute inset-y-0 left-0 w-2 cursor-ew-resize [@media(pointer:coarse)]:w-3" />
                  )}
                  {s.v.ev.can_edit && !s.v.extra && s.v.end <= addDays(from, days) && (
                    <span aria-hidden onPointerDown={(e) => pressSpan(e, s.v, "end")} className="absolute inset-y-0 right-0 w-2 cursor-ew-resize [@media(pointer:coarse)]:w-3" />
                  )}
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Hour grid */}
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="flex" style={{ height: 24 * HOUR }}>
          {tz2 && (
            <div style={{ width: GUTTER2 }} className="relative shrink-0" aria-label={`${zoneCity(tz2)} time`}>
              {Array.from({ length: 23 }, (_, i) => (
                <span key={i} className="absolute right-1 -translate-y-1/2 whitespace-nowrap text-xs tabular-nums text-[var(--text-muted)] opacity-80" style={{ top: (i + 1) * HOUR }}>
                  {hourIn(new Date(from.getFullYear(), from.getMonth(), from.getDate(), i + 1), tz2)}
                </span>
              ))}
            </div>
          )}
          <div style={{ width: GUTTER }} className="relative shrink-0">
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} className="absolute right-2 -translate-y-1/2 whitespace-nowrap text-xs tabular-nums text-[var(--text-muted)]" style={{ top: (i + 1) * HOUR }}>
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
                index={i}
                onCreate={(fromMin) => createAt(i, fromMin, fromMin + 60)}
                onPressEmpty={(e) => pressEmpty(e, i)}
                pending={pending && !pending.allDay ? pending : null}
                loading={!!loading}
                narrow={tightCols}
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
  index,
  onCreate,
  onPressEmpty,
  pending,
  loading,
  narrow,
  drag,
  onPress,
}: {
  day: Date;
  events: ViewEvent[];
  markers: ViewEvent[];
  now: Date;
  onOpen: OpenEvent;
  index: number;
  /** Empty time was clicked, at this many minutes into the day. */
  onCreate: (fromMin: number) => void;
  onPressEmpty: (e: ReactPointerEvent<HTMLElement>) => void;
  pending: DraftSlot | null;
  loading: boolean;
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
  if (drag && (drag.mode !== "plan" || drag.over) && drag.start.getTime() < dayEnd && drag.end.getTime() > dayStart) {
    const top = ((Math.max(drag.start.getTime(), dayStart) - dayStart) / 3_600_000) * HOUR;
    const bottom = ((Math.min(drag.end.getTime(), dayEnd) - dayStart) / 3_600_000) * HOUR;
    ghost = { top, height: Math.max(HOUR / 4, bottom - top) };
  }
  // The new event being drawn (or waiting in its bubble), on this day.
  let fresh: { top: number; height: number } | null = null;
  if (pending && pending.start.getTime() < dayEnd && pending.end.getTime() > dayStart) {
    const top = ((Math.max(pending.start.getTime(), dayStart) - dayStart) / 3_600_000) * HOUR;
    const bottom = ((Math.min(pending.end.getTime(), dayEnd) - dayStart) / 3_600_000) * HOUR;
    fresh = { top, height: Math.max(HOUR / 4, bottom - top) };
  }

  return (
    <div
      className="relative border-l border-[var(--border)]"
      onPointerDown={onPressEmpty}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        const min = Math.floor(((e.clientY - r.top) / HOUR) * 2) * 30;
        onCreate(Math.max(0, Math.min(min, 23 * 60)));
      }}
    >
      {loading &&
        [0, 1].map((n) => (
          // A believable morning and afternoon, staggered from day to day.
          <div
            key={n}
            className="pointer-events-none absolute left-[2px] right-[4px] opacity-70"
            style={{ top: (8.5 + n * 4.5 + ((index * 3 + n) % 4) * 0.75) * HOUR, height: (n ? 1.5 : 1) * HOUR }}
          >
            <Skeleton className="h-full w-full" />
          </div>
        ))}
      {items.map(({ v, top, bottom, col, cols }) => {
        const { style, className } = lookStyle(v);
        const h = ((bottom - top) / 60) * HOUR;
        const short = h < 34;
        const lifted = drag?.v.ev.id === v.ev.id;
        // The resize handles sit on the days the event starts and ends.
        const resizable = v.ev.can_edit && v.end.getTime() <= dayEnd;
        const resizableTop = v.ev.can_edit && v.start.getTime() >= dayStart && !short;
        return (
          <button
            key={v.ev.id}
            type="button"
            onClick={(e) => openFrom(e, v, onOpen)}
            onPointerDown={(e) => onPress(e, v, "move")}
            aria-label={`${v.ev.title}, ${shortTime(v.start)} – ${shortTime(v.end)}`}
            title={(() => {
              const z = zoneNote(v.start, v.ev.tz, v.allDay);
              return z ? `${v.ev.title} · ${z}` : undefined;
            })()}
            className={cn(
              "group/block absolute select-none overflow-hidden rounded-md px-1.5 text-left text-xs leading-tight shadow-[0_0_0_1px_var(--bg)] transition-opacity [-webkit-touch-callout:none] hover:z-10 hover:brightness-95",
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
            {resizableTop && (
              <span
                aria-hidden
                onPointerDown={(e) => onPress(e, v, "resize-start")}
                className="absolute inset-x-0 top-0 h-2 cursor-ns-resize [@media(pointer:coarse)]:h-3 after:absolute after:left-1/2 after:top-[2px] after:h-[3px] after:w-6 after:-translate-x-1/2 after:rounded-full after:bg-current after:opacity-0 after:transition group-hover/block:after:opacity-50"
              />
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
        v.extra?.kind === "task" ? (
          <TaskMarker key={v.ev.id} v={v} onOpen={onOpen} top={top} narrow={narrow} />
        ) : (
          <AppointmentMarker key={v.ev.id} v={v} onOpen={onOpen} top={top} narrow={narrow} />
        )
      ))}
      {drag && ghost && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute left-[1px] right-[3px] z-30 overflow-hidden rounded-md px-1.5 py-1 text-xs leading-tight shadow-[0_8px_24px_rgba(0,0,0,0.28)] ring-2 ring-[var(--bg)]",
            lookStyle(drag.v).className.replace("line-through", ""),
          )}
          style={{ ...lookStyle(drag.v).style, top: ghost.top + 1, height: ghost.height - 2 }}
        >
          <span className="block truncate font-semibold">{drag.v.ev.title}</span>
          <span className="block truncate tabular-nums">{timeRange(drag.start, drag.end)}</span>
        </div>
      )}
      {fresh && pending && (
        <div
          aria-hidden
          className="pointer-events-none absolute left-[1px] right-[3px] z-30 overflow-hidden rounded-md border border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_22%,var(--bg))] px-1.5 py-0.5 text-xs leading-tight text-[var(--text)] shadow-[0_4px_14px_rgba(0,0,0,0.18)]"
          style={{ top: fresh.top + 1, height: fresh.height - 2 }}
        >
          <span className="block truncate font-semibold tabular-nums">{timeRange(pending.start, pending.end)}</span>
        </div>
      )}
      {isToday && (
        <div className="pointer-events-none absolute left-0 right-0 z-20" style={{ top: (nowMin / 60) * HOUR }}>
          <div className="relative h-[2px] bg-[var(--danger)]">
            <span className="absolute -left-[5px] -top-[4px] h-[10px] w-[10px] rounded-full bg-[var(--danger)]" />
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
