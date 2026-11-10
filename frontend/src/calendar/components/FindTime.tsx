import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Sparkles } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { CalUser } from "@/api/calendar";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ItemButton, Sheet } from "@/items/ui";
import { UserAvatar } from "@/rooms/components/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { addDays, fmt, hourLabel, sameDay, startOfDay, timeLabel } from "../dates";
import { availabilityText, BUSY_COLOR, BUSY_STRIPES, busyKey, carve, fetchBusy, overlaps, type BusyMap } from "./Availability";

/**
 * Find a time — one day, a row per person (you first), their "Not available"
 * stretches striped, and the proposed time as a block across everyone. Drag
 * the block (or tap an empty spot) to move it; it snaps to 15 minutes.
 * "Next time everyone's free" looks ahead two weeks, 8:00–21:00.
 *
 * Horizontal on phones too: rooms can have a lot of people, and rows scale
 * with that where columns wouldn't.
 */

const SNAP = 15;
const DAY_MIN = 24 * 60;
const SEARCH_DAYS = 14;
const SEARCH_FROM = 8 * 60;
const SEARCH_TO = 21 * 60;

export interface FindTimeProps {
  open: boolean;
  onClose: () => void;
  me: CalUser;
  people: CalUser[];
  /** The proposed time to start from (its length is kept). */
  start: Date;
  end: Date;
  /** A span to treat as free — the event being edited, which would otherwise block its own slot. */
  ignore?: [Date, Date] | null;
  onPick: (start: Date, end: Date) => void;
}

export function FindTime(props: FindTimeProps) {
  if (!props.open) return null;
  return <FindTimeBody {...props} />;
}

const snap = (m: number) => Math.round(m / SNAP) * SNAP;
const atMinute = (day: Date, m: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m);

function FindTimeBody({ onClose, me, people, start, end, ignore, onPick }: FindTimeProps) {
  const isPhone = useIsMobile();
  const qc = useQueryClient();
  const HOUR_W = isPhone ? 52 : 72;
  const LABEL_W = isPhone ? 56 : 184;
  const ROW_H = isPhone ? 46 : 48;
  const HEAD_H = 30;
  const ppm = HOUR_W / 60;

  const dur = Math.max(SNAP, Math.min(DAY_MIN, Math.round((end.getTime() - start.getTime()) / 60_000)));
  const [day, setDay] = useState(() => startOfDay(start));
  // One day at a time: a block running past midnight is pulled back inside it.
  const [startMin, setStartMin] = useState(() => Math.min(start.getHours() * 60 + start.getMinutes(), DAY_MIN - dur));
  const [searching, setSearching] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; m0: number } | null>(null);
  // Bumped when something outside a drag moves the block, so it's scrolled into view.
  const [reveal, setReveal] = useState(0);

  const everyone = useMemo(() => [me, ...people.filter((p) => p.id !== me.id)], [me, people]);
  const ids = useMemo(() => everyone.map((p) => p.id), [everyone]);

  const d0 = day.toISOString();
  const d1 = addDays(day, 1).toISOString();
  const q = useQuery({
    queryKey: busyKey(ids, d0, d1),
    queryFn: () => fetchBusy(ids, new Date(d0), new Date(d1)),
    staleTime: 30_000,
  });
  const busy: BusyMap | null = useMemo(() => (q.data ? carve(q.data, ignore) : null), [q.data, ignore]);

  const clamp = useCallback((m: number) => Math.max(0, Math.min(DAY_MIN - dur, m)), [dur]);
  const propS = atMinute(day, startMin);
  const propE = new Date(propS.getTime() + dur * 60_000);
  const conflicts = useMemo(() => {
    const s = propS.getTime();
    const e = propE.getTime();
    return new Set(everyone.filter((p) => overlaps(busy?.[p.id], s, e)).map((p) => p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, everyone, propS.getTime(), propE.getTime()]);

  // Open around 7am — or wherever the block is, if that's off-screen.
  const firstScroll = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const visible = el.clientWidth - LABEL_W;
    const left = startMin * ppm;
    const right = (startMin + dur) * ppm;
    if (firstScroll.current) {
      firstScroll.current = false;
      const at7 = 7 * HOUR_W;
      el.scrollLeft = left >= at7 && right <= at7 + visible ? at7 : Math.max(0, left - HOUR_W);
      return;
    }
    if (left < el.scrollLeft || right > el.scrollLeft + visible) {
      el.scrollLeft = Math.max(0, left - HOUR_W);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, HOUR_W, LABEL_W]);

  const moveDay = (n: number) => {
    setDay((d) => addDays(d, n));
  };

  const findNext = async () => {
    setSearching(true);
    try {
      const now = new Date();
      const from = startOfDay(now);
      const to = addDays(from, SEARCH_DAYS + 1);
      const raw = await qc.fetchQuery({
        queryKey: busyKey(ids, from.toISOString(), to.toISOString()),
        queryFn: () => fetchBusy(ids, from, to),
        staleTime: 30_000,
      });
      const all = carve(raw, ignore);
      for (let i = 0; i <= SEARCH_DAYS; i++) {
        const d = addDays(from, i);
        for (let m = SEARCH_FROM; m + dur <= SEARCH_TO; m += SNAP) {
          const s = atMinute(d, m).getTime();
          if (s < now.getTime()) continue;
          const e = s + dur * 60_000;
          if (ids.every((id) => !overlaps(all[id], s, e))) {
            setDay(d);
            setStartMin(m);
            setReveal((r) => r + 1);
            return;
          }
        }
      }
      toast.info("No time in the next two weeks when everyone's free.");
    } catch {
      toast.error("Couldn't check when people are free.");
    } finally {
      setSearching(false);
    }
  };

  // Tap / click an empty spot: centre the block there.
  const onGridClick = (e: React.MouseEvent) => {
    const g = grid.current;
    if (!g) return;
    const x = e.clientX - g.getBoundingClientRect().left - LABEL_W;
    if (x < 0) return;
    setStartMin(clamp(snap(x / ppm - dur / 2)));
  };

  const today = new Date();
  const isToday = sameDay(day, today);
  const nowMin = today.getHours() * 60 + today.getMinutes();
  const dayName = isToday ? "Today" : sameDay(day, addDays(today, 1)) ? "Tomorrow" : sameDay(day, addDays(today, -1)) ? "Yesterday" : null;
  const dateLabel = fmt(day, isPhone ? { weekday: "short", month: "short", day: "numeric" } : { weekday: "long", month: "long", day: "numeric" });

  const busyPeople = everyone.filter((p) => p.id !== me.id && conflicts.has(p.id));
  const summary = busy ? availabilityText(busyPeople, everyone.length - 1, conflicts.has(me.id)) : null;
  const width = LABEL_W + 24 * HOUR_W;
  const rowsH = everyone.length * ROW_H;

  return (
    <Sheet
      open
      onClose={onClose}
      title="Find a time"
      size="full"
      footer={
        <>
          <ItemButton block onClick={onClose}>
            Cancel
          </ItemButton>
          <ItemButton
            block
            variant="primary"
            onClick={() => {
              onPick(propS, propE);
              onClose();
            }}
          >
            Use this time
          </ItemButton>
        </>
      }
    >
      <div className="flex h-[74dvh] min-h-0 flex-col gap-3 md:h-full">
        {/* Day + "next free" */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <button
              type="button"
              aria-label="Previous day"
              onClick={() => moveDay(-1)}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0 px-1 text-center md:text-left" aria-live="polite">
              <p className="truncate text-sm font-semibold text-[var(--text)]">{dateLabel}</p>
              {dayName && <p className="text-xs leading-tight text-[var(--text-muted)]">{dayName}</p>}
            </div>
            <button
              type="button"
              aria-label="Next day"
              onClick={() => moveDay(1)}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <ItemButton
            size="sm"
            onClick={() => void findNext()}
            disabled={searching}
            icon={searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 text-[var(--item-accent)]" />}
            className="max-md:w-full max-md:!h-10"
          >
            Next time everyone's free
          </ItemButton>
        </div>

        {/* The grid */}
        <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto overscroll-contain rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div ref={grid} className="relative" style={{ width, height: HEAD_H + rowsH }} onClick={onGridClick}>
            {/* Hour header */}
            <div className="sticky top-0 z-30 flex border-b border-[var(--border)] bg-[var(--surface)]" style={{ height: HEAD_H, width }}>
              <div className="sticky left-0 z-10 shrink-0 bg-[var(--surface)]" style={{ width: LABEL_W }} />
              <div className="relative flex-1">
                {Array.from({ length: 24 }, (_, h) => (
                  <span
                    key={h}
                    className="absolute top-1/2 -translate-y-1/2 pl-1.5 text-xs tabular-nums text-[var(--text-muted)]"
                    style={{ left: h * HOUR_W }}
                  >
                    {h === 0 ? "" : hourLabel(h)}
                  </span>
                ))}
                {/* The proposed time's label, over the hours (in the header so rows scroll under it). */}
                <span
                  className="pointer-events-none absolute top-1/2 flex h-[22px] -translate-x-1/2 -translate-y-1/2 items-center whitespace-nowrap rounded-full bg-[var(--item-accent)] px-2 text-xs font-semibold tabular-nums text-white shadow-[var(--shadow-sm)]"
                  style={{ left: (startMin + dur / 2) * ppm }}
                >
                  {timeLabel(propS)} – {timeLabel(propE)}
                </span>
              </div>
            </div>

            {/* Rows */}
            {everyone.map((p, i) => {
              const spans = busy?.[p.id] ?? [];
              const dayS = day.getTime();
              const conflict = conflicts.has(p.id);
              return (
                <div key={p.id} className="absolute left-0 flex" style={{ top: HEAD_H + i * ROW_H, height: ROW_H, width }}>
                  <div
                    className="sticky left-0 z-20 flex shrink-0 items-center gap-2 border-b border-r border-[var(--border)] bg-[var(--surface)] px-2 md:px-3"
                    style={{ width: LABEL_W }}
                    title={p.id === me.id ? "You" : p.username}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="relative shrink-0">
                      <UserAvatar user={p} size={isPhone ? 30 : 28} />
                      {busy && (
                        <span
                          className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[var(--surface)]"
                          style={{ background: conflict ? BUSY_COLOR : "#3E8E5A" }}
                          aria-hidden
                        />
                      )}
                    </span>
                    {!isPhone && (
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium text-[var(--text)]">{p.id === me.id ? "You" : p.username}</span>
                        {conflict && <span className="text-xs leading-tight text-[#9a6c12] dark:text-[#e2b65e]">Not available</span>}
                      </span>
                    )}
                    <span className="sr-only">{conflict ? "Not available at the proposed time" : busy ? "Free at the proposed time" : ""}</span>
                  </div>
                  <div
                    className="relative flex-1 border-b border-[var(--border)]"
                    style={{ backgroundImage: "linear-gradient(to right, var(--border) 1px, transparent 1px)", backgroundSize: `${HOUR_W}px 100%` }}
                  >
                    {/* Night hours, quietly shaded. */}
                    <span className="pointer-events-none absolute inset-y-0 left-0 bg-[color-mix(in_srgb,var(--surface-2)_70%,transparent)]" style={{ width: SEARCH_FROM * ppm }} />
                    <span
                      className="pointer-events-none absolute inset-y-0 bg-[color-mix(in_srgb,var(--surface-2)_70%,transparent)]"
                      style={{ left: SEARCH_TO * ppm, right: 0 }}
                    />
                    {q.isLoading && <span className="absolute inset-x-2 inset-y-3 animate-pulse rounded-lg bg-[var(--surface-2)]" />}
                    {spans.map(([s, e]) => {
                      const a = Math.max(0, (s - dayS) / 60_000);
                      const b = Math.min(DAY_MIN, (e - dayS) / 60_000);
                      if (b <= 0 || a >= DAY_MIN || b <= a) return null;
                      const w = (b - a) * ppm;
                      return (
                        <span
                          key={`${s}-${e}`}
                          className="pointer-events-none absolute inset-y-1.5 flex items-center overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--text-muted)_30%,transparent)] px-2"
                          style={{ left: a * ppm + 1, width: Math.max(4, w - 2), ...BUSY_STRIPES }}
                          title={`Not available ${timeLabel(new Date(Math.max(s, dayS)))} – ${timeLabel(new Date(Math.min(e, dayS + DAY_MIN * 60_000)))}`}
                        >
                          {w > 92 && <span className="truncate text-xs font-medium text-[var(--text-muted)]">Not available</span>}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Now */}
            {isToday && (
              <span
                className="pointer-events-none absolute z-[5] w-0.5 bg-[var(--danger)]"
                style={{ left: LABEL_W + nowMin * ppm, top: HEAD_H, height: rowsH }}
                aria-hidden
              />
            )}

            {/* The proposed time, across everyone */}
            <div
              role="slider"
              tabIndex={0}
              aria-label="Proposed time"
              aria-valuemin={0}
              aria-valuemax={DAY_MIN - dur}
              aria-valuenow={startMin}
              aria-valuetext={`${timeLabel(propS)} to ${timeLabel(propE)}`}
              className="absolute z-10 cursor-grab touch-none select-none rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] active:cursor-grabbing"
              style={{ left: LABEL_W + startMin * ppm, width: Math.max(12, dur * ppm), top: HEAD_H, height: rowsH }}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => {
                e.preventDefault();
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                drag.current = { x: e.clientX, m0: startMin };
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (!d) return;
                setStartMin(clamp(snap(d.m0 + (e.clientX - d.x) / ppm)));
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  setStartMin((m) => clamp(m + (e.key === "ArrowLeft" ? -SNAP : SNAP)));
                  setReveal((r) => r + 1);
                }
              }}
            >
              {everyone.map((p, i) => {
                const conflict = conflicts.has(p.id);
                return (
                  <span
                    key={p.id}
                    className={cn("absolute inset-x-0 rounded-lg", conflict ? "border-2" : "border")}
                    style={{
                      top: i * ROW_H + 3,
                      height: ROW_H - 6,
                      borderColor: conflict ? BUSY_COLOR : "var(--item-accent)",
                      background: conflict
                        ? `color-mix(in srgb, ${BUSY_COLOR} 22%, transparent)`
                        : "color-mix(in srgb, var(--item-accent) 26%, transparent)",
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Legend + verdict */}
        <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between">
          <p className={cn("text-sm", summary?.ok ? "text-[var(--text)]" : "text-[var(--text-muted)]")} aria-live="polite">
            {q.isError ? (
              <span className="text-[var(--danger)]">Couldn't check when people are free.</span>
            ) : !summary ? (
              "Checking who's free…"
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: summary.ok ? "#3E8E5A" : BUSY_COLOR }} aria-hidden />
                {summary.text}
              </span>
            )}
          </p>
          <div className="flex shrink-0 items-center gap-3 text-xs text-[var(--text-muted)]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-4 rounded border border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_26%,transparent)]" />
              Proposed
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-4 rounded border border-[color-mix(in_srgb,var(--text-muted)_30%,transparent)]" style={BUSY_STRIPES} />
              Not available
            </span>
            <span className="hidden sm:inline">Drag the block or tap a spot</span>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
