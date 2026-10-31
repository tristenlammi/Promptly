import { Activity, Flame, Info, Loader2, Plus, Scale, Sparkles, Target, TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import {
  Card,
  EmptyState,
  Field,
  ItemButton,
  List,
  ListRow,
  Page,
  Section,
  Segmented,
  Select,
  Sheet,
  Stat,
  StatGrid,
  TextInput,
  addDays,
  fmtNum,
  weekStart,
} from "@/items/ui";
import { TrendChart } from "@/items/ui/charts";
import { toast } from "@/store/toastStore";

import { useTrends } from "./api";
import { today as todayNow, useToday } from "./clock";
import { IntakeBars, NumberInput } from "./components";
import { MACRO_COLOR, MICROS, energy, errorText, fmtEnergy, fmtWeight, macroSplit, meals, targetsFor, total, weightIn, weightOut } from "./lib";
import type { MealsData, TdeeEstimate } from "./types";

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const;

const NUTRIENTS = [
  { value: "kcal", label: "Calories" },
  { value: "protein", label: "Protein" },
  { value: "carbs", label: "Carbs" },
  { value: "sugar", label: "Sugar" },
  { value: "fibre", label: "Fibre" },
  { value: "fat", label: "Fat" },
  { value: "sat_fat", label: "Saturated fat" },
  { value: "sodium", label: "Sodium" },
  ...Object.entries(MICROS).map(([k, m]) => ({ value: k, label: m.label })),
];

export function Trends({ item, isPhone, ask }: ItemViewProps<MealsData>) {
  const data = meals(item.data);
  const s = data.settings;
  const [range, setRange] = useState<"7" | "30" | "90">("30");
  const days = Number(range);
  const [nutrient, setNutrient] = useState("sodium");
  const [weighing, setWeighing] = useState(false);
  const trends = useTrends(item.fileId, item.revision, Math.max(28, days));
  const today = useToday();

  const rows = useMemo(() => {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = addDays(today, -i);
      const day = data.days[d];
      const t = day ? total(day.entries) : null;
      const tg = targetsFor(data.targets, d);
      out.push({ d, logged: !!day?.entries.length, t, tg });
    }
    return out;
  }, [data.days, data.targets, days, today]);

  const logged = rows.filter((r) => r.logged && r.t);
  const avg = useMemo(() => {
    if (!logged.length) return null;
    const sum = (k: "kcal" | "protein" | "carbs" | "fat" | "fibre") => logged.reduce((a, r) => a + (r.t ? r.t[k] : 0), 0) / logged.length;
    return { kcal: sum("kcal"), protein: sum("protein"), carbs: sum("carbs"), fat: sum("fat"), fibre: sum("fibre"), target: logged.reduce((a, r) => a + r.tg.kcal, 0) / logged.length };
  }, [logged]);

  const kcalBars = rows.map((r) => ({ d: r.d, v: r.t ? energy(r.t.kcal, s) : null, target: energy(r.tg.kcal, s) }));
  const proteinBars = rows.map((r) => ({ d: r.d, v: r.t ? r.t.protein : null, target: r.tg.protein }));

  const weeks = useMemo(() => {
    const m = new Map<string, { kcal: number; protein: number; n: number }>();
    for (const r of rows) {
      if (!r.t) continue;
      const w = weekStart(r.d);
      const x = m.get(w) ?? { kcal: 0, protein: 0, n: 0 };
      x.kcal += r.t.kcal;
      x.protein += r.t.protein;
      x.n += 1;
      m.set(w, x);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [rows]);

  const top = useMemo(() => {
    const groups = new Map<string, { name: string; amount: number; times: number }>();
    let sum = 0;
    for (const r of rows) {
      const day = data.days[r.d];
      if (!day) continue;
      for (const e of day.entries) {
        const v = nutrient in MICROS ? e.n.micros?.[nutrient] ?? 0 : (e.n as unknown as Record<string, number>)[nutrient] ?? 0;
        if (v <= 0) continue;
        const k = e.food_ref ?? e.name.toLowerCase();
        const g = groups.get(k) ?? { name: e.name, amount: 0, times: 0 };
        g.amount += v;
        g.times += 1;
        groups.set(k, g);
        sum += v;
      }
    }
    return { sum, list: [...groups.values()].sort((a, b) => b.amount - a.amount).slice(0, 8) };
  }, [rows, data.days, nutrient]);
  const nUnit = nutrient === "kcal" ? s.energy_unit : nutrient === "sodium" ? "mg" : MICROS[nutrient]?.unit ?? "g";
  const nScale = (v: number) => (nutrient === "kcal" ? energy(v, s) : v);

  const tr = trends.data;
  const weightSeries = useMemo(() => {
    if (!tr) return [];
    const raw = new Map(tr.weights.map((w) => [w.date, w.kg]));
    const since = addDays(today, -days);
    return tr.trend.filter((t) => t.date >= since).map((t) => ({ x: t.date.slice(5), y: raw.has(t.date) ? Math.round(weightOut(raw.get(t.date)!, s) * 10) / 10 : null, y2: Math.round(weightOut(t.kg, s) * 10) / 10 }));
  }, [tr, days, today, s]);

  const split = avg ? macroSplit(avg) : null;
  const streak = useMemo(() => {
    let n = 0;
    for (let i = 0; i < 400; i++) {
      const d = addDays(today, -i);
      if (data.days[d]?.entries.length) n++;
      else if (i > 0) break;
    }
    return n;
  }, [data.days, today]);

  if (!Object.keys(data.days).length) {
    return (
      <Page>
        <EmptyState icon={TrendingUp} title="Trends appear as you log" text="Log a few days of food (and weigh in now and then) to see your averages, macro split and an adaptive estimate of your maintenance calories." />
      </Page>
    );
  }

  return (
    <Page wide={!isPhone}>
      <div className="flex items-center justify-between gap-2">
        <Segmented value={range} onChange={setRange} options={RANGES.map((r) => ({ ...r }))} className={isPhone ? "flex-1" : undefined} />
        <ItemButton size="sm" icon={<Sparkles className="h-4 w-4" />} aria-label="Review with AI" onClick={() => ask(`Review my last ${days} days of eating: averages vs targets, protein, fibre, and one thing to change. Check my adaptive TDEE too.`)}>
          {isPhone ? "Review" : "Review with AI"}
        </ItemButton>
      </div>

      <StatGrid>
        <Stat label="Avg intake" icon={Flame} value={avg ? fmtEnergy(avg.kcal, s) : "–"} unit={s.energy_unit} delta={avg ? `target ${fmtEnergy(avg.target, s)}` : undefined} />
        <Stat label="Avg protein" icon={Target} value={avg ? fmtNum(avg.protein) : "–"} unit="g" delta={avg ? `target ${fmtNum(data.targets.protein)} g` : undefined} />
        <Stat label="Days logged" icon={Activity} value={`${logged.length}/${days}`} delta={`${streak}-day streak`} tone={streak >= 7 ? "good" : "neutral"} />
        <Stat
          label="Expenditure"
          icon={TrendingUp}
          tone="accent"
          value={tr?.tdee.tdee ? fmtEnergy(tr.tdee.tdee, s) : "–"}
          unit={s.energy_unit}
          delta={tr ? confidenceText(tr.tdee) : "…"}
        />
      </StatGrid>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Calories" hint="Bars: eaten · dashed: target · amber: over by 10%+">
          <Card>
            <IntakeBars rows={kcalBars} unit={s.energy_unit} height={isPhone ? 160 : 190} />
          </Card>
        </Section>
        <Section title="Protein" hint="Grams a day · dashed: target">
          <Card>
            <IntakeBars rows={proteinBars} unit="g" height={isPhone ? 160 : 190} color={MACRO_COLOR.protein} limitTone={false} />
          </Card>
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Macro split" hint="Share of energy, average logged day">
          <Card className="flex flex-col gap-3">
            {split && avg ? (
              <>
                <div className="flex h-4 w-full overflow-hidden rounded-full" role="img" aria-label={`Protein ${Math.round(split.protein * 100)}%, carbs ${Math.round(split.carbs * 100)}%, fat ${Math.round(split.fat * 100)}%`}>
                  <span style={{ width: `${split.protein * 100}%`, background: MACRO_COLOR.protein }} />
                  <span style={{ width: `${split.carbs * 100}%`, background: MACRO_COLOR.carbs }} />
                  <span style={{ width: `${split.fat * 100}%`, background: MACRO_COLOR.fat }} />
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  {(
                    [
                      ["Protein", avg.protein, split.protein, MACRO_COLOR.protein],
                      ["Carbs", avg.carbs, split.carbs, MACRO_COLOR.carbs],
                      ["Fat", avg.fat, split.fat, MACRO_COLOR.fat],
                    ] as const
                  ).map(([label, g, share, c]) => (
                    <div key={label}>
                      <div className="text-lg font-semibold tabular-nums text-[var(--text)]">{Math.round(share * 100)}%</div>
                      <div className="flex items-center justify-center gap-1 text-xs text-[var(--text-muted)]">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
                        {label} · {fmtNum(g)} g
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-[var(--text-muted)]">Fibre averages {fmtNum(avg.fibre)} g a day (aim for {fmtNum(data.targets.fibre)} g).</p>
              </>
            ) : (
              <p className="text-sm text-[var(--text-muted)]">No logged days in this range.</p>
            )}
          </Card>
        </Section>
        <Section title="Weekly averages">
          {weeks.length ? (
            <List>
              {weeks.map(([w, x]) => (
                <ListRow
                  key={w}
                  title={`Week of ${w.slice(5).replace("-", "/")}`}
                  subtitle={`${x.n} day${x.n === 1 ? "" : "s"} logged`}
                  trailing={
                    <span className="tabular-nums">
                      {fmtEnergy(x.kcal / x.n, s, true)} · P {fmtNum(x.protein / x.n)} g
                    </span>
                  }
                />
              ))}
            </List>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">Nothing logged in this range.</p>
          )}
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section
          title="Weight trend"
          hint={tr?.health_item ? `Weigh-ins from “${tr.health_item}” and this file · dashed: smoothed trend` : "Dots: weigh-ins · dashed: smoothed trend"}
          action={
            item.canEdit && (
              <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setWeighing(true)}>
                Weigh-in
              </ItemButton>
            )
          }
        >
          <Card>
            {trends.isLoading ? (
              <div className="flex h-[200px] items-center justify-center text-[var(--text-muted)]">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : weightSeries.length > 1 ? (
              <TrendChart data={weightSeries} unit={s.weight_unit} height={200} area={false} />
            ) : (
              <EmptyState
                icon={Scale}
                title="No weight data yet"
                text="Weigh in a few times a week (morning, after the bathroom) here or in Body & Health — it powers your expenditure estimate."
                className="border-0 py-6"
              />
            )}
          </Card>
        </Section>
        <Section title="Adaptive expenditure" hint="Like MacroFactor: from what you ate and how your weight moved">
          <TdeeCard tdee={tr?.tdee ?? null} loading={trends.isLoading} item={item} ask={ask} />
        </Section>
      </div>

      <Section
        title="Top sources"
        hint={`Which foods gave you the most, last ${days} days`}
        action={
          <Select value={nutrient} onChange={(e) => setNutrient(e.target.value)} aria-label="Nutrient" className="h-9 w-auto md:h-9">
            {NUTRIENTS.map((n) => (
              <option key={n.value} value={n.value}>
                {n.label}
              </option>
            ))}
          </Select>
        }
      >
        {top.list.length ? (
          <List>
            {top.list.map((r) => (
              <ListRow
                key={r.name}
                title={r.name}
                subtitle={`${r.times}× · ${Math.round((r.amount / (top.sum || 1)) * 100)}% of the total`}
                trailing={
                  <span className="tabular-nums text-[var(--text)]">
                    {fmtNum(nScale(r.amount))} {nUnit}
                  </span>
                }
              />
            ))}
          </List>
        ) : (
          <p className="px-1 text-sm text-[var(--text-muted)]">No data for that nutrient in this range.</p>
        )}
      </Section>

      <WeighInSheet open={weighing} onClose={() => setWeighing(false)} item={item} />
    </Page>
  );
}

function confidenceText(t: TdeeEstimate): string {
  if (t.confidence === "none") return t.formula_tdee ? "formula estimate" : "needs your profile";
  return `${t.confidence} confidence`;
}

function TdeeCard({ tdee, loading, item, ask }: { tdee: TdeeEstimate | null; loading: boolean; item: ItemViewProps<MealsData>["item"]; ask: (p: string) => void }) {
  const s = meals(item.data).settings;
  const [busy, setBusy] = useState(false);
  if (loading || !tdee) {
    return (
      <Card className="flex h-[200px] items-center justify-center text-[var(--text-muted)]">
        <Loader2 className="h-5 w-5 animate-spin" />
      </Card>
    );
  }
  const basis = Number(meals(item.data).targets.basis?.tdee) || null;
  const diff = tdee.adaptive_tdee && basis ? tdee.tdee! - basis : null;
  const apply = async () => {
    setBusy(true);
    try {
      const r = await item.runAction("compute_targets", { use_adaptive: true });
      toast.success(r.summary);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums tracking-tight text-[var(--text)]">{tdee.tdee ? fmtEnergy(tdee.tdee, s) : "–"}</span>
        <span className="text-sm text-[var(--text-muted)]">{s.energy_unit}/day maintenance</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-[var(--text-muted)]">Average intake</dt>
        <dd className="text-right tabular-nums text-[var(--text)]">{tdee.avg_intake_kcal ? fmtEnergy(tdee.avg_intake_kcal, s, true) : "–"}</dd>
        <dt className="text-[var(--text-muted)]">Trend weight change</dt>
        <dd className="text-right tabular-nums text-[var(--text)]">
          {tdee.weight_change_kg_per_week !== null ? `${tdee.weight_change_kg_per_week > 0 ? "+" : ""}${fmtWeight(tdee.weight_change_kg_per_week, s, 2)}/wk` : "–"}
        </dd>
        <dt className="text-[var(--text-muted)]">Formula estimate</dt>
        <dd className="text-right tabular-nums text-[var(--text)]">{tdee.formula_tdee ? fmtEnergy(tdee.formula_tdee, s, true) : "–"}</dd>
        <dt className="text-[var(--text-muted)]">Data</dt>
        <dd className="text-right tabular-nums text-[var(--text)]">
          {tdee.logged_days} whole days · {tdee.weigh_ins} weigh-ins
        </dd>
        {tdee.partial_days_skipped > 0 && (
          <dd className="col-span-2 text-xs text-[var(--text-muted)]">
            {tdee.partial_days_skipped} partly logged day{tdee.partial_days_skipped === 1 ? "" : "s"} left out
            {tdee.typical_day_kcal ? ` (under ~80% of your typical ${fmtEnergy(tdee.typical_day_kcal, s, true)} and not marked complete)` : ""}.
          </dd>
        )}
      </dl>
      {tdee.needs.length > 0 ? (
        <p className="flex gap-2 rounded-xl bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text-muted)]">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" />
          For an adaptive estimate: {tdee.needs.join(" and ")}. Mark days “complete” when you've logged everything.
        </p>
      ) : (
        <p className="text-xs text-[var(--text-muted)]">
          {tdee.source === "blended" ? "Blended with the formula while data builds up. " : ""}
          {diff !== null && Math.abs(diff) >= 100
            ? `That's ${fmtEnergy(Math.abs(diff), s, true)} ${diff > 0 ? "more" : "less"} than your targets assume.`
            : "Your targets match what your body is doing."}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {tdee.adaptive_tdee && item.canEdit && (
          <ItemButton variant="primary" size="sm" disabled={busy} onClick={() => void apply()}>
            {busy ? "Updating…" : "Update targets from this"}
          </ItemButton>
        )}
        <ItemButton size="sm" onClick={() => ask("Explain my adaptive TDEE estimate and whether I should change my calorie target.")}>
          Explain
        </ItemButton>
      </div>
    </Card>
  );
}

function WeighInSheet({ open, onClose, item }: { open: boolean; onClose: () => void; item: ItemViewProps<MealsData>["item"] }) {
  const s = meals(item.data).settings;
  const last = meals(item.data).weighins[meals(item.data).weighins.length - 1]?.kg ?? meals(item.data).profile.weight_kg ?? null;
  const [v, setV] = useState<number | null>(last ? Math.round(weightOut(last, s) * 10) / 10 : null);
  const [day, setDay] = useState(todayNow);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Log a weigh-in"
      size="sm"
      footer={
        <ItemButton
          variant="primary"
          block
          disabled={!v || v <= 0}
          onClick={() => {
            const kg = Math.round(weightIn(v!, s) * 100) / 100;
            if (kg < 20 || kg > 400) {
              toast.error("That weight doesn't look right.");
              return;
            }
            item.update((d) => {
              d.weighins = [...d.weighins.filter((w) => w.date !== day), { date: day, kg }].sort((a, b) => (a.date < b.date ? -1 : 1));
              d.profile.weight_kg = Math.round(d.weighins[d.weighins.length - 1].kg * 10) / 10;
            });
            onClose();
          }}
        >
          Save
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={`Weight (${s.weight_unit})`}>
          <NumberInput ariaLabel="Weight" value={v} onChange={setV} suffix={s.weight_unit} />
        </Field>
        <Field label="Day">
          <TextInput type="date" value={day} max={todayNow()} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </Field>
        <p className="text-xs text-[var(--text-muted)]">Use Body & Health for full body tracking — weigh-ins from either feed the trend.</p>
      </div>
    </Sheet>
  );
}
