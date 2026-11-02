import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "@/utils/cn";

import { beginPress } from "../drag";
import { addDays, monthGrid, sameDay, weekdayHeaders } from "../dates";
import { layoutSpans, onDay, withTimes, type ViewEvent } from "../model";
import { EventChip, type OpenEvent } from "./EventChip";

const HEAD = 24; // the day number's row

export function MonthView({
  cursor,
  events,
  compact,
  onOpen,
  onCreate,
  onDay: goDay,
  onMove,
}: {
  cursor: Date;
  events: ViewEvent[];
  compact: boolean;
  onOpen: OpenEvent;
  onCreate: (day: Date) => void;
  onDay: (day: Date) => void;
  /** An event was dragged to another day (keeping its time). */
  onMove: (v: ViewEvent, start: Date, end: Date) => void;
}) {
  const { start, weeks } = monthGrid(cursor);
  const heads = weekdayHeaders();
  const today = new Date();
  const box = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState(100);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRowH(el.clientHeight / weeks));
    ro.observe(el);
    return () => ro.disconnect();
  }, [weeks]);
  const laneH = compact ? 17 : 21;

  // Dragging a chip to another day: shown there while it moves.
  const [drag, setDragState] = useState<{ v: ViewEvent; origin: number; shift: number } | null>(null);
  const dragRef = useRef(drag);
  const setDrag = (d: typeof drag) => {
    dragRef.current = d;
    setDragState(d);
  };
  const cellAt = (x: number, y: number) => {
    const r = box.current!.getBoundingClientRect();
    const col = Math.max(0, Math.min(6, Math.floor((x - r.left) / (r.width / 7))));
    const row = Math.max(0, Math.min(weeks - 1, Math.floor((y - r.top) / (r.height / weeks))));
    return row * 7 + col;
  };
  const press = (e: ReactPointerEvent<HTMLElement>, v: ViewEvent) => {
    if (!v.ev.can_edit || v.extra) return;
    beginPress(e, {
      start: (x, y) => setDrag({ v, origin: cellAt(x, y), shift: 0 }),
      move: (x, y) => {
        const d = dragRef.current;
        if (d && d.shift !== cellAt(x, y) - d.origin) setDrag({ ...d, shift: cellAt(x, y) - d.origin });
      },
      drop: () => {
        const d = dragRef.current;
        setDrag(null);
        if (d?.shift) onMove(d.v, addDays(d.v.start, d.shift), addDays(d.v.end, d.shift));
      },
      cancel: () => setDrag(null),
    });
  };
  const shown = useMemo(() => {
    if (!drag?.shift) return events;
    return events.map((v) => (v.ev.id === drag.v.ev.id ? withTimes(v, addDays(v.start, drag.shift), addDays(v.end, drag.shift)) : v));
  }, [events, drag]);
  const target = drag ? drag.origin + drag.shift : -1;
  const maxLanes = Math.max(1, Math.floor((rowH - HEAD - 4) / laneH));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-7 border-b border-[var(--border)]">
        {heads.map((h, i) => (
          <div key={i} className="py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {compact ? h.narrow : h.short}
          </div>
        ))}
      </div>
      <div ref={box} className="grid min-h-0 flex-1" style={{ gridTemplateRows: `repeat(${weeks}, minmax(${compact ? 64 : 92}px, 1fr))` }}>
        {Array.from({ length: weeks }, (_, w) => (
          <WeekRow
            key={w}
            from={addDays(start, w * 7)}
            month={cursor.getMonth()}
            today={today}
            events={shown}
            target={target >= w * 7 && target < w * 7 + 7 ? target - w * 7 : -1}
            dragId={drag?.v.ev.id ?? null}
            onPress={press}
            maxLanes={maxLanes}
            laneH={laneH}
            compact={compact}
            onOpen={onOpen}
            onCreate={onCreate}
            onDay={goDay}
          />
        ))}
      </div>
    </div>
  );
}

function WeekRow({
  from,
  month,
  today,
  events,
  maxLanes,
  laneH,
  compact,
  onOpen,
  onCreate,
  onDay: goDay,
  target,
  dragId,
  onPress,
}: {
  from: Date;
  month: number;
  today: Date;
  events: ViewEvent[];
  /** The column a dragged chip is over (-1: none in this week). */
  target: number;
  dragId: string | null;
  onPress: (e: ReactPointerEvent<HTMLElement>, v: ViewEvent) => void;
  maxLanes: number;
  laneH: number;
  compact: boolean;
  onOpen: OpenEvent;
  onCreate: (day: Date) => void;
  onDay: (day: Date) => void;
}) {
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(from, i)), [from]);
  const items = useMemo(() => layoutSpans(events, from, 7), [events, from]);
  const totals = useMemo(() => days.map((d) => events.filter((v) => onDay(v, d)).length), [days, events]);

  // Which lanes show on a day: all of them if they fit, else one fewer and "+N more".
  const visible = (lane: number, col: number) => (totals[col] <= maxLanes ? lane < maxLanes : lane < maxLanes - 1);
  const runs: { v: ViewEvent; col: number; span: number; lane: number; first: boolean; left: boolean; right: boolean }[] = [];
  for (const it of items) {
    let runStart = -1;
    for (let c = it.col; c <= it.col + it.span; c++) {
      const on = c < it.col + it.span && visible(it.lane, c);
      if (on && runStart < 0) runStart = c;
      if (!on && runStart >= 0) {
        runs.push({
          v: it.v,
          col: runStart,
          span: c - runStart,
          lane: it.lane,
          first: runStart === it.col,
          left: runStart > it.col || it.v.start < from,
          right: c < it.col + it.span || it.v.end > addDays(from, 7),
        });
        runStart = -1;
      }
    }
  }
  const more = days.map((_d, c) => {
    if (totals[c] <= maxLanes) return 0;
    const shown = items.filter((it) => it.lane < maxLanes - 1 && c >= it.col && c < it.col + it.span).length;
    return totals[c] - shown;
  });

  return (
    <div className="relative min-h-0 border-b border-[var(--border)] last:border-b-0">
      <div className="absolute inset-0 grid grid-cols-7">
        {days.map((d, c) => {
          const isToday = sameDay(d, today);
          return (
            <div
              key={c}
              onClick={() => onCreate(d)}
              className={cn(
                "min-w-0 cursor-pointer border-r border-[var(--border)] last:border-r-0 hover:bg-[color-mix(in_srgb,var(--hover)_60%,transparent)]",
                d.getMonth() !== month && "bg-[color-mix(in_srgb,var(--surface-2)_55%,transparent)]",
                c === target && "!bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)]",
              )}
            >
              <div className="flex justify-center pt-1" style={{ height: HEAD }}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    goDay(d);
                  }}
                  aria-label={`Open ${d.toDateString()}`}
                  className={cn(
                    "flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-medium tabular-nums",
                    isToday ? "bg-[var(--item-accent)] text-white" : d.getMonth() === month ? "text-[var(--text)] hover:bg-[var(--hover)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]",
                  )}
                >
                  {d.getDate() === 1 && !compact ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d.getDate()}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {runs.map((r) => (
        <div
          key={`${r.v.ev.id}:${r.col}`}
          onPointerDown={(e) => onPress(e, r.v)}
          className={cn("absolute select-none px-[2px] [-webkit-touch-callout:none]", dragId === r.v.ev.id && "z-20 drop-shadow-[0_4px_10px_rgba(0,0,0,0.25)]")}
          style={{ top: HEAD + r.lane * laneH, height: laneH - 2, left: `${(r.col / 7) * 100}%`, width: `${(r.span / 7) * 100}%` }}
        >
          <EventChip v={r.v} onOpen={onOpen} compact={compact} showTitle continuesLeft={r.left} continuesRight={r.right} />
        </div>
      ))}
      {more.map((n, c) =>
        n > 0 ? (
          <button
            key={`more${c}`}
            type="button"
            onClick={() => goDay(days[c])}
            className="absolute truncate rounded-md px-1.5 text-left text-[11px] font-medium text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            style={{ top: HEAD + (maxLanes - 1) * laneH, height: laneH - 2, left: `calc(${(c / 7) * 100}% + 2px)`, width: `calc(${100 / 7}% - 4px)` }}
          >
            +{n}
            {compact ? "" : " more"}
          </button>
        ) : null,
      )}
    </div>
  );
}
