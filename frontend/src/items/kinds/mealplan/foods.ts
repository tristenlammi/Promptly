/*
 * Food knowledge in the app — a port of backend/app/items/kinds/mealplan/
 * foods.py over the SAME tables (``foods.json`` here is a copy of the
 * backend's; a backend test fails when they differ). Keep the matching
 * rules below in step with the Python: allergy warnings in the app and the
 * server's refusals must agree.
 */
import FOODS from "./foods.json";
import type { Amount, GroceryItem, Ingredient, MealPlanData } from "./types";
import { present } from "./units";

interface AllergenTable {
  words: string[];
  safe: string[];
  whole: string[];
}

const FOLD: Record<string, string> = { "œ": "oe", "æ": "ae", "ß": "ss", "ø": "o", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "’": "'", "‘": "'", "ʼ": "'" };

/** Lowercase, accents and ligatures folded ("Crème fraîche" → "creme
 *  fraiche"), punctuation → spaces, single-spaced. */
export function normalize(text: string): string {
  let s = (text || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  for (const [a, b] of Object.entries(FOLD)) s = s.split(a).join(b);
  s = s.replace(/[^a-z0-9' ]+/g, " ");
  return s.split(/\s+/).filter(Boolean).join(" ");
}

const cleanText = (name: string) => normalize((name || "").replace(/\([^)]*\)/g, " "));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ---------------------------------------------------------------- names */

const PREP = new Set<string>(FOODS.prep_words);
const SING_EXCEPT = new Set<string>(FOODS.singular_except);
const SING_MAP = FOODS.singular_map as Record<string, string>;
const SYNONYMS: Record<string, string> = Object.fromEntries(Object.entries(FOODS.synonyms as Record<string, string>).map(([k, v]) => [normalize(k), v]));

export function singular(word: string): string {
  const w = word.toLowerCase();
  if (SING_MAP[w]) return SING_MAP[w];
  if (SING_EXCEPT.has(w) || w.length <= 3) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("oes")) return w.slice(0, -2);
  if (/(ches|shes|xes|sses|zes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("ss") || w.endsWith("us") || w.endsWith("is")) return w;
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

const syn = (words: string[]) => {
  const k = words.join(" ");
  return SYNONYMS[k] ?? k;
};

/** The grocery identity of an ingredient name (see foods.ingredient_key). */
export function ingredientKey(name: string): string {
  const text = cleanText(name.includes(",") ? name.split(",")[0] : name);
  const full = text.split(" ").filter((w) => w && !/^\d+$/.test(w.replace(/'/g, "")));
  if (full.length) {
    const whole = [...full.slice(0, -1), singular(full[full.length - 1])];
    if (SYNONYMS[whole.join(" ")] !== undefined) return syn(whole).slice(0, 80);
  }
  let words = full.filter((w) => !PREP.has(w));
  if (!words.length) words = text.split(" ").filter(Boolean).slice(0, 3);
  if (!words.length) return "";
  words[words.length - 1] = singular(words[words.length - 1]);
  return syn(words).slice(0, 80);
}

/** A hand-added grocery item's key (grocery.manual_key). */
export function manualKey(name: string): string {
  return ingredientKey(name) || normalize(name).slice(0, 80) || name.toLowerCase().slice(0, 80);
}

/* --------------------------------------------------------------- aisles */

const PHRASES: [string, string][] = Object.entries(FOODS.aisle_words as Record<string, string[]>)
  .flatMap(([a, ws]) => ws.map((w) => [normalize(w), a] as [string, string]))
  .sort((x, y) => y[0].length - x[0].length);
const PRIORITY = FOODS.aisle_priority as [string, string][];

function hasPhrase(text: string, word: string): boolean {
  if (/(err|anchov)$/.test(word)) return new RegExp(`(?<![a-z])${esc(word)}`).test(text);
  return new RegExp(`(?<![a-z'])${esc(word)}(?:s|es)?(?![a-z])`).test(text);
}

export function aisleFor(name: string, overrides: { key: string; aisle: string }[] = [], key = ""): string {
  const o = key ? overrides.find((x) => x.key === key) : undefined;
  if (o) return o.aisle || "other";
  const low = cleanText(name);
  for (const [word, aisle] of PRIORITY) {
    if (hasPhrase(low, word.trim())) {
      if (word === "dried ") for (const [w, a] of PHRASES) if (a === "spices" && hasPhrase(low, w)) return "spices";
      return aisle;
    }
  }
  for (const [w, a] of PHRASES) if (hasPhrase(low, w)) return a;
  return "other";
}

/* ------------------------------------------------------------ allergens */

const ALLERGENS: Record<string, AllergenTable> = Object.fromEntries(
  Object.entries(FOODS.allergens as Record<string, AllergenTable>).map(([k, v]) => [k, { words: v.words.map(normalize), safe: v.safe.map(normalize), whole: (v.whole ?? []).map(normalize) }]),
);
const ALIASES: Record<string, string> = Object.fromEntries(Object.entries(FOODS.allergy_aliases as Record<string, string>).map(([k, v]) => [normalize(k), v]));
const GROUPS = FOODS.allergy_groups as Record<string, string[]>;
const NOISE = /^(?:allergic to|allergy to|allergies to|intolerant to|no)\s+|\s+(?:allergy|allergies|intolerance|intolerant|allergic)$/g;

const reCache = new Map<string, RegExp>();
function wordRe(word: string, whole: boolean): RegExp {
  const k = `${whole ? 1 : 0}${word}`;
  let r = reCache.get(k);
  if (!r) {
    r = new RegExp(`(?<![a-z])${esc(word)}${whole ? "(?:s|es)?(?![a-z])" : ""}`);
    reCache.set(k, r);
  }
  return r;
}

export function allergyKeys(allergy: string): string[] {
  let a = normalize(allergy).replace(NOISE, "").trim();
  a = ALIASES[a] ?? a;
  if (!a) return [];
  return GROUPS[a] ? [...GROUPS[a]] : [a];
}

function hits(texts: string[], words: string[], safe: string[], whole: string[], free: string[]): string[] {
  const alts = [...new Set(free.filter(Boolean))].sort((x, y) => y.length - x.length).map(esc).join("|");
  const freeRe = alts ? new RegExp(`(?<![a-z])(?:${alts}) free(?: [a-z']+)?(?![a-z])`, "g") : null;
  return texts.filter((t) => {
    let low = ` ${normalize(t)} `;
    if (freeRe) low = low.replace(freeRe, " ");
    for (const p of safe) if (p) low = low.replace(new RegExp(`(?<![a-z])${esc(p)}(?:s|es)?(?![a-z])`, "g"), " ");
    return words.some((w) => w && wordRe(w, false).test(low)) || whole.some((w) => w && wordRe(w, true).test(low));
  });
}

/** The texts that contain ``allergy`` (foods.allergy_hits). */
export function allergyHits(texts: string[], allergy: string): string[] {
  const found = new Set<string>();
  for (const a of allergyKeys(allergy)) {
    const t = ALLERGENS[a] ?? { words: [singular(a)], safe: [], whole: [] };
    for (const h of hits(texts, t.words, t.safe, t.whole, [a, ...a.split(" "), ...t.words, ...t.whole])) found.add(h);
  }
  return texts.filter((t) => found.has(t));
}

export const ingredientTexts = (ings: Pick<Ingredient, "item" | "note">[]) => ings.map((i) => (i.item || "") + (i.note ? `, ${i.note}` : ""));

/** {allergy as written: [ingredient texts that contain it]} — item AND note. */
export function allergenReport(ings: Pick<Ingredient, "item" | "note">[], allergies: string[]): Record<string, string[]> {
  if (!allergies.length) return {};
  const texts = ingredientTexts(ings);
  const out: Record<string, string[]> = {};
  for (const a of allergies) {
    const h = allergyHits(texts, a);
    if (h.length) out[a] = h;
  }
  return out;
}

/** Free text ("Satay noodles") against the allergy list → the allergies it names. */
export function textAllergens(text: string, allergies: string[]): string[] {
  return text.trim() ? allergies.filter((a) => allergyHits([text], a).length) : [];
}

/* --------------------------------------------------- grocery lines (offline) */

const UNIT_ALIASES = FOODS.unit_aliases as Record<string, string>;
const ALIAS_BY_LEN = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length);
const FRAC: Record<string, number> = { "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };
const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, half: 0.5 };
const MASS_VOL = new Set(["mg", "g", "kg", "oz", "lb", "ml", "cl", "dl", "l", "tsp", "tbsp", "floz", "cup", "pint", "quart", "gallon"]);
const FLUID = new Set<string>(FOODS.fluid_oz);

function parseNum(s: string): number | null {
  const t = s.trim();
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return parseFloat(t.replace(/,/g, ""));
  let m = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (m) return +m[1] + (+m[3] ? +m[2] / +m[3] : 0);
  m = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) return +m[2] ? +m[1] / +m[2] : null;
  m = t.match(/^(\d+(?:[.,]\d+)?)?\s*([½⅓⅔¼¾⅛⅜⅝⅞])$/);
  if (m) return (m[1] ? parseFloat(m[1].replace(",", ".")) : 0) + FRAC[m[2]];
  const n = parseFloat(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** "2 lb chicken thighs" → {qty: 2, unit: "lb", name: "chicken thighs"};
 *  "paper towels" → {qty: null}. A light port of parse.parse_ingredient for
 *  grocery lines typed offline. */
export function parseGroceryLine(line: string): { qty: number | null; unit: string; name: string; note: string } {
  let s = line.replace(/\s+/g, " ").trim().replace(/^[-–—•*·]+\s*/, "");
  let note = "";
  const paren = s.match(/\(([^)]*)\)/);
  if (paren) {
    note = paren[1].trim();
    s = s.replace(/\s*\([^)]*\)/, "").trim();
  }
  // "item, note" — but not the comma in "1,500 ml".
  const comma = s.search(/,(?!\d)/);
  if (comma >= 0) {
    note = [note, s.slice(comma + 1).trim()].filter(Boolean).join(", ");
    s = s.slice(0, comma).trim();
  }
  let qty: number | null = null;
  const m = s.match(/^(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?\s*[½⅓⅔¼¾⅛⅜⅝⅞]|\d+(?:[.,]\d+)?|[½⅓⅔¼¾⅛⅜⅝⅞])\s*/);
  if (m) {
    qty = parseNum(m[1]);
    s = s.slice(m[0].length);
  } else {
    const w = s.match(/^([a-z]+)\s+/i);
    if (w && WORDS[w[1].toLowerCase()] !== undefined) {
      qty = WORDS[w[1].toLowerCase()];
      s = s.slice(w[0].length);
    }
  }
  s = s.replace(/^[x×]\s+/i, "");
  let unit = "";
  if (qty !== null) {
    const low = s.toLowerCase();
    for (const a of ALIAS_BY_LEN) {
      if (low.startsWith(a)) {
        const after = s.slice(a.length).replace(/^\./, "");
        if (after === "" || !/^[a-z0-9]/i.test(after)) {
          unit = UNIT_ALIASES[a];
          s = after.trim();
          break;
        }
      }
    }
  }
  s = s.replace(/^of\s+/i, "").trim();
  if (unit === "oz") {
    const k = ingredientKey(s);
    if (FLUID.has(k) || [...FLUID].some((f) => k.endsWith(` ${f}`))) unit = "floz";
  }
  if (!s) return { qty: null, unit: "", name: line.trim(), note: "" };
  return { qty, unit, name: s, note };
}

const toBase = (q: number, u: string): number => {
  const F: Record<string, number> = { mg: 0.001, g: 1, kg: 1000, oz: 28.3495, lb: 453.592, ml: 1, cl: 10, dl: 100, l: 1000, tsp: 4.92892, tbsp: 14.7868, floz: 29.5735, cup: 236.588, pint: 473.176, quart: 946.353, gallon: 3785.41 };
  return F[u] ? q * F[u] : q;
};
const dimOf = (u: string) => (["mg", "g", "kg", "oz", "lb"].includes(u) ? "mass" : MASS_VOL.has(u) ? "volume" : `count:${u}`);

/** Sum amounts like grocery.amounts_to_base + present_amounts (simplified:
 *  each dimension presented in the person's system). */
export function sumAmounts(list: Amount[], system: "metric" | "imperial", key: string): Amount[] {
  const base = new Map<string, number>();
  for (const a of list) {
    if (a.qty === null) continue;
    const d = dimOf(a.unit);
    base.set(d, (base.get(d) ?? 0) + toBase(a.qty, a.unit));
  }
  const out: Amount[] = [];
  for (const [d, v] of base) {
    if (v <= 1e-9) continue;
    if (d === "mass") {
      const [q, u] = present(v, "g", system === "metric" ? "metric" : "imperial", key);
      out.push({ qty: q, unit: u });
    } else if (d === "volume") {
      const [q, u] = present(v, "ml", system === "metric" ? "metric" : "imperial", key);
      out.push({ qty: q, unit: u });
    } else {
      const u = d.slice(6);
      out.push({ qty: u ? Math.round(v * 100) / 100 : Math.max(1, Math.ceil(v - 0.05)), unit: u });
    }
  }
  return out.slice(0, 6);
}

/** Add typed lines to the grocery list inside a mutator — offline, no
 *  server. ``ids`` are made outside the mutator (one per line). Merges into
 *  an unchecked item with the same key, like grocery.add_manual. Returns
 *  how many were added / merged. */
export function addGroceryLines(d: MealPlanData, lines: string[], ids: string[]): { added: number; merged: number } {
  let added = 0;
  let merged = 0;
  lines.forEach((line, n) => {
    const p = parseGroceryLine(line);
    if (!p.name.trim()) return;
    const r = addGroceryItem(d, { name: p.name, qty: p.qty, unit: p.unit, note: p.note }, ids[n]);
    if (r === "merged") merged += 1;
    else if (r === "added") added += 1;
  });
  return { added, merged };
}

/** One item: "added", "merged" into an existing one, or "full". */
export function addGroceryItem(d: MealPlanData, it: { name: string; qty: number | null; unit: string; note?: string; aisle?: string }, id: string): "added" | "merged" | "full" {
  const key = manualKey(it.name);
  const items = d.grocery.items;
  const same = items.find((i) => (i.key || manualKey(i.name)) === key && !i.checked);
  const system = d.preferences.units;
  if (same) {
    if (it.qty !== null) {
      same.amounts = sumAmounts([...same.amounts, { qty: it.qty, unit: it.unit }], system, key);
      if (same.source === "plan") same.qty_edited = true;
    }
    if (it.note) same.note = it.note.slice(0, 300);
    return "merged";
  }
  if (items.length >= 600) return "full";
  const clean = it.name.replace(/\s+/g, " ").trim().slice(0, 200);
  const row: GroceryItem = {
    id,
    name: clean.charAt(0).toUpperCase() + clean.slice(1),
    key,
    amounts: it.qty !== null ? [(([q, u]) => ({ qty: q, unit: u }))(present(it.qty, it.unit, "keep", key))] : [],
    aisle: it.aisle && it.aisle in FOODS.aisles ? it.aisle : aisleFor(clean, d.aisle_overrides, key),
    checked: false,
    source: "manual",
    recipes: [],
    note: (it.note ?? "").slice(0, 300),
    renamed: false,
    qty_edited: false,
  };
  items.push(row);
  return "added";
}
