import { LineChart, Sparkles, Target } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { Card, Chip, EmptyState, ItemButton, Page, ProgressBar, ScrollRow, Section, Segmented, addDays, fmtDay } from "@/items/ui";
import { cn } from "@/utils/cn";

import { Badge, useWidth } from "./common";
import { HealthChart, type ChartBar, type ChartPoint } from "./HealthChart";
import {
  BP_BANDS,
  allMetrics,
  bpCategory,
  dailySeries,
  displayDecimals,
  ewma,
  fmtHours,
  fmtMetric,
  fmtNumber,
  glucoseBand,
  goalFor,
  indexReadings,
  rateToDisplay,
  toDisplay,
  unitLabel,
  weeklyRate,
  type MetricDef,
} from "./metrics";
import { QuickLogHost } from "./QuickLog";
import type { HealthData, Reading } from "./types";
import { todayISO } from "./zone";

type Range = "7" | "30" | "90" | "365";
const RANGES: { value: Range; label: string }[] = [
  { value: "7", label: "7D" },
  { value: "30", label: "30D" },
  { value: "90", label: "90D" },
  { value: "365", label: "1Y" },
];

export function TrendsView({ item, isPhone, ask }: ItemViewProps<HealthData>) {
  const data = item.data;
  const idx = useMemo(() => indexReadings(data.readings), [data.readings]);
  const metrics = useMemo(() => allMetrics(data).filter((m) => idx[m.id]?.length), [data, idx]);
  const [range, setRange] = useState<Range>("30");
  const [picked, setPicked] = useState<string | null>(null);
  const [measure, width] = useWidth<HTMLElement>();
  const cardCols = width >= 960 ? 4 : width >= 600 ? 3 : 2;
  const selected = metrics.find((m) => m.id === picked) ?? metrics[0];
  const end = todayISO();
  const start = addDays(end, -(Number(range) - 1));

  if (!metrics.length) {
    return (
      <Page>
        <QuickLogHost item={item} />
        <EmptyState
          icon={LineChart}
          title="Your trends appear here"
          text="Log a few readings and you'll see the smoothed trend, your weekly rate and how you're tracking against your goals."
          action={<ItemButton onClick={() => ask("What should I track to get a good picture of my health, and how often?")}>What should I track?</ItemButton>}
        />
      </Page>
    );
  }

  const picker = isPhone ? (
    <ScrollRow>
      {metrics.map((m) => (
        <Chip key={m.id} active={selected?.id === m.id} onClick={() => setPicked(m.id)} icon={<m.icon className="h-3.5 w-3.5" />}>
          {m.label}
        </Chip>
      ))}
    </ScrollRow>
  ) : (
    <div className={cn("grid gap-3", cardCols === 4 ? "grid-cols-4" : cardCols === 3 ? "grid-cols-3" : "grid-cols-2")}>
      {metrics.map((m) => (
        <MetricCard key={m.id} def={m} rows={idx[m.id]} data={data} start={start} active={selected?.id === m.id} onClick={() => setPicked(m.id)} />
      ))}
    </div>
  );

  return (
    <Page wide={!isPhone}>
      <QuickLogHost item={item} />
      <div ref={measure} className="flex items-center justify-between gap-2">
        <h2 className="px-1 text-xl font-semibold text-[var(--text)]">Trends</h2>
        <Segmented value={range} onChange={setRange} options={RANGES} size="sm" />
      </div>
      {picker}
      {selected && <Detail def={selected} rows={idx[selected.id] ?? []} data={data} start={start} end={end} range={Number(range)} isPhone={isPhone} wide={!isPhone && width >= 820} ask={ask} />}
      <Section title="Connections" hint="Correlation isn't causation — but it's a good place to start an experiment.">
        <div className="flex flex-wrap gap-2">
          {[
            "Does my sleep affect my mood the next day?",
            "Do my steps relate to my resting heart rate?",
            "What seems to come before my symptoms?",
            "Is my weight trend on track for my goal?",
          ].map((q) => (
            <Chip key={q} onClick={() => ask(q)} icon={<Sparkles className="h-3 w-3" />}>
              {q}
            </Chip>
          ))}
        </div>
      </Section>
    </Page>
  );
}

function MetricCard({
  def,
  rows,
  data,
  start,
  active,
  onClick,
}: {
  def: MetricDef;
  rows: Reading[];
  data: HealthData;
  start: string;
  active: boolean;
  onClick: () => void;
}) {
  const s = data.settings;
  const series = useMemo(() => dailySeries(rows, def.id, def.agg, start), [rows, def, start]);
  const last = rows[rows.length - 1];
  const value =
    def.kind === "bp" ? (last ? `${last.sys}/${last.dia}` : "–") : def.id === "sleep" ? (series.length ? fmtHours(series[series.length - 1].v) : "–") : fmtMetric(def, series[series.length - 1]?.v ?? last?.value ?? null, s);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-2xl border bg-[var(--surface)] p-3 text-left shadow-[var(--shadow-sm)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
        active ? "border-[var(--item-accent)]" : "border-[var(--border)] hover:border-[var(--item-accent)]",
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
        <def.icon className="h-3.5 w-3.5 text-[var(--item-accent)]" />
        {def.label}
      </span>
      <span className="truncate text-lg font-semibold tabular-nums text-[var(--text)]">{value}</span>
      <FluidSpark values={series.map((p) => p.v)} />
    </button>
  );
}

function Detail({
  def,
  rows,
  data,
  start,
  end,
  range,
  isPhone,
  wide,
  ask,
}: {
  def: MetricDef;
  rows: Reading[];
  data: HealthData;
  start: string;
  end: string;
  range: number;
  isPhone: boolean;
  wide: boolean;
  ask: (p: string) => void;
}) {
  const s = data.settings;
  const goal = goalFor(data, def.id);
  const unit = unitLabel(def, s);
  const dp = displayDecimals(def, s);
  const disp = (v: number) => toDisplay(v, def.dim, s);
  const fmtAxis = (v: number) => (def.id === "sleep" ? `${fmtNumber(v, 1)}h` : fmtNumber(v, def.kind === "bp" ? 0 : Math.min(dp, 1)));

  const model = useMemo(() => {
    const series = dailySeries(rows, def.id, def.agg, start, end);
    const vals = series.map((p) => p.v);
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const out: {
      raw: ChartPoint[];
      trend: ChartPoint[];
      bars: ChartBar[];
      columns: ChartPoint[];
      goals: { y: number; label: string }[];
      band?: { lo: number; hi: number; label: string };
      avg: number | null;
      min: number | null;
      max: number | null;
      days: number;
      trendNow: number | null;
      change: number | null;
      rate: number | null;
    } = {
      raw: [],
      trend: [],
      bars: [],
      columns: [],
      goals: [],
      avg,
      min: vals.length ? Math.min(...vals) : null,
      max: vals.length ? Math.max(...vals) : null,
      days: series.length,
      trendNow: null,
      change: null,
      rate: null,
    };
    if (def.kind === "bp") {
      for (const r of rows) {
        if (r.at.slice(0, 10) < start || r.at.slice(0, 10) > end || r.sys === null || r.dia === null) continue;
        const c = bpCategory(r.sys, r.dia);
        out.bars.push({ day: r.at.slice(0, 10), hi: r.sys, lo: r.dia, color: c?.color ?? "var(--item-accent)", label: `${r.sys}/${r.dia} · ${c?.label ?? ""}` });
      }
      out.goals.push({ y: 120, label: "120" }, { y: 80, label: "80" });
      return out;
    }
    if (def.agg === "sum" || def.id === "steps" || (def.custom && def.agg === "max")) {
      out.columns = series.map((p) => ({ day: p.day, v: disp(p.v), color: goal?.target && p.v >= goal.target ? "var(--success)" : undefined }));
      if (goal?.target) out.goals.push({ y: disp(goal.target), label: `Goal ${def.id === "sleep" ? fmtHours(goal.target) : fmtNumber(disp(goal.target), dp)}` });
      if (def.id === "sleep") out.band = { lo: 7, hi: 9, label: "7–9 h" };
      return out;
    }
    // Readings as dots (several a day are all shown), with a smoothed trend line.
    for (const r of rows) {
      const d = r.at.slice(0, 10);
      if (d < start || d > end || r.value === null) continue;
      const color = def.id === "glucose" ? glucoseBand(r.value, r.context).color : undefined;
      out.raw.push({ day: d, v: disp(r.value), color });
    }
    const alpha = def.smooth ? s.smoothing : 0.3;
    const full = dailySeries(rows, def.id, def.agg, undefined, end);
    const tr = ewma(full, alpha).filter((p) => p.day >= start);
    if (def.id !== "glucose") out.trend = tr.map((p) => ({ day: p.day, v: disp(p.v) }));
    if (tr.length) {
      out.trendNow = tr[tr.length - 1].v;
      out.change = tr.length > 1 ? tr[tr.length - 1].v - tr[0].v : null;
      out.rate = weeklyRate(tr, Math.min(28, range));
    }
    if (goal?.target !== null && goal?.target !== undefined) out.goals.push({ y: disp(goal.target), label: `Goal ${fmtNumber(disp(goal.target), dp)}` });
    if (goal?.low !== null && goal?.low !== undefined && goal.high !== null) out.band = { lo: disp(goal.low), hi: disp(goal.high), label: "Target" };
    else if (def.id === "glucose") out.band = { lo: disp(3.9), hi: disp(7.8), label: "3.9–7.8" };
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, def, start, end, goal, s.smoothing, s.weight_unit, s.length_unit, s.glucose_unit, s.temp_unit, s.water_unit, range]);

  const bpStats = useMemo(() => {
    if (def.kind !== "bp") return null;
    const inR = rows.filter((r) => r.at.slice(0, 10) >= start && r.at.slice(0, 10) <= end && r.sys !== null && r.dia !== null);
    if (!inR.length) return null;
    const sys = Math.round(inR.reduce((a, r) => a + (r.sys ?? 0), 0) / inR.length);
    const dia = Math.round(inR.reduce((a, r) => a + (r.dia ?? 0), 0) / inR.length);
    const pulses = inR.filter((r) => r.pulse).map((r) => r.pulse as number);
    const counts: Record<string, number> = {};
    for (const r of inR) {
      const c = bpCategory(r.sys, r.dia);
      const k = c ? (c.id === "low" ? "normal" : c.id) : "normal";
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return { sys, dia, n: inR.length, pulse: pulses.length ? Math.round(pulses.reduce((a, b) => a + b, 0) / pulses.length) : null, counts, cat: bpCategory(sys, dia) };
  }, [def.kind, rows, start, end]);

  const projection = useMemo(() => {
    if (!goal || goal.target === null || model.trendNow === null || !model.rate || (goal.direction !== "down" && goal.direction !== "up")) return null;
    const remaining = goal.target - model.trendNow;
    if (Math.abs(remaining) < 1e-6) return { reached: true as const };
    if (remaining * model.rate <= 0) return { reached: false as const, remaining, away: true as const };
    const days = Math.round((remaining / model.rate) * 7);
    return { reached: false as const, remaining, day: addDays(todayISO(), days) };
  }, [goal, model.trendNow, model.rate]);

  const head =
    def.kind === "bp"
      ? bpStats
        ? `${bpStats.sys}/${bpStats.dia}`
        : "–"
      : model.trendNow !== null && def.smooth
        ? fmtMetric(def, model.trendNow, s)
        : model.avg !== null
          ? fmtMetric(def, model.avg, s)
          : "–";
  const headLabel = def.kind === "bp" ? `Average of ${bpStats?.n ?? 0} readings` : def.smooth ? "Trend now" : `Average · ${range} days`;

  // A goal far outside this range's readings would squash them into a flat
  // line (Happy Scale keeps the axis on the data); the goal row below still
  // says where it is.
  const chartGoals = useMemo(() => {
    const vals = [...model.raw.map((p) => p.v), ...model.trend.map((p) => p.v), ...model.columns.map((p) => p.v)];
    if (!vals.length || def.kind === "bp") return model.goals;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = Math.max(hi - lo, Math.abs(hi) * 0.02);
    return model.goals.filter((g) => g.y >= lo - span * 1.2 && g.y <= hi + span * 1.2);
  }, [model, def.kind]);

  const chart = (
    <HealthChart
      start={start}
      end={end}
      raw={model.raw}
      trend={model.trend}
      bars={model.bars}
      columns={model.columns}
      goals={chartGoals}
      band={model.band}
      height={isPhone ? 220 : 300}
      fmt={(v) => (def.kind === "bp" ? String(Math.round(v)) : fmtAxis(v))}
      label={`${def.label} over the last ${range} days`}
    />
  );

  const rateText =
    model.rate !== null && def.smooth
      ? `${model.rate > 0 ? "+" : ""}${fmtNumber(rateToDisplay(model.rate, def.dim, s), Math.max(1, dp))} ${unit}/week`
      : null;

  const fmtV = (v: number | null) => (v === null ? "–" : def.id === "sleep" ? fmtHours(v) : fmtNumber(disp(v), dp));
  const statItems: { label: string; value: string; sub?: string }[] =
    def.kind === "bp" && bpStats
      ? [
          { label: "Average", value: `${bpStats.sys}/${bpStats.dia}`, sub: "mmHg" },
          { label: "Pulse", value: bpStats.pulse ? String(bpStats.pulse) : "–", sub: bpStats.pulse ? "bpm" : undefined },
          { label: "Readings", value: String(bpStats.n), sub: `in ${range} days` },
        ]
      : [
          { label: "Average", value: fmtV(model.avg), sub: def.id === "sleep" ? undefined : unit },
          { label: "Lowest", value: fmtV(model.min) },
          { label: "Highest", value: fmtV(model.max) },
          { label: "Logged", value: String(model.days), sub: `of ${range} days` },
        ];
  const stats = (
    <dl
      className={cn(
        "grid overflow-hidden rounded-xl border border-[var(--border)]",
        wide ? "grid-cols-2 self-start" : statItems.length === 3 ? "grid-cols-3" : "grid-cols-4",
      )}
    >
      {statItems.map((x, i) => (
        <div
          key={x.label}
          className={cn(
            "flex min-w-0 flex-col gap-0.5 px-3 py-2.5",
            wide ? (i % 2 ? "border-l border-[var(--border)]" : "") + (i > 1 ? " border-t border-[var(--border)]" : "") : i > 0 && "border-l border-[var(--border)]",
          )}
        >
          <dt className="truncate text-[11px] font-medium text-[var(--text-muted)]">{x.label}</dt>
          <dd className="truncate text-base font-semibold tabular-nums text-[var(--text)]">{x.value}</dd>
          {x.sub && <dd className="truncate text-[11px] text-[var(--text-muted)]">{x.sub}</dd>}
        </div>
      ))}
    </dl>
  );

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-muted)]">
            <def.icon className="h-4 w-4 text-[var(--item-accent)]" />
            {def.label} · {headLabel}
          </p>
          <p className="text-3xl font-semibold tabular-nums tracking-tight text-[var(--text)]" aria-live="polite">
            {head}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
            {rateText && <span className="tabular-nums">{rateText}</span>}
            {model.change !== null && def.smooth && (
              <span className="tabular-nums">
                {model.change > 0 ? "+" : ""}
                {fmtNumber(rateToDisplay(model.change, def.dim, s), Math.max(1, dp))} {unit} over {range} days
              </span>
            )}
            {def.kind === "bp" && bpStats?.cat && <Badge color={bpStats.cat.color}>{bpStats.cat.label}</Badge>}
          </div>
        </div>
        <ItemButton size="sm" icon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => ask(`Look at my ${def.label.toLowerCase()} over the last ${range} days — what's the trend, how noisy is it, and what stands out?`)}>
          Explain this
        </ItemButton>
      </div>

      {!wide ? (
        <>
          {chart}
          {stats}
        </>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-5">
          <div className="min-w-0">{chart}</div>
          {stats}
        </div>
      )}

      {def.kind === "bp" && (
        <div className="flex flex-col gap-2">
          {bpStats && (
            <div className="flex h-2.5 w-full overflow-hidden rounded-full" role="img" aria-label="Readings by AHA category">
              {BP_BANDS.map((b) => (bpStats.counts[b.id] ? <span key={b.id} style={{ flex: bpStats.counts[b.id], background: b.color }} /> : null))}
            </div>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
            {BP_BANDS.map((b) => (
              <span key={b.id} className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: b.color }} />
                {b.label}
                {bpStats?.counts[b.id] ? ` · ${bpStats.counts[b.id]}` : ""}
              </span>
            ))}
            <span>AHA categories · judge on averages, not one reading</span>
          </div>
        </div>
      )}

      {goal && (goal.target !== null || goal.low !== null) && def.kind !== "bp" && (
        <div className="flex items-center gap-3 rounded-xl bg-[var(--surface-2)] px-3 py-2.5 text-sm">
          <Target className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />
          <div className="min-w-0 flex-1 text-[var(--text)]">
            {goal.direction === "daily" && goal.target !== null && (
              <>
                Goal {def.id === "sleep" ? fmtHours(goal.target) : fmtMetric(def, goal.target, s)} a day ·{" "}
                <span className="tabular-nums">
                  met on {model.columns.filter((c) => c.color === "var(--success)").length} of {model.days} logged days
                </span>
              </>
            )}
            {(goal.direction === "down" || goal.direction === "up") && goal.target !== null && (
              <>
                Goal {fmtMetric(def, goal.target, s)}
                {projection?.reached && " — reached 🎉"}
                {projection && !projection.reached && (
                  <span className="text-[var(--text-muted)]">
                    {" "}
                    · {fmtNumber(Math.abs(rateToDisplay(projection.remaining, def.dim, s)), Math.max(1, dp))} {unit} to go
                    {"day" in projection && projection.day ? ` · on this trend, around ${fmtDay(projection.day)}` : ""}
                    {"away" in projection ? " · the trend is heading the other way" : ""}
                  </span>
                )}
                {!projection && <span className="text-[var(--text-muted)]"> · keep logging for a projection</span>}
                {goal.start_value !== null && model.trendNow !== null && Math.abs(goal.target - goal.start_value) > 1e-6 && (
                  <GoalProgress
                    pct={(goal.start_value - model.trendNow) / (goal.start_value - goal.target)}
                    from={fmtMetric(def, goal.start_value, s)}
                    to={fmtMetric(def, goal.target, s)}
                  />
                )}
              </>
            )}
            {goal.direction === "range" && goal.low !== null && goal.high !== null && (
              <>
                Target {fmtMetric(def, goal.low, s)} – {fmtMetric(def, goal.high, s)}
              </>
            )}
          </div>
        </div>
      )}
      {def.smooth && model.days < 7 && <p className="text-xs text-[var(--text-muted)]">A trend needs about a week of readings before it means much.</p>}
    </Card>
  );
}

/** Start → goal, how far along the trend is (Happy Scale's progress bar). */
function GoalProgress({ pct, from, to }: { pct: number; from: string; to: string }) {
  const p = Math.max(0, Math.min(1, pct));
  return (
    <span className="mt-2 flex flex-col gap-1">
      <ProgressBar value={p} color={p >= 1 ? "var(--success)" : undefined} />
      <span className="flex justify-between text-[11px] tabular-nums text-[var(--text-muted)]">
        <span>Start {from}</span>
        <span className="font-semibold text-[var(--text)]">{Math.round(p * 100)}% there</span>
        <span>Goal {to}</span>
      </span>
    </span>
  );
}

/** A sparkline that fills its box (the kit's has a fixed width). */
function FluidSpark({ values }: { values: number[] }) {
  const v = values.filter((n) => Number.isFinite(n));
  if (v.length < 2) return <span className="block h-7" />;
  const min = Math.min(...v);
  const span = Math.max(...v) - min || 1;
  const pts = v.map((n, i) => `${(i / (v.length - 1)) * 100},${28 - ((n - min) / span) * 24}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="block h-7 w-full" aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--item-accent)" strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
