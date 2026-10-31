/*
 * FSRS-6 — a line-by-line mirror of backend/app/items/kinds/flashcards/fsrs.py.
 * Change both together. See the Python module for the formulas and the
 * three deliberate choices (study days with a rollover hour, review due at
 * the rollover moment, seeded uniform fuzz, half-up rounding, ordered
 * Hard ≤ Good < Easy in the Review state).
 */

import type { Srs, SrsState } from "./types";

export const DEFAULT_WEIGHTS: readonly number[] = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
  1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];
export const STABILITY_MIN = 0.001;
const MIN_D = 1;
const MAX_D = 10;
export const AGAIN = 1;
export const HARD = 2;
export const GOOD = 3;
export const EASY = 4;
export type Rating = 1 | 2 | 3 | 4;
export const RATINGS: Rating[] = [1, 2, 3, 4];
const FUZZ_RANGES: [number, number, number][] = [
  [2.5, 7, 0.15],
  [7, 20, 0.1],
  [20, Infinity, 0.05],
];
export const LEARN_AHEAD_MIN = 20;
const DAY_MS = 86_400_000;

export const roundHalfUp = (x: number) => Math.floor(x + 0.5);

export interface Config {
  weights: readonly number[];
  retention: number;
  learningSteps: number[];
  relearningSteps: number[];
  maximumInterval: number;
  fuzz: boolean;
  rolloverHour: number;
  /** IANA zone the study days are counted in — the person's saved zone
   *  (the server's ``ctx.tz``), so the app, reminders and the AI agree on
   *  "today". ``null`` = this device's zone. */
  tz: string | null;
}

export const decayOf = (c: Config) => -c.weights[20];
export const factorOf = (c: Config) => Math.pow(0.9, 1 / decayOf(c)) - 1;

export function configFrom(
  s: {
    weights?: number[];
    desired_retention?: number;
    learning_steps?: number[];
    relearning_steps?: number[];
    maximum_interval?: number;
    fuzz?: boolean;
    rollover_hour?: number;
  },
  tz: string | null = null,
): Config {
  const w = s.weights ?? [];
  return {
    weights: w.length === 21 ? w : DEFAULT_WEIGHTS,
    retention: s.desired_retention ?? 0.9,
    learningSteps: s.learning_steps ?? [1, 10],
    relearningSteps: s.relearning_steps ?? [10],
    maximumInterval: s.maximum_interval ?? 36500,
    fuzz: s.fuzz ?? true,
    rolloverHour: s.rollover_hour ?? 4,
    tz: validZone(tz),
  };
}

// ------------------------------------------------------------- the model

export function retrievability(t: number, s: number, c: Config): number {
  return Math.pow(1 + (factorOf(c) * Math.max(t, 0)) / s, decayOf(c));
}

export function nextInterval(s: number, c: Config): number {
  const ivl = (s / factorOf(c)) * (Math.pow(c.retention, 1 / decayOf(c)) - 1);
  return Math.min(Math.max(roundHalfUp(ivl), 1), c.maximumInterval);
}

export function initStability(g: Rating, c: Config): number {
  return Math.max(c.weights[g - 1], STABILITY_MIN);
}

export function initDifficulty(g: Rating, c: Config, clamp = true): number {
  const w = c.weights;
  const d = w[4] - Math.exp(w[5] * (g - 1)) + 1;
  return clamp ? Math.min(Math.max(d, MIN_D), MAX_D) : d;
}

export function nextDifficulty(d: number, g: Rating, c: Config): number {
  const w = c.weights;
  const delta = -(w[6] * (g - 3));
  const damped = d + ((10 - d) * delta) / 9;
  const nd = w[7] * initDifficulty(EASY, c, false) + (1 - w[7]) * damped;
  return Math.min(Math.max(nd, MIN_D), MAX_D);
}

export function shortTermStability(s: number, g: Rating, c: Config): number {
  const w = c.weights;
  let inc = Math.exp(w[17] * (g - 3 + w[18])) * Math.pow(s, -w[19]);
  if (g >= HARD) inc = Math.max(inc, 1);
  return Math.max(s * inc, STABILITY_MIN);
}

export function forgetStability(d: number, s: number, r: number, c: Config): number {
  const w = c.weights;
  const longTerm = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]);
  const shortTerm = s / Math.exp(w[17] * w[18]);
  return Math.max(Math.min(longTerm, shortTerm), STABILITY_MIN);
}

export function recallStability(d: number, s: number, r: number, g: Rating, c: Config): number {
  const w = c.weights;
  const hard = g === HARD ? w[15] : 1;
  const easy = g === EASY ? w[16] : 1;
  const out = s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hard * easy);
  return Math.max(out, STABILITY_MIN);
}

// ----------------------------------------------------------- study days

export const parseMoment = (iso: string) => Date.parse(iso);

// --- time zones (Intl; offsets cached per zone and hour — they only change
// at DST transitions, and a year of review history is ~9k distinct hours)

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const offCache = new Map<string, Map<number, number>>();

/** ``tz`` when this browser knows it, else null (this device's zone). */
export function validZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    zoneFormat(tz);
    return tz;
  } catch {
    return null;
  }
}

function zoneFormat(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Minutes ``tz`` is ahead of UTC at ``ms`` (null tz = this device). */
export function offsetMinutes(ms: number, tz: string | null): number {
  if (!tz) return -new Date(ms).getTimezoneOffset();
  const hour = Math.floor(ms / 3_600_000);
  let m = offCache.get(tz);
  if (!m) offCache.set(tz, (m = new Map()));
  const hit = m.get(hour);
  if (hit !== undefined) return hit;
  const p: Record<string, number> = {};
  for (const part of zoneFormat(tz).formatToParts(new Date(hour * 3_600_000))) if (part.type !== "literal") p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  const off = Math.round((wall - hour * 3_600_000) / 60_000);
  if (m.size > 50_000) m.clear();
  m.set(hour, off);
  return off;
}

/** The study day ``ms`` falls in: wall time in the zone minus the rollover hour. */
export function dayIndex(ms: number, c: Config): number {
  const wall = Math.floor(ms / 1000) * 1000 + offsetMinutes(ms, c.tz) * 60_000;
  return Math.floor((wall - c.rolloverHour * 3_600_000) / DAY_MS);
}

/** When study day ``n`` begins (the rollover moment, in the zone). */
export function dayStart(n: number, c: Config): number {
  const wall = n * DAY_MS + c.rolloverHour * 3_600_000;
  const first = wall - offsetMinutes(wall, c.tz) * 60_000;
  const second = wall - offsetMinutes(first, c.tz) * 60_000;
  return second;
}

export function dayISO(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function studyDate(ms: number, c: Config): string {
  return dayISO(dayIndex(ms, c));
}

/** ``2026-10-31T09:30:00+11:00`` in ``tz`` — what Python's
 *  ``isoformat(timespec="seconds")`` gives for an aware moment. */
export function iso(ms: number, tz: string | null = null): string {
  const off = offsetMinutes(ms, tz);
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  const local = new Date(Math.floor(ms / 1000) * 1000 + off * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
}

// ----------------------------------------------------------------- fuzz

const encoder = new TextEncoder();

/** FNV-1a of the UTF-8 seed, one mulberry32 step → [0, 1). */
export function seededRandom(seed: string): number {
  let h = 0x811c9dc5;
  for (const byte of encoder.encode(seed)) {
    h = (h ^ byte) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let t = (h + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t = (t ^ ((t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0)) >>> 0)) >>> 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function fuzzInterval(ivl: number, rand: number, c: Config): number {
  if (ivl < 2.5) return ivl;
  let delta = 1;
  for (const [start, end, f] of FUZZ_RANGES) delta += f * Math.max(Math.min(ivl, end) - start, 0);
  let lo = roundHalfUp(ivl - delta);
  let hi = roundHalfUp(ivl + delta);
  lo = Math.max(2, lo);
  hi = Math.min(hi, c.maximumInterval);
  lo = Math.min(lo, hi);
  return Math.min(Math.floor(rand * (hi - lo + 1) + lo), c.maximumInterval);
}

// ------------------------------------------------------------- scheduling

export function newSrs(k: string): Srs {
  return { k, state: "new", stability: null, difficulty: null, due: null, last_review: null, reps: 0, lapses: 0, step: null };
}

interface Raw {
  srs: Srs;
  minutes: number | null;
  days: number | null;
}

function outcome(srs: Srs, g: Rating, now: number, c: Config): Raw {
  const state: SrsState = srs.state || "new";
  let s = srs.stability;
  let d = srs.difficulty;
  const today = dayIndex(now, c);
  const last = srs.last_review;
  const elapsed = last ? Math.max(0, today - dayIndex(parseMoment(last), c)) : null;
  if (state === "new" || s === null || d === null) {
    s = initStability(g, c);
    d = initDifficulty(g, c);
  } else if (elapsed !== null && elapsed < 1) {
    s = shortTermStability(s, g, c);
    d = nextDifficulty(d, g, c);
  } else {
    const r = retrievability(elapsed ?? 0, s, c);
    s = g === AGAIN ? forgetStability(d, s, r, c) : recallStability(d, s, r, g, c);
    d = nextDifficulty(d, g, c);
  }
  const out: Srs = { ...srs, stability: s, difficulty: d, reps: (srs.reps || 0) + 1, lapses: srs.lapses || 0, last_review: iso(now, c.tz) };
  let minutes: number | null = null;
  let days: number | null = null;
  if (state === "new" || state === "learning" || state === "relearning") {
    const steps = state === "relearning" ? c.relearningSteps : c.learningSteps;
    const stay: SrsState = state === "relearning" ? "relearning" : "learning";
    let step = state !== "new" ? srs.step || 0 : 0;
    const n = steps.length;
    if (n === 0 || (step >= n && g >= HARD)) {
      days = nextInterval(s, c);
    } else if (g === AGAIN) {
      step = 0;
      minutes = steps[0];
    } else if (g === HARD) {
      if (step === 0 && n === 1) minutes = steps[0] * 1.5;
      else if (step === 0 && n >= 2) minutes = (steps[0] + steps[1]) / 2;
      else minutes = steps[step];
    } else if (g === GOOD) {
      if (step + 1 === n) days = nextInterval(s, c);
      else {
        step = step + 1;
        minutes = steps[step];
      }
    } else {
      days = nextInterval(s, c);
    }
    if (minutes !== null) Object.assign(out, { state: stay, step });
    else Object.assign(out, { state: "review", step: null });
  } else {
    if (g === AGAIN) {
      out.lapses += 1;
      if (c.relearningSteps.length) {
        minutes = c.relearningSteps[0];
        Object.assign(out, { state: "relearning", step: 0 });
      } else {
        days = nextInterval(s, c);
        Object.assign(out, { state: "review", step: null });
      }
    } else {
      days = nextInterval(s, c);
      Object.assign(out, { state: "review", step: null });
    }
  }
  return { srs: out, minutes, days };
}

export interface Next {
  srs: Srs;
  minutes: number | null;
  days: number | null;
}

/** What each of the four buttons would do. */
export function preview(srs: Srs, now: number, c: Config, seed: string): Record<Rating, Next> {
  const raw = {} as Record<Rating, Raw>;
  for (const g of RATINGS) raw[g] = outcome(srs, g, now, c);
  const days = {} as Record<Rating, number | null>;
  for (const g of RATINGS) days[g] = raw[g].days;
  const rand = seededRandom(`${seed}:${srs.reps || 0}`);
  for (const g of RATINGS) {
    const v = days[g];
    if (v !== null && c.fuzz) days[g] = fuzzInterval(v, rand, c);
  }
  if (srs.state === "review" && days[HARD] !== null && days[GOOD] !== null && days[EASY] !== null) {
    days[HARD] = Math.min(days[HARD]!, days[GOOD]!);
    days[GOOD] = Math.max(days[GOOD]!, days[HARD]! + 1);
    days[EASY] = Math.max(days[EASY]!, days[GOOD]! + 1);
    for (const g of [HARD, GOOD, EASY] as Rating[]) days[g] = Math.min(days[g]!, c.maximumInterval);
  }
  const out = {} as Record<Rating, Next>;
  const today = dayIndex(now, c);
  for (const g of RATINGS) {
    const { srs: nxt, minutes } = raw[g];
    nxt.due = minutes !== null ? iso(now + minutes * 60_000, c.tz) : iso(dayStart(today + days[g]!, c), c.tz);
    out[g] = { srs: nxt, minutes, days: minutes === null ? days[g] : null };
  }
  return out;
}

export const STATE_CODE: Record<SrsState, "n" | "l" | "r" | "x"> = { new: "n", learning: "l", review: "r", relearning: "x" };

/** Answer ``g``: the new SRS state and the review-log fields. */
export function review(srs: Srs, g: Rating, now: number, c: Config, seed: string) {
  const nxt = preview(srs, now, c, seed)[g];
  const last = srs.last_review;
  // Never negative: a previous review "ahead" of this one (clock skew
  // between devices, travelling west) counts as the same day.
  const elapsed = last ? Math.max(0, dayIndex(now, c) - dayIndex(parseMoment(last), c)) : 0;
  const sched = nxt.minutes !== null ? Math.round((nxt.minutes / 1440) * 10_000) / 10_000 : nxt.days!;
  return { srs: nxt.srs, log: { r: g, s: STATE_CODE[srs.state || "new"], e: elapsed, i: sched } };
}

export function currentRetrievability(srs: Srs, now: number, c: Config): number | null {
  if (srs.state === "new" || !srs.stability || !srs.last_review) return null;
  const t = dayIndex(now, c) - dayIndex(parseMoment(srs.last_review), c);
  return retrievability(t, srs.stability, c);
}

const g10 = (x: number) => String(roundHalfUp(x * 10) / 10);

/** "<1m", "10m", "1.5h", "2d", "3.4mo", "1.2y" (mirrors Python ``label``). */
export function label(minutes: number | null, days: number | null): string {
  if (minutes !== null) {
    if (minutes < 1) return "<1m";
    if (minutes < 60) return `${roundHalfUp(minutes)}m`;
    if (minutes < 1440) return `${g10(minutes / 60)}h`;
    return `${roundHalfUp(minutes / 1440)}d`;
  }
  const d = days ?? 0;
  if (d < 30) return `${d}d`;
  if (d < 365) return `${g10(d / 30.4)}mo`;
  return `${g10(d / 365)}y`;
}
