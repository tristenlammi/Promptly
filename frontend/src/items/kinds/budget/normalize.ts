/*
 * The server stores transactions slim — fields still at their default are
 * left out (models.py ``slim_txn``), which keeps years of bank history in one
 * file. Views read the full shape: ``normalizeData`` fills the defaults back
 * in (cached per raw object, so unchanged data isn't rebuilt).
 *
 * Mutators (``item.update``) still get the raw draft — write the fields you
 * change and read others with ``?? default``; never copy a normalized
 * object into the draft (that would send every default back as a change).
 */
import type { BudgetData, Settings, Txn, UpSync } from "./types";

export const TXN_DEFAULTS: Omit<Txn, "id" | "date" | "amount_cents"> = {
  payee: "",
  description: "",
  category_id: null,
  category_by: "auto",
  payee_by: "auto",
  account_id: null,
  notes: "",
  tags: [],
  splits: [],
  pending: false,
  transfer: false,
  transfer_account_id: null,
  source: "manual",
  external_id: null,
  created_at: null,
  settled_at: null,
  foreign: null,
  round_up_cents: 0,
  cashback_cents: 0,
  bank_category: null,
  transfer_by: "auto",
  review: "",
};

const UP_DEFAULTS: UpSync = {
  connected: false,
  status: "off",
  last_sync_at: null,
  last_error: "",
  webhook: false,
  added_last_sync: 0,
  archived_before: null,
};

const txnCache = new WeakMap<object, Txn>();

export function normalizeTxn(t: Partial<Txn> & Pick<Txn, "id" | "date" | "amount_cents">): Txn {
  const hit = txnCache.get(t);
  if (hit) return hit;
  const full = { ...TXN_DEFAULTS, ...t, tags: t.tags ?? [], splits: t.splits ?? [] } as Txn;
  txnCache.set(t, full);
  return full;
}

const dataCache = new WeakMap<object, BudgetData>();

export function normalizeData(raw: BudgetData): BudgetData {
  const hit = dataCache.get(raw);
  if (hit) return hit;
  const out: BudgetData = {
    ...raw,
    settings: { ...(raw.settings ?? ({} as Settings)), budget_start: raw.settings?.budget_start ?? null },
    accounts: raw.accounts ?? [],
    transactions: (raw.transactions ?? []).map((t) => normalizeTxn(t)),
    groups: raw.groups ?? [],
    categories: raw.categories ?? [],
    months: raw.months ?? [],
    rules: raw.rules ?? [],
    goals: raw.goals ?? [],
    subscriptions: raw.subscriptions ?? [],
    up: { ...UP_DEFAULTS, ...(raw.up ?? {}) },
    carry_in: raw.carry_in ?? null,
  };
  dataCache.set(raw, out);
  return out;
}
