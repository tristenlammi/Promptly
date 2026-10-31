/* Whole-trip edits that must keep every amount and reference intact
 * (mirrors backend logic.py: ``rebase_home``, ``remove_traveller``,
 * ``claim_me``), plus the "assign only what changed" helper every sheet
 * save uses. All of these run inside ``item.update`` mutators on the
 * draft — they read current state from it, never from a snapshot. */

import { exponent, rateFor } from "./logic";
import type { Trip } from "./types";

const conv = (minor: number, from: string, to: string, pivot: number) =>
  Math.round((minor / 10 ** exponent(from)) * pivot * 10 ** exponent(to));

/** Is there anything priced on the trip a home-currency change must convert? */
function hasMoney(t: Trip): boolean {
  return !!(
    t.currencies.length ||
    t.expenses.length ||
    t.settlements.length ||
    t.budget.total_minor !== null ||
    t.budget.lines.length ||
    t.bookings.some((b) => b.cost_minor) ||
    t.ideas.some((i) => i.cost_minor) ||
    t.days.some((d) => d.items.some((i) => i.cost_minor))
  );
}

/** Why the home currency can't change to ``next`` right now, or null. */
export function rebaseProblem(t: Trip, next: string): string | null {
  const old = t.settings.home_currency;
  if (next === old || !hasMoney(t) || rateFor(t, next)) return null;
  return `There's no exchange rate for ${next} yet, so the ${old} amounts can't be converted. Add a rate for ${next} (Money → Exchange rates), then change the home currency.`;
}

/** Make ``next`` the home currency, keeping every amount's value. Returns a
 *  refusal (nothing changed) when there's no rate for it. */
export function rebaseHome(x: Trip, next: string, today: string): string | null {
  const old = x.settings.home_currency;
  if (next === old) return null;
  const problem = rebaseProblem(x, next);
  if (problem) return problem;
  if (!hasMoney(x)) {
    x.settings.home_currency = next;
    return null;
  }
  const pivot = rateFor(x, next)!; // units of next per 1 old
  const r8 = (v: number) => Math.round(v * 1e8) / 1e8;
  const rates = [{ code: old, per_home: r8(1 / pivot), updated: today }, ...x.currencies.filter((r) => r.code !== next).map((r) => ({ ...r, per_home: r8(r.per_home / pivot) }))];
  for (const e of x.expenses) {
    if (e.currency === next) e.per_home = null;
    else if (e.currency === old) e.per_home = r8(1 / pivot);
    else {
      const r = e.per_home || rateFor(x, e.currency);
      e.per_home = r ? r8(r / pivot) : null;
    }
  }
  for (const s of x.settlements) s.amount_minor = conv(s.amount_minor, old, next, pivot);
  if (x.budget.total_minor !== null) x.budget.total_minor = conv(x.budget.total_minor, old, next, pivot);
  for (const l of x.budget.lines) l.amount_minor = conv(l.amount_minor, old, next, pivot);
  const priced = [...x.bookings, ...x.ideas, ...x.days.flatMap((d) => d.items)];
  for (const p of priced) {
    if (p.cost_minor !== null && !p.currency) p.currency = old;
    if (p.currency === next) p.currency = null;
  }
  x.currencies = rates.slice(0, 24);
  x.settings.home_currency = next;
  return null;
}

/** Take traveller ``id`` off the trip; their expenses / repayments move to
 *  ``to`` (required when they have any — check ``travellerRefs`` first). */
export function removeTraveller(x: Trip, id: string, to: string | null) {
  if (to) {
    for (const e of x.expenses) {
      if (e.paid_by === id) e.paid_by = to;
      const out: typeof e.shares = [];
      for (const raw of e.shares) {
        const sh = raw.traveller_id === id ? { ...raw, traveller_id: to } : raw;
        const prev = out.find((o) => o.traveller_id === sh.traveller_id);
        if (!prev) out.push(sh);
        else {
          if (prev.amount_minor !== null || sh.amount_minor !== null) prev.amount_minor = (prev.amount_minor ?? 0) + (sh.amount_minor ?? 0);
          if (prev.weight !== null || sh.weight !== null) prev.weight = Math.min(1000, (prev.weight ?? 0) + (sh.weight ?? 0));
        }
      }
      e.shares = out;
    }
    for (const s of x.settlements) {
      if (s.from_id === id) s.from_id = to;
      if (s.to_id === id) s.to_id = to;
    }
    x.settlements = x.settlements.filter((s) => s.from_id !== s.to_id);
  } else {
    for (const e of x.expenses) {
      if (e.paid_by === id) e.paid_by = null;
      e.shares = e.shares.filter((s) => s.traveller_id !== id);
    }
    x.settlements = x.settlements.filter((s) => s.from_id !== id && s.to_id !== id);
  }
  for (const p of x.packing) if (p.traveller_id === id) p.traveller_id = null;
  for (const d of x.documents) if (d.traveller_id === id) d.traveller_id = null;
  for (const b of x.bookings) b.traveller_ids = b.traveller_ids.filter((t) => t !== id);
  x.me_by_user ??= {};
  for (const [k, v] of Object.entries(x.me_by_user)) if (v === id) delete x.me_by_user[k];
  x.travellers = x.travellers.filter((t) => t.id !== id);
}

/** "This is me": ``userId`` is traveller ``id`` (one traveller per user). */
export function claimMe(x: Trip, userId: string, id: string) {
  x.me_by_user ??= {};
  for (const [k, v] of Object.entries(x.me_by_user)) if (v === id || k === userId) delete x.me_by_user[k];
  for (const t of x.travellers) {
    if (t.user_id === userId && t.id !== id) t.user_id = "";
    if (t.id === id) t.user_id = userId;
  }
  x.me_by_user[userId] = id;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Copy onto ``target`` only the fields that differ between what the sheet
 *  opened with (``before``) and what it's saving (``after``) — so a save
 *  never overwrites someone else's newer change to a field you didn't touch. */
export function assignChanged<T extends object>(target: T, before: Partial<T>, after: Partial<T>): void {
  for (const k of Object.keys(after) as (keyof T)[]) {
    if (!same(before[k], after[k])) target[k] = structuredClone(after[k]) as T[keyof T];
  }
}
