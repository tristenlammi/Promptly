import { useEffect, useMemo } from "react";

import { apiClient } from "@/api/client";
import { addDays, parseDay, todayISO, uid } from "@/items/ui";

import { allergenReport } from "./foods";
import type { Ingredient, MealPlanData, PlanEntry, Preferences, Recipe, RecipeDraft } from "./types";

/* ------------------------------------------------------------------ api */

export const mealplanApi = {
  async importRecipe(body: { url?: string; text?: string }): Promise<RecipeDraft> {
    const { data } = await apiClient.post("/items/k/mealplan/import", body, { timeout: 40_000 });
    return data.recipe;
  },
  async parseLines(lines: string[]): Promise<Omit<Ingredient, "id">[]> {
    const { data } = await apiClient.post("/items/k/mealplan/parse", { lines }, { timeout: 20_000 });
    return data.ingredients;
  },
};

/* ---------------------------------------------------------------- dates */

/** First day of the week ``day`` is in (``weekStart``: 0 = Sunday … 6 = Saturday). */
export function startOfWeek(day: string, weekStart: number): string {
  const d = parseDay(day);
  const diff = (d.getDay() - weekStart + 7) % 7;
  return addDays(day, -diff);
}

export function weekDays(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

const shortDay = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayNum = new Intl.DateTimeFormat(undefined, { day: "numeric" });
const monthDay = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

export const fmtWeekday = (day: string) => shortDay.format(parseDay(day));
export const fmtDayNum = (day: string) => dayNum.format(parseDay(day));
export const fmtMonthDay = (day: string) => monthDay.format(parseDay(day));

export function fmtRange(a: string, b: string): string {
  const da = parseDay(a);
  const db = parseDay(b);
  if (da.getMonth() === db.getMonth()) return `${dayNum.format(da)} – ${monthDay.format(db)}`;
  return `${monthDay.format(da)} – ${monthDay.format(db)}`;
}

export const isWeekend = (day: string) => {
  const g = parseDay(day).getDay();
  return g === 0 || g === 6;
};

export function fmtMinutes(m: number | null | undefined): string {
  if (!m) return "";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/* -------------------------------------------------------------- recipes */

export function emptyRecipe(): Recipe {
  return {
    id: uid("r"),
    title: "",
    servings: 4,
    ingredients: [],
    steps: [],
    prep_min: null,
    cook_min: null,
    total_min: null,
    tags: [],
    cuisine: "",
    source_url: "",
    image_url: "",
    notes: "",
    prep_ahead: "",
    rating: 0,
    favorite: false,
    times_cooked: 0,
    last_cooked: null,
    nutrition: null,
    added: todayISO(),
  };
}

export function recipeFromDraft(d: RecipeDraft): Recipe {
  return {
    ...emptyRecipe(),
    ...d,
    title: (d.title || "Imported recipe").slice(0, 200),
    prep_ahead: d.prep_ahead ?? "",
    ingredients: d.ingredients.map((i, n) => ({ ...i, id: `i${n + 1}` })),
  };
}

export function recipeTime(r: Recipe): number | null {
  return r.total_min ?? ((r.prep_min ?? 0) + (r.cook_min ?? 0) || null);
}

/** Servings a planned meal cooks (its own, or the household's). */
export function entryServings(e: PlanEntry, prefs: Preferences): number {
  return e.servings ?? prefs.household_size;
}

/** Leftover servings that ride on this cook. */
export function leftoverServings(data: MealPlanData, entry: PlanEntry): number {
  return data.plan.filter((x) => x.leftovers_of === entry.id).reduce((n, x) => n + entryServings(x, data.preferences), 0);
}

export function sortPlan(plan: PlanEntry[]): void {
  const order = { breakfast: 0, lunch: 1, dinner: 2, snack: 3 };
  plan.sort((a, b) => (a.date === b.date ? order[a.slot] - order[b.slot] : a.date < b.date ? -1 : 1));
}

/* ----------------------------------------------------- allergen warnings */

type WithIngredients = { ingredients: Pick<Ingredient, "item" | "note">[] };

/** Ingredients of ``recipe`` (item + note) that hit the person's allergies —
 *  the same tables and rules as the server's check (foods.ts). */
export function allergenHits(recipe: WithIngredients, allergies: string[]): string[] {
  return [...new Set(Object.values(allergenReport(recipe.ingredients, allergies)).flat())];
}

/** "dairy (butter, crème fraîche); tree nut (pesto)" for a warning line. */
export function allergenSummary(recipe: WithIngredients, allergies: string[]): string {
  return Object.entries(allergenReport(recipe.ingredients, allergies))
    .map(([a, h]) => `${a} (${h.slice(0, 3).join(", ")})`)
    .join("; ");
}

/** Ask before putting a recipe with an allergen on the plan (drag/drop,
 *  tap-to-place, the pickers). True = go ahead. */
export function confirmAllergens(recipe: WithIngredients & { title: string }, allergies: string[]): boolean {
  const s = allergenSummary(recipe, allergies);
  if (!s) return true;
  return window.confirm(`“${recipe.title}” contains ${s} — on your allergy list.

Plan it anyway?`);
}

/* --------------------------------------------------------------- timers */

const WORD_NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, half: 0.5 };

export interface DetectedTimer {
  label: string;
  seconds: number;
}

/** "Bake for 25–30 minutes", "simmer 1 hour 15 minutes", "rest 30 secs" → timers. */
export function detectTimers(text: string): DetectedTimer[] {
  const re = /(\d+(?:[.,]\d+)?|½|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty(?:-five)?|half(?: an?)?)\s*(?:(?:-|–|to)\s*(\d+(?:[.,]\d+)?)\s*)?(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  const out: DetectedTimer[] = [];
  let m: RegExpExecArray | null;
  let last: { end: number; idx: number; unit: string } | null = null;
  while ((m = re.exec(text))) {
    const rawN = m[1].toLowerCase();
    const n = rawN === "½" ? 0.5 : WORD_NUM[rawN.split(" ")[0]] ?? parseFloat(rawN.replace(",", "."));
    const hi = m[2] ? parseFloat(m[2].replace(",", ".")) : null;
    if (!Number.isFinite(n) || n <= 0) continue;
    const u = m[3].toLowerCase();
    // a lone "m"/"s"/"h" only right after a digit ("25m"), not "a s…"
    if (u.length === 1 && !/\d$/.test(m[1])) continue;
    if (/^(a|an)$/.test(rawN) && !/^(hour|minute)/.test(u)) continue;
    const mult = u.startsWith("h") ? 3600 : u.startsWith("s") ? 1 : 60;
    const unitLabel = mult === 3600 ? "h" : mult === 1 ? "s" : "min";
    // "1 hour 30 minutes" → one timer
    if (last && mult === 60 && last.unit === "h" && m.index - last.end <= 6) {
      const prev = out[last.idx];
      prev.seconds += n * 60;
      prev.label = `${prev.label} ${n} min`;
      last = null;
      continue;
    }
    const range = hi && hi > n ? `${fmt(n)}–${fmt(hi)}` : fmt(n);
    out.push({ label: `${range} ${unitLabel}`, seconds: Math.round(n * mult) });
    last = { end: m.index + m[0].length, idx: out.length - 1, unit: unitLabel };
  }
  return out.filter((t) => t.seconds >= 10 && t.seconds <= 48 * 3600).slice(0, 4);
}

const fmt = (n: number) => (n === 0.5 ? "½" : String(n));

/* ------------------------------------------------------------ wake lock */

/** Keep the screen on while ``active`` (Screen Wake Lock API; quietly
 *  does nothing where unsupported). Re-acquired when the tab comes back. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    if (!active || !wl) return;
    let lock: { release: () => Promise<void> } | null = null;
    let live = true;
    const req = async () => {
      try {
        const l = await wl.request("screen");
        if (live) lock = l;
        else void l.release();
      } catch {
        /* denied (battery saver) — fine */
      }
    };
    void req();
    const onVis = () => {
      if (document.visibilityState === "visible" && live) void req();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release().catch(() => undefined);
    };
  }, [active]);
}

/* -------------------------------------------------- cross-tab hand-offs */

let pendingRecipe: string | null = null;
/** Ask the Recipes tab to open a recipe when it next mounts. */
export const recipeNav = {
  open(id: string) {
    pendingRecipe = id;
  },
  take(): string | null {
    const r = pendingRecipe;
    pendingRecipe = null;
    return r;
  },
};

/** A short beep pattern for finished timers (no audio files). */
export function chime(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.25);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.3);
    });
    window.setTimeout(() => void ctx.close(), 1500);
  } catch {
    /* no audio */
  }
  try {
    navigator.vibrate?.([300, 150, 300, 150, 300]);
  } catch {
    /* no vibration */
  }
}

/** Recipes sorted for pickers: favourites, then most cooked, then newest. */
export function useSortedRecipes(recipes: Recipe[]): Recipe[] {
  return useMemo(
    () =>
      [...recipes].sort(
        (a, b) =>
          Number(b.favorite) - Number(a.favorite) ||
          (b.times_cooked || 0) - (a.times_cooked || 0) ||
          (b.added || "").localeCompare(a.added || "") ||
          a.title.localeCompare(b.title),
      ),
    [recipes],
  );
}

export function matchesQuery(r: Recipe, q: string): boolean {
  if (!q) return true;
  const low = q.toLowerCase();
  return (
    r.title.toLowerCase().includes(low) ||
    r.cuisine.toLowerCase().includes(low) ||
    r.tags.some((t) => t.includes(low)) ||
    r.ingredients.some((i) => i.item.toLowerCase().includes(low))
  );
}
