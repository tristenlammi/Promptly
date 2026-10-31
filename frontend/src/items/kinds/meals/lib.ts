import { addDays, fmtNum, uid } from "@/items/ui";

import { nowHM, today as todayZ, zonedNow } from "./clock";
import type { Day, Entry, Food, MealSlot, MealsData, Nutrients, Portion, SavedMeal, Settings, Targets, Unit, Weekday } from "./types";

/* Nutrition maths for the UI — the same rules as the backend's science.py
 * (portions scale per-100 g values; entries keep a snapshot). */

export const MACRO_KEYS = ["kcal", "protein", "carbs", "sugar", "fibre", "fat", "sat_fat", "sodium"] as const;
export const OZ = 28.3495;
export const LB = 0.45359237;
export const KJ = 4.184;
export const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const WEEKDAY_LABEL: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
export const MAX_VISIBLE_SLOTS = 8;

/** Household measures (ml) — a cup is the US 240 ml (labelled as such). */
export const HOUSEHOLD_ML = { cup: 240, tbsp: 15, tsp: 5, floz: 29.5735 } as const;
export const HOUSEHOLD_LABEL: Record<keyof typeof HOUSEHOLD_ML, string> = { cup: "cup (240 ml)", tbsp: "tbsp (15 ml)", tsp: "tsp (5 ml)", floz: "fl oz" };
const HOUSEHOLD_WORD: Record<keyof typeof HOUSEHOLD_ML, [string, string]> = { cup: ["cup", "cups"], tbsp: ["tbsp", "tbsp"], tsp: ["tsp", "tsp"], floz: ["fl oz", "fl oz"] };
const isHousehold = (u: Unit): u is keyof typeof HOUSEHOLD_ML => u in HOUSEHOLD_ML;

/** Data-viz hues for the macros (readable on light and dark surfaces). */
export const MACRO_COLOR = {
  protein: "#4F7FD1",
  carbs: "#D9902F",
  fat: "#C2557A",
  fibre: "#5BAA6A",
} as const;

export const MICROS: Record<string, { label: string; unit: string; dv: number | null; limit?: boolean }> = {
  potassium_mg: { label: "Potassium", unit: "mg", dv: 4700 },
  calcium_mg: { label: "Calcium", unit: "mg", dv: 1300 },
  iron_mg: { label: "Iron", unit: "mg", dv: 18 },
  magnesium_mg: { label: "Magnesium", unit: "mg", dv: 420 },
  zinc_mg: { label: "Zinc", unit: "mg", dv: 11 },
  vitamin_a_ug: { label: "Vitamin A", unit: "µg", dv: 900 },
  vitamin_c_mg: { label: "Vitamin C", unit: "mg", dv: 90 },
  vitamin_d_ug: { label: "Vitamin D", unit: "µg", dv: 20 },
  vitamin_b12_ug: { label: "Vitamin B12", unit: "µg", dv: 2.4 },
  folate_ug: { label: "Folate", unit: "µg", dv: 400 },
  cholesterol_mg: { label: "Cholesterol", unit: "mg", dv: 300, limit: true },
  added_sugar_g: { label: "Added sugar", unit: "g", dv: 50, limit: true },
  mono_fat_g: { label: "Monounsaturated fat", unit: "g", dv: null },
  poly_fat_g: { label: "Polyunsaturated fat", unit: "g", dv: null },
  trans_fat_g: { label: "Trans fat", unit: "g", dv: null, limit: true },
  omega3_g: { label: "Omega-3", unit: "g", dv: null },
  caffeine_mg: { label: "Caffeine", unit: "mg", dv: 400, limit: true },
  alcohol_g: { label: "Alcohol", unit: "g", dv: null, limit: true },
};

export function zero(): Nutrients {
  return { kcal: 0, protein: 0, carbs: 0, sugar: 0, fibre: 0, fat: 0, sat_fat: 0, sodium: 0, micros: {} };
}

// ------------------------------------------------- the file, defaults filled

/* The stored JSON leaves default fields out (see types.ts). ``meals(data)``
 * is the file with them filled back in — cached per object, so an entry or
 * day that didn't change isn't rebuilt. Read through it; write (in mutators)
 * to the raw draft, assigning only the fields that change. */

const nCache = new WeakMap<object, Nutrients>();
const eCache = new WeakMap<object, Entry>();
const pCache = new WeakMap<object, Portion>();
const dCache = new WeakMap<object, Day>();
const mCache = new WeakMap<object, SavedMeal>();
const fCache = new WeakMap<object, Food>();
const dataCache = new WeakMap<object, MealsData>();

export function fullN(n: Partial<Nutrients> | null | undefined): Nutrients {
  if (!n) return zero();
  let out = nCache.get(n);
  if (!out) {
    out = { ...zero(), ...n, micros: n.micros ?? {} } as Nutrients;
    nCache.set(n, out);
  }
  return out;
}

function portionDefaults(p: Partial<Portion>): Portion {
  return {
    brand: "",
    food_ref: null,
    amount: 1,
    unit: "serving",
    serving_id: null,
    serving_label: "",
    grams: null,
    estimate: false,
    ...p,
    name: p.name ?? "",
    n: fullN(p.n),
  } as Portion;
}

export function fullPortion(p: Partial<Portion>): Portion {
  let out = pCache.get(p);
  if (!out) {
    out = portionDefaults(p);
    pCache.set(p, out);
  }
  return out;
}

export function fullEntry(e: Partial<Entry>): Entry {
  let out = eCache.get(e);
  if (!out) {
    out = { ...portionDefaults(e), source: "food", time: null, note: "", ...e, n: fullN(e.n) } as Entry;
    out.brand ??= "";
    eCache.set(e, out);
  }
  return out;
}

function fullDay(d: Partial<Day>): Day {
  let out = dCache.get(d);
  if (!out) {
    out = { water_ml: 0, note: "", complete: false, ...d, entries: (d.entries ?? []).map(fullEntry) };
    dCache.set(d, out);
  }
  return out;
}

function fullFood(f: Food): Food {
  let out = fCache.get(f);
  if (!out) {
    const defaults: Partial<Food> = { brand: "", barcode: null, servings: [], default_serving: null, liquid: false };
    out = { ...defaults, ...f, per100: fullN(f.per100) } as Food;
    fCache.set(f, out);
  }
  return out;
}

/** The file with every default filled in (cached by identity). */
export function meals(d: MealsData): MealsData {
  let out = dataCache.get(d);
  if (!out) {
    const days: Record<string, Day> = {};
    for (const [k, v] of Object.entries(d.days ?? {})) days[k] = fullDay(v);
    out = {
      ...d,
      days,
      foods: (d.foods ?? []).map(fullFood),
      favourites: d.favourites ?? [],
      weighins: d.weighins ?? [],
      meals: (d.meals ?? []).map((m) => {
        let x = mCache.get(m);
        if (!x) {
          x = { ...m, items: (m.items ?? []).map(fullPortion) };
          mCache.set(m, x);
        }
        return x;
      }),
    };
    dataCache.set(d, out);
  }
  return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function scale(per100: Nutrients, grams: number): Nutrients {
  return scaleTotals(per100, grams / 100);
}

export function scaleTotals(n: Nutrients, f: number): Nutrients {
  const out = zero();
  for (const k of MACRO_KEYS) out[k] = r1((n[k] || 0) * f);
  for (const [k, v] of Object.entries(n.micros || {})) out.micros[k] = r2(v * f);
  return out;
}

export function addN(a: Nutrients, b: Nutrients): Nutrients {
  const out = zero();
  for (const k of MACRO_KEYS) out[k] = r1((a[k] || 0) + (b[k] || 0));
  out.micros = { ...(a.micros || {}) };
  for (const [k, v] of Object.entries(b.micros || {})) out.micros[k] = r2((out.micros[k] || 0) + v);
  return out;
}

export function total(entries: { n: Nutrients }[]): Nutrients {
  return entries.reduce((t, e) => addN(t, e.n), zero());
}

/** How many of the entries carry micronutrient data (for "from 3 of 7 foods"). */
export function microsCoverage(entries: { n: Nutrients }[]): { withMicros: number; of: number } {
  return { withMicros: entries.filter((e) => Object.keys(e.n.micros || {}).length > 0).length, of: entries.length };
}

export const kcalFromMacros = (p: number, c: number, f: number) => r1(p * 4 + c * 4 + f * 9);

export function servingOf(food: Food, servingId: string | null | undefined) {
  const s = food.servings || [];
  return s.find((x) => x.id === servingId) ?? s.find((x) => x.id === food.default_serving) ?? s[0] ?? null;
}

/** Grams per ml when a cup / spoon measure makes sense for the food. */
export function densityOf(food: Food | null): number | null {
  if (!food) return 1; // a described item: the person's own estimate
  if (food.density && food.density > 0) return food.density;
  return food.liquid ? 1 : null;
}

export function gramsFor(food: Food | null, amount: number, unit: Unit, servingId: string | null): { grams: number | null; label: string } {
  if (unit === "ml" && food?.density) return { grams: amount * food.density, label: "" };
  if (unit === "g" || unit === "ml") return { grams: amount, label: "" };
  if (unit === "oz") return { grams: amount * OZ, label: "" };
  if (isHousehold(unit)) {
    const dens = densityOf(food);
    return dens === null ? { grams: null, label: "" } : { grams: amount * HOUSEHOLD_ML[unit] * dens, label: HOUSEHOLD_LABEL[unit] };
  }
  if (unit === "serving" && food) {
    const s = servingOf(food, servingId);
    return s ? { grams: amount * s.grams, label: s.label } : { grams: amount * 100, label: "100 g" };
  }
  return { grams: null, label: "" };
}

export function portionOf(food: Food, amount: number, unit: Unit, servingId: string | null): Portion {
  const { grams, label } = gramsFor(food, amount, unit, servingId);
  const s = unit === "serving" ? servingOf(food, servingId) : null;
  return {
    name: food.name,
    brand: food.brand || "",
    food_ref: food.id,
    amount,
    unit,
    serving_id: s?.id ?? null,
    serving_label: label,
    grams: grams === null ? null : r1(grams),
    n: scale(food.per100, grams ?? 0),
    estimate: false,
  };
}

export function emptyDay(): Day {
  return { entries: [], water_ml: 0, note: "", complete: false };
}

/** A day of the (filled-in) file — never undefined. */
export function dayOf(d: MealsData, day: string): Day {
  const x = meals(d).days[day];
  return x ?? emptyDay();
}

/** For a mutator: the raw day, created if missing. */
export function ensureDay(d: MealsData, day: string): Day {
  if (!d.days[day]) d.days[day] = emptyDay();
  const x = d.days[day];
  x.entries ??= [];
  x.water_ml ??= 0;
  return x;
}

export function weekdayOf(day: string): Weekday {
  const [y, m, dd] = day.split("-").map(Number);
  const js = new Date(y, m - 1, dd).getDay(); // 0 = Sun
  return WEEKDAYS[(js + 6) % 7];
}

export function targetsFor(t: Targets, day: string) {
  const over = t.weekday?.[weekdayOf(day)] ?? {};
  return {
    kcal: over.kcal ?? t.kcal,
    protein: over.protein ?? t.protein,
    carbs: over.carbs ?? t.carbs,
    fat: over.fat ?? t.fat,
    fibre: t.fibre,
    sodium: t.sodium,
    sugar: t.sugar,
    water_ml: t.water_ml,
  };
}

/** The meals you can log into (removed meals with history are hidden). */
export function visibleSlots(s: Settings): MealSlot[] {
  const v = s.meal_slots.filter((x) => !x.hidden);
  return v.length ? v : s.meal_slots.slice(0, 1);
}

/** A day's meal cards: the shown meals, then removed meals this day has
 *  entries in, then "Other" for entries whose meal no longer exists. */
export function daySlots(s: Settings, entries: Entry[]): { slot: MealSlot; entries: Entry[]; archived: boolean }[] {
  const vis = visibleSlots(s);
  const out = vis.map((slot) => ({ slot, entries: [] as Entry[], archived: false }));
  const by = new Map(out.map((x) => [x.slot.id, x]));
  for (const e of entries) {
    let g = by.get(e.slot);
    if (!g) {
      const known = s.meal_slots.find((x) => x.id === e.slot);
      g = { slot: known ?? { id: e.slot, name: "Other", remind_at: null, hidden: true }, entries: [], archived: true };
      by.set(e.slot, g);
      out.push(g);
    }
    g.entries.push(e);
  }
  return out.filter((g) => !g.archived || g.entries.length);
}

export function guessSlot(slots: MealSlot[]): string {
  const vis = slots.filter((x) => !x.hidden);
  const z = zonedNow();
  const h = z.hour + z.minute / 60;
  const want = h < 10.5 ? "breakfast" : h < 15 ? "lunch" : h < 17 ? "snacks" : h < 21.5 ? "dinner" : "snacks";
  return vis.find((s) => s.id === want)?.id ?? vis[vis.length - 1]?.id ?? slots[0]?.id ?? "snacks";
}

export { nowHM };

/** A new diary entry — build it OUTSIDE ``item.update`` (the id is random),
 *  then push it inside. */
export function makeEntry(p: Portion, slot: string, source: Entry["source"], day: string): Entry {
  return { ...p, id: uid("e"), slot, source, time: day === todayZ() ? nowHM() : null, note: "" };
}

export function portionText(p: Portion): string {
  const amt = fmtNum(p.amount, 2);
  if (p.unit === "serving") {
    if (!p.serving_label) return p.amount === 1 ? "1 serving" : `${amt} servings`;
    return p.amount === 1 ? p.serving_label : `${amt} × ${p.serving_label}`;
  }
  if (p.unit === "kcal") return "quick add";
  if (isHousehold(p.unit)) return `${amt} ${HOUSEHOLD_WORD[p.unit][p.amount === 1 ? 0 : 1]}`;
  return `${amt} ${p.unit}`;
}

// ------------------------------------------------------------------ units

export function energy(kcal: number, s: Settings): number {
  return s.energy_unit === "kJ" ? kcal * KJ : kcal;
}
export function fmtEnergy(kcal: number, s: Settings, withUnit = false): string {
  const v = fmtNum(Math.round(energy(kcal, s)));
  return withUnit ? `${v} ${s.energy_unit}` : v;
}
export function toKcal(v: number, s: Settings): number {
  return s.energy_unit === "kJ" ? v / KJ : v;
}
export function weightOut(kg: number, s: Settings): number {
  return s.weight_unit === "lb" ? kg / LB : kg;
}
export function weightIn(v: number, s: Settings): number {
  return s.weight_unit === "lb" ? v * LB : v;
}
export function fmtWeight(kg: number | null | undefined, s: Settings, digits = 1): string {
  if (kg === null || kg === undefined) return "–";
  return `${fmtNum(weightOut(kg, s), digits)} ${s.weight_unit}`;
}
export function waterOut(ml: number, s: Settings): string {
  return s.water_unit === "floz" ? `${fmtNum(ml / 29.5735, 0)} fl oz` : ml >= 1000 ? `${fmtNum(ml / 1000, 2)} L` : `${fmtNum(ml)} ml`;
}

// ------------------------------------------------------------- recents etc.

export interface Recent {
  key: string;
  food: Food | null; // a resolvable food
  portion: Portion; // the last portion logged (for one-tap re-log)
  times: number;
  last: string;
}

/** Foods logged recently (newest first), one per food (or free-text name). */
export function recents(d: MealsData, resolve: (ref: string | null) => Food | null, days = 45, limit = 40): Recent[] {
  const data = meals(d);
  const map = new Map<string, Recent>();
  const keys = Object.keys(data.days).sort().reverse();
  const cutoff = addDays(todayZ(), -days);
  for (const day of keys) {
    if (day < cutoff) break;
    const es = data.days[day].entries;
    for (let i = es.length - 1; i >= 0; i--) {
      const e = es[i];
      const key = e.food_ref ?? `n:${e.name.toLowerCase()}|${e.brand.toLowerCase()}`;
      const hit = map.get(key);
      if (hit) hit.times += 1;
      else map.set(key, { key, food: resolve(e.food_ref), portion: e, times: 1, last: day });
    }
  }
  return [...map.values()].slice(0, limit);
}

/** Foods with a barcode, most recently added first (scan / type history
 *  that works offline). */
export function recentBarcodes(d: MealsData, limit = 8): Food[] {
  return meals(d)
    .foods.filter((f) => f.barcode)
    .slice()
    .sort((a, b) => ((b.created ?? "") > (a.created ?? "") ? 1 : -1))
    .slice(0, limit);
}

// ------------------------------------------------------------------ search
/* Mirrors backend/app/items/kinds/meals/search.py exactly — keep in step.
 * "eggs" → Egg, "bananas" → Banana, "yoghurt" → Yogurt, "aubergine" →
 * Eggplant, "yog" → Yogurt (prefix). */

const CANON: Record<string, string> = {
  yoghurt: "yogurt", yoghourt: "yogurt", yogourt: "yogurt", doughnut: "donut", chilli: "chili", chile: "chili",
  flavour: "flavor", flavoured: "flavored", savoury: "savory", colour: "color", fibre: "fiber", wholemeal: "wholewheat",
  skimmed: "skim", fillet: "filet", omelette: "omelet", catsup: "ketchup",
  aubergine: "eggplant", courgette: "zucchini", capsicum: "pepper", prawn: "shrimp", coriander: "cilantro", rocket: "arugula",
  beetroot: "beet", mince: "ground", minced: "ground", biscuit: "cookie", crisp: "chip", porridge: "oatmeal", maize: "corn",
  sultana: "raisin", garbanzo: "chickpea", swede: "rutabaga", rockmelon: "cantaloupe", lolly: "candy", cornflour: "cornstarch",
  icing: "frosting", spud: "potato", tinned: "canned", jello: "jelly", kiwifruit: "kiwi",
};
const IRREGULAR: Record<string, string> = { leaves: "leaf", loaves: "loaf", halves: "half", knives: "knife", teeth: "tooth", geese: "goose", mice: "mouse", fungi: "fungus", cacti: "cactus" };

export function stem(w: string): string {
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (w.length > 4 && w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.length > 4 && ["xes", "zes", "ches", "shes", "oes"].some((x) => w.endsWith(x))) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 3 && w.endsWith("s") && !["ss", "us", "is"].some((x) => w.endsWith(x))) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("ie")) w = w.slice(0, -2) + "y";
  return w;
}

const tokCache = new Map<string, string[]>();

export function foodTokens(text: string): string[] {
  const hit = tokCache.get(text);
  if (hit) return hit;
  const folded = text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const out = (folded.match(/[a-z0-9]+/g) ?? []).map((w) => {
    const s = stem(CANON[w] ?? w);
    return stem(CANON[s] ?? s);
  });
  if (tokCache.size > 20_000) tokCache.clear();
  tokCache.set(text, out);
  return out;
}

function matchWord(q: string, words: string[]): number {
  let best = 0;
  for (const w of words) {
    if (w === q) return 1;
    if (q.length >= 3 && w.startsWith(q)) best = Math.max(best, 0.85);
    else if (w.length >= 4 && q.startsWith(w) && q.length - w.length <= 2) best = Math.max(best, 0.7);
  }
  return best;
}

/** 0 = no match; higher is better (same as search.py ``score``). */
export function scoreText(name: string, brand: string, query: string): number {
  const qs = foodTokens(query);
  if (!qs.length) return 0;
  const nameW = foodTokens(name);
  const words = [...nameW, ...foodTokens(brand || "")];
  const hits = qs.map((q) => matchWord(q, words));
  const matched = hits.filter((h) => h > 0).length;
  if (!matched) return 0;
  let s = hits.reduce((a, b) => a + b, 0) / qs.length;
  if (matched === qs.length) s += 0.3;
  if (nameW.length && nameW[0] === qs[0]) s += 0.5;
  else if (nameW.length && qs[0].length >= 3 && nameW[0].startsWith(qs[0])) s += 0.3;
  return s;
}

export function scoreFood(f: Food, q: string): number {
  const s = scoreText(f.name, f.brand, q);
  return s > 0 && !f.id.startsWith("b:") ? s + 0.2 : s;
}

export function searchFoods(pool: Food[], q: string, favs: Set<string>, limit = 40): Food[] {
  const query = q.trim();
  if (!query) return [];
  return pool
    .map((f, i) => ({ f, i, s: scoreFood(f, query) }))
    .filter((x) => x.s > 0)
    .map((x) => (favs.has(x.f.id) ? { ...x, s: x.s + 0.3 } : x))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.f);
}

export function foodLabel(f: { name: string; brand?: string }): string {
  return f.brand ? `${f.name} · ${f.brand}` : f.name;
}

export function defaultPortionText(f: Food, st?: Settings): string {
  const s = servingOf(f, null);
  const e = (kcal: number) => (st ? fmtEnergy(kcal, st, true) : `${fmtNum(kcal)} kcal`);
  if (!s) return `${e(f.per100.kcal)} / 100 ${f.liquid ? "ml" : "g"}`;
  return `${s.label} · ${e((f.per100.kcal * s.grams) / 100)}`;
}

// ---------------------------------------------------------------- barcodes

/** A GTIN-8/12/13/14 (EAN-8, UPC-A, EAN-13, ITF-14) with a correct check
 *  digit — same rule as the server. */
export function validGtin(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const d = [...code].map(Number);
  const check = d.pop()!;
  const sum = d.reverse().reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** A short UPC-E (8 digits, number system 0/1) as its full UPC-A. */
export function expandUpcE(code: string): string | null {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const [n, a, b, c, d, e, f, chk] = [...code];
  const body =
    f <= "2" ? `${n}${a}${b}${f}0000${c}${d}${e}` : f === "3" ? `${n}${a}${b}${c}00000${d}${e}` : f === "4" ? `${n}${a}${b}${c}${d}00000${e}` : `${n}${a}${b}${c}${d}${e}0000${f}`;
  return `${body}${chk}`;
}

/** The lookup-ready GTIN for typed / scanned digits, or null if invalid. */
export function normalizeBarcode(code: string): string | null {
  if (validGtin(code)) return code;
  if (code.length === 8) {
    const a = expandUpcE(code);
    if (a && validGtin(a)) return a;
  }
  return null;
}

export function barcodeProblem(code: string): string | null {
  if (!code) return null;
  if (![8, 12, 13, 14].includes(code.length)) return `Barcodes have 8, 12, 13 or 14 digits — this has ${code.length}.`;
  if (!normalizeBarcode(code)) return "The last (check) digit doesn't match — a digit is probably off.";
  return null;
}

// ------------------------------------------------------------------- misc

export function age(profile: { birth_year: number | null }): number | null {
  return profile.birth_year ? new Date().getFullYear() - profile.birth_year : null;
}

export function pct(n: number, of: number): number {
  return of > 0 ? n / of : 0;
}

export function macroSplit(n: { protein: number; carbs: number; fat: number }) {
  const p = n.protein * 4;
  const c = n.carbs * 4;
  const f = n.fat * 9;
  const t = p + c + f || 1;
  return { protein: p / t, carbs: c / t, fat: f / t };
}

export function errorText(e: unknown): string {
  const anyE = e as { response?: { data?: { detail?: unknown } }; message?: string };
  const d = anyE?.response?.data?.detail;
  if (typeof d === "string") return d;
  return anyE?.message || "Something went wrong.";
}

export const DIET_TAGS = ["vegetarian", "vegan", "pescatarian", "gluten-free", "dairy-free", "nut-free", "halal", "kosher", "low-FODMAP"];

export const ACTIVITY_OPTIONS = [
  { value: "sedentary", label: "Sedentary", hint: "Desk job, little exercise" },
  { value: "light", label: "Lightly active", hint: "Exercise 1–3 days a week" },
  { value: "moderate", label: "Moderately active", hint: "Exercise 3–5 days a week" },
  { value: "active", label: "Very active", hint: "Hard exercise 6–7 days a week" },
  { value: "very_active", label: "Extremely active", hint: "Physical job plus training" },
] as const;

export const STYLE_OPTIONS = [
  { value: "balanced", label: "Balanced" },
  { value: "high_protein", label: "High protein" },
  { value: "low_carb", label: "Low carb" },
  { value: "keto", label: "Keto" },
  { value: "low_fat", label: "Low fat" },
] as const;

// --------------------------------------------- header "Add food" (shell)

/* The shell's header button lives outside the Diary; it switches to the
 * Diary (goTo) and asks it to open Add food through this tiny signal. A
 * request made before the Diary mounts is kept until it does. */
let addPending = false;
const addListeners = new Set<() => void>();

export function requestAddFood(): void {
  addPending = true;
  for (const l of addListeners) l();
}

export function onAddFoodRequest(fn: () => void): () => void {
  const run = () => {
    if (addPending) {
      addPending = false;
      fn();
    }
  };
  addListeners.add(run);
  run();
  return () => void addListeners.delete(run);
}
