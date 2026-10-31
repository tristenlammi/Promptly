import { Check, Minus, X } from "lucide-react";
import { useMemo } from "react";

import { fmtDay } from "@/items/ui";
import { cn } from "@/utils/cn";

import { WEEKDAYS, dayState, dn, ds, isFlexible, wd, weekStartOf, type LogMap } from "./engine";
import { useWidth } from "./hooks";
import type { Habit } from "./types";

const monthShort = new Intl.DateTimeFormat(undefined, { month: "short" });

/**
 * A GitHub-style year grid that fills its card: as many weeks as fit (up to
 * ``maxWeeks``), newest on the right, month labels on top, weekday labels on
 * the left. (The kit Heatmap uses fixed 12px cells and scrolls from the
 * oldest week, which leaves gaps on a phone and hides "now" when narrow.)
 */
export function FillHeatmap({
  days,
  today,
  weekStart,
  maxWeeks = 53,
  since,
  color = "var(--item-accent)",
  label,
}: {
  /** The first day with data: no need to show a year of empty weeks before it. */
  since?: string | null;
  days: Record<string, number>;
  today: string;
  weekStart: number;
  maxWeeks?: number;
  color?: string;
  label?: (day: string, level: number) => string;
}) {
  const [ref, w] = useWidth();
  const gap = 3;
  const lead = 22; // weekday label column
  const fit = Math.floor((w - lead + gap) / (13 + gap));
  const t0 = dn(today);
  const needed = since ? Math.ceil((weekStartOf(t0, weekStart) - weekStartOf(dn(since), weekStart)) / 7) + 1 : maxWeeks;
  const weeks = Math.max(6, Math.min(maxWeeks, fit || 17, Math.max(needed, 16)));
  const cell = w ? Math.max(10, Math.min(22, Math.floor((w - lead + gap) / weeks) - gap)) : 13;
  const t = dn(today);
  const first = weekStartOf(t, weekStart) - (weeks - 1) * 7;
  const cols = useMemo(() => {
    const out: { n: number; month: string | null }[] = [];
    for (let i = 0; i < weeks; i++) {
      const n = first + i * 7;
      // Label the column holding the 1st of a month (and the first column).
      let month: string | null = null;
      for (let k = 0; k < 7; k++) {
        const d = ds(n + k);
        if (d.endsWith("-01")) month = monthShort.format(new Date(`${d}T12:00:00`));
      }
      out.push({ n, month });
    }
    return out;
  }, [first, weeks]);
  const shade = (l: number) =>
    l <= 0
      ? "var(--surface-2)"
      : l >= 4
        ? color
        : `color-mix(in srgb, ${color} ${[0, 30, 55, 78][l]}%, var(--surface-2))`;

  return (
    <div ref={ref} className="w-full" role="img" aria-label={`Activity over the last ${weeks} weeks`}>
      <div className="grid" style={{ gridTemplateColumns: `${lead}px repeat(${weeks}, ${cell}px)`, columnGap: gap, rowGap: gap }}>
        <span />
        {cols.map((c) => (
          <span key={`m${c.n}`} className="h-3.5 overflow-visible whitespace-nowrap text-[10px] leading-none text-[var(--text-muted)]">
            {c.month ?? ""}
          </span>
        ))}
        {Array.from({ length: 7 }, (_, r) => (
          <Row key={r} r={r} cols={cols} t={t} cell={cell} days={days} shade={shade} label={label} weekStart={weekStart} />
        ))}
      </div>
    </div>
  );
}

function Row({
  r,
  cols,
  t,
  cell,
  days,
  shade,
  label,
  weekStart,
}: {
  r: number;
  cols: { n: number }[];
  t: number;
  cell: number;
  days: Record<string, number>;
  shade: (l: number) => string;
  label?: (day: string, level: number) => string;
  weekStart: number;
}) {
  const name = WEEKDAYS[(r + weekStart) % 7];
  return (
    <>
      <span className="flex items-center text-[10px] leading-none text-[var(--text-muted)]" style={{ height: cell }}>
        {r % 2 === 0 ? name.slice(0, 1) : ""}
      </span>
      {cols.map((c) => {
        const n = c.n + r;
        if (n > t) return <span key={n} style={{ width: cell, height: cell }} />;
        const d = ds(n);
        const l = days[d] ?? 0;
        return (
          <span
            key={n}
            title={label ? label(d, l) : d}
            className={cn("rounded-[3px]", n === t && "ring-1 ring-[var(--text-muted)]")}
            style={{ width: cell, height: cell, background: shade(l) }}
          />
        );
      })}
    </>
  );
}

/**
 * The last ``count`` days of one habit as tappable dots (Loop's main-screen
 * pattern): filled = done, tinted = partly, dashed = skipped, ring = missed,
 * small dot = not scheduled. Tapping opens that day's log.
 */
export function HistoryStrip({
  habit,
  logs,
  today,
  weekStart,
  count = 7,
  onOpenDay,
}: {
  habit: Habit;
  logs: LogMap;
  today: string;
  weekStart: number;
  count?: number;
  onOpenDay?: (day: string) => void;
}) {
  const t = dn(today);
  const flex = isFlexible(habit);
  const cells = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const n = t - count + 1 + i;
        const s = dayState(habit, n, t, weekStart, logs);
        const started = !habit.start_date || dn(habit.start_date) <= n;
        const missed = started && !flex && s.due && !s.done && !s.skipped && n < t;
        const partial = !s.done && !s.skipped && s.value > 0 && habit.type !== "avoid";
        return { n, s, missed, partial, started };
      }),
    [habit, logs, t, weekStart, count, flex],
  );
  return (
    <div className="flex items-center gap-1" role="group" aria-label={`${habit.name}: last ${count} days`}>
      {cells.map(({ n, s, missed, partial, started }) => {
        const day = ds(n);
        const what = s.skipped ? "skipped" : s.failed ? "slipped" : s.done ? "done" : partial ? "partly done" : missed ? "missed" : n === t ? "to do" : "not scheduled";
        const body = (
          <span
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums",
              s.done && "text-white",
              s.skipped && "border border-dashed border-[var(--text-muted)] text-[var(--text-muted)]",
              s.failed && "text-[var(--danger)]",
              missed && "border-2",
              !s.done && n === t && !s.skipped && "border-2 border-dashed",
            )}
            style={
              s.done
                ? { background: habit.color }
                : partial
                  ? { background: `color-mix(in srgb, ${habit.color} 30%, transparent)` }
                  : s.failed
                    ? { background: "color-mix(in srgb, var(--danger) 14%, transparent)" }
                    : missed || n === t
                      ? { borderColor: `color-mix(in srgb, ${habit.color} 45%, transparent)` }
                      : undefined
            }
          >
            {s.done ? (
              <Check className="h-3.5 w-3.5" strokeWidth={3} />
            ) : s.skipped ? (
              <Minus className="h-3 w-3" />
            ) : s.failed ? (
              <X className="h-3.5 w-3.5" />
            ) : !missed && n !== t && !partial ? (
              <span className={cn("h-1 w-1 rounded-full bg-[var(--text-muted)]", started ? "opacity-50" : "opacity-20")} />
            ) : null}
          </span>
        );
        return onOpenDay ? (
          <button
            key={n}
            type="button"
            onClick={() => onOpenDay(day)}
            aria-label={`${fmtDay(day)}: ${what}`}
            title={`${fmtDay(day)}: ${what}`}
            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
          >
            {body}
          </button>
        ) : (
          <span key={n} aria-label={`${fmtDay(day)}: ${what}`}>
            {body}
          </span>
        );
      })}
    </div>
  );
}

/** Weekday initials above a HistoryStrip (desktop list header). */
export function HistoryHead({ today, count = 7 }: { today: string; count?: number }) {
  const t = dn(today);
  return (
    <div className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: count }, (_, i) => {
        const n = t - count + 1 + i;
        return (
          <span key={n} className={cn("flex w-7 flex-col items-center text-[10px] leading-tight", n === t ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]")}>
            <span>{WEEKDAYS[wd(n)].slice(0, 1)}</span>
            <span className="tabular-nums">{Number(ds(n).slice(8))}</span>
          </span>
        );
      })}
    </div>
  );
}
