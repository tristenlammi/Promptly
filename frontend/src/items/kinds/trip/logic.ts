/* Derived trip facts for the UI (mirrors backend logic.py where it matters:
 * money conversion, splits, settle-up, booking events, where you are each
 * day). Conflicts come from the server's ``conflicts`` action. */

import type { Booking, Category, Expense, PlanItem, Trip, TripDay } from "./types";
import { BOOKING_CATEGORY } from "./types";
import { dateRange, dayDiff, dayOf, minutesBetween, timeOf, toInstant } from "./tz";

/* ---------------------------------------------------------------- money */

const EXP: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0,
  XAF: 0, XOF: 0, XPF: 0, BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};
export const exponent = (code: string | null | undefined) => EXP[(code ?? "").toUpperCase()] ?? 2;
// Math.round is half-up; the server rounds the same way (``half_up``).
export const toMinor = (major: number, code: string) => Math.round(major * 10 ** exponent(code));
export const toMajor = (minor: number, code: string) => minor / 10 ** exponent(code);

export function money(minor: number | null | undefined, code: string, opts: { compact?: boolean } = {}): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return "–";
  const e = exponent(code);
  const v = minor / 10 ** e;
  try {
    return v.toLocaleString(undefined, {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      // Compact drops cents only when there are none (or it's 1,000+): "$318.50", "$320", "$1,240".
      ...(opts.compact && (Math.abs(v) >= 1000 || Number.isInteger(v))
        ? { maximumFractionDigits: 0, minimumFractionDigits: 0 }
        : { maximumFractionDigits: e, minimumFractionDigits: e }),
    });
  } catch {
    return `${code} ${v.toFixed(e)}`;
  }
}

export function rateFor(t: Trip, code: string | null | undefined): number | null {
  const home = t.settings.home_currency;
  const c = (code || home).toUpperCase();
  if (c === home) return 1;
  return t.currencies.find((r) => r.code === c)?.per_home ?? null;
}

export function toHome(t: Trip, minor: number | null | undefined, code: string | null | undefined, perHome?: number | null): number | null {
  if (minor === null || minor === undefined) return null;
  const home = t.settings.home_currency;
  const c = (code || home).toUpperCase();
  if (c === home) return minor;
  const rate = perHome || rateFor(t, c);
  if (!rate) return null;
  return Math.round((minor / 10 ** exponent(c) / rate) * 10 ** exponent(home));
}

export function allocate(total: number, weights: number[]): number[] {
  if (!weights.length) return [];
  let w = weights;
  let s = w.reduce((a, b) => a + b, 0);
  if (s <= 0) {
    w = w.map(() => 1);
    s = w.length;
  }
  const raw = w.map((x) => (total * x) / s);
  const parts = raw.map((r) => (r >= 0 ? Math.floor(r) : -Math.floor(-r)));
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((_, i) => i).sort((a, b) => raw[b] - parts[b] - (raw[a] - parts[a]) || a - b);
  const step = left > 0 ? 1 : -1;
  for (const i of order) {
    if (!left) break;
    parts[i] += step;
    left -= step;
  }
  return parts;
}

/** Who owes what of one expense, in its own minor units. */
export function expenseSplit(t: Trip, e: Expense): Record<string, number> {
  const ids = t.travellers.map((x) => x.id);
  const shares = e.shares.filter((s) => ids.includes(s.traveller_id));
  if (e.split === "exact" && shares.length) {
    const out: Record<string, number> = {};
    for (const s of shares) out[s.traveller_id] = s.amount_minor ?? 0;
    const diff = e.amount_minor - Object.values(out).reduce((a, b) => a + b, 0);
    if (diff) {
      const people = Object.keys(out);
      allocate(diff, people.map(() => 1)).forEach((x, i) => (out[people[i]] += x));
    }
    return out;
  }
  if (e.split === "shares" && shares.length) {
    const parts = allocate(e.amount_minor, shares.map((s) => s.weight ?? 1));
    return Object.fromEntries(shares.map((s, i) => [s.traveller_id, parts[i]]));
  }
  const people = shares.length ? shares.map((s) => s.traveller_id) : ids;
  const parts = allocate(e.amount_minor, people.map(() => 1));
  return Object.fromEntries(people.map((p, i) => [p, parts[i]]));
}

export interface Balance {
  id: string;
  name: string;
  paid: number;
  share: number;
  balance: number;
}

export function settleUp(t: Trip): { balances: Balance[]; transfers: { from: string; to: string; amount: number }[]; skipped: number } {
  const order = t.travellers.map((x) => x.id);
  const paid: Record<string, number> = Object.fromEntries(order.map((i) => [i, 0]));
  const owed: Record<string, number> = Object.fromEntries(order.map((i) => [i, 0]));
  let skipped = 0;
  for (const e of t.expenses) {
    let payer = e.paid_by && order.includes(e.paid_by) ? e.paid_by : null;
    if (!payer && order.length === 1) payer = order[0];
    const total = toHome(t, e.amount_minor, e.currency, e.per_home);
    const split = expenseSplit(t, e);
    const people = Object.keys(split);
    if (!payer || total === null || !people.length) {
      skipped++;
      continue;
    }
    const sum = people.reduce((a, p) => a + split[p], 0);
    const parts = allocate(total, people.map((p) => (sum ? split[p] : 1)));
    paid[payer] += total;
    people.forEach((p, i) => (owed[p] += parts[i]));
  }
  const bal: Record<string, number> = Object.fromEntries(order.map((i) => [i, paid[i] - owed[i]]));
  for (const s of t.settlements) {
    if (s.from_id in bal && s.to_id in bal) {
      bal[s.from_id] += s.amount_minor;
      bal[s.to_id] -= s.amount_minor;
    }
  }
  const transfers = minimalTransfers(bal, order);
  const names = Object.fromEntries(t.travellers.map((x) => [x.id, x.name]));
  return {
    balances: order.map((id) => ({ id, name: names[id], paid: paid[id], share: owed[id], balance: bal[id] })),
    transfers,
    skipped,
  };
}

type Transfer = { from: string; to: string; amount: number };

/** Past this many people with a balance, the simple greedy is used (as on the server). */
export const EXACT_MAX = 10;

function greedy(bal: Record<string, number>, ids: string[], rank: Record<string, number>): Transfer[] {
  let cred = ids.filter((i) => bal[i] > 0).map((i) => ({ id: i, v: bal[i] }));
  let debt = ids.filter((i) => bal[i] < 0).map((i) => ({ id: i, v: -bal[i] }));
  const out: Transfer[] = [];
  while (cred.length && debt.length) {
    cred.sort((a, b) => b.v - a.v || rank[a.id] - rank[b.id]);
    debt.sort((a, b) => b.v - a.v || rank[a.id] - rank[b.id]);
    const amt = Math.min(cred[0].v, debt[0].v);
    out.push({ from: debt[0].id, to: cred[0].id, amount: amt });
    cred[0].v -= amt;
    debt[0].v -= amt;
    cred = cred.filter((x) => x.v > 0);
    debt = debt.filter((x) => x.v > 0);
  }
  return out;
}

/** The most groups of people whose balances sum to zero (each then squares
 *  up on its own in size−1 transfers: the fewest overall). Mirrors the
 *  server's ``zero_sum_groups``. */
function zeroSumGroups(people: string[], bal: Record<string, number>): string[][] | null {
  const n = people.length;
  const full = (1 << n) - 1;
  const sums = new Array<number>(full + 1).fill(0);
  for (let m = 1; m <= full; m++) {
    const low = m & -m;
    sums[m] = sums[m ^ low] + bal[people[31 - Math.clz32(low)]];
  }
  if (sums[full] !== 0) return null;
  const dp = new Array<number>(full + 1).fill(0);
  for (let m = 1; m <= full; m++) {
    let best = 0;
    for (let i = 0; i < n; i++) if ((m >> i) & 1 && dp[m ^ (1 << i)] > best) best = dp[m ^ (1 << i)];
    dp[m] = best + (sums[m] === 0 ? 1 : 0);
  }
  const chain = [full];
  let m = full;
  while (m) {
    const want = dp[m] - (sums[m] === 0 ? 1 : 0);
    let i = 0;
    while (!((m >> i) & 1 && dp[m ^ (1 << i)] === want)) i++;
    m ^= 1 << i;
    if (m && sums[m] === 0) chain.push(m);
  }
  chain.push(0);
  const groups: string[][] = [];
  for (let k = 0; k + 1 < chain.length; k++) {
    const diff = chain[k] & ~chain[k + 1];
    groups.push(people.filter((_, i) => (diff >> i) & 1));
  }
  return groups;
}

/** Who pays whom: provably fewest transfers up to {@link EXACT_MAX} people,
 *  else greedy; a few minor units of rounding dust aren't worth a transfer. */
export function minimalTransfers(bal: Record<string, number>, order: string[]): Transfer[] {
  const rank = Object.fromEntries(order.map((id, i) => [id, i]));
  const people = order.filter((t) => bal[t]);
  const groups = (people.length > 0 && people.length <= EXACT_MAX ? zeroSumGroups(people, bal) : null) ?? [people];
  const dust = order.length;
  return groups.flatMap((g) => greedy(bal, g, rank)).filter((t) => t.amount > dust);
}

/* ------------------------------------------------------------- "me" */

/** The traveller this Promptly user is on the trip — never just the file
 *  owner: each companion has their own "me". */
export function meId(t: Trip, userId: string | null | undefined): string | null {
  if (!userId) return null;
  const ids = new Set(t.travellers.map((x) => x.id));
  const tid = t.me_by_user?.[userId];
  if (tid && ids.has(tid)) return tid;
  return t.travellers.find((x) => x.user_id && x.user_id === userId)?.id ?? null;
}

export function travellerRefs(t: Trip, id: string): { expenses: number; settlements: number } {
  return {
    expenses: t.expenses.filter((e) => e.paid_by === id || e.shares.some((s) => s.traveller_id === id)).length,
    settlements: t.settlements.filter((s) => s.from_id === id || s.to_id === id).length,
  };
}

/** The rate a new expense keeps: the trip's rate for its currency now
 *  (null for the home currency, or while there's no rate yet). */
export function lockedRate(t: Trip, code: string): number | null {
  return code === t.settings.home_currency ? null : rateFor(t, code);
}

const PLAN_CATEGORY: Record<string, Category> = { activity: "activities", food: "food", transport: "transport", stay: "stays", flight: "flights", note: "other" };

export interface BudgetRow {
  category: Category;
  budget: number | null;
  booked: number;
  spent: number;
  planned: number;
}

export function budget(t: Trip) {
  const lines = Object.fromEntries(t.budget.lines.map((l) => [l.category, l.amount_minor]));
  const rows: Record<string, BudgetRow> = {};
  const row = (c: Category) => (rows[c] ??= { category: c, budget: lines[c] ?? null, booked: 0, spent: 0, planned: 0 });
  const linked = new Set(t.expenses.map((e) => e.booking_id).filter(Boolean));
  const missing = new Set<string>();
  for (const b of t.bookings) {
    if (b.status === "cancelled" || !b.cost_minor || linked.has(b.id)) continue;
    const v = toHome(t, b.cost_minor, b.currency);
    if (v === null) missing.add(b.currency ?? "");
    else row(BOOKING_CATEGORY[b.type]).booked += v;
  }
  for (const e of t.expenses) {
    const v = toHome(t, e.amount_minor, e.currency, e.per_home);
    if (v === null) missing.add(e.currency);
    else row(e.category).spent += v;
  }
  for (const d of t.days)
    for (const it of d.items) {
      if (!it.cost_minor || it.status === "done" || it.booking_id) continue;
      const v = toHome(t, it.cost_minor, it.currency);
      if (v === null) missing.add(it.currency ?? "");
      else row(PLAN_CATEGORY[it.type] ?? "other").planned += v;
    }
  for (const c of Object.keys(lines)) row(c as Category);
  const list = Object.values(rows);
  const booked = list.reduce((a, r) => a + r.booked, 0);
  const spent = list.reduce((a, r) => a + r.spent, 0);
  const planned = list.reduce((a, r) => a + r.planned, 0);
  const total = t.budget.total_minor ?? (t.budget.lines.length ? t.budget.lines.reduce((a, l) => a + l.amount_minor, 0) : null);
  return { rows: list, booked, spent, planned, actual: booked + spent, total, missing: [...missing].filter(Boolean).sort() };
}

/* ------------------------------------------------------------ bookings */

export function bookingLabel(b: Booking): string {
  if (b.title) return b.title;
  if (b.type === "flight") {
    const num = [b.provider, b.number].filter(Boolean).join(" ");
    return `${num} ${b.from_code || b.from_place || "?"} → ${b.to_code || b.to_place || "?"}`.trim();
  }
  if (b.type === "train" || b.type === "bus" || b.type === "ferry") {
    const route = [b.from_place, b.to_place].filter(Boolean).join(" → ");
    return [b.provider, b.number, route].filter(Boolean).join(" ") || b.type;
  }
  return b.provider || b.type[0].toUpperCase() + b.type.slice(1);
}

export const isJourney = (t: Booking["type"]) => t === "flight" || t === "train" || t === "bus" || t === "ferry";

export function bookingMinutes(b: Booking): number | null {
  return minutesBetween(b.start, b.start_tz || null, b.end, b.end_tz || b.start_tz || null);
}

export const EVENT_WORDS: Record<Booking["type"], [string, string]> = {
  flight: ["Depart", "Arrive"],
  train: ["Depart", "Arrive"],
  bus: ["Depart", "Arrive"],
  ferry: ["Depart", "Arrive"],
  stay: ["Check in", "Check out"],
  car: ["Pick up", "Drop off"],
  tour: ["Starts", "Ends"],
  ticket: ["Starts", "Ends"],
  insurance: ["Cover starts", "Cover ends"],
  other: ["Starts", "Ends"],
};

export interface BookingEvent {
  key: string;
  date: string;
  time: string;
  edge: "start" | "end";
  word: string;
  booking: Booking;
  at: number | null;
  until: string;
}

export function bookingEvents(t: Trip): BookingEvent[] {
  const out: BookingEvent[] = [];
  for (const b of t.bookings) {
    if (b.status === "cancelled") continue;
    const [sw, ew] = EVENT_WORDS[b.type];
    const sameDay = (isJourney(b.type) || b.type === "tour" || b.type === "ticket") && dayOf(b.start) === dayOf(b.end);
    if (b.start)
      out.push({
        key: `${b.id}:s`, date: dayOf(b.start)!, time: timeOf(b.start), edge: "start", word: sw, booking: b,
        at: toInstant(b.start, b.start_tz), until: sameDay ? timeOf(b.end) : "",
      });
    if (b.end && !sameDay && b.type !== "insurance")
      out.push({
        key: `${b.id}:e`, date: dayOf(b.end)!, time: timeOf(b.end), edge: "end", word: ew, booking: b,
        at: toInstant(b.end, b.end_tz || b.start_tz), until: "",
      });
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

/* --------------------------------------------------------- where you are */

export function dayZone(t: Trip, day: string): string {
  const d = t.days.find((x) => x.date === day);
  if (d?.tz) return d.tz;
  for (const dest of t.destinations) if (dest.tz && dest.start && dest.start <= day && day <= (dest.end ?? dest.start)) return dest.tz;
  for (const b of t.bookings)
    if (b.type === "stay" && b.status !== "cancelled" && b.start && (b.start_tz || b.end_tz)) {
      const s = dayOf(b.start)!;
      const e = dayOf(b.end) ?? s;
      if (s <= day && day <= e) return b.start_tz || b.end_tz;
    }
  let best: [string, string] | null = null;
  for (const b of t.bookings)
    if (isJourney(b.type) && b.status !== "cancelled" && b.end && b.end_tz && dayOf(b.end)! <= day && (!best || b.end > best[0])) best = [b.end, b.end_tz];
  if (best) return best[1];
  return t.destinations.find((x) => x.tz)?.tz ?? "";
}

export function destinationOn(t: Trip, day: string) {
  return t.destinations.find((d) => d.start && d.start <= day && day <= (d.end ?? d.start)) ?? null;
}

export function itemInstant(t: Trip, day: string, item: PlanItem): number | null {
  return item.time ? toInstant(`${day}T${item.time}`, dayZone(t, day) || null) : null;
}

/** All the dates to show: the trip's, plus any planned day outside it. */
export function tripDates(t: Trip): string[] {
  const set = new Set(dateRange(t.start, t.end));
  for (const d of t.days) if (d.items.length || d.title) set.add(d.date);
  return [...set].sort();
}

export type Row =
  | { kind: "item"; item: PlanItem }
  | { kind: "event"; event: BookingEvent };

export function dayRows(t: Trip, day: string, events: BookingEvent[]): Row[] {
  const entry: TripDay | undefined = t.days.find((d) => d.date === day);
  const items = entry?.items ?? [];
  const linked = new Set(items.map((i) => i.booking_id).filter(Boolean));
  const pending = events.filter((e) => e.date === day && !linked.has(e.booking.id));
  const rows: Row[] = [];
  for (const it of items) {
    if (it.time) while (pending.length && pending[0].time && pending[0].time <= it.time) rows.push({ kind: "event", event: pending.shift()! });
    rows.push({ kind: "item", item: it });
  }
  for (const e of pending) rows.push({ kind: "event", event: e });
  return rows;
}

/* --------------------------------------------------------------- phase */

export type Phase =
  | { phase: "undated" }
  | { phase: "before"; days: number }
  | { phase: "during"; day: number; of: number }
  | { phase: "after"; days: number };

export function phaseOf(t: Trip, today: string): Phase {
  if (!t.start) return { phase: "undated" };
  const end = t.end ?? t.start;
  if (today < t.start) return { phase: "before", days: dayDiff(today, t.start) };
  if (today > end) return { phase: "after", days: dayDiff(end, today) };
  return { phase: "during", day: dayDiff(t.start, today) + 1, of: dayDiff(t.start, end) + 1 };
}

export interface NextUp {
  at: number;
  title: string;
  sub: string;
  day: string;
  time: string;
  tz: string;
  booking?: Booking;
  item?: PlanItem;
}

export function nextUp(t: Trip, now: number, limit = 3): NextUp[] {
  const out: NextUp[] = [];
  for (const e of bookingEvents(t)) {
    if (e.at !== null && e.at >= now)
      out.push({
        at: e.at, title: `${e.word}: ${bookingLabel(e.booking)}`, day: e.date, time: e.time, booking: e.booking,
        tz: e.edge === "start" ? e.booking.start_tz : e.booking.end_tz || e.booking.start_tz,
        sub: [e.edge === "start" ? e.booking.from_place || e.booking.address : e.booking.to_place, e.booking.confirmation && `Ref ${e.booking.confirmation}`]
          .filter(Boolean)
          .join(" · "),
      });
  }
  for (const d of t.days)
    for (const it of d.items) {
      const at = itemInstant(t, d.date, it);
      if (at !== null && at >= now && it.status !== "done")
        out.push({ at, title: it.title, sub: [it.place, it.area].filter(Boolean).join(" · "), day: d.date, time: it.time ?? "", tz: dayZone(t, d.date), item: it });
    }
  return out.sort((a, b) => a.at - b.at).slice(0, limit);
}

/* ----------------------------------------------------- nights & checks */

export function nightsWithoutStay(t: Trip): string[] {
  const nights = dateRange(t.start, t.end).slice(0, -1);
  const covered = new Set<string>();
  for (const b of t.bookings) {
    if (b.status === "cancelled" || !b.start) continue;
    const s = dayOf(b.start)!;
    const e = dayOf(b.end) ?? s;
    if (b.type === "stay") dateRange(s, e).slice(0, -1).forEach((d) => covered.add(d));
    else if ((isJourney(b.type) || b.type === "other" || b.type === "tour") && e > s) dateRange(s, e).slice(0, -1).forEach((d) => covered.add(d));
  }
  for (const d of t.days) if (d.items.some((i) => i.type === "stay")) covered.add(d.date);
  return nights.filter((n) => !covered.has(n));
}

export function stayFor(t: Trip, night: string): Booking | null {
  return (
    t.bookings.find((b) => b.type === "stay" && b.status !== "cancelled" && b.start && dayOf(b.start)! <= night && night < (dayOf(b.end) ?? dayOf(b.start)!)) ??
    null
  );
}

export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export function packingProgress(t: Trip, travellerId?: string | null) {
  const items = travellerId === undefined ? t.packing : t.packing.filter((i) => i.traveller_id === travellerId);
  const done = items.filter((i) => i.checked).length;
  return { done, total: items.length, ratio: items.length ? done / items.length : 0 };
}

export function mapsUrl(q: { lat?: number | null; lng?: number | null; place?: string; address?: string; title?: string }): string | null {
  if (q.lat !== null && q.lat !== undefined && q.lng !== null && q.lng !== undefined)
    return `https://www.google.com/maps/search/?api=1&query=${q.lat},${q.lng}`;
  const text = [q.place || q.title, q.address].filter(Boolean).join(", ");
  return text ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}` : null;
}
