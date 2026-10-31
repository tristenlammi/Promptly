import { ChevronLeft, ChevronRight, Dumbbell, Flame, LineChart, Search, Sparkles, Trophy } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { Card, EmptyState, IconButton, ItemButton, List, ListRow, Page, ScrollRow, Chip, Section, Segmented, Sheet, Stat, StatGrid, TextInput, addDays, fmtDay, todayISO } from "@/items/ui";
import { Bars, Heatmap, Sparkline, TrendChart } from "@/items/ui/charts";
import { cn } from "@/utils/cn";

import { fmtSet } from "./Logger";
import { PR_LABEL, fmtRecord, fmtW, fmtWeekRange, isHard, sessionStats, streakWeeks, toUnit, weekStartOf, weeklyVolume, type RecordKind } from "./science";
import { ActiveBanner, ExerciseBadge, muscleLine, useWorkoutCtx, type Ctx } from "./shared";
import type { Exercise, WorkoutData } from "./types";
import { VolumeBars } from "./Volume";

const BOARD: RecordKind[] = ["e1rm", "1rm", "3rm", "5rm", "10rm"];

/** An estimate shown to 0.1 in their unit ("53.8 kg", not "53.83 kg"). */
function e1(kg: number | null | undefined, s: WorkoutData["settings"]): string {
  // Rounded in kg first, like the record book, so the two never disagree by 0.1.
  return fmtW(kg == null ? 0 : Math.round(kg * 10) / 10, s);
}

export function Progress({ item, isPhone, ask, goTo }: ItemViewProps<WorkoutData>) {
  const { ctx } = useWorkoutCtx(item);
  const data = item.data;
  const s = data.settings;
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [week, setWeek] = useState(() => weekStartOf(todayISO(), s));
  const done = useMemo(() => {
    if (!ctx) return [];
    return [...ctx.hist.entries()]
      .map(([id, sessions]) => ({ ex: ctx.lib.get(id), sessions, last: sessions[sessions.length - 1].workout.date }))
      .sort((a, b) => b.last.localeCompare(a.last) || b.sessions.length - a.sessions.length);
  }, [ctx]);
  const heat = useMemo(() => {
    const out: Record<string, number> = {};
    for (const w of data.workouts) {
      const sets = w.exercises.reduce((n, we) => n + we.sets.filter(isHard).length, 0);
      out[w.date] = Math.max(out[w.date] ?? 0, sets >= 25 ? 4 : sets >= 16 ? 3 : sets >= 8 ? 2 : 1);
    }
    return out;
  }, [data.workouts]);
  const vol = useMemo(() => (ctx ? weeklyVolume(data, ctx.lib, week, "logged") : {}), [ctx, data, week]);

  const today = todayISO();
  const monthCount = data.workouts.filter((w) => w.date.slice(0, 7) === today.slice(0, 7)).length;
  const last8 = data.workouts.filter((w) => w.date >= addDays(today, -56)).length;
  const board = done.filter((d) => d.ex.log === "weight_reps" && d.ex.compound && ctx.records.get(d.ex.id)?.e1rm).slice(0, 8);
  const shown = done.filter((d) => !q || d.ex.name.toLowerCase().includes(q.toLowerCase()));

  if (!data.workouts.length)
    return (
      <Page>
        <EmptyState
          icon={LineChart}
          title="Your progress shows up here"
          text="Estimated 1RMs, PRs, weekly sets per muscle vs volume landmarks and your consistency — after your first logged workout."
          action={<ItemButton variant="primary" icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Plan my training week with the exact weights to use")}>Plan my first week</ItemButton>}
        />
      </Page>
    );

  const detail = sel ? <ExerciseDetail ctx={ctx} data={data} id={sel} ask={ask} /> : null;
  const exerciseList = (
    <Section title="Exercises" hint={`${done.length} you've trained`}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an exercise" className="pl-9" aria-label="Find an exercise" />
      </div>
      <List>
        {shown.slice(0, 60).map(({ ex, sessions }) => {
          const series = sessions.slice(-12).map((h) => sessionStats(h.we, ex, s)).map((st) => (ex.log === "weight_reps" ? st.e1rm ?? 0 : ex.log === "duration" ? st.maxSeconds : ex.log === "distance" ? st.maxMeters : st.maxReps));
          const rec = ctx.records.get(ex.id);
          return (
            <ListRow
              key={ex.id}
              selected={sel === ex.id}
              leading={<ExerciseBadge ex={ex} lib={ctx.lib} size={36} />}
              title={ex.name}
              subtitle={`${sessions.length} session${sessions.length === 1 ? "" : "s"} · last ${fmtDay(sessions[sessions.length - 1].workout.date)}`}
              trailing={
                <span className="flex items-center gap-2">
                  <Sparkline values={series} width={56} />
                  <span className="w-16 text-right text-xs font-semibold tabular-nums text-[var(--text)]">
                    {rec?.e1rm ? fmtW(rec.e1rm.value, s) : rec?.max_reps ? `${rec.max_reps.value} reps` : rec?.longest ? fmtRecord("longest", rec.longest.value, s) : rec?.farthest ? fmtRecord("farthest", rec.farthest.value, s) : ""}
                  </span>
                </span>
              }
              onClick={() => setSel(ex.id)}
            />
          );
        })}
      </List>
    </Section>
  );

  const overview = (
    <div className="flex flex-col gap-5">
      <ActiveBanner data={data} goTo={goTo} />
      <StatGrid className="md:grid-cols-2">
        <Stat label="Workouts" value={data.workouts.length} icon={Dumbbell} tone="accent" />
        <Stat label="This month" value={monthCount} />
        <Stat label="Week streak" value={streakWeeks(data)} icon={Flame} />
        <Stat label="Per week (8 wk)" value={(last8 / 8).toFixed(1)} unit={`/ ${s.days_per_week}`} />
      </StatGrid>
      <Section title="Consistency" hint="Last 6 months">
        <Card>
          <Heatmap days={heat} weeks={18} label={(d, l) => `${fmtDay(d)}${l ? " — trained" : ""}`} />
        </Card>
      </Section>
      <Section
        title="Sets per muscle"
        hint={week === weekStartOf(today, s) ? `This week · ${fmtWeekRange(week)}` : fmtWeekRange(week)}
        action={
          <div className="flex items-center">
            <IconButton label="Previous week" icon={ChevronLeft} onClick={() => setWeek(addDays(week, -7))} />
            <IconButton label="Next week" icon={ChevronRight} onClick={() => setWeek(addDays(week, 7))} disabled={week >= weekStartOf(today, s)} />
          </div>
        }
      >
        <Card>
          <VolumeBars sets={vol} muscles={ctx.lib.catalog.muscles} compact={isPhone} />
        </Card>
        <ItemButton size="sm" variant="ghost" icon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => ask("Look at my weekly sets per muscle over the last 4 weeks vs MEV/MAV/MRV and adjust my plan where it's off.")} className="self-start">
          Ask the coach to balance it
        </ItemButton>
      </Section>
      {board.length > 0 && (
        <Section title="PR board" hint={`Main lifts · ${s.units}`}>
          {/* One row per lift: the e1RM big on the right, the rep maxes under
              the name — fits a phone with no sideways scroll. */}
          <Card padded={false}>
            <ul className="divide-y divide-[var(--border)]">
              {board.map(({ ex }) => {
                const rec = ctx.records.get(ex.id) ?? {};
                return (
                  <li key={ex.id}>
                    <button type="button" onClick={() => setSel(ex.id)} className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--hover)]">
                      <ExerciseBadge ex={ex} lib={ctx.lib} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-[var(--text)]">{ex.name.replace(/ \(Barbell\)$/, "")}</span>
                        <span className="block truncate text-[11px] tabular-nums text-[var(--text-muted)]">
                          {BOARD.filter((k) => k !== "e1rm" && rec[k]).map((k) => `${PR_LABEL[k]} ${fmtW(rec[k]!.value, s, false)}`).join(" · ") || "—"}
                        </span>
                      </span>
                      <span className="shrink-0 text-right" title={rec.e1rm ? `Set ${fmtDay(rec.e1rm.date)}` : undefined}>
                        <span className="block text-base font-semibold tabular-nums text-[var(--text)]">{rec.e1rm ? fmtW(rec.e1rm.value, s, false) : "–"}</span>
                        <span className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{PR_LABEL.e1rm}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
        </Section>
      )}
      <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Review my last month of training: consistency, volume per muscle, PRs, stalled lifts and whether I need a deload.")}>
        Review my month
      </ItemButton>
    </div>
  );

  if (isPhone)
    return (
      <Page>
        {overview}
        {exerciseList}
        {sel && (
          <Sheet open onClose={() => setSel(null)} title={ctx.lib.get(sel).name} size="full">
            {detail}
          </Sheet>
        )}
      </Page>
    );
  return (
    <Page wide>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-6">
        <div className="flex flex-col gap-5">
          {overview}
        </div>
        <div className="flex flex-col gap-5">
          {detail ? (
            <Card className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <ExerciseBadge ex={ctx.lib.get(sel!)} lib={ctx.lib} />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-semibold text-[var(--text)]">{ctx.lib.get(sel!).name}</h2>
                  <p className="truncate text-xs text-[var(--text-muted)]">{muscleLine(ctx.lib.get(sel!), ctx.lib)}</p>
                </div>
                <ItemButton size="sm" variant="ghost" onClick={() => setSel(null)}>Close</ItemButton>
              </div>
              {detail}
            </Card>
          ) : null}
          {exerciseList}
        </div>
      </div>
    </Page>
  );
}

type Metric = "e1rm" | "top" | "volume" | "reps";
type Range = "3m" | "6m" | "1y" | "all";

export function ExerciseDetail({ ctx, data, id, ask }: { ctx: Ctx; data: WorkoutData; id: string; ask: (p: string) => void }) {
  const ex: Exercise = ctx.lib.get(id);
  const s = data.settings;
  const sessions = ctx.hist.get(id) ?? [];
  const weighted = ex.log === "weight_reps";
  const [metric, setMetric] = useState<Metric>(weighted ? "e1rm" : "reps");
  const [range, setRange] = useState<Range>("6m");
  const since = range === "all" ? "" : addDays(todayISO(), -({ "3m": 91, "6m": 182, "1y": 365 } as const)[range]);
  const rows = sessions.filter((h) => h.workout.date >= since).map((h) => ({ h, st: sessionStats(h.we, ex, s) }));
  const unitLabel = metric === "reps" ? (ex.log === "duration" ? "s" : ex.log === "distance" ? "m" : "reps") : s.units;
  const points = rows.map(({ h, st }) => ({
    x: new Date(h.workout.date + "T12:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }),
    y:
      metric === "e1rm" ? toUnit(st.e1rm, s) : metric === "top" ? toUnit(st.topKg, s) : metric === "volume" ? toUnit(st.volume, s) : ex.log === "duration" ? st.maxSeconds : ex.log === "distance" ? st.maxMeters : st.maxReps,
  }));
  const rec = ctx.records.get(id) ?? {};
  const first = rows.find((r) => r.st.e1rm)?.st.e1rm;
  const lastE = [...rows].reverse().find((r) => r.st.e1rm)?.st.e1rm;
  const change = first && lastE ? ((lastE - first) / first) * 100 : null;
  return (
    <div className="flex flex-col gap-4">
      {weighted ? (
        <Segmented value={metric} onChange={setMetric} options={[{ value: "e1rm", label: "Est. 1RM" }, { value: "top", label: "Heaviest" }, { value: "volume", label: "Volume" }]} />
      ) : null}
      <ScrollRow>
        {(["3m", "6m", "1y", "all"] as Range[]).map((r) => (
          <Chip key={r} active={range === r} onClick={() => setRange(r)}>
            {r === "all" ? "All time" : r.toUpperCase()}
          </Chip>
        ))}
      </ScrollRow>
      {points.length >= 2 ? (
        metric === "volume" ? <Bars data={points} unit={unitLabel} height={190} /> : <TrendChart data={points} unit={unitLabel} height={190} />
      ) : (
        <p className="rounded-xl bg-[var(--surface-2)] p-4 text-center text-sm text-[var(--text-muted)]">{points.length ? "One session so far — the chart starts with the second." : "Nothing in this range."}</p>
      )}
      {change !== null && rows.length >= 2 && (
        <p className={cn("text-sm", change >= 0 ? "text-[var(--success)]" : "text-[var(--warning)]")}>
          {Math.abs(change) < 0.05
            ? `Estimated 1RM unchanged over this range (${e1(first, s)}).`
            : `Estimated 1RM ${change > 0 ? "up" : "down"} ${Math.abs(change).toFixed(1)}% over this range (${e1(first, s)} → ${e1(lastE, s)}).`}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {(Object.keys(rec) as RecordKind[]).map((k) => (
          <div key={k} className="rounded-xl bg-[var(--surface-2)] p-2.5">
            <div className="flex items-center gap-1 text-[11px] font-medium text-[var(--text-muted)]">
              <Trophy className="h-3 w-3" /> {PR_LABEL[k]}
            </div>
            <div className="text-base font-semibold tabular-nums text-[var(--text)]">{fmtRecord(k, rec[k]!.value, s)}</div>
            <div className="text-[10px] text-[var(--text-muted)]">
              {fmtDay(rec[k]!.date)}
              {k === "e1rm" && rec[k]!.kg ? ` · ${fmtW(rec[k]!.kg, s, false)}×${rec[k]!.reps}` : ""}
            </div>
          </div>
        ))}
      </div>
      <Section title="Sessions">
        <List>
          {[...rows].reverse().slice(0, 20).map(({ h, st }) => (
            <ListRow
              key={h.workout.id + h.we.id}
              title={fmtDay(h.workout.date)}
              subtitle={h.we.sets.filter(isHard).map((x) => fmtSet(x, ex, s)).join(", ")}
              trailing={st.e1rm ? <span className="tabular-nums">{e1(st.e1rm, s)}</span> : null}
            />
          ))}
        </List>
      </Section>
      <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask(`How is my ${ex.name} progressing? Suggest the load and reps for my next session.`)}>
        Ask about {ex.name.replace(/ \(.*\)$/, "")}
      </ItemButton>
    </div>
  );
}
