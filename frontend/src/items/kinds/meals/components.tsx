import { useEffect, useState, type ReactNode } from "react";

import { ProgressBar, ProgressRing, TextInput, fmtNum } from "@/items/ui";
import { cn } from "@/utils/cn";

import { MACRO_COLOR, MICROS, energy, fmtEnergy, waterOut } from "./lib";
import type { Nutrients, Settings } from "./types";

/* Shared bits for the Meals & Macros views. */

type DayTargets = { kcal: number; protein: number; carbs: number; fat: number; fibre: number; sodium: number; sugar: number | null; water_ml: number };

/** The calorie ring: remaining in the middle, the ring fills as you eat. */
export function CalorieRing({ eaten, target, settings, size = 132 }: { eaten: number; target: number; settings: Settings; size?: number }) {
  const left = target - eaten;
  const over = left < 0;
  return (
    <div className="flex flex-col items-center" aria-live="polite">
      <ProgressRing value={target ? eaten / target : 0} size={size} stroke={Math.round(size / 11)} color={over ? "var(--warning)" : undefined}>
        <div className="flex flex-col items-center leading-tight">
          <span className="text-[26px] font-semibold tabular-nums tracking-tight text-[var(--text)]">{fmtEnergy(Math.abs(left), settings)}</span>
          <span className="text-[11px] font-medium text-[var(--text-muted)]">{over ? `${settings.energy_unit} over` : `${settings.energy_unit} left`}</span>
        </div>
      </ProgressRing>
    </div>
  );
}

export function MacroBar({
  label,
  value,
  target,
  color,
  unit = "g",
  limit,
  className,
}: {
  label: string;
  value: number;
  target: number | null | undefined;
  color: string;
  unit?: string;
  limit?: boolean;
  className?: string;
}) {
  const over = !!target && value > target * (limit ? 1 : 1.1);
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-[var(--text)]">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
          {label}
        </span>
        <span className={cn("tabular-nums text-[var(--text-muted)]", over && "text-[var(--warning)]")}>
          <span className="font-semibold text-[var(--text)]">{fmtNum(value)}</span>
          {target ? ` / ${fmtNum(target)}` : ""} {unit}
        </span>
      </div>
      <ProgressBar value={target ? value / target : 0} color={over ? "var(--warning)" : color} />
    </div>
  );
}

/** Eaten / target / remaining strip + macro bars. ``compact`` is the phone
 *  layout: ring beside the macro bars and one quiet eaten/target line, so the
 *  food log starts above the fold (MyFitnessPal / MacroFactor put it first). */
export function MacroSummary({ n, tgt, settings, compact }: { n: Nutrients; tgt: DayTargets; settings: Settings; compact?: boolean }) {
  if (compact) {
    return (
      <div className="flex items-center gap-4">
        <CalorieRing eaten={n.kcal} target={tgt.kcal} settings={settings} size={118} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="flex justify-between gap-2 text-[11px] tabular-nums text-[var(--text-muted)]">
            <span>
              Eaten <span className="font-semibold text-[var(--text)]">{fmtEnergy(n.kcal, settings)}</span>
            </span>
            <span>
              Target <span className="font-semibold text-[var(--text)]">{fmtEnergy(tgt.kcal, settings)}</span>
            </span>
          </p>
          <MacroBar label="Protein" value={n.protein} target={tgt.protein} color={MACRO_COLOR.protein} />
          <MacroBar label="Carbs" value={n.carbs} target={tgt.carbs} color={MACRO_COLOR.carbs} />
          <MacroBar label="Fat" value={n.fat} target={tgt.fat} color={MACRO_COLOR.fat} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <CalorieRing eaten={n.kcal} target={tgt.kcal} settings={settings} size={132} />
      <div className="flex w-full min-w-0 flex-1 flex-col gap-2.5">
        <div className="grid grid-cols-3 gap-2 text-center">
          <Mini label="Target" value={fmtEnergy(tgt.kcal, settings)} />
          <Mini label="Eaten" value={fmtEnergy(n.kcal, settings)} />
          <Mini label="Left" value={fmtEnergy(tgt.kcal - n.kcal, settings)} />
        </div>
        <MacroBar label="Protein" value={n.protein} target={tgt.protein} color={MACRO_COLOR.protein} />
        <MacroBar label="Carbs" value={n.carbs} target={tgt.carbs} color={MACRO_COLOR.carbs} />
        <MacroBar label="Fat" value={n.fat} target={tgt.fat} color={MACRO_COLOR.fat} />
        <MacroBar label="Fibre" value={n.fibre} target={tgt.fibre} color={MACRO_COLOR.fibre} />
      </div>
    </div>
  );
}

const noon = (d: string) => new Date(`${d}T12:00:00`);

/** MacroFactor-style week strip: one tap to any day of the week, each day's
 *  calories as a small ring (amber when over, a dot when complete). */
export function WeekStrip({
  day,
  today,
  onPick,
  days,
}: {
  day: string;
  today: string;
  onPick: (d: string) => void;
  days: { d: string; kcal: number; target: number; logged: boolean; complete: boolean }[];
}) {
  return (
    <div className="grid grid-cols-7 gap-1" role="group" aria-label="Pick a day this week">
      {days.map((x) => {
        const on = x.d === day;
        const future = x.d > today;
        const ratio = x.target ? x.kcal / x.target : 0;
        const over = ratio > 1.1;
        return (
          <button
            key={x.d}
            type="button"
            onClick={() => onPick(x.d)}
            aria-pressed={on}
            aria-label={`${noon(x.d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}${x.logged ? `, ${Math.round(x.kcal)} kcal` : ""}${x.complete ? ", complete" : ""}`}
            className={cn(
              "flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl py-1.5 transition",
              on ? "bg-[color-mix(in_srgb,var(--item-accent)_16%,transparent)]" : "hover:bg-[var(--hover)]",
              future && !on && "opacity-50",
            )}
          >
            <span className={cn("text-[10px] font-semibold uppercase", x.d === today ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]")}>
              {noon(x.d).toLocaleDateString(undefined, { weekday: "narrow" })}
            </span>
            <ProgressRing value={x.logged ? Math.min(1, ratio) : 0} size={30} stroke={3} color={over ? "var(--warning)" : undefined}>
              <span className={cn("text-[11px] font-semibold", on ? "text-[var(--text)]" : "text-[var(--text-muted)]")}>{Number(x.d.slice(8))}</span>
            </ProgressRing>
            <span className="h-1 w-1 rounded-full" style={{ background: x.complete ? "var(--success)" : "transparent" }} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

/** Daily intake as bars against a dashed target line — reads better than a
 *  wiggly line for "did I hit it each day" (MacroFactor's intake chart).
 *  Calorie bars turn amber when >10% over; unlogged days leave a gap. */
export function IntakeBars({
  rows,
  height = 180,
  unit,
  color = "var(--item-accent)",
  limitTone = true,
}: {
  rows: { d: string; v: number | null; target: number }[];
  height?: number;
  unit: string;
  color?: string;
  limitTone?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.v ?? 0, r.target))) * 1.08;
  const n = rows.length || 1;
  const bw = 100 / n;
  const ticks = niceTicks(max);
  const labelEvery = Math.ceil(n / 7);
  const h = hover !== null ? rows[hover] : null;
  const y = (v: number) => 100 - (v / max) * 100;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2" style={{ height }}>
        <div className="relative w-8 shrink-0 text-right text-[10px] tabular-nums text-[var(--text-muted)]">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${y(t)}%` }}>
              {t >= 1000 ? `${(t / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k` : t}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1" onMouseLeave={() => setHover(null)}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
            {ticks.map((t) => (
              <line key={t} x1={0} x2={100} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            {rows.map((r, i) =>
              r.v ? (
                <rect
                  key={r.d}
                  x={i * bw + bw * 0.17}
                  width={bw * 0.66}
                  y={y(r.v)}
                  height={100 - y(r.v)}
                  fill={limitTone && r.target && r.v > r.target * 1.1 ? "var(--warning)" : color}
                  opacity={hover === null || hover === i ? 0.9 : 0.4}
                />
              ) : null,
            )}
            <polyline
              points={rows.map((r, i) => `${i * bw + bw / 2},${y(r.target)}`).join(" ")}
              fill="none"
              stroke="var(--text)"
              strokeOpacity={0.55}
              strokeWidth={1.5}
              strokeDasharray="5 4"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className="absolute inset-0 flex">
            {rows.map((r, i) => (
              <button key={r.d} type="button" tabIndex={-1} aria-hidden className="h-full flex-1" onMouseEnter={() => setHover(i)} onClick={() => setHover(hover === i ? null : i)} />
            ))}
          </div>
          {h && (
            <div
              className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs shadow-[var(--shadow-md)]"
              style={{ left: `${Math.min(82, Math.max(18, ((hover! + 0.5) / n) * 100))}%` }}
            >
              <div className="text-[var(--text-muted)]">{noon(h.d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</div>
              <div className="font-semibold tabular-nums text-[var(--text)]">
                {h.v ? `${Math.round(h.v).toLocaleString()} ${unit}` : "Not logged"}
                <span className="font-normal text-[var(--text-muted)]"> / {Math.round(h.target).toLocaleString()}</span>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="ml-10 flex text-[10px] tabular-nums text-[var(--text-muted)]">
        {rows.map((r, i) => (
          <span key={r.d} className="flex-1 text-center">
            {(n - 1 - i) % labelEvery === 0 ? (n <= 7 ? noon(r.d).toLocaleDateString(undefined, { weekday: "short" }) : Number(r.d.slice(8))) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function niceTicks(max: number): number[] {
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? raw;
  const out: number[] = [];
  for (let t = 0; t <= max; t += step) out.push(Math.round(t));
  return out;
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[var(--surface-2)] px-2 py-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-[var(--text)]">{value}</div>
    </div>
  );
}

/** Small macro rings (P / C / F) for a compact header. */
export function MacroRings({ n, tgt }: { n: Nutrients; tgt: DayTargets }) {
  const rows = [
    { k: "P", label: "Protein", v: n.protein, t: tgt.protein, c: MACRO_COLOR.protein },
    { k: "C", label: "Carbs", v: n.carbs, t: tgt.carbs, c: MACRO_COLOR.carbs },
    { k: "F", label: "Fat", v: n.fat, t: tgt.fat, c: MACRO_COLOR.fat },
  ];
  return (
    <div className="flex gap-3">
      {rows.map((r) => (
        <div key={r.k} className="flex flex-col items-center gap-1" aria-label={`${r.label} ${fmtNum(r.v)} of ${fmtNum(r.t)} g`}>
          <ProgressRing value={r.t ? r.v / r.t : 0} size={46} stroke={5} color={r.c}>
            <span className="text-[10px]">{fmtNum(r.v)}</span>
          </ProgressRing>
          <span className="text-[10px] text-[var(--text-muted)]">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/** A nutrition-label style breakdown with % of target / daily value. */
export function NutrientTable({
  n,
  tgt,
  settings,
  showMicros = true,
  coverage,
}: {
  n: Nutrients;
  tgt?: DayTargets;
  settings: Settings;
  showMicros?: boolean;
  /** For a day: how many foods carried vitamin/mineral data. */
  coverage?: { withMicros: number; of: number };
}) {
  const row = (label: ReactNode, value: string, ratio: number | null, opts: { sub?: boolean; limit?: boolean } = {}) => (
    <div className={cn("flex items-center gap-3 py-1.5", opts.sub && "pl-4")}>
      <span className={cn("min-w-0 flex-1 truncate text-sm", opts.sub ? "text-[var(--text-muted)]" : "font-medium text-[var(--text)]")}>{label}</span>
      <span className="text-sm tabular-nums text-[var(--text)]">{value}</span>
      <span
        className={cn(
          "w-12 text-right text-xs tabular-nums",
          ratio !== null && opts.limit && ratio > 1 ? "text-[var(--warning)]" : "text-[var(--text-muted)]",
        )}
      >
        {ratio === null ? "" : `${Math.round(ratio * 100)}%`}
      </span>
    </div>
  );
  const micros = Object.entries(MICROS).filter(([k]) => (n.micros?.[k] ?? 0) > 0);
  const partial = coverage && coverage.of > 0 && coverage.withMicros < coverage.of;
  return (
    <div className="divide-y divide-[var(--border)]">
      {row("Energy", `${fmtNum(Math.round(energy(n.kcal, settings)))} ${settings.energy_unit}`, tgt ? n.kcal / (tgt.kcal || 1) : null)}
      {row("Protein", `${fmtNum(n.protein, 1)} g`, tgt ? n.protein / (tgt.protein || 1) : null)}
      {row("Carbohydrate", `${fmtNum(n.carbs, 1)} g`, tgt ? n.carbs / (tgt.carbs || 1) : null)}
      {row("Sugars", `${fmtNum(n.sugar, 1)} g`, tgt?.sugar ? n.sugar / tgt.sugar : null, { sub: true, limit: true })}
      {row("Fibre", `${fmtNum(n.fibre, 1)} g`, tgt ? n.fibre / (tgt.fibre || 1) : null, { sub: true })}
      {row("Fat", `${fmtNum(n.fat, 1)} g`, tgt ? n.fat / (tgt.fat || 1) : null)}
      {row("Saturated", `${fmtNum(n.sat_fat, 1)} g`, tgt ? n.sat_fat / Math.max(1, (tgt.kcal * 0.1) / 9) : null, { sub: true, limit: true })}
      {row("Sodium", `${fmtNum(n.sodium)} mg`, tgt ? n.sodium / (tgt.sodium || 2300) : null, { limit: true })}
      {showMicros && partial && micros.length > 0 && (
        <p className="py-2 text-xs text-[var(--warning)]" role="note">
          Vitamins & minerals below are from {coverage.withMicros} of {coverage.of} foods — the rest didn't list them, so the real totals are higher.
        </p>
      )}
      {showMicros &&
        micros.map(([k, m]) => row(m.label, `${fmtNum(n.micros[k], m.unit === "g" ? 1 : 0)} ${m.unit}`, m.dv && tgt ? n.micros[k] / m.dv : null, { limit: m.limit }))}
      {showMicros && micros.length === 0 && (
        <p className="py-2 text-xs text-[var(--text-muted)]">
          {coverage && coverage.of > 0 ? "None of these foods list vitamins or minerals" : "No micronutrient data yet"} — built-in foods carry the main ones; packaged foods only what their label gives.
        </p>
      )}
    </div>
  );
}

export function EstBadge() {
  return (
    <span
      title="Estimated nutrition"
      className="rounded-md bg-[var(--warning-bg)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-[var(--warning)]"
    >
      est.
    </span>
  );
}

/** A number input that lets you type freely (commas, a trailing dot). */
export function NumberInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
  allowEmpty,
  suffix,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  allowEmpty?: boolean;
  suffix?: string;
}) {
  const [text, setText] = useState(value === null || value === undefined ? "" : String(value));
  useEffect(() => {
    const parsed = parseFloat(text.replace(",", "."));
    if ((value ?? null) !== (Number.isFinite(parsed) ? parsed : null)) setText(value === null || value === undefined ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className={cn("relative", className)}>
      <TextInput
        inputMode="decimal"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d.,-]/g, "");
          setText(t);
          const n = parseFloat(t.replace(",", "."));
          if (Number.isFinite(n)) onChange(n);
          else if (t === "" && allowEmpty) onChange(null);
        }}
        className={cn("tabular-nums", suffix && "pr-12")}
      />
      {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--text-muted)]">{suffix}</span>}
    </div>
  );
}

/** Water glasses (one tap each) with + / −. */
export function WaterGlasses({ ml, target, step }: { ml: number; target: number; step: number }) {
  const n = Math.max(1, Math.min(16, Math.ceil(target / step)));
  const full = Math.floor(ml / step);
  return (
    <div className="flex flex-wrap gap-1" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <span
          key={i}
          className={cn("h-6 w-4 rounded-b-md rounded-t-sm border", i < full ? "border-transparent" : "border-[var(--border)] bg-[var(--surface-2)]")}
          style={i < full ? { background: "color-mix(in srgb, #3B9CD8 75%, transparent)" } : undefined}
        />
      ))}
    </div>
  );
}

export { waterOut };
