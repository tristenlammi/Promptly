import { ArrowLeft, ChevronLeft, ChevronRight, Pencil, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import { Card, IconButton, ItemButton, ProgressRing, Section, Stat, StatGrid, fmtDay } from "@/items/ui";
import { Bars, TrendChart } from "@/items/ui/charts";
import { cn } from "@/utils/cn";

import { WEEKDAYS, configOn, dayLevel, describeGoal, describeSchedule, dn, ds, fraction, habitStats, isFlexible, isMet, periodOf, startOf, streakUnit, wd } from "./engine";
import { useWidth } from "./hooks";
import { HabitBadge } from "./parts";
import { FillHeatmap } from "./viz";
import type { Habit, HabitsData } from "./types";
import { TIMES, pct } from "./util";

const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

/** One habit in depth: streaks, strength, rates, heatmap, calendar, weekdays, trend, notes. */
export function HabitDetail({
  habit,
  data,
  today,
  onEdit,
  onOpenDay,
  ask,
  onBack,
  compact,
}: {
  habit: Habit;
  data: HabitsData;
  today: string;
  onEdit?: () => void;
  onOpenDay?: (day: string) => void;
  ask?: (prompt: string) => void;
  onBack?: () => void;
  compact?: boolean;
}) {
  const t = dn(today);
  const ws = data.settings.week_start;
  const st = useMemo(() => habitStats(habit, t, ws), [habit, t, ws]);
  const levels = useMemo(() => {
    const out: Record<string, number> = {};
    const start = startOf(habit) ?? t;
    for (let n = Math.max(start, t - 7 * 53); n <= t; n++) out[ds(n)] = dayLevel(habit, st.logs, n, t);
    return out;
  }, [habit, st.logs, t]);
  const trend = useMemo(() => {
    const s = st.series;
    if (!s.length) return [];
    const pts: { x: string; y: number }[] = [];
    const from = Math.max(0, s.length - 180);
    for (let i = from; i < s.length; i += 7) pts.push({ x: fmtDay(ds(s[i].n)).replace(/^\w+ /, ""), y: Math.round(s[i].v * 100) });
    const last = s[s.length - 1];
    pts.push({ x: "Now", y: Math.round(last.v * 100) });
    return pts;
  }, [st.series]);
  const notes = useMemo(() => [...habit.logs].reverse().filter((l) => l.note).slice(0, 8), [habit.logs]);
  const period = st.periods[st.periods.length - 1];
  const score = Math.round(st.score * 100);
  const tod = TIMES.find((x) => x.id === habit.time_of_day)?.label;
  // Four stat tiles in a row only when each gets ~150px.
  const [ref, w] = useWidth();
  const narrow = w > 0 && w < 620;

  return (
    <div ref={ref} className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        {onBack && <IconButton label="Back to all habits" icon={ArrowLeft} onClick={onBack} />}
        <HabitBadge habit={habit} size={48} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-[var(--text)]">{habit.name}</h2>
          <p className="truncate text-sm text-[var(--text-muted)]">
            {[describeGoal(habit), describeSchedule(habit), tod, habit.area].filter(Boolean).join(" · ")}
            {habit.archived ? " · Archived" : ""}
          </p>
        </div>
        {onEdit && <IconButton label="Edit habit" icon={Pencil} onClick={onEdit} />}
      </div>

      {(habit.intention || habit.identity) && (
        <Card className="flex flex-col gap-1 bg-[color-mix(in_srgb,var(--item-accent)_7%,var(--surface))]">
          {habit.intention && <p className="text-sm text-[var(--text)]">{habit.intention}</p>}
          {habit.identity && <p className="text-xs italic text-[var(--text-muted)]">{habit.identity}</p>}
        </Card>
      )}

      <StatGrid className={cn(narrow && "md:!grid-cols-2")}>
        <Stat label="Current streak" value={st.current} unit={st.unit} tone="accent" />
        <Stat label="Best streak" value={st.best} unit={streakUnit(habit, st.best)} />
        <Card className="flex items-center gap-3">
          <ProgressRing value={st.score} size={52} color={habit.color}>
            {score}
          </ProgressRing>
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--text-muted)]">Strength</p>
            <p className={cn("text-xs tabular-nums", st.scoreChange30 >= 0 ? "text-[var(--success)]" : "text-[var(--text-muted)]")}>
              {st.scoreChange30 >= 0 ? "+" : ""}
              {Math.round(st.scoreChange30 * 100)} in 30 d
            </p>
          </div>
        </Card>
        <Stat label="Last 30 days" value={pct(st.rate30)} delta={`${st.timesDone} times in all`} />
      </StatGrid>

      {period && (
        <Card className="flex items-center justify-between gap-3">
          <span className="text-sm text-[var(--text)]">
            {habit.schedule.kind === "per_week" ? "This week" : "This month"}: <strong className="tabular-nums">{period.done}</strong> of{" "}
            <span className="tabular-nums">{period.required}</span>
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            {period.status === "done" ? "Target reached 🎉" : period.status === "pending" ? `${period.left} day${period.left === 1 ? "" : "s"} left` : period.status === "neutral" ? "Skipped" : "Missed"}
          </span>
        </Card>
      )}

      <Section title="Completion">
        <div className="grid grid-cols-4 gap-2">
          {(
            [
              ["7 days", st.rate7],
              ["30 days", st.rate30],
              ["90 days", st.rate90],
              ["All time", st.rateAll],
            ] as const
          ).map(([label, v]) => (
            <Card key={label} className="flex flex-col items-center gap-1 !p-3">
              <span className="text-lg font-semibold tabular-nums text-[var(--text)]">{pct(v)}</span>
              <span className="text-[11px] text-[var(--text-muted)]">{label}</span>
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Calendar" hint={onOpenDay ? "Tap a day to log or fix it" : undefined}>
        <MonthCalendar habit={habit} data={data} today={today} onOpenDay={onOpenDay} />
      </Section>

      <Section title="History">
        <Card>
          <FillHeatmap days={levels} today={today} weekStart={ws} since={habit.start_date} maxWeeks={53} color={habit.color} label={(d, l) => `${fmtDay(d)}: ${l >= 4 ? "done" : l > 0 ? "partly" : "—"}`} />
        </Card>
      </Section>

      <div className={cn("grid gap-5", !compact && !narrow && "md:grid-cols-2")}>
        <Section title="Strength over time">
          <Card>
            {trend.length > 1 ? <TrendChart data={trend} unit="%" yDomain={[0, 100]} height={160} /> : <p className="py-6 text-center text-sm text-[var(--text-muted)]">A trend appears after a week or two.</p>}
          </Card>
        </Section>
        <Section title="By weekday">
          <Card>
            <Bars data={st.weekdays.map((w) => ({ x: w.weekday, y: w.rate === null ? 0 : Math.round(w.rate * 100) }))} unit="%" height={160} color={habit.color} />
          </Card>
        </Section>
      </div>

      {notes.length > 0 && (
        <Section title="Notes">
          <Card className="flex flex-col gap-2">
            {notes.map((l) => (
              <div key={l.day} className="flex gap-3 text-sm">
                <span className="w-20 shrink-0 text-xs text-[var(--text-muted)]">{fmtDay(l.day)}</span>
                <span className="min-w-0 flex-1 text-[var(--text)]">{l.note}</span>
              </div>
            ))}
          </Card>
        </Section>
      )}

      {habit.why && (
        <Section title="Why">
          <Card>
            <p className="whitespace-pre-wrap text-sm text-[var(--text)]">{habit.why}</p>
          </Card>
        </Section>
      )}

      {ask && (
        <ItemButton
          icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />}
          onClick={() => ask(`Look at my stats for "${habit.name}" and tell me what's working, what isn't, and one tiny tweak.`)}
        >
          Ask the coach about this habit
        </ItemButton>
      )}
    </div>
  );
}

function MonthCalendar({ habit, data, today, onOpenDay }: { habit: Habit; data: HabitsData; today: string; onOpenDay?: (day: string) => void }) {
  const t = dn(today);
  const ws = data.settings.week_start;
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const st = useMemo(() => habitStats(habit, t, ws), [habit, t, ws]);
  const [first, last] = periodOf(dn(`${month}-01`), "per_month", ws);
  const gridStart = first - ((wd(first) - ws + 7) % 7);
  const cells: number[] = [];
  for (let n = gridStart; n <= last || cells.length % 7; n++) cells.push(n);
  const start = startOf(habit);
  const shift = (k: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + k, 1));
    setMonth(d.toISOString().slice(0, 7));
  };
  const heads = Array.from({ length: 7 }, (_, i) => WEEKDAYS[(i + ws) % 7]);
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <IconButton label="Previous month" icon={ChevronLeft} onClick={() => shift(-1)} />
        <span className="text-sm font-semibold text-[var(--text)]">{monthFmt.format(new Date(`${month}-15T12:00:00`))}</span>
        <IconButton label="Next month" icon={ChevronRight} onClick={() => shift(1)} disabled={month >= today.slice(0, 7)} />
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {heads.map((h) => (
          <span key={h} className="text-[11px] font-medium text-[var(--text-muted)]">
            {h.slice(0, 2)}
          </span>
        ))}
        {cells.map((n) => {
          const inMonth = n >= first && n <= last;
          const day = ds(n);
          const l = st.logs.get(n);
          const future = n > t;
          const before = start === null || n < start;
          const v = configOn(habit, n);
          const met = !future && !before && isMet(v, l, n, t) && (v.type !== "avoid" || !!l || n < t);
          const part = !met && l && !l.skipped ? fraction(v, l, n, t) : 0;
          const status = st.statuses.get(n);
          const missed = status === "missed";
          const off = status === "off" && !isFlexible(v);
          const label = `${fmtDay(day)}: ${l?.skipped ? "skipped" : met ? "done" : part ? "partly done" : missed ? "missed" : off ? "not scheduled" : future ? "upcoming" : "—"}`;
          const body = (
            <span
              className={cn(
                "relative flex h-9 w-9 items-center justify-center rounded-full text-xs tabular-nums transition md:h-10 md:w-10",
                !inMonth && "opacity-30",
                n === t && "ring-2 ring-[var(--item-accent)]",
                met ? "font-semibold text-white" : "text-[var(--text)]",
                (before || off) && !met && "text-[var(--text-muted)]",
                l?.skipped && "border border-dashed border-[var(--text-muted)]",
              )}
              style={
                met
                  ? { background: habit.color }
                  : part
                    ? { background: `color-mix(in srgb, ${habit.color} ${Math.round(18 + part * 40)}%, transparent)` }
                    : undefined
              }
            >
              {Number(day.slice(8))}
              {missed && <span className="absolute bottom-1 h-1 w-1 rounded-full bg-[var(--text-muted)] opacity-60" aria-hidden />}
            </span>
          );
          return onOpenDay && !future && inMonth ? (
            <button key={n} type="button" aria-label={label} onClick={() => onOpenDay(day)} className="flex justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]">
              {body}
            </button>
          ) : (
            <span key={n} className="flex justify-center" aria-label={inMonth ? label : undefined}>
              {body}
            </span>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-[var(--text-muted)]">
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: habit.color }} /> Done
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: `color-mix(in srgb, ${habit.color} 35%, transparent)` }} /> Partly
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-full border border-dashed border-[var(--text-muted)]" /> Skipped
        </span>
      </div>
    </Card>
  );
}
