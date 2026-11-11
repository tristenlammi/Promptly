import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { Skeleton } from "@/components/shared/Skeleton";
import { cn } from "@/utils/cn";

import { beginPress, stretchDays } from "../drag";
import { addDays, fmt, monthGrid, sameDay, weekdayHeaders } from "../dates";
import { layoutSpans, onDay, sortEvents, withTimes, type ViewEvent } from "../model";
import { EventChip, type OpenEvent } from "./EventChip";
import { Popover } from "./ui";

const HEAD = 24; // the day number's row

type Edge = "start" | "end";
interface ChipDrag {
  v: ViewEvent;
  origin: number;
  shift: number;
  /** Stretching one end instead of moving the whole thing. */
  edge?: Edge;
}

export function MonthView({
  cursor,
  events,
  compact,
  onOpen,
  onCreate,
  onDay: goDay,
  onMove,
  draftDay,
  loading,
}: {
  cursor: Date;
  events: ViewEvent[];
  compact: boolean;
  onOpen: OpenEvent;
  /** An empty day was clicked (and where it sits on screen). */
  onCreate: (day: Date, anchor?: DOMRect) => void;
  onDay: (day: Date) => void;
  /** An event was dragged to another day (keeping its time), or stretched over more days. */
  onMove: (v: ViewEvent, start: Date, end: Date) => void;
  /** The day a new event is being added to (its quick-add bubble is open). */
  draftDay?: Date | null;
  /** Events are still arriving: show placeholder bars. */
  loading?: boolean;
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
  const laneH = compact ? 19 : 22;

  // Dragging a chip to another day (or one of its ends): shown there while it moves.
  const [drag, setDragState] = useState<ChipDrag | null>(null);
  const dragRef = useRef(drag);
  const setDrag = (d: ChipDrag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const cellAt = (x: number, y: number) => {
    const r = box.current!.getBoundingClientRect();
    const col = Math.max(0, Math.min(6, Math.floor((x - r.left) / (r.width / 7))));
    const row = Math.max(0, Math.min(weeks - 1, Math.floor((y - r.top) / (r.height / weeks))));
    return row * 7 + col;
  };
  const press = (e: ReactPointerEvent<HTMLElement>, v: ViewEvent, edge?: Edge) => {
    if (!v.ev.can_edit || v.extra) return;
    if (edge) e.stopPropagation();
    beginPress(e, {
      cursor: edge ? "ew-resize" : "grabbing",
      start: (x, y) => setDrag({ v, origin: cellAt(x, y), shift: 0, edge }),
      move: (x, y) => {
        const d = dragRef.current;
        if (d && d.shift !== cellAt(x, y) - d.origin) setDrag({ ...d, shift: cellAt(x, y) - d.origin });
      },
      drop: () => {
        const d = dragRef.current;
        setDrag(null);
        if (!d?.shift) return;
        const to = stretchDays(d.v, d.shift, d.edge);
        onMove(d.v, to.start, to.end);
      },
      cancel: () => setDrag(null),
    });
  };
  const shown = useMemo(() => {
    if (!drag?.shift) return events;
    const to = stretchDays(drag.v, drag.shift, drag.edge);
    return events.map((v) => (v.ev.id === drag.v.ev.id ? withTimes(v, to.start, to.end) : v));
  }, [events, drag]);
  const target = drag && !drag.edge ? drag.origin + drag.shift : -1;
  const maxLanes = Math.max(1, Math.floor((rowH - HEAD - 4) / laneH));

  // "+3 more": that day's whole list, in place.
  const [more, setMore] = useState<{ day: Date; anchor: DOMRect } | null>(null);
  const moreClosedAt = useRef(0);
  const moreList = useMemo(() => (more ? events.filter((v) => onDay(v, more.day)).sort(sortEvents) : []), [events, more]);
  useEffect(() => setMore(null), [cursor]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-7 border-b border-[var(--border)]">
        {heads.map((h, i) => (
          <div key={i} className="py-1.5 text-center text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {compact ? h.narrow : h.short}
          </div>
        ))}
      </div>
      <div ref={box} className="grid min-h-0 flex-1" style={{ gridTemplateRows: `repeat(${weeks}, minmax(${compact ? 64 : 92}px, 1fr))` }}>
        {Array.from({ length: weeks }, (_, w) => (
          <WeekRow
            key={w}
            row={w}
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
            onCreate={(d, anchor) => {
              // The click that closed the day list doesn't also start an event.
              if (Date.now() - moreClosedAt.current < 400) return;
              onCreate(d, anchor);
            }}
            onDay={goDay}
            onMore={(day, anchor) => setMore({ day, anchor })}
            draftDay={draftDay ?? null}
            loading={!!loading}
          />
        ))}
      </div>
      {more && (
        <Popover
          anchor={more.anchor}
          width={compact ? 260 : 280}
          onClose={() => {
            moreClosedAt.current = Date.now();
            setMore(null);
          }}
        >
          <div className="p-3" data-cal-keep-popover>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="min-w-0 truncate text-sm font-semibold text-[var(--text)]">{fmt(more.day, { weekday: "long", day: "numeric", month: "long" })}</h2>
              <button
                type="button"
                onClick={() => {
                  const d = more.day;
                  setMore(null);
                  goDay(d);
                }}
                className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-[var(--accent-text,var(--item-accent))] hover:bg-[var(--hover)]"
              >
                Open day
              </button>
            </div>
            <ul className="flex flex-col gap-1">
              {moreList.map((v) => (
                <li key={v.ev.id} className="h-7">
                  <EventChip
                    v={v}
                    showTitle
                    onOpen={(ev, anchor) => {
                      setMore(null);
                      onOpen(ev, anchor);
                    }}
                    continuesLeft={v.spanning && !sameDay(v.start, more.day) && v.start < more.day}
                    continuesRight={v.spanning && v.end > addDays(more.day, 1)}
                  />
                </li>
              ))}
            </ul>
          </div>
        </Popover>
      )}
    </div>
  );
}

function WeekRow({
  row,
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
  onMore,
  target,
  dragId,
  onPress,
  draftDay,
  loading,
}: {
  row: number;
  from: Date;
  month: number;
  today: Date;
  events: ViewEvent[];
  /** The column a dragged chip is over (-1: none in this week). */
  target: number;
  dragId: string | null;
  onPress: (e: ReactPointerEvent<HTMLElement>, v: ViewEvent, edge?: Edge) => void;
  maxLanes: number;
  laneH: number;
  compact: boolean;
  onOpen: OpenEvent;
  onCreate: (day: Date, anchor?: DOMRect) => void;
  onDay: (day: Date) => void;
  onMore: (day: Date, anchor: DOMRect) => void;
  draftDay: Date | null;
  loading: boolean;
}) {
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(from, i)), [from]);
  const items = useMemo(() => layoutSpans(events, from, 7), [events, from]);
  const totals = useMemo(() => days.map((d) => events.filter((v) => onDay(v, d)).length), [days, events]);
  const weekEnd = addDays(from, 7);

  // Which lanes show on a day: all of them if they fit, else one fewer and "+N more".
  const visible = (lane: number, col: number) => (totals[col] <= maxLanes ? lane < maxLanes : lane < maxLanes - 1);
  const runs: { v: ViewEvent; col: number; span: number; lane: number; first: boolean; last: boolean; left: boolean; right: boolean }[] = [];
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
          last: c === it.col + it.span,
          left: runStart > it.col || it.v.start < from,
          right: c < it.col + it.span || it.v.end > weekEnd,
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
              onClick={(e) => onCreate(d, e.currentTarget.getBoundingClientRect())}
              className={cn(
                "min-w-0 cursor-pointer border-r border-[var(--border)] last:border-r-0 hover:bg-[color-mix(in_srgb,var(--hover)_60%,transparent)]",
                d.getMonth() !== month && "bg-[color-mix(in_srgb,var(--surface-2)_55%,transparent)]",
                c === target && "!bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)]",
                draftDay && sameDay(draftDay, d) && "!bg-[color-mix(in_srgb,var(--item-accent)_16%,transparent)]",
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
                    "flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-medium tabular-nums",
                    isToday ? "bg-[var(--item-accent-fill)] text-white" : d.getMonth() === month ? "text-[var(--text)] hover:bg-[var(--hover)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]",
                  )}
                >
                  {d.getDate() === 1 && !compact ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d.getDate()}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {loading &&
        days.map((_d, c) =>
          // A scatter of placeholder bars, so the month reads as "filling in".
          [0, 1]
            .filter((n) => n < maxLanes && (row * 5 + c * 3 + n * 2) % (n ? 4 : 3) !== 0)
            .map((n) => (
              <div
                key={`sk${c}:${n}`}
                className="pointer-events-none absolute px-[3px]"
                style={{ top: HEAD + n * laneH, height: laneH - 4, left: `${(c / 7) * 100}%`, width: `${((n ? 0.7 : 1) / 7) * 100}%` }}
              >
                <Skeleton className="h-full w-full" />
              </div>
            )),
        )}
      {runs.map((r) => {
        const canStretch = r.v.ev.can_edit && !r.v.extra;
        return (
          <div
            key={`${r.v.ev.id}:${r.col}`}
            onPointerDown={(e) => onPress(e, r.v)}
            className={cn("absolute select-none px-[2px] [-webkit-touch-callout:none]", dragId === r.v.ev.id && "z-20 drop-shadow-[0_4px_10px_rgba(0,0,0,0.25)]")}
            style={{ top: HEAD + r.lane * laneH, height: laneH - 2, left: `${(r.col / 7) * 100}%`, width: `${(r.span / 7) * 100}%` }}
          >
            <EventChip v={r.v} onOpen={onOpen} compact={compact} showTitle continuesLeft={r.left} continuesRight={r.right} />
            {/* Stretch it over more (or fewer) days from either end. */}
            {canStretch && r.first && r.v.start >= from && (
              <span aria-hidden onPointerDown={(e) => onPress(e, r.v, "start")} className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize [@media(pointer:coarse)]:w-2.5" />
            )}
            {canStretch && r.last && r.v.end <= weekEnd && (
              <span aria-hidden onPointerDown={(e) => onPress(e, r.v, "end")} className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize [@media(pointer:coarse)]:w-2.5" />
            )}
          </div>
        );
      })}
      {more.map((n, c) =>
        n > 0 ? (
          <button
            key={`more${c}`}
            type="button"
            aria-label={`${n} more on ${fmt(days[c], { weekday: "long", day: "numeric", month: "long" })}`}
            onClick={(e) => onMore(days[c], e.currentTarget.getBoundingClientRect())}
            className="absolute truncate rounded-md px-1.5 text-left text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
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
