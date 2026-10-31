/*
 * Habit maths — a mirror of backend/app/items/kinds/habits/engine.py (keep
 * them in step). Days are handled as integer day numbers (days since
 * 1970-01-01, UTC) so loops over years are fast and DST-proof.
 *
 * Day-based schedules (daily, weekdays, every N days): each due day is done,
 * missed, skipped (neutral) or — today — pending until it's settled.
 * Period schedules (X per week / month): weeks or months are the unit; skips
 * shrink the requirement to ceil(times × available / days).
 * Avoid habits: past days without a slip are clean; today counts once
 * confirmed. Strength score: Loop Habit Tracker's exponential average.
 * Eras: a schedule / type / goal change keeps the old rules in ``history``
 * so every past day is judged by the rules it had. every-N-days counts
 * from ``anchor_date`` (a backfill never shifts it).
 *
 * Parity: backend/tests/habits_engine_fixtures.json holds inputs + the
 * Python engine's outputs; ``checkFixtures`` below recomputes them here.
 */
import type { Habit, HabitLog, HabitsData } from "./types";

export type Status = "done" | "missed" | "skipped" | "pending" | "off" | "neutral";

const DAY_MS = 86_400_000;
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// ------------------------------------------------------------------ days

export function dn(day: string): number {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return Math.round(Date.UTC(y, (m || 1) - 1, d || 1) / DAY_MS);
}

export function ds(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
export function wd(n: number): number {
  return (((n + 3) % 7) + 7) % 7;
}

/** Today as the person counts it — before ``dayEndsAt`` o'clock it's still yesterday. */
export function logicalToday(dayEndsAt: number, now: Date = new Date()): string {
  const d = new Date(now.getTime() - (dayEndsAt || 0) * 3_600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function weekStartOf(n: number, weekStart: number): number {
  return n - ((wd(n) - weekStart + 7) % 7);
}

export function periodOf(n: number, kind: string, weekStart: number): [number, number] {
  if (kind === "per_month") {
    const d = new Date(n * DAY_MS);
    const first = Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY_MS);
    const next = Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / DAY_MS);
    return [first, next - 1];
  }
  const a = weekStartOf(n, weekStart);
  return [a, a + 6];
}

// ---------------------------------------------------------------- habits

export const isFlexible = (h: Pick<Habit, "schedule">) => h.schedule.kind === "per_week" || h.schedule.kind === "per_month";

export function startOf(h: Habit): number | null {
  if (h.start_date) return dn(h.start_date);
  const c: number[] = [];
  if (h.created_at) c.push(dn(h.created_at));
  if (h.logs.length) c.push(dn(h.logs[0].day));
  return c.length ? Math.min(...c) : null;
}

export const endOf = (h: Habit): number | null => (h.end_date ? dn(h.end_date) : null);

/** Where an every-N-days cadence counts from: ``anchor_date``, else the start. */
export const anchorOf = (h: Habit, start: number | null): number | null => (h.anchor_date ? dn(h.anchor_date) : start);

/** The fields that decide what a day needs; kept per era in ``history``. */
export const CONFIG_KEYS = ["type", "target", "limit", "schedule", "anchor_date"] as const;

export interface EraSpan {
  view: Habit;
  /** null = from the start */
  lo: number | null;
  /** null = still running */
  hi: number | null;
}

/** The habit's life in stretches with one set of rules each, oldest first. */
export function eras(h: Habit): EraSpan[] {
  const end = endOf(h);
  const hist = [...(h.history ?? [])].sort((a, b) => (a.until < b.until ? -1 : a.until > b.until ? 1 : 0));
  const out: EraSpan[] = [];
  let lo: number | null = null;
  for (const e of hist) {
    const until = dn(e.until);
    let hi = until - 1;
    if (end !== null && hi > end) hi = end;
    const view: Habit = {
      ...h,
      type: e.type ?? h.type,
      target: e.target ?? h.target,
      limit: e.limit ?? h.limit,
      schedule: e.schedule ?? h.schedule,
      anchor_date: e.anchor_date === undefined ? h.anchor_date : e.anchor_date,
      history: [],
    };
    if (lo === null || hi >= lo) out.push({ view, lo, hi });
    lo = lo === null ? until : Math.max(lo, until);
  }
  if (end === null || lo === null || lo <= end) out.push({ view: h.history?.length ? { ...h, history: [] } : h, lo, hi: end });
  return out;
}

export const lastDay = (h: Habit, today: number) => {
  const e = endOf(h);
  return e === null ? today : Math.min(today, e);
};

/** Every day from the start to today (or the end) with the rules it had. */
export function dayViews(h: Habit, today: number): { n: number; v: Habit }[] {
  const start = startOf(h);
  if (start === null) return [];
  const last = lastDay(h, today);
  const es = eras(h);
  if (start > last || !es.length) return [];
  const out: { n: number; v: Habit }[] = [];
  let i = 0;
  for (let n = start; n <= last; n++) {
    while (i < es.length - 1 && es[i].hi !== null && n > (es[i].hi as number)) i++;
    out.push({ n, v: es[i].view });
  }
  return out;
}

/** The habit as it was set up on day ``n``. */
export function configOn(h: Habit, n: number): Habit {
  for (const e of eras(h)) if ((e.lo === null || n >= e.lo) && (e.hi === null || n <= e.hi)) return e.view;
  return h;
}

export type LogMap = Map<number, HabitLog>;

export function logMap(h: Habit): LogMap {
  const m: LogMap = new Map();
  for (const l of h.logs) m.set(dn(l.day), l);
  return m;
}

export function isDue(h: Habit, n: number, start: number | null): boolean {
  if (start === null || n < start) return false;
  const s = h.schedule;
  if (s.kind === "weekdays") return s.days.includes(wd(n));
  if (s.kind === "every_n_days") {
    const k = Math.max(2, s.every || 2);
    const a = anchorOf(h, start) ?? start;
    return (((n - a) % k) + k) % k === 0;
  }
  return true;
}

export const isSkipped = (l: HabitLog | undefined) => !!l?.skipped;

export function isMet(h: Habit, l: HabitLog | undefined, n: number, today: number): boolean {
  if (l?.skipped) return false;
  if (h.type === "avoid") return l ? l.value <= (h.limit || 0) : n < today;
  if (!l) return false;
  if (h.type === "yes_no") return l.value > 0;
  return l.value >= (h.target || 1) - 1e-9;
}

/** An avoid habit whose slips already went past the limit — lost for the day. */
export function isFailed(h: Habit, l: HabitLog | undefined): boolean {
  return h.type === "avoid" && !!l && !l.skipped && l.value > (h.limit || 0);
}

export function isFinal(h: Habit, l: HabitLog | undefined, n: number, today: number): boolean {
  return n < today || isMet(h, l, n, today) || isFailed(h, l);
}

export function fraction(h: Habit, l: HabitLog | undefined, n: number, today: number): number {
  if (h.type === "avoid") return isMet(h, l, n, today) ? 1 : 0;
  if (!l || l.skipped) return 0;
  if (h.type === "yes_no") return l.value > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, l.value / (h.target || 1)));
}

// --------------------------------------------------------- day-based units

function dayStatusOf(v: Habit, n: number, start: number | null, today: number, logs: LogMap): Status {
  if (!isDue(v, n, start)) return "off";
  const l = logs.get(n);
  if (isSkipped(l)) return "skipped";
  if (isMet(v, l, n, today)) return "done";
  if (n === today && !isFailed(v, l)) return "pending";
  return "missed";
}

function flexDayStatus(v: Habit, n: number, today: number, logs: LogMap): Status {
  const l = logs.get(n);
  if (isSkipped(l)) return "skipped";
  return l && isMet(v, l, n, today) ? "done" : "off";
}

/** (day, status) from the start to today, each day under the rules it had. */
export function dayStatuses(h: Habit, today: number, logs: LogMap = logMap(h)): { n: number; s: Status }[] {
  const start = startOf(h);
  return dayViews(h, today).map(({ n, v }) => ({ n, s: isFlexible(v) ? flexDayStatus(v, n, today, logs) : dayStatusOf(v, n, start, today, logs) }));
}

// ------------------------------------------------------ period-based units

export interface Period {
  start: number;
  end: number;
  required: number;
  done: number;
  left: number;
  status: Status;
}

function eraPeriods(v: Habit, first: number, cap: number | null, today: number, weekStart: number, logs: LogMap): Period[] {
  const kind = v.schedule.kind;
  const times = v.schedule.times || 1;
  const out: Period[] = [];
  const last = cap === null ? today : Math.min(today, cap);
  let [a, b] = periodOf(first, kind, weekStart);
  while (a <= last) {
    const length = b - a + 1;
    let available = 0;
    let done = 0;
    let left = 0;
    for (let n = a; n <= b; n++) {
      if (n < first || (cap !== null && n > cap)) continue;
      const l = logs.get(n);
      if (isSkipped(l)) continue;
      available++;
      if (n <= today && isMet(v, l, n, today)) done++;
      else if (n > today || (n === today && !isFailed(v, l))) left++;
    }
    const required = Math.min(times, available, Math.ceil((times * available) / length - 1e-9));
    const current = a <= today && today <= b && (cap === null || cap >= today);
    let status: Status;
    if (required <= 0) status = "neutral";
    else if (done >= required) status = "done";
    else if (current && done + left >= required) status = "pending";
    else status = "missed";
    out.push({ start: a, end: b, required, done, left: current ? left : 0, status });
    a = b + 1;
    b = periodOf(a, kind, weekStart)[1];
  }
  return out;
}

/** Eras overlapping the habit's life up to today: (view, first day, cap). */
function eraSpans(h: Habit, today: number): { v: Habit; first: number; cap: number | null }[] {
  const start = startOf(h);
  if (start === null) return [];
  const last = lastDay(h, today);
  const out: { v: Habit; first: number; cap: number | null }[] = [];
  for (const e of eras(h)) {
    const first = e.lo === null ? start : Math.max(start, e.lo);
    if (first > last || (e.hi !== null && e.hi < first)) continue;
    out.push({ v: e.view, first, cap: e.hi });
  }
  return out;
}

export function periods(h: Habit, today: number, weekStart: number, logs: LogMap = logMap(h)): Period[] {
  const out: Period[] = [];
  for (const { v, first, cap } of eraSpans(h, today)) if (isFlexible(v)) out.push(...eraPeriods(v, first, cap, today, weekStart, logs));
  return out;
}

// ------------------------------------------------------------------ streaks

export function streaks(seq: Status[]): { current: number; best: number } {
  let best = 0;
  let run = 0;
  for (const s of seq) {
    if (s === "done") {
      run++;
      best = Math.max(best, run);
    } else if (s === "missed") run = 0;
  }
  let current = 0;
  for (let i = seq.length - 1; i >= 0; i--) {
    if (seq[i] === "done") current++;
    else if (seq[i] === "missed") break;
  }
  return { current, best };
}

/** Streak units in order: periods for X-per-period eras, days otherwise. */
export function unitStatuses(h: Habit, today: number, weekStart: number, logs: LogMap = logMap(h)): Status[] {
  const start = startOf(h);
  const out: Status[] = [];
  for (const { v, first, cap } of eraSpans(h, today)) {
    if (isFlexible(v)) for (const p of eraPeriods(v, first, cap, today, weekStart, logs)) out.push(p.status);
    else {
      const last = cap === null ? today : Math.min(today, cap);
      for (let n = first; n <= last; n++) out.push(dayStatusOf(v, n, start, today, logs));
    }
  }
  return out;
}

export function streakUnit(h: Habit, n = 2): string {
  const one = n === 1;
  if (h.schedule.kind === "per_week") return one ? "week" : "weeks";
  if (h.schedule.kind === "per_month") return one ? "month" : "months";
  return one ? "day" : "days";
}

// -------------------------------------------------------------------- rates

export function completionRate(h: Habit, today: number, windowDays: number | null, weekStart: number, logs: LogMap = logMap(h)): number | null {
  const lo = windowDays ? today - windowDays + 1 : -Infinity;
  const start = startOf(h);
  let got = 0;
  let need = 0;
  for (const { v, first, cap } of eraSpans(h, today)) {
    if (isFlexible(v)) {
      for (const p of eraPeriods(v, first, cap, today, weekStart, logs)) {
        if (p.end < lo || p.status === "neutral") continue;
        if (p.status === "done") {
          got += p.required;
          need += p.required;
        } else if (p.status === "missed") {
          got += p.done;
          need += p.required;
        } else {
          got += Math.min(p.done, p.required);
          need += Math.min(p.done, p.required);
        }
      }
      continue;
    }
    const last = cap === null ? today : Math.min(today, cap);
    for (let n = Math.max(first, lo); n <= last; n++) {
      const s = dayStatusOf(v, n, start, today, logs);
      if (s === "done") {
        got++;
        need++;
      } else if (s === "missed") need++;
    }
  }
  return need ? Math.round((got / need) * 10000) / 10000 : null;
}

// -------------------------------------------------------------------- score

export function frequency(h: Habit): number {
  const s = h.schedule;
  if (s.kind === "weekdays") return Math.max(1, s.days.length) / 7;
  if (s.kind === "every_n_days") return 1 / Math.max(2, s.every || 2);
  if (s.kind === "per_week") return Math.min(7, s.times || 1) / 7;
  if (s.kind === "per_month") return Math.min(31, s.times || 1) / 30.44;
  return 1;
}

/** The strength score (0..1) at the end of every day, each day under its own rules. */
export function scoreSeries(h: Habit, today: number, logs: LogMap = logMap(h)): { n: number; v: number }[] {
  const start = startOf(h);
  const dv = dayViews(h, today);
  const met = new Set<number>();
  for (const { n, v } of dv) if (isFlexible(v) && isMet(v, logs.get(n), n, today)) met.add(n);
  const out: { n: number; v: number }[] = [];
  let s = 0;
  for (const { n, v } of dv) {
    const l = logs.get(n);
    const f = frequency(v);
    if (isFlexible(v)) {
      if (isSkipped(l) || !isFinal(v, l, n, today)) {
        out.push({ n, v: s });
        continue;
      }
      const m = 0.5 ** (Math.sqrt(f) / 13);
      const windowDays = v.schedule.kind === "per_week" ? 7 : 30;
      const times = v.schedule.times || 1;
      let c = 0;
      for (let k = 0; k < windowDays; k++) if (met.has(n - k)) c++;
      s = s * m + Math.min(1, c / times) * (1 - m);
      out.push({ n, v: s });
      continue;
    }
    if (!isDue(v, n, start) || isSkipped(l) || !isFinal(v, l, n, today)) {
      out.push({ n, v: s });
      continue;
    }
    const m = 0.5 ** (1 / (13 * Math.sqrt(f)));
    s = s * m + fraction(v, l, n, today) * (1 - m);
    out.push({ n, v: s });
  }
  return out;
}

// ------------------------------------------------------------- breakdowns

export function weekdayBreakdown(h: Habit, today: number, logs: LogMap = logMap(h)): { weekday: string; done: number; total: number; rate: number | null }[] {
  const rows = WEEKDAYS.map((w) => ({ weekday: w, done: 0, total: 0 }));
  const start = startOf(h);
  for (const { n, v } of dayViews(h, today)) {
    const l = logs.get(n);
    const r = rows[wd(n)];
    if (isFlexible(v)) {
      if (isSkipped(l) || !isFinal(v, l, n, today)) continue;
      r.total++;
      if (isMet(v, l, n, today)) r.done++;
      continue;
    }
    const s = dayStatusOf(v, n, start, today, logs);
    if (s === "done" || s === "missed") {
      r.total++;
      if (s === "done") r.done++;
    }
  }
  return rows.map((r) => ({ ...r, rate: r.total ? Math.round((r.done / r.total) * 10000) / 10000 : null }));
}

export interface PerfectDays {
  total: number;
  current: number;
  best: number;
  last30: number;
  today: Status | undefined;
  days: Set<number>;
}

export function perfectDays(habits: Habit[], today: number): PerfectDays {
  const perDay = new Map<number, Status[]>();
  for (const h of habits) {
    if (h.archived || isFlexible(h)) continue;
    for (const { n, s } of dayStatuses(h, today)) {
      if (s === "done" || s === "missed" || s === "pending") {
        const arr = perDay.get(n);
        if (arr) arr.push(s);
        else perDay.set(n, [s]);
      }
    }
  }
  const ordered = [...perDay.keys()].sort((a, b) => a - b);
  const flags: Status[] = [];
  const days = new Set<number>();
  let todayFlag: Status | undefined;
  for (const n of ordered) {
    const ss = perDay.get(n)!;
    let f: Status;
    if (ss.every((s) => s === "done")) {
      f = "done";
      days.add(n);
    } else if (n === today && !ss.includes("missed")) f = "pending";
    else f = "missed";
    flags.push(f);
    if (n === today) todayFlag = f;
  }
  const { current, best } = streaks(flags);
  let last30 = 0;
  for (const n of days) if (n > today - 30) last30++;
  return { total: days.size, current, best, last30, today: todayFlag, days };
}

// ----------------------------------------------------------------- today

export interface DayState {
  /** Expected on this day (day-based due, or a period still open). */
  due: boolean;
  done: boolean;
  skipped: boolean;
  failed: boolean;
  value: number;
  log: HabitLog | undefined;
  period?: Period;
}

export function dayState(h: Habit, n: number, today: number, weekStart: number, logs: LogMap = logMap(h)): DayState {
  const start = startOf(h);
  const l = logs.get(n);
  const out: DayState = {
    due: false,
    done: isMet(h, l, n, today) && (h.type !== "avoid" || !!l || n < today),
    skipped: isSkipped(l),
    failed: isFailed(h, l),
    value: l && !l.skipped ? l.value : 0,
    log: l,
  };
  const end = endOf(h);
  if (start === null || start > n || (end !== null && n > end)) return out;
  if (isFlexible(h)) {
    const ps = periods(h, Math.max(n, today), weekStart, logs);
    const [a] = periodOf(n, h.schedule.kind, weekStart);
    const p = ps.find((x) => x.start === a);
    if (p) {
      out.period = p;
      out.due = (p.status === "pending" || out.done) && !out.skipped;
    }
  } else {
    out.due = isDue(h, n, start) && !out.skipped;
  }
  return out;
}

// ----------------------------------------------------------- descriptions

export function describeSchedule(h: Habit): string {
  const s = h.schedule;
  if (s.kind === "weekdays") {
    const d = s.days;
    if (d.join() === "0,1,2,3,4") return "Weekdays";
    if (d.join() === "5,6") return "Weekends";
    return d.map((x) => WEEKDAYS[x]).join(", ");
  }
  if (s.kind === "per_week") return `${s.times}× a week`;
  if (s.kind === "per_month") return `${s.times}× a month`;
  if (s.kind === "every_n_days") return `Every ${s.every} days`;
  return "Every day";
}

export function fmtN(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function describeGoal(h: Habit): string {
  if (h.type === "count") return `${fmtN(h.target)} ${h.unit || "times"}`;
  if (h.type === "duration") return `${fmtN(h.target)} min`;
  if (h.type === "avoid") return h.limit ? `At most ${h.limit} ${h.unit || "times"}` : "Avoid";
  return "";
}

// ------------------------------------------------------------- per habit

export interface HabitStats {
  current: number;
  best: number;
  unit: string;
  score: number;
  scoreChange30: number;
  rate7: number | null;
  rate30: number | null;
  rate90: number | null;
  rateAll: number | null;
  timesDone: number;
  lastDone: number | null;
  skippedDays: number;
  missedYesterday: boolean;
  series: { n: number; v: number }[];
  weekdays: ReturnType<typeof weekdayBreakdown>;
  periods: Period[];
  statuses: Map<number, Status>;
  logs: LogMap;
}

export function habitStats(h: Habit, today: number, weekStart: number): HabitStats {
  const logs = logMap(h);
  const flexible = isFlexible(h);
  const ds_ = dayStatuses(h, today, logs);
  const ps = periods(h, today, weekStart, logs);
  const units = unitStatuses(h, today, weekStart, logs);
  const { current, best } = streaks(units);
  const series = scoreSeries(h, today, logs);
  const score = series.length ? series[series.length - 1].v : 0;
  let prev = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].n <= today - 30) {
      prev = series[i].v;
      break;
    }
  }
  let timesDone = 0;
  let lastDone: number | null = null;
  let skippedDays = 0;
  const views = new Map<number, Habit>();
  for (const x of dayViews(h, today)) views.set(x.n, x.v);
  for (const [n, l] of logs) {
    if (l.skipped) skippedDays++;
    else if (n <= today && isMet(views.get(n) ?? h, l, n, today)) {
      timesDone++;
      if (lastDone === null || n > lastDone) lastDone = n;
    }
  }
  const statuses = new Map<number, Status>();
  for (const x of ds_) statuses.set(x.n, x.s);
  const y = today - 1;
  const missedYesterday = !flexible && statuses.get(y) === "missed";
  return {
    current,
    best,
    unit: streakUnit(h, current),
    score,
    scoreChange30: score - prev,
    rate7: completionRate(h, today, 7, weekStart, logs),
    rate30: completionRate(h, today, 30, weekStart, logs),
    rate90: completionRate(h, today, 90, weekStart, logs),
    rateAll: completionRate(h, today, null, weekStart, logs),
    timesDone,
    lastDone,
    skippedDays,
    missedYesterday,
    series,
    weekdays: weekdayBreakdown(h, today, logs),
    periods: ps,
    statuses,
    logs,
  };
}

/** Heatmap level 0..4 for one habit on one day. */
export function dayLevel(h: Habit, logs: LogMap, n: number, today: number): number {
  const l = logs.get(n);
  if (!l || l.skipped) return h.type === "avoid" && !l && n < today && n >= (startOf(h) ?? n + 1) ? 2 : 0;
  if (isMet(h, l, n, today)) return 4;
  const f = fraction(h, l, n, today);
  return f <= 0 ? 0 : Math.max(1, Math.min(3, Math.ceil(f * 3)));
}

/** Overall heatmap: share of the day's due (day-based) habits that were done. */
export function overallLevels(data: HabitsData, today: number, from: number): Record<string, number> {
  const out: Record<string, number> = {};
  const due = new Map<number, number>();
  const done = new Map<number, number>();
  for (const h of data.habits) {
    if (h.archived) continue;
    const logs = logMap(h);
    if (isFlexible(h)) {
      for (const [n, l] of logs) {
        if (n >= from && n <= today && isMet(h, l, n, today)) {
          done.set(n, (done.get(n) ?? 0) + 1);
          due.set(n, (due.get(n) ?? 0) + 1);
        }
      }
      continue;
    }
    for (const { n, s } of dayStatuses(h, today, logs)) {
      if (n < from) continue;
      if (s === "done" || s === "missed" || s === "pending") due.set(n, (due.get(n) ?? 0) + 1);
      if (s === "done") done.set(n, (done.get(n) ?? 0) + 1);
    }
  }
  for (const [n, total] of due) {
    const f = (done.get(n) ?? 0) / total;
    out[ds(n)] = f <= 0 ? 0 : f >= 1 ? 4 : Math.max(1, Math.min(3, Math.ceil(f * 3)));
  }
  return out;
}

// ------------------------------------------------------------- parity

export interface FixtureCase {
  name: string;
  habit: Habit;
  today: string;
  week_start: number;
  expected: Record<string, unknown>;
}

/** What the parity fixtures compare (the Python test computes the same). */
export function fixtureOutputs(h: Habit, todayDay: string, weekStart: number): Record<string, unknown> {
  const t = dn(todayDay);
  const units = unitStatuses(h, t, weekStart);
  const { current, best } = streaks(units);
  const series = scoreSeries(h, t);
  const st = dayStatuses(h, t);
  return {
    current,
    best,
    units: units.join(","),
    days: st.map((x) => x.s[0]).join(""),
    score: Math.round((series.length ? series[series.length - 1].v : 0) * 10000) / 10000,
    rate_all: completionRate(h, t, null, weekStart),
    rate_30: completionRate(h, t, 30, weekStart),
    weekdays: weekdayBreakdown(h, t).map((r) => `${r.done}/${r.total}`).join(" "),
  };
}

/** Recompute every fixture; returns the mismatches (empty = in step with Python). */
export function checkFixtures(cases: FixtureCase[]): string[] {
  const bad: string[] = [];
  for (const c of cases) {
    const got = fixtureOutputs(c.habit, c.today, c.week_start);
    for (const [k, want] of Object.entries(c.expected)) {
      const g = got[k];
      const same = typeof want === "number" && typeof g === "number" ? Math.abs(want - g) < 1e-4 : JSON.stringify(g) === JSON.stringify(want);
      if (!same) bad.push(`${c.name}.${k}: python ${JSON.stringify(want)} vs ts ${JSON.stringify(g)}`);
    }
  }
  return bad;
}
