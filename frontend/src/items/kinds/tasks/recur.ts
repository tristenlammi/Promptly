import type { Repeat } from "./types";

/*
 * Calendar-day maths on ``YYYY-MM-DD`` strings (UTC under the hood, so no
 * DST surprises), and repeats: the next due day after a completion.
 * Mirrors backend/app/items/kinds/tasks/recur.py — change both together.
 */

export function toUTC(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

export function fromUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function plusDays(day: string, n: number): string {
  const d = toUTC(day);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
}

/** Mon=0 … Sun=6. */
export function weekday(day: string): number {
  return (toUTC(day).getUTCDay() + 6) % 7;
}

export function daysInMonth(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

export function addMonths(day: string, n: number, dom: number): string {
  const d = toUTC(day);
  const total = d.getUTCMonth() + n;
  const y = d.getUTCFullYear() + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  return fromUTC(new Date(Date.UTC(y, m, Math.min(dom, daysInMonth(y, m)))));
}

function step(rep: Repeat, d: string, anchorDom: number, anchor: string): string {
  const n = rep.interval || 1;
  if (rep.freq === "daily") return plusDays(d, n);
  if (rep.freq === "weekly") {
    const days = rep.weekdays ?? [];
    if (!days.length) return plusDays(d, 7 * n);
    const week0 = plusDays(anchor, -weekday(anchor));
    let c = plusDays(d, 1);
    for (let i = 0; i < 7 * n + 7; i++) {
      const wk = Math.floor((toUTC(c).getTime() - toUTC(week0).getTime()) / (7 * 86_400_000)) % n;
      if (days.includes(weekday(c)) && wk === 0) return c;
      c = plusDays(c, 1);
    }
    return plusDays(d, 7 * n);
  }
  if (rep.freq === "monthly") return addMonths(d, n, rep.month_day || anchorDom);
  const a = toUTC(anchor);
  const y = toUTC(d).getUTCFullYear() + n;
  return fromUTC(new Date(Date.UTC(y, a.getUTCMonth(), Math.min(a.getUTCDate(), daysInMonth(y, a.getUTCMonth())))));
}

/** The day after ``due`` (or ``doneDay``) the task is next due, or null when
 *  it's past ``until``. Never on or before the day it was done. */
export function nextDue(rep: Repeat, due: string | null, doneDay: string): string | null {
  let base = due || doneDay;
  if (rep.from_completion) base = doneDay;
  const anchorDom = rep.month_day || Number(base.slice(8, 10));
  let next = step(rep, base, anchorDom, base);
  for (let guard = 0; next <= doneDay && guard < 1000; guard++) next = step(rep, next, anchorDom, base);
  if (rep.until && next > rep.until) return null;
  return next;
}

/** The first day on or after ``from`` that a new repeat lands on. */
export function firstDue(rep: Repeat, from: string): string {
  if (rep.freq === "weekly" && rep.weekdays.length) {
    let c = from;
    for (let i = 0; i < 7; i++) {
      if (rep.weekdays.includes(weekday(c))) return c;
      c = plusDays(c, 1);
    }
  }
  if (rep.freq === "monthly" && rep.month_day) {
    const d = toUTC(from);
    const here = fromUTC(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(rep.month_day, daysInMonth(d.getUTCFullYear(), d.getUTCMonth())))));
    return here >= from ? here : addMonths(here, 1, rep.month_day);
  }
  return from;
}

export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

/** "every day", "every 2 weeks on Mon, Thu", "every month on the 15th". */
export function describeRepeat(rep: Repeat | null | undefined): string {
  if (!rep) return "";
  const n = rep.interval || 1;
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[rep.freq];
  let s = n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
  const wd = rep.weekdays ?? [];
  if (rep.freq === "weekly" && wd.length) {
    s = wd.join() === "0,1,2,3,4" && n === 1 ? "every weekday" : wd.join() === "5,6" && n === 1 ? "every weekend" : `${s} on ${wd.map((d) => WEEKDAY_SHORT[d]).join(", ")}`;
  }
  if (rep.freq === "monthly" && rep.month_day) s += ` on the ${ordinal(rep.month_day)}`;
  if (rep.from_completion) s += " after done";
  return s;
}

export function makeRepeat(p: Partial<Repeat> & { freq: Repeat["freq"] }): Repeat {
  return { interval: 1, weekdays: [], month_day: null, from_completion: false, until: null, ...p };
}
