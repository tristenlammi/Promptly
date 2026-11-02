/* The shape of a .budget file (backend: app/items/kinds/budget/models.py).
 * Money is integer cents; a transaction's amount is negative for money out.
 *
 * The server stores transactions **slim** (fields at their default are left
 * out). Views get them filled in (``normalize.ts``, via ``withBudget`` in
 * index.tsx), so ``Txn`` here is the full shape. Inside ``item.update``
 * mutators the draft is the raw, slim data — read with ``?? default``. */

export type AccountType = "transactional" | "saver" | "credit" | "home_loan" | "loan" | "cash" | "investment" | "other";
export type Source = "manual" | "up" | "csv";
export type Cadence = "weekly" | "fortnightly" | "monthly" | "quarterly" | "yearly";
export type SetBy = "auto" | "rule" | "user";

export interface Split {
  category_id: string | null;
  amount_cents: number;
  note: string;
}

export interface Txn {
  id: string;
  date: string;
  amount_cents: number;
  payee: string;
  description: string;
  category_id: string | null;
  category_by: SetBy;
  payee_by: SetBy;
  account_id: string | null;
  notes: string;
  tags: string[];
  splits: Split[];
  pending: boolean;
  transfer: boolean;
  transfer_account_id: string | null;
  source: Source;
  external_id: string | null;
  created_at: string | null;
  settled_at: string | null;
  foreign: { amount_cents: number; currency: string } | null;
  round_up_cents: number;
  cashback_cents: number;
  bank_category: string | null;
  transfer_by: SetBy;
  /** Why it needs a look (a bank amount change under a split); "" = fine. */
  review: string;
  /** The trip it was spent on ("<trip file id>:<trip id>"), for the trip's "Spent so far". */
  trip_ref?: string | null;
}

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  balance_cents: number;
  source: Source;
  external_id: string | null;
  on_budget: boolean;
  archived: boolean;
  balance_at: string | null;
  ownership: "individual" | "joint";
  renamed: boolean;
}

export interface Group {
  id: string;
  name: string;
  hidden: boolean;
}

export interface Category {
  id: string;
  group_id: string;
  name: string;
  kind: "expense" | "income";
  emoji: string;
  budget_cents: number;
  rollover: boolean;
  hidden: boolean;
  bucket: "needs" | "wants" | "savings" | "none";
}

export interface BudgetMonth {
  month: string;
  assigned: Record<string, number>;
  note: string;
}

export interface Rule {
  id: string;
  field: "payee" | "description" | "any";
  match: "contains" | "equals" | "starts" | "regex";
  pattern: string;
  category_id: string | null;
  rename_to: string | null;
  add_tags: string[];
  mark_transfer: boolean;
  enabled: boolean;
  created_at: string | null;
}

export interface Goal {
  id: string;
  name: string;
  target_cents: number;
  target_date: string | null;
  account_id: string | null;
  saved_cents: number;
  category_id: string | null;
  emoji: string;
  created: string | null;
  done: boolean;
}

export interface Subscription {
  id: string;
  name: string;
  merchant: string;
  kind: "subscription" | "bill";
  cadence: Cadence;
  amount_cents: number;
  variable: boolean;
  monthly_cents: number;
  last_date: string | null;
  next_due: string | null;
  occurrences: number;
  confidence: number;
  status: "active" | "maybe_cancelled";
  user_status: "confirmed" | "ignored" | "cancelled" | null;
  cancelled_on: string | null;
  charged_after_cancel: boolean;
  price_change: { from_cents: number; to_cents: number; on: string } | null;
  category_id: string | null;
  account_id: string | null;
  transaction_ids: string[];
  source: "detected" | "manual";
  remind: boolean;
  renamed: boolean;
}

export interface UpSync {
  connected: boolean;
  status: "off" | "ok" | "error" | "disconnected" | "full";
  /** Legacy — sync times come from the status endpoint now. */
  last_sync_at: string | null;
  last_error: string;
  webhook: boolean;
  added_last_sync: number;
  archived_before: string | null;
}

export interface CarryIn {
  month: string;
  available: Record<string, number>;
  to_be_budgeted: number;
}

export interface Settings {
  currency: string;
  month_start_day: number;
  style: "simple" | "envelope";
  zero_based: boolean;
  pay_frequency: "weekly" | "fortnightly" | "monthly" | "irregular";
  next_payday: string | null;
  bill_reminders: boolean;
  overspend_alerts: boolean;
  up_category_map: Record<string, string>;
  up_history_days: number;
  /** First budget month (YYYY-MM): rollover and "to be budgeted" count from here. */
  budget_start: string | null;
  onboarded: boolean;
}

export interface BudgetData {
  settings: Settings;
  accounts: Account[];
  transactions: Txn[];
  groups: Group[];
  categories: Category[];
  months: BudgetMonth[];
  rules: Rule[];
  goals: Goal[];
  subscriptions: Subscription[];
  up: UpSync;
  carry_in: CarryIn | null;
}
