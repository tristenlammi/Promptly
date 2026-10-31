import {
  Activity,
  Droplet,
  Droplets,
  Footprints,
  Gauge,
  HeartPulse,
  Moon,
  Ruler,
  Scale,
  Smile,
  Sparkles,
  Thermometer,
  Wind,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { addDays, daysBetween } from "@/items/ui";

import { momentAt as zonedMomentAt, todayISO } from "./zone";

import type { CustomMetric, Goal, HealthData, PeriodDay, Reading, Settings } from "./types";

/*
 * The numbers behind Body & Health — a mirror of the backend's science.py:
 * the metric catalogue, unit conversion, daily series, the smoothed trend
 * (EWMA, Hacker's Diet / Happy Scale style), regression, and the
 * recognised reference bands (AHA blood pressure, WHO BMI, ADA glucose).
 */

export type Dim = "weight" | "length" | "glucose" | "temp" | "water" | "none";
export type Agg = "avg" | "sum" | "last" | "max" | "min";

export interface MetricDef {
  id: string;
  label: string;
  unit: string; // canonical unit label (for dim "none")
  dim: Dim;
  agg: Agg;
  decimals: number;
  lo: number;
  hi: number;
  higherIsBetter: boolean | null;
  smooth: boolean;
  icon: LucideIcon;
  kind: "number" | "bp" | "sleep" | "scale" | "water";
  custom?: boolean;
}

const B = (
  id: string,
  label: string,
  unit: string,
  dim: Dim,
  agg: Agg,
  decimals: number,
  lo: number,
  hi: number,
  higherIsBetter: boolean | null,
  smooth: boolean,
  icon: LucideIcon,
  kind: MetricDef["kind"] = "number",
): MetricDef => ({ id, label, unit, dim, agg, decimals, lo, hi, higherIsBetter, smooth, icon, kind });

export const BUILTIN: MetricDef[] = [
  B("weight", "Weight", "kg", "weight", "avg", 1, 2, 400, null, true, Scale),
  B("bp", "Blood pressure", "mmHg", "none", "avg", 0, 40, 320, null, false, HeartPulse, "bp"),
  B("sleep", "Sleep", "h", "none", "sum", 1, 0, 24, true, false, Moon, "sleep"),
  B("water", "Water", "ml", "water", "sum", 0, 0, 10_000, true, false, Droplets, "water"),
  B("mood", "Mood", "/5", "none", "avg", 1, 1, 5, true, false, Smile, "scale"),
  B("energy", "Energy", "/5", "none", "avg", 1, 1, 5, true, false, Zap, "scale"),
  B("steps", "Steps", "steps", "none", "max", 0, 0, 200_000, true, false, Footprints),
  B("resting_hr", "Resting HR", "bpm", "none", "avg", 0, 20, 250, false, true, Activity),
  B("glucose", "Glucose", "mmol/L", "glucose", "avg", 1, 0.5, 50, null, false, Droplet),
  B("body_fat", "Body fat", "%", "none", "avg", 1, 2, 75, null, true, Gauge),
  B("spo2", "Blood oxygen", "%", "none", "avg", 0, 50, 100, true, false, Wind),
  B("temperature", "Temperature", "°C", "temp", "max", 1, 30, 45, null, false, Thermometer),
  B("waist", "Waist", "cm", "length", "last", 1, 10, 300, null, true, Ruler),
  B("hip", "Hips", "cm", "length", "last", 1, 10, 300, null, true, Ruler),
  B("chest", "Chest", "cm", "length", "last", 1, 10, 300, null, true, Ruler),
  B("arm", "Arm", "cm", "length", "last", 1, 5, 150, null, true, Ruler),
  B("thigh", "Thigh", "cm", "length", "last", 1, 10, 200, null, true, Ruler),
];

export const BUILTIN_BY_ID: Record<string, MetricDef> = Object.fromEntries(BUILTIN.map((m) => [m.id, m]));

export function customDef(c: CustomMetric): MetricDef {
  return {
    id: c.id,
    label: c.name,
    unit: c.unit,
    dim: "none",
    agg: c.aggregate,
    decimals: c.decimals,
    lo: -1e6,
    hi: 1e7,
    higherIsBetter: c.higher_is_better,
    smooth: c.aggregate === "avg" || c.aggregate === "last",
    icon: Sparkles,
    kind: "number",
    custom: true,
  };
}

export function allMetrics(data: HealthData): MetricDef[] {
  return [...BUILTIN, ...data.custom_metrics.map(customDef)];
}

export function metricDef(data: HealthData, id: string): MetricDef | null {
  if (BUILTIN_BY_ID[id]) return BUILTIN_BY_ID[id];
  const c = data.custom_metrics.find((m) => m.id === id);
  return c ? customDef(c) : null;
}

// ------------------------------------------------------------------ units

export const LB_PER_KG = 2.2046226218;
const CM_PER_IN = 2.54;
export const MGDL_PER_MMOL = 18.0182; // glucose, 180.16 g/mol — same as science.py
const ML_PER_OZ = 29.5735;

export function toDisplay(v: number, dim: Dim, s: Settings): number {
  if (dim === "weight" && s.weight_unit === "lb") return v * LB_PER_KG;
  if (dim === "length" && s.length_unit === "in") return v / CM_PER_IN;
  if (dim === "glucose" && s.glucose_unit === "mgdl") return v * MGDL_PER_MMOL;
  if (dim === "temp" && s.temp_unit === "f") return (v * 9) / 5 + 32;
  if (dim === "water" && s.water_unit === "oz") return v / ML_PER_OZ;
  return v;
}

export function fromDisplay(v: number, dim: Dim, s: Settings): number {
  if (dim === "weight" && s.weight_unit === "lb") return v / LB_PER_KG;
  if (dim === "length" && s.length_unit === "in") return v * CM_PER_IN;
  if (dim === "glucose" && s.glucose_unit === "mgdl") return v / MGDL_PER_MMOL;
  if (dim === "temp" && s.temp_unit === "f") return ((v - 32) * 5) / 9;
  if (dim === "water" && s.water_unit === "oz") return v * ML_PER_OZ;
  return v;
}

/** A rate (per week) in display units — offset-free for °F. */
export function rateToDisplay(v: number, dim: Dim, s: Settings): number {
  return toDisplay(v, dim, s) - toDisplay(0, dim, s);
}

export function unitLabel(def: MetricDef, s: Settings): string {
  switch (def.dim) {
    case "weight":
      return s.weight_unit;
    case "length":
      return s.length_unit;
    case "glucose":
      return s.glucose_unit === "mgdl" ? "mg/dL" : "mmol/L";
    case "temp":
      return s.temp_unit === "f" ? "°F" : "°C";
    case "water":
      return s.water_unit === "oz" ? "oz" : "ml";
    default:
      return def.unit;
  }
}

export function displayDecimals(def: MetricDef, s: Settings): number {
  if (def.dim === "glucose" && s.glucose_unit === "mgdl") return 0;
  if (def.dim === "water") return 0;
  return def.decimals;
}

/** The step for a stepper in display units. */
export function displayStep(def: MetricDef, s: Settings): number {
  if (def.dim === "weight") return 0.1;
  if (def.dim === "length") return s.length_unit === "in" ? 0.25 : 0.5;
  if (def.dim === "glucose") return s.glucose_unit === "mgdl" ? 1 : 0.1;
  if (def.dim === "temp") return 0.1;
  if (def.dim === "water") return s.water_unit === "oz" ? 1 : 50;
  if (def.id === "steps") return 500;
  if (def.custom) return def.decimals ? 1 / 10 ** def.decimals : 1;
  return def.decimals ? 0.1 : 1;
}

export function fmtNumber(v: number, decimals: number): string {
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

export function fmtHours(h: number): string {
  let hh = Math.floor(h);
  let mm = Math.round((h - hh) * 60);
  if (mm === 60) {
    hh += 1;
    mm = 0;
  }
  return `${hh}h ${String(mm).padStart(2, "0")}m`;
}

/** A canonical value in the person's units — ``{ value: "80.2", unit: "kg" }``. */
export function fmtParts(def: MetricDef, v: number | null | undefined, s: Settings): { value: string; unit: string } {
  if (v === null || v === undefined || !Number.isFinite(v)) return { value: "–", unit: "" };
  if (def.id === "sleep") return { value: fmtHours(v), unit: "" };
  const unit = unitLabel(def, s);
  if (def.dim === "glucose") {
    const g = glucoseShown(v, s.glucose_unit);
    return { value: fmtNumber(g, s.glucose_unit === "mgdl" ? 0 : 1), unit };
  }
  return { value: fmtNumber(toDisplay(v, def.dim, s), displayDecimals(def, s)), unit: unit === "/5" ? "/ 5" : unit };
}

export function fmtMetric(def: MetricDef, v: number | null | undefined, s: Settings): string {
  const p = fmtParts(def, v, s);
  return p.unit ? `${p.value} ${p.unit}` : p.value;
}

// ------------------------------------------------------------------ series

export interface DayValue {
  day: string;
  v: number;
}

function combine(vals: number[], agg: Agg): number {
  if (agg === "sum") return vals.reduce((a, b) => a + b, 0);
  if (agg === "last") return vals[vals.length - 1];
  if (agg === "max") return Math.max(...vals);
  if (agg === "min") return Math.min(...vals);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export type SeriesKey = string; // a metric id, or bp_sys / bp_dia / pulse / sleep_quality

function readingValue(r: Reading, key: SeriesKey): number | null {
  if (key === "bp" || key === "bp_sys") return r.sys;
  if (key === "bp_dia") return r.dia;
  if (key === "pulse") return r.pulse;
  if (key === "sleep_quality") return r.quality;
  return r.value;
}

/** Readings grouped by metric, each sorted by time — build once per data. */
export function indexReadings(readings: Reading[]): Record<string, Reading[]> {
  const out: Record<string, Reading[]> = {};
  for (const r of readings) (out[r.metric] ??= []).push(r);
  for (const k of Object.keys(out)) out[k].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

export function dailySeries(rows: Reading[] | undefined, key: SeriesKey, agg: Agg, start?: string, end?: string): DayValue[] {
  if (!rows?.length) return [];
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const v = readingValue(r, key);
    if (v === null || v === undefined) continue;
    const d = r.at.slice(0, 10);
    if ((start && d < start) || (end && d > end)) continue;
    const arr = by.get(d);
    if (arr) arr.push(v);
    else by.set(d, [v]);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, vals]) => ({ day, v: combine(vals, agg) }));
}

/** The smoothed trend: each day pulls it ``alpha`` of the way; a gap of n
 *  days counts as n steps. */
export function ewma(series: DayValue[], alpha = 0.1): DayValue[] {
  const out: DayValue[] = [];
  let trend: number | null = null;
  let prev: string | null = null;
  for (const p of series) {
    if (trend === null) trend = p.v;
    else {
      const gap = Math.max(1, prev ? daysBetween(prev, p.day) : 1);
      const a = 1 - (1 - alpha) ** gap;
      trend = trend + a * (p.v - trend);
    }
    out.push({ day: p.day, v: trend });
    prev = p.day;
  }
  return out;
}

export function linreg(points: [number, number][]): { slope: number; intercept: number } | null {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
  }
  if (!sxx) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/** Weekly rate (canonical units/week) of a series over its last ``span`` days. */
export function weeklyRate(series: DayValue[], span = 28): number | null {
  if (series.length < 3) return null;
  const last = series[series.length - 1].day;
  const from = addDays(last, -(span - 1));
  const pts = series.filter((p) => p.day >= from).map((p) => [daysBetween(from, p.day), p.v] as [number, number]);
  const fit = linreg(pts);
  return fit ? fit.slope * 7 : null;
}

export function goalFor(data: HealthData, metric: string): Goal | undefined {
  return data.goals.find((g) => g.metric === metric);
}

export function todayValue(rows: Reading[] | undefined, def: MetricDef, day = todayISO()): number | null {
  const s = dailySeries(rows, def.id, def.agg, day, day);
  return s.length ? s[0].v : null;
}

export function latest(rows: Reading[] | undefined): Reading | null {
  return rows?.length ? rows[rows.length - 1] : null;
}

// -------------------------------------------------------------- references

export interface Band {
  id: string;
  label: string;
  color: string;
  advice?: string;
}

export const BP_BANDS: Band[] = [
  { id: "normal", label: "Normal", color: "var(--success)" },
  { id: "elevated", label: "Elevated", color: "var(--warning)" },
  { id: "stage1", label: "Stage 1", color: "color-mix(in srgb, var(--warning) 45%, var(--danger))" },
  { id: "stage2", label: "Stage 2", color: "var(--danger)" },
  { id: "crisis", label: "Crisis", color: "color-mix(in srgb, var(--danger) 70%, var(--text))" },
];

/** AHA/ACC categories — the higher of the two numbers decides. */
export function bpCategory(sys: number | null, dia: number | null): Band | null {
  if (sys === null || dia === null) return null;
  const b = (id: string) => BP_BANDS.find((x) => x.id === id)!;
  if (sys > 180 || dia > 120)
    return {
      ...b("crisis"),
      label: "Hypertensive crisis range",
      advice:
        "Higher than 180 and/or higher than 120. Rest 5 minutes and measure again. If it's still this high, contact your doctor now. With chest pain, shortness of breath, back pain, numbness or weakness, vision change or trouble speaking, call emergency services.",
    };
  if (sys >= 140 || dia >= 90) return { ...b("stage2"), label: "Hypertension stage 2" };
  if (sys >= 130 || dia >= 80) return { ...b("stage1"), label: "Hypertension stage 1" };
  if (sys >= 120) return b("elevated");
  if (sys < 90 || dia < 60) return { id: "low", label: "Low", color: "var(--text-muted)" };
  return b("normal");
}

export function bmiOf(weightKg: number | null, heightCm: number | null): number | null {
  if (!weightKg || !heightCm) return null;
  const m = heightCm / 100;
  return weightKg / (m * m);
}

export function bmiBand(b: number): Band {
  if (b < 18.5) return { id: "under", label: "Underweight", color: "var(--warning)" };
  if (b < 25) return { id: "healthy", label: "Healthy weight", color: "var(--success)" };
  if (b < 30) return { id: "over", label: "Overweight", color: "var(--warning)" };
  if (b < 35) return { id: "ob1", label: "Obesity class I", color: "var(--danger)" };
  if (b < 40) return { id: "ob2", label: "Obesity class II", color: "var(--danger)" };
  return { id: "ob3", label: "Obesity class III", color: "var(--danger)" };
}

/* ADA cut points in both units — the mmol/L figures are the ADA's own rounded
 * equivalents, so a reading is judged in the unit the person sees, rounded
 * as shown (mirrors science.py GLUCOSE_CUTS / glucose_shown / glucose_band). */
export const GLUCOSE_CUTS = {
  mmol: { very_low: 3.0, low: 3.9, fasting_pre: 5.6, fasting_diabetes: 7.0, post_normal: 7.8, post_target: 10.0, random_high: 11.1, very_high: 13.9, pre_target: 7.2 },
  mgdl: { very_low: 54, low: 70, fasting_pre: 100, fasting_diabetes: 126, post_normal: 140, post_target: 180, random_high: 200, very_high: 250, pre_target: 130 },
} as const;

/** A stored (mmol/L) glucose as shown: whole mg/dL, or mmol/L to 0.1. */
export function glucoseShown(mmol: number, unit: Settings["glucose_unit"] = "mmol"): number {
  if (unit === "mgdl") return Math.floor(mmol * MGDL_PER_MMOL + 0.5 + 1e-9);
  return Math.floor(mmol * 10 + 0.5 + 1e-9) / 10;
}

export function glucoseBand(mmol: number, context: string | null, unit: Settings["glucose_unit"] = "mmol"): Band {
  const ok = "var(--success)";
  const warn = "var(--warning)";
  const bad = "var(--danger)";
  const u = unit === "mgdl" ? "mgdl" : "mmol";
  const c = GLUCOSE_CUTS[u];
  const v = glucoseShown(mmol, u);
  if (v < c.very_low) return { id: "very_low", label: "Very low", color: bad, advice: "Treat a low now (15 g fast sugar) and get help if you feel unwell." };
  if (v < c.low) return { id: "low", label: "Low", color: bad, advice: "15 g fast-acting carbs, recheck in 15 minutes." };
  if (v >= c.very_high) return { id: "very_high", label: "Very high", color: bad, advice: "If you have diabetes, follow your sick-day / ketone plan; seek care if unwell." };
  if (context === "fasting") {
    if (v < c.fasting_pre) return { id: "normal", label: "Normal fasting", color: ok };
    if (v < c.fasting_diabetes) return { id: "elevated", label: "Prediabetes range", color: warn, advice: "Worth confirming with a lab test via your doctor." };
    return { id: "high", label: "Diabetes range", color: bad, advice: "One reading doesn't diagnose — talk to your doctor." };
  }
  if (context === "post_meal") {
    if (v < c.post_normal) return { id: "normal", label: "Normal after a meal", color: ok };
    if (v < c.post_target) return { id: "elevated", label: "Above non-diabetic range", color: warn };
    return { id: "high", label: "High after a meal", color: bad };
  }
  if (v >= c.random_high) return { id: "high", label: "High", color: bad };
  if ((context === "pre_meal" || context === "bedtime") && v > c.pre_target)
    return { id: "elevated", label: `Above usual target (${u === "mgdl" ? "80–130" : "4.4–7.2"})`, color: warn };
  return { id: "normal", label: "In range", color: ok };
}

/** SpO₂ — same lines as the backend: ≥95 typical, 93–94 slightly low,
 *  ≤92 contact a clinician, <90 urgent. */
export function spo2Band(p: number): Band {
  const v = Math.round(p);
  if (v >= 95) return { id: "normal", label: "Typical", color: "var(--success)" };
  if (v > 92) return { id: "slightly_low", label: "Slightly low", color: "var(--warning)" };
  if (v >= 90) return { id: "low", label: "Low", color: "var(--danger)", advice: "Contact a clinician today — urgently if you're breathless or unwell." };
  return { id: "very_low", label: "Very low", color: "var(--danger)", advice: "Get urgent medical help, especially if you're breathless or unwell." };
}

export function ageYears(birth: string | null, today = todayISO()): number | null {
  if (!birth) return null;
  const [by, bm, bd] = birth.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

// ------------------------------------------------------------------- cycle

export interface CycleForecast {
  lastStart: string;
  cycleDay: number;
  avgCycle: number;
  avgPeriod: number;
  cyclesLogged: number;
  nextPeriod: string;
  daysUntilNext: number;
  ovulation: string;
  fertile: [string, string];
  inPeriod: boolean;
  lowConfidence: boolean;
}

export function cycleForecast(periods: PeriodDay[], today = todayISO()): CycleForecast | null {
  const days = [...new Set(periods.filter((p) => p.flow !== "spotting").map((p) => p.day))].sort();
  if (!days.length) return null;
  const have = new Set(days);
  const starts: string[] = [];
  const lengths: number[] = [];
  for (const d of days) {
    if (have.has(addDays(d, -1)) || have.has(addDays(d, -2))) {
      if (lengths.length) lengths[lengths.length - 1] = daysBetween(starts[starts.length - 1], d) + 1;
      continue;
    }
    starts.push(d);
    lengths.push(1);
  }
  const cycles: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    const n = daysBetween(starts[i - 1], starts[i]);
    if (n >= 15 && n <= 60) cycles.push(n);
  }
  const recent = cycles.slice(-6);
  const avgCycle = recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : 28;
  const lens = lengths.slice(-6);
  const avgPeriod = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
  const last = starts[starts.length - 1];
  const next = addDays(last, avgCycle);
  const ov = addDays(next, -14);
  const variation = recent.length >= 2 ? Math.max(...recent) - Math.min(...recent) : null;
  return {
    lastStart: last,
    cycleDay: daysBetween(last, today) + 1,
    avgCycle,
    avgPeriod,
    cyclesLogged: cycles.length,
    nextPeriod: next,
    daysUntilNext: daysBetween(today, next),
    ovulation: ov,
    fertile: [addDays(ov, -5), addDays(ov, 1)],
    inPeriod: today >= last && daysBetween(last, today) < lengths[lengths.length - 1],
    lowConfidence: recent.length < 3 || (variation !== null && variation > 7),
  };
}

// ------------------------------------------------------------------ misc

export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** ISO moment for a day + HH:MM in the person's saved zone (see zone.ts). */
export function momentAt(day: string, hhmm: string): string {
  return zonedMomentAt(day, hhmm);
}

/** "HH:MM" of an ISO moment in its own (the person's) offset. */
export function hhmmOf(iso: string): string {
  return iso.slice(11, 16);
}

export const GLUCOSE_CONTEXTS: { value: string; label: string }[] = [
  { value: "fasting", label: "Fasting" },
  { value: "pre_meal", label: "Before meal" },
  { value: "post_meal", label: "After meal" },
  { value: "bedtime", label: "Bedtime" },
  { value: "random", label: "Other" },
];

export const SCALE_FACES = ["😞", "🙁", "😐", "🙂", "😄"];
export const SCALE_WORDS = ["Awful", "Low", "Okay", "Good", "Great"];
