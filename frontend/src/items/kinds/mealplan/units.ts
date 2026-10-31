/*
 * Units, scaling and formatting — a port of
 * backend/app/items/kinds/mealplan/units.py (``present`` / ``fmt_qty``) so
 * the servings stepper scales instantly. Keep the two in step.
 */
import type { Amount, Ingredient } from "./types";

type Dim = "mass" | "volume";
type Sys = "metric" | "imperial" | "both";

const UNITS: Record<string, [Dim, number, string, string, Sys]> = {
  mg: ["mass", 0.001, "mg", "mg", "metric"],
  g: ["mass", 1, "g", "g", "metric"],
  kg: ["mass", 1000, "kg", "kg", "metric"],
  oz: ["mass", 28.3495, "oz", "oz", "imperial"],
  lb: ["mass", 453.592, "lb", "lb", "imperial"],
  ml: ["volume", 1, "ml", "ml", "metric"],
  cl: ["volume", 10, "cl", "cl", "metric"],
  dl: ["volume", 100, "dl", "dl", "metric"],
  l: ["volume", 1000, "l", "l", "metric"],
  tsp: ["volume", 4.92892, "tsp", "tsp", "both"],
  tbsp: ["volume", 14.7868, "tbsp", "tbsp", "both"],
  floz: ["volume", 29.5735, "fl oz", "fl oz", "imperial"],
  cup: ["volume", 236.588, "cup", "cups", "imperial"],
  pint: ["volume", 473.176, "pint", "pints", "imperial"],
  quart: ["volume", 946.353, "quart", "quarts", "imperial"],
  gallon: ["volume", 3785.41, "gallon", "gallons", "imperial"],
};

const COUNT: Record<string, [string, string]> = {
  pinch: ["pinch", "pinches"], dash: ["dash", "dashes"], drop: ["drop", "drops"], clove: ["clove", "cloves"],
  can: ["can", "cans"], jar: ["jar", "jars"], bottle: ["bottle", "bottles"], package: ["pack", "packs"],
  bag: ["bag", "bags"], box: ["box", "boxes"], slice: ["slice", "slices"], bunch: ["bunch", "bunches"],
  sprig: ["sprig", "sprigs"], head: ["head", "heads"], stalk: ["stalk", "stalks"], stick: ["stick", "sticks"],
  piece: ["piece", "pieces"], handful: ["handful", "handfuls"], fillet: ["fillet", "fillets"], sheet: ["sheet", "sheets"],
  leaf: ["leaf", "leaves"], cube: ["cube", "cubes"], scoop: ["scoop", "scoops"], sachet: ["sachet", "sachets"],
  rasher: ["rasher", "rashers"], knob: ["knob", "knobs"], ear: ["ear", "ears"], loaf: ["loaf", "loaves"],
  dozen: ["dozen", "dozen"], serving: ["serving", "servings"],
};

/** Units offered in pickers (canonical keys). */
export const UNIT_CHOICES = ["", "g", "kg", "ml", "l", "tsp", "tbsp", "cup", "oz", "lb", "floz", "clove", "can", "jar", "package", "bunch", "slice", "pinch", "piece", "bag", "bottle", "head", "stalk"];

export function unitLabel(unit: string, qty: number | null | undefined): string {
  if (!unit) return "";
  const plural = qty !== null && qty !== undefined && qty > 1 + 1e-9;
  if (UNITS[unit]) return plural ? UNITS[unit][3] : UNITS[unit][2];
  if (COUNT[unit]) return plural ? COUNT[unit][1] : COUNT[unit][0];
  return unit;
}

const FRACTIONS: [number, string][] = [
  [0, ""], [0.125, "⅛"], [0.25, "¼"], [1 / 3, "⅓"], [0.375, "⅜"], [0.5, "½"], [0.625, "⅝"], [2 / 3, "⅔"], [0.75, "¾"], [0.875, "⅞"], [1, ""],
];
const COMMON = [0, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1];

export function roundFraction(x: number, fine = false): number {
  if (x <= 0) return 0;
  if (x >= 10) return Math.round(x);
  const whole = Math.floor(x);
  const frac = x - whole;
  const opts = fine ? FRACTIONS.map((f) => f[0]) : COMMON;
  let best = opts[0];
  for (const o of opts) if (Math.abs(o - frac) < Math.abs(best - frac)) best = o;
  let out = whole + best;
  if (out === 0) out = opts[1];
  return out;
}

export function roundMetric(x: number): number {
  if (x <= 0) return 0;
  if (x < 1) return Math.round(x * 10) / 10 || 0.1;
  if (x < 10) return Math.round(x * 2) / 2;
  if (x < 100) return Math.round(x);
  if (x < 250) return Math.round(x / 5) * 5;
  if (x < 1000) return Math.round(x / 10) * 10;
  return Math.round(x / 50) * 50;
}

function fmtNumber(x: number): string {
  if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
  return String(Number(x.toFixed(2)));
}

export function fmtFraction(x: number): string {
  if (x <= 0) return "0";
  let whole = Math.floor(x + 1e-9);
  const frac = x - whole;
  for (const [f, g] of FRACTIONS) {
    if (Math.abs(frac - f) < 0.02) {
      if (f === 1) whole += 1;
      if (whole && g) return `${whole} ${g}`;
      if (g) return g;
      return String(whole);
    }
  }
  return fmtNumber(Math.round(x * 100) / 100);
}

export function fmtQty(qty: number | null | undefined, unit: string, qtyMax?: number | null): string {
  if (qty === null || qty === undefined) return "";
  const metric = !!UNITS[unit] && UNITS[unit][4] === "metric";
  const f = metric ? fmtNumber : fmtFraction;
  let num = f(qty);
  if (qtyMax !== null && qtyMax !== undefined && qtyMax > qty) num = `${num}–${f(qtyMax)}`;
  return `${num} ${unitLabel(unit, qtyMax ?? qty)}`.trim();
}

export function fmtAmounts(a: Amount[]): string {
  return a.filter((x) => x.qty !== null).map((x) => fmtQty(x.qty, x.unit)).join(" + ");
}

const toBase = (q: number, u: string) => (UNITS[u] ? q * UNITS[u][1] : q);

function bestMetric(base: number, dim: Dim): [number, string] {
  if (dim === "mass") return base >= 1000 ? [Math.round((base / 1000) * 20) / 20, "kg"] : [roundMetric(base), "g"];
  return base >= 1000 ? [Math.round((base / 1000) * 20) / 20, "l"] : [roundMetric(base), "ml"];
}

function bestImperialVolume(base: number): [number, string] {
  const cup = UNITS.cup[1];
  const tbsp = UNITS.tbsp[1];
  if (base >= cup / 4 - 0.5) return [roundFraction(base / cup), "cup"];
  if (base >= tbsp - 0.2) return [roundFraction(base / tbsp), "tbsp"];
  return [roundFraction(base / UNITS.tsp[1], true), "tsp"];
}

function bestImperialMass(base: number): [number, string] {
  if (base >= UNITS.lb[1] - 1) return [Math.round((base / UNITS.lb[1]) * 4) / 4, "lb"];
  const oz = base / UNITS.oz[1];
  return [(oz < 10 ? Math.round(oz * 2) / 2 : Math.round(oz)) || 0.5, "oz"];
}

const WHOLE_ONLY = ["egg", "lemon", "lime", "avocado", "orange", "apple", "banana", "tortilla", "bun", "roll"];

function roundCount(q: number, item: string): number {
  const low = item.toLowerCase();
  if (WHOLE_ONLY.some((w) => low.includes(w))) return Math.max(1, Math.round(q));
  if (q >= 5) return Math.round(q);
  return roundFraction(q);
}

export type UnitSystem = "keep" | "metric" | "imperial";

export function present(qty: number, unit: string, system: UnitSystem = "keep", item = ""): [number, string] {
  const def = UNITS[unit];
  if (!def) {
    if (!unit || unit === "piece" || !COUNT[unit]) return [roundCount(qty, item), unit];
    return [roundFraction(qty), unit];
  }
  const [dim, , , , own] = def;
  const base = toBase(qty, unit);
  if (dim === "mass") {
    const target = system === "keep" ? own : system;
    return target === "metric" ? bestMetric(base, dim) : bestImperialMass(base);
  }
  if (unit === "tsp" || unit === "tbsp") {
    if (system === "metric" && base >= 58) return bestMetric(base, dim);
    return bestImperialVolume(base);
  }
  if (own === "metric") return system === "imperial" ? bestImperialVolume(base) : bestMetric(base, dim);
  if (system === "metric") return bestMetric(base, dim);
  if (unit === "cup") return bestImperialVolume(base);
  return [roundFraction(qty), unit];
}

function roundIn(v: number, unit: string, item: string): number {
  const def = UNITS[unit];
  if (def && def[4] === "metric") return unit === "kg" || unit === "l" ? Math.round((v / 1000) * 20) / 20 : roundMetric(v);
  if (unit === "lb") return Math.round(v * 4) / 4;
  if (unit === "oz") return v < 10 ? Math.round(v * 2) / 2 : Math.round(v);
  if (def) return roundFraction(v, unit === "tsp");
  return !unit || unit === "piece" || !COUNT[unit] ? roundCount(v, item) : roundFraction(v);
}

export function scaleIngredient<T extends Pick<Ingredient, "qty" | "qty_max" | "unit" | "item">>(ing: T, factor: number, system: UnitSystem = "keep"): T {
  if (ing.qty === null) return ing;
  if (factor === 1 && system === "keep") return ing;
  const [q, u] = present(ing.qty * factor, ing.unit, system, ing.item);
  let qm: number | null = null;
  if (ing.qty_max !== null) {
    let raw = ing.qty_max * factor;
    if (u !== ing.unit && UNITS[u] && UNITS[ing.unit]) raw = toBase(raw, ing.unit) / UNITS[u][1];
    const m = roundIn(raw, u, ing.item);
    qm = m > q ? m : null;
  }
  return { ...ing, qty: q, unit: u, qty_max: qm };
}

export function ingredientText(ing: Pick<Ingredient, "qty" | "qty_max" | "unit" | "item" | "note" | "optional">): string {
  let s = `${fmtQty(ing.qty, ing.unit, ing.qty_max)} ${ing.item}`.trim();
  if (ing.note) s += `, ${ing.note}`;
  if (ing.optional && !/optional/i.test(s)) s += " (optional)";
  return s;
}

/** Ingredients back to editable lines ("For the sauce:" headings included). */
export function ingredientsToLines(ings: Pick<Ingredient, "qty" | "qty_max" | "unit" | "item" | "note" | "optional" | "group">[]): string {
  const out: string[] = [];
  let group = "";
  for (const i of ings) {
    if ((i.group || "") !== group) {
      group = i.group || "";
      if (group) out.push(`${group}:`);
    }
    out.push(ingredientText(i));
  }
  return out.join("\n");
}

/** °C ⇄ °F in step text, for the person's units. */
export function convertTemps(text: string, units: "metric" | "imperial"): string {
  // A step that already gives both ("200°C (400°F)") is left alone.
  if (/°\s?F\b/.test(text) && /°\s?C\b/.test(text)) return text;
  if (units === "imperial") {
    return text.replace(/(\d{2,3})\s?°\s?C\b/g, (_m, c) => `${c}°C (${Math.round(((Number(c) * 9) / 5 + 32) / 5) * 5}°F)`);
  }
  return text.replace(/(\d{3})\s?°\s?F\b/g, (_m, f) => `${f}°F (${Math.round(((Number(f) - 32) * 5) / 9 / 5) * 5}°C)`);
}
