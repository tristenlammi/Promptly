/*
 * Budget arithmetic for the UI — the same rules as the backend's logic.py
 * (payday months, rollover, "to be budgeted", transfers never count), so
 * what's on screen matches what the assistant quotes.
 */
import { addDays, daysBetween, parseDay, todayISO } from "@/items/ui";

import type { BudgetData, Cadence, Category, Subscription, Txn } from "./types";

// ------------------------------------------------------------------ money

const fmtCache = new Map<string, Intl.NumberFormat>();

export function money(cents: number, currency = "AUD", opts: { sign?: boolean; whole?: boolean } = {}): string {
  const key = `${currency}|${opts.whole ? 0 : 2}`;
  let f = fmtCache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        // "$1,234" rather than "A$1,234": a budget is in one currency, so the
        // short symbol is unambiguous (and what every banking app shows).
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: opts.whole ? 0 : 2,
        maximumFractionDigits: opts.whole ? 0 : 2,
      });
    } catch {
      f = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    fmtCache.set(key, f);
  }
  const s = f.format(Math.abs(cents) / 100);
  if (cents < 0) return `−${s}`;
  return opts.sign && cents > 0 ? `+${s}` : s;
}

/** "$" for AUD/USD, "€", "£"… — the short symbol the amounts are shown with. */
export function currencySymbol(currency = "AUD"): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency")?.value ?? "$";
  } catch {
    return "$";
  }
}

/** "12.50" / "-12.5" / "$1,234" → cents (NaN when it isn't a number). */
export function parseMoney(input: string): number {
  let s = input.trim().replace(/[$,\s]/g, "").replace(/^AUD/i, "");
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("−")) s = "-" + s.slice(1);
  if (s.endsWith("-")) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  if (s.toUpperCase().endsWith("CR")) s = s.slice(0, -2);
  else if (s.toUpperCase().endsWith("DR")) {
    neg = !neg;
    s = s.slice(0, -2);
  }
  const v = Number(s);
  if (!Number.isFinite(v) || s === "") return NaN;
  return Math.round((neg ? -v : v) * 100);
}

// ----------------------------------------------------------------- months

const pad = (n: number) => String(n).padStart(2, "0");
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();

export function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

export function monthOf(day: string, startDay = 1): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  const month = `${y}-${pad(m)}`;
  return d < startDay ? addMonths(month, -1) : month;
}

export function monthRange(month: string, startDay = 1): [string, string] {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const start = `${month}-${pad(Math.min(startDay, daysIn(y, m)))}`;
  const nxt = addMonths(month, 1);
  const ny = Number(nxt.slice(0, 4));
  const nm = Number(nxt.slice(5, 7));
  const end = addDays(`${nxt}-${pad(Math.min(startDay, daysIn(ny, nm)))}`, -1);
  return [start, end];
}

const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const shortFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

export function monthLabel(month: string, startDay = 1, withDates = false): string {
  const name = monthFmt.format(parseDay(`${month}-01`));
  if (startDay === 1 || !withDates) return name;
  const [a, b] = monthRange(month, startDay);
  return `${name} · ${shortFmt.format(parseDay(a))} – ${shortFmt.format(parseDay(b))}`;
}

/** The first full budget month from ``today`` (logic.py ``default_budget_start``). */
export function defaultBudgetStart(today: string, startDay = 1): string {
  const m = monthOf(today, startDay);
  return monthRange(m, startDay)[0] === today ? m : addMonths(m, 1);
}

export function currentMonth(data: BudgetData, today = todayISO()): string {
  return monthOf(today, data.settings.month_start_day || 1);
}

// ------------------------------------------------------------ transactions

export function txnLines(t: Txn): [string | null, number][] {
  if (t.splits?.length) return t.splits.map((s) => [s.category_id, s.amount_cents]);
  return [[t.category_id, t.amount_cents]];
}

/** Accounts outside the budget: off-budget (a home loan, investments) or archived. */
export function excludedAccounts(data: BudgetData): Set<string> {
  return new Set(data.accounts.filter((a) => a.archived || a.on_budget === false).map((a) => a.id));
}

/** Real spending / income: not a transfer, not on an excluded account (logic.py ``counts``). */
export const counts = (t: Txn, off?: Set<string>) => !t.transfer && !(off && t.account_id && off.has(t.account_id));

export function catIndex(data: BudgetData): Map<string, Category> {
  return new Map(data.categories.map((c) => [c.id, c]));
}

export function isIncomeLine(cats: Map<string, Category>, cid: string | null, cents: number): boolean {
  const c = cid ? cats.get(cid) : undefined;
  return c ? c.kind === "income" : cents > 0;
}

export interface BudgetRow {
  id: string;
  name: string;
  emoji: string;
  group_id: string;
  assigned: number;
  spent: number;
  carried: number;
  available: number;
  rollover: boolean;
  hidden: boolean;
}

export interface BudgetTable {
  month: string;
  rows: BudgetRow[];
  assigned: number;
  spent: number;
  uncategorisedSpent: number;
  income: number;
  available: number;
  toBeBudgeted: number;
  /** Before the budget start (or the archived history): shown on its own. */
  beforeStart: boolean;
  budgetStart: string | null;
  overspent: BudgetRow[];
}

/** Same rule as logic.py ``is_overspent``. */
export const isOverspent = (r: Pick<BudgetRow, "available" | "assigned" | "carried">) => r.available < 0 && (r.assigned > 0 || r.carried !== 0);

/** Per category for ``month``: assigned, spent, rollover in, available — the
 *  envelope maths of logic.py ``budget_table``: counted from the budget start
 *  (or the archive carry-in); rollover categories carry their balance, the
 *  others hand theirs back to "to be budgeted" at month end; uncategorised
 *  spending comes out of "to be budgeted". */
export function budgetTable(data: BudgetData, month: string): BudgetTable {
  const sd = data.settings.month_start_day || 1;
  const cats = catIndex(data);
  const off = excludedAccounts(data);
  const act = new Map<string, Map<string | null, number>>();
  const income = new Map<string, number>();
  const uncatOut = new Map<string, number>();
  let firstDay: string | null = null;
  for (const t of data.transactions) {
    if (!firstDay || t.date < firstDay) firstDay = t.date;
    if (!counts(t, off)) continue;
    const m = monthOf(t.date, sd);
    let row = act.get(m);
    if (!row) act.set(m, (row = new Map()));
    for (const [cid, cents] of txnLines(t)) {
      const c = cid ? cats.get(cid) : undefined;
      const key = c ? cid : null;
      row.set(key, (row.get(key) ?? 0) + cents);
      if (isIncomeLine(cats, c ? cid : null, cents)) income.set(m, (income.get(m) ?? 0) + cents);
      else if (!c) uncatOut.set(m, (uncatOut.get(m) ?? 0) - cents);
    }
  }
  const assignedBy = new Map(data.months.map((m) => [m.month, m.assigned]));
  const bs = data.settings.budget_start ?? null;
  const ci = data.carry_in ?? null;
  const standalone = !!((bs && month < bs) || (ci && month < ci.month));
  const expense = data.categories.filter((c) => c.kind === "expense");
  const carry = new Map<string, number>(expense.map((c) => [c.id, 0]));
  let tbb = 0;
  let start = month;
  if (!standalone) {
    if (bs) start = bs;
    else {
      const months = data.months.map((m) => m.month);
      if (firstDay) months.push(monthOf(firstDay, sd));
      start = months.length ? months.reduce((a, b) => (a < b ? a : b)) : month;
      const floor = addMonths(month, -35);
      if (start < floor) start = floor;
    }
    if (ci && ci.month >= start) {
      start = ci.month;
      tbb = ci.to_be_budgeted ?? 0;
      for (const [k, v] of Object.entries(ci.available ?? {})) if (carry.has(k)) carry.set(k, v);
    }
    const cap = addMonths(month, -120);
    if (start < cap) start = cap;
    if (start > month) start = month;
  }
  let rows: BudgetRow[] = [];
  for (let m = start; ; m = addMonths(m, 1)) {
    tbb += (income.get(m) ?? 0) - (uncatOut.get(m) ?? 0);
    const over = assignedBy.get(m) ?? {};
    const a = act.get(m);
    rows = expense.map((c) => {
      const assigned = c.id in over ? over[c.id] : c.budget_cents;
      const spent = -(a?.get(c.id) ?? 0);
      const carried = c.rollover ? carry.get(c.id) ?? 0 : 0;
      const available = carried + assigned - spent;
      tbb -= assigned;
      carry.set(c.id, available);
      return { id: c.id, name: c.name, emoji: c.emoji, group_id: c.group_id, assigned, spent, carried, available, rollover: c.rollover, hidden: c.hidden };
    });
    if (m >= month) break;
    for (const r of rows) if (!r.rollover) tbb += r.available;
  }
  const uncategorisedSpent = uncatOut.get(month) ?? 0;
  const assigned = rows.reduce((n, r) => n + r.assigned, 0);
  return {
    month,
    rows,
    assigned,
    spent: rows.reduce((n, r) => n + r.spent, 0) + uncategorisedSpent,
    uncategorisedSpent,
    income: income.get(month) ?? 0,
    available: rows.reduce((n, r) => n + r.available, 0),
    toBeBudgeted: standalone ? 0 : tbb,
    beforeStart: standalone,
    budgetStart: bs,
    overspent: rows.filter(isOverspent),
  };
}

export function assignedFor(data: BudgetData, month: string, c: Category): number {
  const m = data.months.find((x) => x.month === month);
  return m && c.id in m.assigned ? m.assigned[c.id] : c.budget_cents;
}

/** Money in / out per budget month, last ``n`` months ending with ``month``. */
export function cashflowMonths(data: BudgetData, month: string, n: number) {
  const sd = data.settings.month_start_day || 1;
  const cats = catIndex(data);
  const off = excludedAccounts(data);
  const first = addMonths(month, -(n - 1));
  const out = new Map<string, { month: string; in: number; out: number }>();
  for (let i = 0; i < n; i++) {
    const m = addMonths(first, i);
    out.set(m, { month: m, in: 0, out: 0 });
  }
  for (const t of data.transactions) {
    if (!counts(t, off)) continue;
    const p = out.get(monthOf(t.date, sd));
    if (!p) continue;
    for (const [cid, cents] of txnLines(t)) {
      if (isIncomeLine(cats, cid, cents)) p.in += cents;
      else p.out += -cents;
    }
  }
  return [...out.values()];
}

export function spendingByCategory(data: BudgetData, start: string, end: string) {
  const cats = catIndex(data);
  const off = excludedAccounts(data);
  const by = new Map<string, number>();
  let total = 0;
  for (const t of data.transactions) {
    if (!counts(t, off) || t.date < start || t.date > end) continue;
    for (const [cid, cents] of txnLines(t)) {
      if (isIncomeLine(cats, cid, cents)) continue;
      by.set(cid ?? "_none", (by.get(cid ?? "_none") ?? 0) - cents);
      total -= cents;
    }
  }
  return {
    total,
    rows: [...by.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id, v]) => ({ id, name: cats.get(id)?.name ?? "Uncategorised", emoji: cats.get(id)?.emoji ?? "❔", spent: v })),
  };
}

// ---------------------------------------------------------- subscriptions

export const effectiveStatus = (s: Subscription) => s.user_status ?? s.status;
export const isLive = (s: Subscription) => ["active", "confirmed"].includes(effectiveStatus(s));

export function nextDue(day: string, cadence: Cadence): string {
  const d = parseDay(day);
  if (cadence === "weekly") return addDays(day, 7);
  if (cadence === "fortnightly") return addDays(day, 14);
  const months = cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
  const y = d.getFullYear();
  const idx = y * 12 + d.getMonth() + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d.getDate(), daysIn(ny, nm)))}`;
}

/** Charges due from tomorrow through ``days`` ahead. */
export function upcoming(data: BudgetData, days = 14, today = todayISO()) {
  const end = addDays(today, days);
  const out: { sub: Subscription; date: string }[] = [];
  for (const s of data.subscriptions) {
    if (!isLive(s) || !s.next_due) continue;
    let d = s.next_due;
    let guard = 0;
    while (d < today && guard++ < 60) d = nextDue(d, s.cadence);
    while (d <= end && guard++ < 60) {
      out.push({ sub: s, date: d });
      d = nextDue(d, s.cadence);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export const CADENCE_LABEL: Record<Cadence, string> = {
  weekly: "Weekly",
  fortnightly: "Fortnightly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};
export const PER_MONTH: Record<Cadence, number> = { weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };

// ------------------------------------------------------------------ misc

export function goalProgress(data: BudgetData, goalAccount: string | null, saved: number): number {
  if (goalAccount) {
    const a = data.accounts.find((x) => x.id === goalAccount);
    if (a) return Math.max(0, a.balance_cents);
  }
  return saved;
}

export function daysUntil(day: string, today = todayISO()): number {
  return daysBetween(today, day);
}

/** Next payday on or after today, from the setting (rolled forward by the pay cycle). */
export function nextPayday(data: BudgetData, today = todayISO()): string | null {
  const s = data.settings;
  if (!s.next_payday) return null;
  let d = s.next_payday;
  const step = s.pay_frequency === "weekly" ? 7 : s.pay_frequency === "fortnightly" ? 14 : 0;
  let guard = 0;
  while (d < today && guard++ < 400) {
    if (step) d = addDays(d, step);
    else if (s.pay_frequency === "monthly") d = nextDue(d, "monthly");
    else return null;
  }
  return d;
}

export function merchantKey(payee: string): string {
  return (payee || "")
    .toLowerCase()
    .replace(/\.com/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/\d/.test(w))
    .slice(0, 3)
    .join(" ");
}

export const ACCOUNT_LABEL: Record<string, string> = {
  transactional: "Everyday",
  saver: "Saver",
  credit: "Credit card",
  home_loan: "Home loan",
  loan: "Loan",
  cash: "Cash",
  investment: "Investment",
  other: "Other",
};
