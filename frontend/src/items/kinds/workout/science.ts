/* The numbers, client side (mirrors backend science.py): e1RM, loads for a
 * target, rounding to the person's kit, plates, warm-ups, records, weekly
 * volume. Everything in kg. */
import { addDays, parseDay, todayISO } from "@/items/ui";

import type { Library } from "./catalog";
import type { Exercise, MuscleInfo, Prescription, SetLog, Settings, Workout, WorkoutData, WorkoutExercise } from "./types";

export const LB = 0.45359237;
const FULL_GYM = ["barbell", "rack", "bench", "dumbbell", "kettlebell", "cable", "machine", "smith", "ez_bar", "trap_bar", "pullup_bar", "dip_station", "band", "rings", "cardio", "sled", "bodyweight"];
const LOWER = new Set(["quads", "glutes", "hamstrings", "adductors", "abductors", "calves", "lower_back"]);

// -------------------------------------------------------------- time

/** A moment as an ISO string with the device's UTC offset (never naive). */
export function isoWithOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
}

/** ``day`` at ``hh:mm`` local time, with its offset (DST-correct for that day). */
export function dayAt(day: string, hh = 12, mm = 0): string {
  const d = parseDay(day);
  d.setHours(hh, mm, 0, 0);
  return isoWithOffset(d);
}

// ------------------------------------------------------------- units

export const toUnit = (kg: number | null | undefined, s: Settings): number | null =>
  kg === null || kg === undefined ? null : s.units === "lb" ? Math.round((kg / LB) * 10) / 10 : Math.round(kg * 100) / 100;
export const fromUnit = (v: number, s: Settings): number => (s.units === "lb" ? v * LB : v);

export function fmtW(kg: number | null | undefined, s: Settings, withUnit = true): string {
  const v = toUnit(kg, s);
  if (v === null) return "–";
  const txt = Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return withUnit ? `${txt} ${s.units}` : txt;
}

export function fmtBig(kg: number, s: Settings): string {
  const v = toUnit(kg, s) ?? 0;
  return v >= 10000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v).toLocaleString();
}

/** "26 Oct – 1 Nov" — a week's dates (never "Tomorrow"). */
export function fmtWeekRange(start: string): string {
  const f = (d: string) => new Date(d + "T12:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const end = new Date(start + "T12:00");
  end.setDate(end.getDate() + 6);
  return `${f(start)} – ${f(end.toISOString().slice(0, 10))}`;
}

/** "56 min" / "1h 15m" — how long a workout took (Strong-style). */
export function fmtMinutes(seconds: number | null | undefined): string {
  const m = Math.round((seconds ?? 0) / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// ------------------------------------------------------------ strength

/** Estimated 1RM. ``reserve`` is the internal margin load suggestions
 *  assume (``RESERVE``) — never something the person logs. */
export function e1rm(kg: number | null | undefined, reps: number | null | undefined, reserve?: number | null, formula: Settings["e1rm_formula"] = "epley"): number | null {
  if (!kg || !reps || reps <= 0) return null;
  const eff = reps + (reserve ?? 0);
  if (eff > 20) return null;
  if (eff <= 1) return kg;
  return formula === "brzycki" ? (kg * 36) / (37 - eff) : kg * (1 + eff / 30);
}

export function loadFor(oneRm: number, reps: number, reserve = 0, formula: Settings["e1rm_formula"] = "epley"): number {
  const eff = Math.max(1, reps + reserve);
  if (eff <= 1) return oneRm;
  return formula === "brzycki" ? (oneRm * (37 - Math.min(eff, 36))) / 36 : oneRm / (1 + eff / 30);
}

export function available(s: Settings): Set<string> {
  const have = new Set<string>(s.equipment ?? []);
  if (have.has("full_gym") || have.size === 0) return new Set(FULL_GYM);
  have.add("bodyweight");
  return have;
}

export function isAvailable(ex: Exercise, s: Settings): boolean {
  const have = available(s);
  return ex.needs.some((alt) => alt.every((n) => have.has(n)));
}

export function loadEquipment(ex: Exercise, s: Settings): string {
  const have = available(s);
  for (const alt of ex.needs) if (alt.every((n) => have.has(n))) return alt[0];
  return ex.equipment;
}

const sumsCache = new Map<string, number[]>();
function perSideSums(s: Settings): number[] {
  const plates = [...(s.plates ?? [])].sort((a, b) => b.kg - a.kg);
  const key = plates.map((p) => `${p.kg}x${p.pairs}`).join(",");
  const hit = sumsCache.get(key);
  if (hit) return hit;
  let sums = new Set<number>([0]);
  for (const p of plates) {
    const g = Math.round(p.kg * 1000);
    const next = new Set<number>();
    for (const x of sums) for (let k = 0; k <= p.pairs; k++) if (x + g * k <= 400_000) next.add(x + g * k);
    sums = next;
  }
  const out = [...sums].sort((a, b) => a - b).map((x) => x / 1000);
  sumsCache.set(key, out);
  return out;
}

export function barFor(eq: string, s: Settings): number {
  if (eq === "ez_bar") return s.ez_bar_kg ?? 10;
  if (eq === "trap_bar") return s.trap_bar_kg ?? 25;
  if (eq === "smith") return 0;
  return s.bar_kg ?? 20;
}

/** [implement, loadable weights ascending] — or null when there's no load. */
export function achievable(ex: Exercise, s: Settings): [string, number[]] | null {
  if ((ex.log === "duration" || ex.log === "distance") && ["bodyweight", "cardio", "band"].includes(ex.equipment)) return null;
  const eq = loadEquipment(ex, s);
  if (ex.log === "assisted") {
    const step = s.machine_step_kg || 5;
    return ["machine", Array.from({ length: 41 }, (_, i) => +(step * i).toFixed(4))];
  }
  if (ex.log === "bodyweight_reps" || ["bodyweight", "band", "pullup_bar", "dip_station", "rings", "bench"].includes(eq)) {
    if (ex.log !== "bodyweight_reps" || eq === "band") return null;
    const smallest = s.plates?.length ? Math.min(...s.plates.map((p) => p.kg)) : 1.25;
    return ["added", Array.from({ length: 121 }, (_, i) => +(smallest * i).toFixed(4))];
  }
  if (["barbell", "ez_bar", "trap_bar", "smith", "rack"].includes(eq)) {
    const bar = barFor(eq, s);
    const loads = [...new Set(perSideSums(s).map((x) => +(bar + 2 * x).toFixed(4)))].sort((a, b) => a - b);
    return [eq === "rack" ? "barbell" : eq, loads];
  }
  if (eq === "dumbbell") {
    if (s.dumbbells_kg?.length) return ["dumbbell", [...s.dumbbells_kg].sort((a, b) => a - b)];
    const step = s.dumbbell_step_kg || 2;
    const top = s.dumbbell_max_kg || 60;
    return ["dumbbell", Array.from({ length: Math.floor(top / step + 1e-6) }, (_, i) => +(step * (i + 1)).toFixed(4))];
  }
  if (eq === "kettlebell") return ["kettlebell", [...(s.kettlebells_kg?.length ? s.kettlebells_kg : [8, 12, 16, 20, 24, 28, 32])].sort((a, b) => a - b)];
  const step = s.machine_step_kg || 5;
  return [eq, Array.from({ length: 80 }, (_, i) => +(step * (i + 1)).toFixed(4))];
}

export function roundLoad(kg: number | null | undefined, ex: Exercise, s: Settings, mode: "nearest" | "down" = "nearest"): number | null {
  if (kg === null || kg === undefined) return null;
  const got = achievable(ex, s);
  if (!got || !got[1].length) return Math.round(kg * 100) / 100;
  const loads = got[1];
  if (mode === "down") {
    const below = loads.filter((x) => x <= kg + 1e-6);
    return below.length ? below[below.length - 1] : loads[0];
  }
  return loads.reduce((best, x) => (Math.abs(x - kg) < Math.abs(best - kg) - 1e-9 ? x : best), loads[0]);
}

/** The next / previous loadable weight (for steppers). */
export function stepLoad(kg: number | null | undefined, ex: Exercise, s: Settings, dir: 1 | -1): number {
  const got = achievable(ex, s);
  const cur = kg ?? 0;
  if (!got || !got[1].length) {
    const step = s.units === "lb" ? 5 * LB : 2.5;
    return Math.max(0, +(cur + dir * step).toFixed(4));
  }
  const loads = got[1];
  if (dir > 0) return loads.find((x) => x > cur + 1e-6) ?? loads[loads.length - 1];
  const below = loads.filter((x) => x < cur - 1e-6);
  return below.length ? below[below.length - 1] : loads[0];
}

export function increment(ex: Exercise, s: Settings): number {
  const upper = !ex.primary.some((m) => LOWER.has(m));
  let nominal = upper ? 1.25 : 2.5;
  if (s.units === "lb") nominal = (upper ? 2.5 : 5) * LB;
  const got = achievable(ex, s);
  if (!got) return 0;
  const steps = got[1].slice(1).map((b, i) => b - got[1][i]).filter((d) => d > 1e-6);
  return Math.max(nominal, steps.length ? Math.min(...steps) : nominal);
}

export function platesPerSide(totalKg: number, s: Settings, bar = s.bar_kg ?? 20): { perSide: number[]; remainder: number; loaded: number; bar: number } {
  let left = Math.max(0, (totalKg - bar) / 2);
  left = Math.round(left * 10000) / 10000;
  const out: number[] = [];
  for (const p of [...(s.plates ?? [])].sort((a, b) => b.kg - a.kg)) {
    let n = 0;
    while (n < p.pairs && left + 1e-6 >= p.kg) {
      out.push(p.kg);
      left = Math.round((left - p.kg) * 10000) / 10000;
      n++;
    }
  }
  return { perSide: out, remainder: Math.round(left * 2 * 1000) / 1000, loaded: bar + 2 * out.reduce((a, b) => a + b, 0), bar };
}

export function warmups(workKg: number, ex: Exercise, s: Settings): { kg: number; reps: number }[] {
  const got = achievable(ex, s);
  if (!workKg || !got) return [];
  const eq = got[0];
  const out: { kg: number; reps: number }[] = [];
  let steps: [number, number][];
  if (["barbell", "ez_bar", "trap_bar", "smith"].includes(eq)) {
    const bar = barFor(eq, s);
    if (bar && workKg > bar * 1.15) out.push({ kg: bar, reps: 10 });
    steps = workKg >= Math.max(bar * 2.5, 60) ? [[0.4, 5], [0.6, 3], [0.8, 2]] : [[0.6, 5], [0.8, 3]];
  } else steps = [[0.5, 10], [0.75, 5]];
  for (const [pct, reps] of steps) {
    const kg = roundLoad(workKg * pct, ex, s, "down");
    if (kg === null || kg <= 0 || kg >= workKg - 1e-6) continue;
    if (out.length && kg <= out[out.length - 1].kg + 1e-6) continue;
    out.push({ kg, reps });
  }
  return out;
}

// ------------------------------------------------------------- history

/** A set that counts: done, not a warm-up, not a 0-rep miss (mirrors science.py is_hard). */
export const isHard = (s: SetLog) => (s.type ?? "working") !== "warmup" && (s.done ?? true) && !(s.reps === 0 && !s.seconds && !s.meters);
export const isCardio = (ex: Exercise) => ex.pattern === "cardio";
/** A cardio bout's default length on a timed machine (one bout, not sets). */
export const CARDIO_SECONDS = 1200;
export const setType = (s: SetLog) => s.type ?? "working";
export const isDone = (s: SetLog) => s.done ?? true;

/** The margin load suggestions work with (mirrors science.py RESERVE): a
 *  working set stops a couple of reps short of failure, so it's read that
 *  way when it feeds a suggestion (reading it as a max walks every
 *  suggestion down) and suggested loads leave the same margin. Internal
 *  only — nothing asks for or shows reps in reserve. */
export const RESERVE = 2;
/** Double progression reads the last session only while it's this recent. */
const PROGRESSION_DAYS = 42;

export function isDeload(data: WorkoutData, w: Workout): boolean {
  if (w.deload) return true;
  if (!w.session_id) return false;
  return !!data.planned.find((p) => p.id === w.session_id)?.deload;
}

export interface Session {
  workout: Workout;
  we: WorkoutExercise;
  deload?: boolean;
}

/** Every exercise's sessions, oldest first (``deload`` marks deload ones). */
export function historyIndex(data: WorkoutData): Map<string, Session[]> {
  const out = new Map<string, Session[]>();
  for (const w of data.workouts) {
    const deload = isDeload(data, w);
    for (const we of w.exercises) {
      if (!we.sets.some(isHard)) continue;
      const arr = out.get(we.exercise_id) ?? [];
      arr.push({ workout: w, we, deload });
      out.set(we.exercise_id, arr);
    }
  }
  return out;
}

/** Sessions progression reads: deloads left out (while there's anything else). */
export function trainingSessions(hist: Session[] | undefined): Session[] {
  if (!hist?.length) return [];
  const real = hist.filter((h) => !h.deload);
  return real.length ? real : hist;
}

/** The session progression keys off: the latest non-deload one. */
export function lastSession(hist: Session[] | undefined): Session | null {
  const t = trainingSessions(hist);
  return t.length ? t[t.length - 1] : null;
}

/** e1RM of one set from load × reps (a legacy stored ``rir`` is ignored);
 *  ``reserve`` only for load suggestions, never on a set to failure. */
export function setE1rm(st: SetLog, ex: Exercise, s: Settings, reserve?: number | null): number | null {
  if (ex.log !== "weight_reps") return null;
  const margin = reserve != null && st.type !== "failure" ? reserve : null;
  return e1rm(st.kg, st.reps, margin, s.e1rm_formula);
}

/** The set worth quoting from a logged exercise (Strong's "best set"):
 *  the top e1RM for loaded lifts, else the most reps / time / distance. */
export function bestSet(we: WorkoutExercise, ex: Exercise, s: Settings): SetLog | null {
  const hard = we.sets.filter(isHard);
  if (!hard.length) return null;
  if (ex.log === "weight_reps") return sessionStats(we, ex, s).best ?? hard[0];
  const key = ex.log === "duration" ? "seconds" : ex.log === "distance" ? "meters" : "reps";
  return hard.reduce((a, b) => ((b[key] ?? 0) > (a[key] ?? 0) ? b : a));
}

export interface SessionStats {
  sets: number;
  best: SetLog | null;
  e1rm: number | null;
  volume: number;
  topKg: number;
  maxReps: number;
  maxSeconds: number;
  maxMeters: number;
}

export function sessionStats(we: WorkoutExercise, ex: Exercise, s: Settings, reserve?: number | null): SessionStats {
  const hard = we.sets.filter(isHard);
  let best: SetLog | null = null;
  let bestE: number | null = null;
  for (const st of hard) {
    const e = setE1rm(st, ex, s, reserve);
    if (e !== null && (bestE === null || e > bestE)) {
      best = st;
      bestE = e;
    }
  }
  return {
    sets: hard.length,
    best,
    e1rm: bestE,
    volume: ex.log === "weight_reps" ? hard.reduce((a, x) => a + (x.kg ?? 0) * (x.reps ?? 0), 0) : 0,
    topKg: Math.max(0, ...hard.map((x) => x.kg ?? 0)),
    maxReps: Math.max(0, ...hard.map((x) => x.reps ?? 0)),
    maxSeconds: Math.max(0, ...hard.map((x) => x.seconds ?? 0)),
    maxMeters: Math.max(0, ...hard.map((x) => x.meters ?? 0)),
  };
}

export type RecordKind = "e1rm" | "1rm" | "3rm" | "5rm" | "10rm" | "volume" | "max_reps" | "heaviest" | "least_assist" | "longest" | "farthest";
export interface Rec {
  value: number;
  date: string;
  workoutId: string;
  reps?: number | null;
  kg?: number | null;
}
export type Records = Partial<Record<RecordKind, Rec>>;
export interface Pr {
  exerciseId: string;
  kind: RecordKind;
  value: number;
  previous: number | null;
  /** The headline PR carries the exercise's other records from that workout. */
  also?: Pr[];
}

/** Which record headlines an exercise's PRs in a workout (mirrors science.py PR_PRIORITY). */
export const PR_PRIORITY: RecordKind[] = ["e1rm", "1rm", "3rm", "5rm", "10rm", "heaviest", "least_assist", "max_reps", "longest", "farthest", "volume"];

/** All records per exercise, and the PRs each workout set (chronological
 *  pass). A record must beat an earlier one (a first time isn't a PR); of the
 *  1/3/5/10RMs one set beats only the most specific counts; assisted lifts'
 *  "most reps" only counts at the least assistance reached. ``prs`` holds
 *  ONE entry per exercise (its headline record, the rest in ``also``), so
 *  ``prs.get(id).length`` is the number of exercises with a PR. */
export function recordBook(data: WorkoutData, lib: Library): { records: Map<string, Records>; prs: Map<string, Pr[]> } {
  const records = new Map<string, Records>();
  const prs = new Map<string, Pr[]>();
  const s = data.settings;
  for (const w of data.workouts) {
    const found: Pr[] = [];
    const before = new Map<string, Records>();
    for (const we of w.exercises) {
      const ex = lib.get(we.exercise_id);
      const hard = we.sets.filter(isHard);
      if (!hard.length) continue;
      const rec: Records = records.get(ex.id) ?? {};
      if (!before.has(ex.id)) before.set(ex.id, { ...rec });
      const bump = (k: RecordKind, v: number | null | undefined, extra: Partial<Rec> = {}, lower = false) => {
        if (v === null || v === undefined || (!lower && v <= 0)) return;
        const cur = rec[k];
        if (!cur || (lower ? v < cur.value : v > cur.value + 1e-9)) rec[k] = { value: v, date: w.date, workoutId: w.id, ...extra };
      };
      for (const st of hard) {
        if (ex.log === "weight_reps") {
          const e = setE1rm(st, ex, s);
          bump("e1rm", e !== null ? Math.round(e * 10) / 10 : null, { kg: st.kg, reps: st.reps });
          for (const n of [1, 3, 5, 10]) if ((st.reps ?? 0) >= n) bump(`${n}rm` as RecordKind, st.kg, { reps: st.reps });
        } else if (ex.log === "bodyweight_reps") {
          bump("max_reps", st.reps, { kg: st.kg });
          if (st.kg) bump("heaviest", st.kg, { reps: st.reps });
        } else if (ex.log === "assisted") {
          if (st.reps) {
            // Less assistance is harder: "most reps" counts at the least assistance only.
            const kg = st.kg ?? 0;
            const least = rec.least_assist;
            if (!least || kg < least.value - 1e-9) {
              rec.least_assist = { value: Math.round(kg * 100) / 100, date: w.date, workoutId: w.id, reps: st.reps };
              rec.max_reps = { value: st.reps, date: w.date, workoutId: w.id, kg: st.kg };
            } else if (kg <= least.value + 1e-9) bump("max_reps", st.reps, { kg: st.kg });
          }
        } else if (ex.log === "duration") bump("longest", st.seconds);
        else if (ex.log === "distance") bump("farthest", st.meters, { reps: st.seconds });
      }
      if (ex.log === "weight_reps") bump("volume", sessionStats(we, ex, s).volume);
      records.set(ex.id, rec);
    }
    for (const [exId, old] of before) {
      const rec = records.get(exId)!;
      const beaten = (k: RecordKind) => {
        const r = rec[k];
        const p = old[k];
        if (!r || !p || r === p || r.workoutId !== w.id) return false; // a first time isn't a record
        return k === "least_assist" ? r.value < p.value - 1e-9 : r.value > p.value + 1e-9;
      };
      const rms = (["10rm", "5rm", "3rm", "1rm"] as RecordKind[]).filter(beaten);
      const mine: Pr[] = [];
      for (const k of PR_PRIORITY) {
        if (!beaten(k)) continue;
        if (k.endsWith("rm") && k !== "e1rm" && k !== rms[0]) continue;
        mine.push({ exerciseId: exId, kind: k, value: rec[k]!.value, previous: old[k]?.value ?? null });
      }
      if (mine.length) found.push({ ...mine[0], also: mine.slice(1) });
    }
    if (found.length) prs.set(w.id, found);
  }
  return { records, prs };
}

export const PR_LABEL: Record<RecordKind, string> = {
  e1rm: "Est. 1RM",
  "1rm": "1RM",
  "3rm": "3RM",
  "5rm": "5RM",
  "10rm": "10RM",
  volume: "Volume",
  max_reps: "Most reps",
  heaviest: "Heaviest",
  least_assist: "Least assistance",
  longest: "Longest",
  farthest: "Farthest",
};

export function fmtRecord(kind: RecordKind, v: number, s: Settings): string {
  if (kind === "max_reps") return `${v} reps`;
  if (kind === "longest") return fmtSecs(v);
  if (kind === "farthest") return fmtMeters(v);
  if (kind === "volume") return `${fmtBig(v, s)} ${s.units}`;
  return fmtW(v, s);
}

export function fmtSecs(sec: number): string {
  const m = Math.floor(sec / 60);
  const r = Math.round(sec % 60);
  return m ? `${m}:${String(r).padStart(2, "0")}` : `${r}s`;
}

export const fmtMeters = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} km` : `${Math.round(m)} m`);

// ------------------------------------------------------------ suggestions

/** The best e1RM of the last few (non-deload) sessions — working sets read
 *  with ``reserve`` (``RESERVE`` for load maths; null = the strict e1RM the
 *  records show) — falling back to the all-time best. */
export const baselineFor = (s: Settings, exerciseId: string) => s.baselines?.find((b) => b.exercise_id === exerciseId) ?? null;

/** e1RM from a stated best, read strictly (loads from it keep the usual margin). */
export function baselineE1rm(ex: Exercise, s: Settings): number | null {
  const b = baselineFor(s, ex.id);
  if (!b || ex.log !== "weight_reps") return null;
  return e1rm(b.kg, b.reps, null, s.e1rm_formula);
}

export function recentE1rm(hist: Session[] | undefined, ex: Exercise, s: Settings, reserve: number | null = RESERVE): number | null {
  const t = trainingSessions(hist);
  if (!t.length) return baselineE1rm(ex, s);
  const cutoff = addDays(todayISO(), -70);
  const recent = t.slice(-3).filter((h) => h.workout.date >= cutoff).map((h) => sessionStats(h.we, ex, s, reserve).e1rm).filter((v): v is number => !!v);
  if (recent.length) return Math.max(...recent);
  const all = t.map((h) => sessionStats(h.we, ex, s, reserve).e1rm).filter((v): v is number => !!v);
  return all.length ? Math.max(...all) : baselineE1rm(ex, s);
}

export function startingLoad(ex: Exercise, s: Settings, reps: number, reserve = RESERVE): number | null {
  if (ex.log !== "weight_reps") return null;
  let r = ex.start;
  if (r === null) {
    const c = ex.compound;
    r = ({ barbell: c ? 0.4 : 0.15, dumbbell: c ? 0.15 : 0.06, kettlebell: 0.2, cable: c ? 0.35 : 0.12, machine: c ? 0.5 : 0.25, smith: 0.4 } as Record<string, number>)[ex.equipment] ?? 0.2;
  }
  const bw = s.bodyweight_kg || ({ male: 80, female: 65 } as Record<string, number>)[s.sex] || 72;
  const exp = { beginner: 1, intermediate: 1.45, advanced: 1.8 }[s.experience] ?? 1;
  const sex = ({ male: 1, female: 0.7 } as Record<string, number>)[s.sex] ?? 0.85;
  const one = r * bw * exp * sex * (1 + 13 / 30);
  return loadFor(one, reps, reserve, s.e1rm_formula) * 0.92;
}

const workSets = (we: WorkoutExercise) => we.sets.filter((x) => ["working", "failure"].includes(setType(x)) && isDone(x));

/** The load a session was trained at: the heaviest — or, for assisted
 *  lifts, the least assistance (the hardest). */
function level(work: SetLog[], assisted: boolean): number {
  const loads = work.map((x) => x.kg ?? 0);
  if (!loads.length) return 0;
  return assisted ? Math.min(...loads) : Math.max(...loads);
}

export type ProgressionAction = "add_load" | "add_reps" | "less_assist" | "unassisted" | "reset" | "repeat";

/** Double progression on the last session: every set at the top load
 *  reached the top of the range → the next loadable step; else the same
 *  load (beat the reps). Assisted lifts run backwards (``kg`` = assistance:
 *  hit the range → less assistance); bodyweight lifts with added load add
 *  load. ``kg`` is null when there's no load to call (nothing logged). */
export function progression(we: WorkoutExercise, ex: Exercise, s: Settings, _lo: number, hi: number): { action: ProgressionAction; kg: number | null } {
  const hard = workSets(we);
  if (!hard.length) return { action: "repeat", kg: null };
  const assisted = ex.log === "assisted";
  const top = level(hard, assisted);
  const atTop = hard.filter((x) => Math.abs((x.kg ?? 0) - top) < 1e-6);
  const hit = atTop.every((x) => (x.reps ?? 0) >= hi);
  if (assisted) {
    if (!hit) return { action: "add_reps", kg: top };
    if (top <= 1e-6) return { action: "unassisted", kg: 0 };
    return { action: "less_assist", kg: stepLoad(top, ex, s, -1) < top - 1e-6 ? stepLoad(top, ex, s, -1) : 0 };
  }
  if (ex.log === "bodyweight_reps") {
    if (!hit || top <= 1e-6) return { action: "add_reps", kg: top };
    const next = roundLoad(top + increment(ex, s), ex, s);
    return { action: "add_load", kg: Math.max(next ?? top, top) };
  }
  if (ex.log !== "weight_reps") return { action: "add_reps", kg: top || null };
  if (top <= 0) return { action: "repeat", kg: null };
  if (hit) {
    let next = roundLoad(top + increment(ex, s), ex, s);
    if (next !== null && next <= top) next = stepLoad(top, ex, s, 1);
    return { action: "add_load", kg: next };
  }
  return { action: "add_reps", kg: top };
}

/** Did that session train roughly this rep range? */
export function comparable(we: WorkoutExercise, lo: number, hi: number, assisted = false): boolean {
  const work = workSets(we).filter((x) => x.reps);
  if (!work.length) return false;
  const top = level(work, assisted);
  const reps = Math.max(...work.filter((x) => Math.abs((x.kg ?? 0) - top) < 1e-6).map((x) => x.reps ?? 0));
  return reps >= lo - 2 && reps <= hi + 1;
}

/** Repeated failure → a ~10% reset (mirrors science.py stall_reset): the
 *  last two sessions at one load both short of the bottom of the range with
 *  no rep gained, or three at one load that never reached the top and gained
 *  no reps. Null when the lift is progressing. */
export function stallReset(hist: Session[] | undefined, ex: Exercise, s: Settings, lo: number, hi: number): { kg: number; fromKg: number } | null {
  if (ex.log !== "weight_reps") return null;
  let run: [number, number[]][] = [];
  for (const h of trainingSessions(hist).slice(-3)) {
    const work = workSets(h.we).filter((x) => x.reps !== null && x.reps !== undefined);
    if (!work.length || !comparable(h.we, lo, hi)) {
      run = [];
      continue;
    }
    const top = level(work, false);
    const reps = work.filter((x) => Math.abs((x.kg ?? 0) - top) < 1e-6).map((x) => x.reps ?? 0);
    if (run.length && Math.abs(run[run.length - 1][0] - top) >= 1e-6) run = [];
    run.push([top, reps]);
  }
  if (run.length < 2 || run[run.length - 1][0] <= 0) return null;
  const mean = (r: number[]) => r.reduce((a, b) => a + b, 0) / r.length;
  const top = run[run.length - 1][0];
  const [a, b] = run.slice(-2);
  const shortTwice = Math.min(...a[1]) < lo && Math.min(...b[1]) < lo && mean(b[1]) <= mean(a[1]) + 1e-9;
  const flatThree = run.length >= 3 && !run.some((v) => Math.min(...v[1]) >= hi) && mean(run[run.length - 1][1]) <= mean(run[0][1]) + 1e-9;
  if (!shortTwice && !flatThree) return null;
  let kg = roundLoad(top * 0.9, ex, s, "down");
  if (kg === null || kg >= top - 1e-6) {
    const down = stepLoad(top, ex, s, -1);
    kg = down < top - 1e-6 ? down : null;
  }
  return kg === null ? null : { kg, fromKg: top };
}

/** What last time says for a ``lo``-``hi`` session (mirrors science.py
 *  progress_call): a stall reset, else double progression on the last recent
 *  comparable non-deload session; null without one. */
export function progressCall(ex: Exercise, lo: number, hi: number, hist: Session[] | undefined, s: Settings): { action: ProgressionAction; kg: number | null; fromKg?: number } | null {
  const last = lastSession(hist);
  if (!last || last.workout.date < addDays(todayISO(), -PROGRESSION_DAYS)) return null;
  if (!comparable(last.we, lo, hi, ex.log === "assisted")) return null;
  const reset = stallReset(hist, ex, s, lo, hi);
  if (reset) return { action: "reset", kg: reset.kg, fromKg: reset.fromKg };
  return progression(last.we, ex, s, lo, hi);
}

/** What progression calls for next time (mirrors science.py next_load):
 *  a stall reset / double progression on the last recent non-deload session
 *  of a similar range; else the recent e1RM; else a calibration estimate.
 *  Assisted / bodyweight lifts: progression, else last time's load. */
export function nextLoad(ex: Exercise, lo: number, hi: number, hist: Session[] | undefined, s: Settings): { kg: number | null; basis: "progression" | "reset" | "e1rm" | "baseline" | "estimate" | "last" | "none" } {
  const call = progressCall(ex, lo, hi, hist, s);
  if (call && call.kg !== null) return { kg: call.kg, basis: call.action === "reset" ? "reset" : "progression" };
  if (ex.log === "assisted" || ex.log === "bodyweight_reps") {
    const last = lastSession(hist);
    const work = last ? workSets(last.we) : [];
    if (work.length) return { kg: level(work, ex.log === "assisted"), basis: "last" };
    const b = baselineFor(s, ex.id);
    return b ? { kg: b.kg, basis: "baseline" } : { kg: null, basis: "none" };
  }
  if (ex.log !== "weight_reps") return { kg: null, basis: "none" };
  const one = recentE1rm(hist, ex, s);
  const mid = Math.floor((lo + hi) / 2);
  if (one) return { kg: roundLoad(loadFor(one, mid, RESERVE, s.e1rm_formula), ex, s), basis: trainingSessions(hist).length ? "e1rm" : "baseline" };
  return { kg: roundLoad(startingLoad(ex, s, mid), ex, s, "down"), basis: "estimate" };
}

/** Deloads: ~10% lighter — assisted lifts ~25% more assistance. */
export function deloadLoad(kg: number | null, ex: Exercise, s: Settings): number | null {
  if (kg === null) return null;
  if (ex.log === "assisted") return kg > 0 ? roundLoad(kg * 1.25, ex, s) : kg;
  return kg > 0 ? roundLoad(kg * 0.9, ex, s, "down") : kg;
}

/** A drop set's load: ~25% lighter — assisted lifts get more assistance. */
export function dropLoad(kg: number | null, ex: Exercise, s: Settings): number | null {
  if (ex.log === "assisted") return roundLoad(Math.max((kg ?? 0) * 1.3, (kg ?? 0) + 10), ex, s);
  return kg ? roundLoad(kg * 0.75, ex, s, "down") : null;
}

/** The load a set starts at in the logger (mirrors science.py prefill): the
 *  better of the planned load and what double progression calls for — a
 *  stalled lift's reset wins over a plan at the stalled load; as planned on a
 *  deload (or ~10% under last time when there's no planned load); a % of
 *  the strict e1RM; or progression / e1RM / a calibration estimate.
 *  Assisted lifts: "better" = less assistance. */
export function prefill(ex: Exercise, rx: Prescription | null | undefined, hist: Session[] | undefined, s: Settings, deload = false): number | null {
  const lo = rx?.reps_min ?? 8;
  const hi = rx?.reps_max ?? lo;
  const planned = rx?.load_kg ?? null;
  if (ex.log === "assisted" || ex.log === "bodyweight_reps") {
    const assisted = ex.log === "assisted";
    if (planned !== null && deload) return planned;
    if (deload) {
      const last = lastSession(hist);
      const work = last ? workSets(last.we) : [];
      return work.length ? deloadLoad(level(work, assisted), ex, s) : null;
    }
    const nl = nextLoad(ex, lo, hi, hist, s);
    if (planned === null) return nl.kg;
    const call = nl.basis === "progression" ? nl.kg : null;
    if (call === null) return planned;
    return assisted ? Math.min(planned, call) : Math.max(planned, call);
  }
  if (ex.log !== "weight_reps") {
    if (planned !== null) return planned;
    const last = lastSession(hist);
    if (last) return Math.max(0, ...last.we.sets.filter(isHard).map((x) => x.kg ?? 0)) || null;
    return null;
  }
  if (planned !== null) {
    if (deload) return planned;
    const call = progressCall(ex, lo, hi, hist, s);
    if (call && call.kg !== null) {
      if (call.action === "reset") {
        if (planned >= (call.fromKg ?? 0) - 1e-6) return call.kg;
      } else if (call.kg > planned + 1e-6) return call.kg;
    }
    return planned;
  }
  if (rx?.load_pct) {
    const one = recentE1rm(hist, ex, s, null);
    if (one) {
      const kg = roundLoad((one * rx.load_pct) / 100, ex, s);
      return deload ? deloadLoad(kg, ex, s) : kg;
    }
  }
  if (deload) {
    const last = lastSession(hist);
    const work = last ? workSets(last.we) : [];
    if (work.length && level(work, false) > 0) return deloadLoad(level(work, false), ex, s);
  }
  return nextLoad(ex, lo, hi, hist, s).kg;
}

/** Double progression's call for a prescription (null when last time isn't
 *  a comparable, recent session) — shown next to a planned load. Loaded
 *  lifts only (a stall reset comes back as the lower load). */
export function progressionSuggestion(ex: Exercise, rx: Prescription, hist: Session[] | undefined, s: Settings): number | null {
  if (ex.log !== "weight_reps") return null;
  return progressCall(ex, rx.reps_min, rx.reps_max, hist, s)?.kg ?? null;
}

/** Rest after a set: the explicit one, else none for cardio (one bout), else the compound / isolation default. */
export function restFor(we: WorkoutExercise, ex: Exercise, s: Settings): number {
  return we.rest_s ?? we.rx?.rest_s ?? defaultRest(ex, s);
}

export const defaultRest = (ex: Exercise, s: Settings): number => (isCardio(ex) ? 0 : ex.compound ? s.rest_compound_s : s.rest_isolation_s);

// ------------------------------------------------------------- building

export function newSetsFor(
  ex: Exercise,
  rx: Prescription | null,
  hist: Session[] | undefined,
  s: Settings,
  uid: (p: string) => string,
  { warm, deload = false }: { warm: boolean; deload?: boolean },
): SetLog[] {
  const kg = prefill(ex, rx, hist, s, deload);
  const prevSession = lastSession(hist);
  const last = prevSession ? prevSession.we.sets.filter((x) => setType(x) === "working" && isDone(x)) : [];
  const out: SetLog[] = [];
  if (warm && kg) for (const w of warmups(kg, ex, s)) out.push({ id: uid("t"), type: "warmup", kg: w.kg, reps: w.reps, done: false });
  const cardio = isCardio(ex);
  const n = rx?.sets ?? (cardio ? 1 : 3); // cardio: one bout
  for (let i = 0; i < n; i++) {
    const prev = last[i] ?? last[last.length - 1];
    const sameLoad = prev && kg !== null && Math.abs((prev.kg ?? 0) - kg) < 0.01;
    out.push({
      id: uid("t"),
      type: "working",
      kg,
      reps: ex.log === "duration" || ex.log === "distance" ? null : sameLoad ? prev.reps : rx?.reps_min ?? (prev?.reps ?? null),
      seconds: rx?.seconds ?? (ex.log === "duration" ? prev?.seconds ?? (cardio ? CARDIO_SECONDS : 30) : null),
      meters: rx?.meters ?? null,
      done: false,
    });
  }
  for (let i = 0; i < (rx?.drop_sets ?? 0); i++) out.push({ id: uid("t"), type: "drop", kg: dropLoad(kg, ex, s), reps: rx?.reps_max ?? null, done: false });
  return out;
}

export function buildActive(
  data: WorkoutData,
  lib: Library,
  hist: Map<string, Session[]>,
  uid: (p: string) => string,
  { name, rxs, sessionId, programId, deload = false, startedAt }: { name: string; rxs: Prescription[]; sessionId?: string | null; programId?: string | null; deload?: boolean; startedAt: string },
): Workout {
  const s = data.settings;
  const warmed = new Set<string>();
  const exercises: WorkoutExercise[] = rxs.map((rx) => {
    const ex = lib.get(rx.exercise_id);
    const warm = rx.warmup ?? (s.warmups && ex.compound && ex.log === "weight_reps" && !warmed.has(ex.pattern));
    if (ex.compound) warmed.add(ex.pattern);
    const { target_rir: _legacy, ...plain } = rx; // never carry a legacy RIR target forward
    return { id: uid("e"), exercise_id: ex.id, sets: newSetsFor(ex, rx, hist.get(ex.id), s, uid, { warm: !!warm, deload }), notes: "", superset: rx.superset ?? null, rest_s: rx.rest_s ?? null, rx: plain };
  });
  return {
    id: uid("w"),
    name,
    date: startedAt.slice(0, 10),
    started_at: startedAt,
    ended_at: null,
    duration_s: null,
    exercises,
    notes: "",
    session_id: sessionId ?? null,
    program_id: programId ?? null,
    bodyweight_kg: s.bodyweight_kg,
    deload,
    rest_until: null,
    rest_total_s: null,
  };
}

/** The most workouts one file holds (models.py ``workouts`` max_length). */
export const MAX_WORKOUTS = 2500;

/** Move the live session into history (unticked sets dropped). Mutates —
 *  a mutator: the end time is passed in (made once, outside), never read
 *  from the clock here, so a replay gives the same result. */
export function finishActive(d: WorkoutData, notes: string, endedAt: string): string | null {
  const w = d.active;
  if (!w) return null;
  if (d.workouts.length >= MAX_WORKOUTS) return null; // the file is full: keep the live workout
  for (const we of w.exercises) we.sets = we.sets.filter(isDone);
  w.exercises = w.exercises.filter((we) => we.sets.length);
  if (!w.exercises.length) return null;
  w.ended_at = endedAt;
  w.duration_s = w.started_at ? Math.max(0, Math.min(86_400, Math.round((new Date(endedAt).getTime() - new Date(w.started_at).getTime()) / 1000))) : null;
  w.rest_until = null;
  w.rest_total_s = null;
  w.notes = notes;
  if (w.session_id) {
    const p = d.planned.find((x) => x.id === w.session_id);
    if (p) {
      p.status = "done";
      p.workout_id = w.id;
      if (p.deload) w.deload = true;
      // Done on another day → it moves to the day it was done (mirrors science.py/actions.py).
      if (p.date !== w.date) {
        p.date = w.date;
        d.planned.sort((a, b) => (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")));
      }
    }
  }
  d.active = null;
  d.workouts.push(w);
  d.workouts.sort((a, b) => (a.date + (a.started_at ?? "")).localeCompare(b.date + (b.started_at ?? "")));
  return w.id;
}

// --------------------------------------------------------------- volume

export function weekStartOf(day: string, s: Settings): string {
  const d = parseDay(day);
  const first = s.week_start === "sun" ? 0 : 1;
  d.setDate(d.getDate() - ((d.getDay() - first + 7) % 7));
  return todayISO(d);
}

export function muscleSets(pairs: [Exercise, number][], muscles: Record<string, MuscleInfo>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of Object.keys(muscles)) out[m] = 0;
  for (const [ex, n] of pairs) {
    if (isCardio(ex)) continue; // conditioning, not hard sets for a muscle
    for (const m of ex.primary) out[m] = (out[m] ?? 0) + n;
    for (const m of ex.secondary) out[m] = (out[m] ?? 0) + n * 0.5;
  }
  return out;
}

export function weeklyVolume(data: WorkoutData, lib: Library, start: string, source: "logged" | "planned"): Record<string, number> {
  const end = addDays(start, 7);
  const pairs: [Exercise, number][] = [];
  if (source === "logged") {
    for (const w of data.workouts) if (w.date >= start && w.date < end) for (const we of w.exercises) pairs.push([lib.get(we.exercise_id), we.sets.filter(isHard).length]);
    const a = data.active;
    if (a && a.date >= start && a.date < end) for (const we of a.exercises) pairs.push([lib.get(we.exercise_id), we.sets.filter((x) => isHard(x)).length]);
  } else {
    for (const p of data.planned) if (p.date >= start && p.date < end && p.status !== "skipped") for (const rx of p.exercises) pairs.push([lib.get(rx.exercise_id), rx.sets + (rx.drop_sets ?? 0)]);
  }
  return muscleSets(pairs, lib.catalog.muscles);
}

export type Landmark = "none" | "below_mev" | "productive" | "in_mav" | "above_mav" | "near_mrv" | "above_mrv";
export function landmark(m: MuscleInfo, sets: number): Landmark {
  if (sets === 0) return m.mev > 0 ? "below_mev" : "none";
  if (sets < m.mev) return "below_mev";
  if (sets > m.mrv) return "above_mrv";
  if (sets >= m.mrv - 1) return "near_mrv";
  if (sets > m.mav[1]) return "above_mav";
  if (sets >= m.mav[0]) return "in_mav";
  return "productive";
}

export function estimateMinutes(rxs: Prescription[], lib: Library, s: Settings): number {
  let total = 0;
  for (const rx of rxs) {
    const ex = lib.get(rx.exercise_id);
    const rest = rx.rest_s ?? defaultRest(ex, s);
    const sets = rx.sets + (rx.drop_sets ?? 0);
    const work = ex.log === "distance" ? rx.seconds ?? 600 : rx.seconds ?? 45;
    total += sets * work + Math.max(0, sets - 1) * rest + 120;
    if (ex.compound && ex.log === "weight_reps" && rx.warmup !== false) total += 240;
  }
  return Math.ceil(total / 60);
}

export function streakWeeks(data: WorkoutData): number {
  const s = data.settings;
  const weeks = new Set(data.workouts.map((w) => weekStartOf(w.date, s)));
  let cur = weekStartOf(todayISO(), s);
  let n = 0;
  if (!weeks.has(cur)) cur = addDays(cur, -7);
  while (weeks.has(cur)) {
    n++;
    cur = addDays(cur, -7);
  }
  return n;
}
