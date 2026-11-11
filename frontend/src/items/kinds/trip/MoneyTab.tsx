import { ArrowRight, ArrowRightLeft, Coins, HandCoins, PiggyBank, Plus, Receipt, Sparkles, Trash2, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { TWO_COL, useTripWidth } from "./layout";
import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import { Avatar, Card, Chip, EmptyState, Fab, Field, IconButton, ItemButton, List, ListRow, Page, ProgressBar, Section, Segmented, Select, Sheet, Stat, StatGrid, TextInput, Toggle, todayISO, uid } from "@/items/ui";
import { cn } from "@/utils/cn";

import { onAddExpense, takeAddExpense } from "./bus";
import { BudgetSpentCard } from "./CrossApp";
import { budget, expenseSplit, lockedRate, meId, money, phaseOf, settleUp, toHome, toMajor, toMinor } from "./logic";
import { assignChanged, claimMe } from "./ops";
import { homeHint } from "./PlanItemSheet";
import type { Category, Expense, SplitMode, Trip } from "./types";
import { CATEGORIES, CATEGORY_LABEL } from "./types";
import { dateRange, fmtDate } from "./tz";
import { ConfirmDelete, CurrencySelect, FieldRow, parseAmount, useUserId } from "./ui";

/* ---------------------------------------------------------- expense sheet */

interface Draft {
  id: string;
  title: string;
  amount: string;
  currency: string;
  date: string;
  category: Category;
  paid_by: string | null;
  split: SplitMode;
  people: string[];
  exact: Record<string, string>;
  weights: Record<string, string>;
  booking_id: string | null;
  notes: string;
  /** The rate the expense was logged at (kept when editing). */
  per_home: number | null;
}

function lastCurrency(t: Trip): string {
  return t.expenses[t.expenses.length - 1]?.currency ?? (phaseOf(t, todayISO()).phase === "during" && t.currencies[0] ? t.currencies[0].code : t.settings.home_currency);
}

function draftOf(t: Trip, e: Expense | null, me: string | null): Draft {
  if (!e) {
    const today = todayISO();
    const payer = me ?? (t.travellers.length === 1 ? t.travellers[0].id : null);
    return {
      id: uid("x-"), title: "", amount: "", currency: lastCurrency(t), date: today, category: "food", paid_by: payer, split: "equal",
      people: t.travellers.map((x) => x.id), exact: {}, weights: {}, booking_id: null, notes: "", per_home: null,
    };
  }
  const shareIds = e.shares.map((s) => s.traveller_id);
  return {
    id: e.id, title: e.title, amount: String(toMajor(e.amount_minor, e.currency)), currency: e.currency, date: e.date, category: e.category,
    paid_by: e.paid_by, split: e.split, people: shareIds.length ? shareIds : t.travellers.map((x) => x.id),
    exact: Object.fromEntries(e.shares.map((s) => [s.traveller_id, s.amount_minor !== null ? String(toMajor(s.amount_minor, e.currency)) : ""])),
    weights: Object.fromEntries(e.shares.map((s) => [s.traveller_id, s.weight !== null ? String(s.weight) : "1"])),
    booking_id: e.booking_id, notes: e.notes, per_home: e.per_home,
  };
}

/** ``original`` = the expense being edited (its locked rate is kept unless
 *  the currency changes; a new expense locks today's trip rate). */
function toExpense(t: Trip, d: Draft, original: Expense | null): Expense | string {
  const amount = parseAmount(d.amount);
  if (amount === null || amount < 0) return "Enter an amount.";
  if (t.travellers.length > 1 && !d.paid_by) return "Pick who paid.";
  const minor = toMinor(amount, d.currency);
  const all = t.travellers.map((x) => x.id);
  let shares: Expense["shares"] = [];
  if (d.split === "equal") {
    const people = d.people.filter((p) => all.includes(p));
    if (!people.length && all.length) return "Pick who shares it.";
    shares = people.length === all.length ? [] : people.map((p) => ({ traveller_id: p, amount_minor: null, weight: null }));
  } else if (d.split === "exact") {
    shares = all
      .filter((p) => (parseAmount(d.exact[p] ?? "") ?? 0) > 0)
      .map((p) => ({ traveller_id: p, amount_minor: toMinor(parseAmount(d.exact[p])!, d.currency), weight: null }));
    const sum = shares.reduce((a, s) => a + (s.amount_minor ?? 0), 0);
    if (Math.abs(sum - minor) > shares.length) return `The parts add up to ${money(sum, d.currency)}, not ${money(minor, d.currency)}.`;
  } else {
    shares = all
      .map((p) => ({ traveller_id: p, amount_minor: null, weight: parseAmount(d.weights[p] ?? "1") ?? 0 }))
      .filter((s) => (s.weight ?? 0) > 0);
    if (!shares.length) return "Give someone a share.";
  }
  return {
    id: d.id, date: d.date || todayISO(), title: d.title.trim() || CATEGORY_LABEL[d.category], amount_minor: minor, currency: d.currency,
    category: d.category, paid_by: d.paid_by, split: d.split, shares,
    per_home: original && original.currency === d.currency ? d.per_home : lockedRate(t, d.currency),
    booking_id: d.booking_id, notes: d.notes,
  };
}

export function ExpenseSheet({ item, open, expense, onClose }: { item: ItemHandle<Trip>; open: boolean; expense: Expense | null; onClose: () => void }) {
  const t = item.data;
  const me = meId(t, useUserId());
  const [d, setD] = useState<Draft>(() => draftOf(t, expense, me));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setD(draftOf(item.data, expense, me));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const amount = parseAmount(d.amount);
  const preview = useMemo(() => {
    const e = toExpense(t, d, expense);
    return typeof e === "string" ? null : expenseSplit(t, e);
  }, [t, d, expense]);
  const save = () => {
    const e = toExpense(t, d, expense);
    if (typeof e === "string") return setError(e);
    // Editing: only the fields changed in this sheet (someone else may have
    // edited the rest meanwhile).
    const before = expense ? toExpense(t, draftOf(t, expense, me), expense) : null;
    item.update((x) => {
      const cur = x.expenses.find((z) => z.id === e.id);
      if (cur) {
        if (before && typeof before !== "string") assignChanged(cur, before, e);
        else Object.assign(cur, e); // the old one didn't validate (no payer): take the whole fixed expense
      } else if (!expense && x.expenses.length < 3000) x.expenses.push(e);
      x.expenses.sort((a, b) => a.date.localeCompare(b.date));
    });
    onClose();
  };
  const multi = t.travellers.length > 1;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={expense ? "Expense" : "Add expense"}
      footer={
        <>
          {expense && (
            <ConfirmDelete
              question="Delete this expense?"
              onConfirm={() => {
                item.update((x) => {
                  x.expenses = x.expenses.filter((z) => z.id !== expense.id);
                });
                onClose();
              }}
            />
          )}
          <ItemButton variant="primary" block disabled={amount === null} onClick={save}>
            Save
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FieldRow className="grid-cols-[1fr_7rem]">
          <Field label="Amount" hint={homeHint(t, amount, d.currency)}>
            <TextInput autoFocus={!expense} inputMode="decimal" value={d.amount} onChange={(e) => set("amount", e.target.value)} placeholder="0" className="text-lg font-semibold tabular-nums" />
          </Field>
          <Field label="Currency">
            <CurrencySelect trip={t} value={d.currency} onChange={(v) => set("currency", v)} />
          </Field>
        </FieldRow>
        <Field label="What for">
          <TextInput value={d.title} onChange={(e) => set("title", e.target.value)} placeholder="Ramen at Ichiran" />
        </Field>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Category">
          {CATEGORIES.map((c) => (
            <Chip key={c} active={d.category === c} onClick={() => set("category", c)}>
              {CATEGORY_LABEL[c]}
            </Chip>
          ))}
        </div>
        <FieldRow>
          <Field label="Date">
            <TextInput type="date" value={d.date} onChange={(e) => set("date", e.target.value)} />
          </Field>
          {multi && (
            <Field label="Paid by">
              <Select value={d.paid_by ?? ""} onChange={(e) => set("paid_by", e.target.value || null)}>
                {!d.paid_by && <option value="">Choose…</option>}
                {t.travellers.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.id === me ? " (you)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </FieldRow>
        {multi && (
          <Field label="Split">
            <Segmented<SplitMode>
              value={d.split}
              onChange={(v) => set("split", v)}
              options={[
                { value: "equal", label: "Equally" },
                { value: "exact", label: "Exact" },
                { value: "shares", label: "Shares" },
              ]}
            />
          </Field>
        )}
        {multi && (
          <div className="flex flex-col divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)]">
            {t.travellers.map((x) => {
              const on = d.people.includes(x.id);
              return (
                <div key={x.id} className="flex min-h-[52px] items-center gap-3 px-3">
                  <Avatar name={x.name} size={28} />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{x.name}</span>
                  {d.split === "equal" && (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-label={`${x.name} shares this`}
                      onClick={() => set("people", on ? d.people.filter((p) => p !== x.id) : [...d.people, x.id])}
                      className={cn("flex h-7 w-7 items-center justify-center rounded-lg border-2 text-xs font-bold", on ? "border-[var(--item-accent)] bg-[var(--item-accent-fill)] text-white" : "border-[var(--border)]")}
                    >
                      {on ? "✓" : ""}
                    </button>
                  )}
                  {d.split === "exact" && (
                    <TextInput aria-label={`${x.name}'s part`} inputMode="decimal" className="w-28 text-right tabular-nums" value={d.exact[x.id] ?? ""} onChange={(e) => set("exact", { ...d.exact, [x.id]: e.target.value })} placeholder="0" />
                  )}
                  {d.split === "shares" && (
                    <TextInput aria-label={`${x.name}'s shares`} inputMode="decimal" className="w-20 text-right tabular-nums" value={d.weights[x.id] ?? "1"} onChange={(e) => set("weights", { ...d.weights, [x.id]: e.target.value })} />
                  )}
                  <span className="w-24 shrink-0 text-right text-xs tabular-nums text-[var(--text-muted)]">{preview && preview[x.id] !== undefined ? money(preview[x.id], d.currency) : "—"}</span>
                </div>
              );
            })}
          </div>
        )}
        {t.bookings.some((b) => b.cost_minor) && (
          <Field label="Pays for a booking" hint="So the booking isn't counted twice in the budget">
            <Select value={d.booking_id ?? ""} onChange={(e) => set("booking_id", e.target.value || null)}>
              <option value="">—</option>
              {t.bookings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title || [b.provider, b.number, b.from_code && `${b.from_code}→${b.to_code}`].filter(Boolean).join(" ") || b.type}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {expense && expense.currency !== t.settings.home_currency && d.currency === expense.currency && expense.per_home && (
          <p className="text-xs text-[var(--text-muted)]">
            Kept at the rate it was logged at: 1 {t.settings.home_currency} = {expense.per_home.toLocaleString(undefined, { maximumFractionDigits: 6 })} {expense.currency}.
          </p>
        )}
        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      </div>
    </Sheet>
  );
}

/* -------------------------------------------------------------- rates */

function RatesSheet({ item, open, onClose }: { item: ItemHandle<Trip>; open: boolean; onClose: () => void }) {
  const t = item.data;
  const home = t.settings.home_currency;
  const [rows, setRows] = useState<{ code: string; per: string }[]>([]);
  const [opened, setOpened] = useState<Record<string, number>>({});
  const [add, setAdd] = useState("");
  const [revalue, setRevalue] = useState(false);
  useEffect(() => {
    if (open) {
      setRows(t.currencies.map((c) => ({ code: c.code, per: String(c.per_home) })));
      setOpened(Object.fromEntries(t.currencies.map((c) => [c.code, c.per_home])));
      setRevalue(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const needed = useMemo(() => budget(t).missing.filter((c) => !rows.some((r) => r.code === c)), [t, rows]);
  const valid = rows
    .map((r) => ({ code: r.code.toUpperCase(), per: parseAmount(r.per) }))
    .filter((r): r is { code: string; per: number } => /^[A-Z]{3}$/.test(r.code) && r.code !== home && !!r.per && r.per > 0);
  const changed = valid.filter((r) => opened[r.code] !== r.per);
  const logged = t.expenses.filter((e) => changed.some((c) => c.code === e.currency)).length;
  const save = () => {
    const today = todayISO();
    const removed = Object.keys(opened).filter((c) => !valid.some((r) => r.code === c));
    item.update((x) => {
      // Only what changed here: rates someone else added meanwhile stay.
      x.currencies = x.currencies.filter((c) => !removed.includes(c.code));
      for (const r of changed) {
        const row = x.currencies.find((c) => c.code === r.code);
        if (row) Object.assign(row, { per_home: r.per, updated: today });
        else if (x.currencies.length < 24) x.currencies.push({ code: r.code, per_home: r.per, updated: today });
        if (revalue) for (const e of x.expenses) if (e.currency === r.code) e.per_home = r.per;
      }
    });
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Exchange rates"
      footer={
        <ItemButton variant="primary" block onClick={save}>
          Save rates
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--text-muted)]">
          Your own rates — amounts convert to {home} with them. Each expense keeps the rate it was logged at, so a new rate here applies to expenses you log from now on (and to bookings and plans).
        </p>
        {rows.map((r, i) => (
          <div key={r.code} className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-sm tabular-nums text-[var(--text)]">1 {home} =</span>
            <TextInput aria-label={`${r.code} per ${home}`} inputMode="decimal" value={r.per} onChange={(e) => setRows(rows.map((x, n) => (n === i ? { ...x, per: e.target.value } : x)))} className="tabular-nums" />
            <span className="w-12 shrink-0 text-sm font-semibold text-[var(--text)]">{r.code}</span>
            <IconButton label={`Remove ${r.code}`} icon={Trash2} onClick={() => setRows(rows.filter((_, n) => n !== i))} />
          </div>
        ))}
        {needed.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--warning)]">
            Needs a rate:
            {needed.map((c) => (
              <Chip key={c} onClick={() => setRows([...rows, { code: c, per: "" }])}>
                + {c}
              </Chip>
            ))}
          </div>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const c = add.trim().toUpperCase();
            if (/^[A-Z]{3}$/.test(c) && c !== home && !rows.some((r) => r.code === c)) setRows([...rows, { code: c, per: "" }]);
            setAdd("");
          }}
        >
          <TextInput aria-label="Add currency" value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Add currency (JPY)" maxLength={3} className="uppercase" />
          <ItemButton type="submit" icon={<Plus className="h-4 w-4" />}>
            Add
          </ItemButton>
        </form>
        {logged > 0 && (
          <div className="flex items-start justify-between gap-3 rounded-2xl border border-[var(--border)] p-3">
            <span className="text-sm text-[var(--text)]">
              Also re-value the {logged} expense{logged === 1 ? "" : "s"} already logged in {changed.map((c) => c.code).join(", ")}
              <span className="block text-xs text-[var(--text-muted)]">Changes balances, even ones you've already settled.</span>
            </span>
            <Toggle checked={revalue} onChange={setRevalue} label="Re-value logged expenses" />
          </div>
        )}
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------- budget */

function BudgetSheet({ item, open, onClose }: { item: ItemHandle<Trip>; open: boolean; onClose: () => void }) {
  const t = item.data;
  const home = t.settings.home_currency;
  const [total, setTotal] = useState("");
  const [lines, setLines] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<{ total: string; lines: Record<string, string> }>({ total: "", lines: {} });
  useEffect(() => {
    if (!open) return;
    const tot = t.budget.total_minor !== null ? String(toMajor(t.budget.total_minor, home)) : "";
    const ls = Object.fromEntries(t.budget.lines.map((l) => [l.category, String(toMajor(l.amount_minor, home))]));
    setTotal(tot);
    setLines(ls);
    setOpened({ total: tot, lines: ls });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const save = () => {
    const tv = parseAmount(total);
    const newTotal = tv === null ? null : toMinor(Math.max(0, tv), home);
    const edits = CATEGORIES.filter((c) => (lines[c] ?? "") !== (opened.lines[c] ?? "")).map((c) => {
      const v = parseAmount(lines[c] ?? "");
      return { category: c, amount: v === null || v <= 0 ? null : toMinor(v, home) };
    });
    item.update((x) => {
      if (total !== opened.total) x.budget.total_minor = newTotal;
      for (const e of edits) {
        const row = x.budget.lines.find((l) => l.category === e.category);
        if (e.amount === null) x.budget.lines = x.budget.lines.filter((l) => l.category !== e.category);
        else if (row) row.amount_minor = e.amount;
        else x.budget.lines.push({ category: e.category, amount_minor: e.amount });
      }
    });
    onClose();
  };
  const sumLines = CATEGORIES.reduce((a, c) => a + (parseAmount(lines[c] ?? "") ?? 0), 0);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Budget"
      footer={
        <ItemButton variant="primary" block onClick={save}>
          Save budget
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={`Whole trip (${home})`} hint={sumLines ? `Categories add up to ${money(toMinor(sumLines, home), home)}` : "Leave blank to use the categories' total"}>
          <TextInput inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="0" className="text-lg font-semibold tabular-nums" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          {CATEGORIES.map((c) => (
            <Field key={c} label={CATEGORY_LABEL[c]}>
              <TextInput inputMode="decimal" value={lines[c] ?? ""} onChange={(e) => setLines({ ...lines, [c]: e.target.value })} placeholder="—" className="tabular-nums" />
            </Field>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- tab */

export function MoneyTab({ item, isPhone, ask }: ItemViewProps<Trip>) {
  const t = item.data;
  const width = useTripWidth();
  const narrow = isPhone || width < TWO_COL;
  const home = t.settings.home_currency;
  const [editing, setEditing] = useState<Expense | null>(null);
  const [adding, setAdding] = useState(false);
  const [rates, setRates] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [filter, setFilter] = useState<Category | "all">("all");
  const userId = useUserId();
  const me = meId(t, userId);
  // The header's "Add expense" (from any tab: the shell switches here first).
  useEffect(() => {
    if (!item.canEdit) return;
    if (takeAddExpense()) setAdding(true);
    return onAddExpense(() => {
      if (takeAddExpense()) setAdding(true);
    });
  }, [item.canEdit]);
  const b = useMemo(() => budget(t), [t]);
  const s = useMemo(() => settleUp(t), [t]);
  const names = Object.fromEntries(t.travellers.map((x) => [x.id, x.name]));
  const days = dateRange(t.start, t.end).length;
  const today = todayISO();
  const ph = phaseOf(t, today);
  const left = b.total !== null ? b.total - b.actual : null;
  const daysLeft = ph.phase === "during" ? ph.of - ph.day + 1 : ph.phase === "before" ? days : 0;

  const expenses = useMemo(() => [...t.expenses].filter((e) => filter === "all" || e.category === filter).sort((a, z) => z.date.localeCompare(a.date)), [t.expenses, filter]);
  const byDay = useMemo(() => {
    const m = new Map<string, Expense[]>();
    for (const e of expenses) m.set(e.date, [...(m.get(e.date) ?? []), e]);
    return [...m.entries()];
  }, [expenses]);

  const settle = (from: string, to: string, amount: number) => {
    const id = uid("s-");
    item.update((d) => {
      if (d.settlements.length < 300 && !d.settlements.some((x) => x.id === id)) d.settlements.push({ id, date: today, from_id: from, to_id: to, amount_minor: amount, note: "" });
    });
  };

  const summary = (
    <StatGrid className={width < 900 ? "md:grid-cols-2" : undefined}>
      <Stat label="Spent + booked" value={money(b.actual, home, { compact: true })} icon={Coins} tone="accent" delta={b.total !== null ? `of ${money(b.total, home, { compact: true })}` : undefined} onClick={item.canEdit ? () => setBudgetOpen(true) : undefined} />
      <Stat
        label="Left"
        value={left !== null ? money(left, home, { compact: true }) : "—"}
        icon={PiggyBank}
        tone={left !== null && left < 0 ? "bad" : "neutral"}
        delta={left !== null && daysLeft > 0 ? `${money(Math.round(left / daysLeft), home, { compact: true })} / day` : left === null ? "Set a budget" : undefined}
        onClick={item.canEdit ? () => setBudgetOpen(true) : undefined}
      />
      <Stat label="Booked" value={money(b.booked, home, { compact: true })} icon={Receipt} />
      <Stat label="Spent on the trip" value={money(b.spent, home, { compact: true })} icon={HandCoins} delta={ph.phase === "during" && ph.day ? `${money(Math.round(b.spent / ph.day), home, { compact: true })} / day` : undefined} />
    </StatGrid>
  );

  const budgetCard = (
    <Section
      title="Budget vs actual"
      action={
        item.canEdit && (
          <div className="flex gap-1">
            <ItemButton size="sm" variant="ghost" icon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => ask("Suggest a realistic budget for this trip by category (state the destination cost tier you assume), set it, and tell me how we're tracking.")}>
              Suggest
            </ItemButton>
            <ItemButton size="sm" onClick={() => setBudgetOpen(true)}>
              Edit
            </ItemButton>
          </div>
        )
      }
    >
      <Card className="flex flex-col gap-3">
        {b.rows.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Costs from bookings and expenses show up here by category. Set a budget to see what's left.</p>
        ) : (
          b.rows
            .sort((x, y) => CATEGORIES.indexOf(x.category) - CATEGORIES.indexOf(y.category))
            .map((r) => {
              const actual = r.booked + r.spent;
              const over = r.budget !== null && actual > r.budget;
              return (
                <div key={r.category} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium text-[var(--text)]">{CATEGORY_LABEL[r.category]}</span>
                    <span className={cn("tabular-nums", over ? "font-semibold text-[var(--danger)]" : "text-[var(--text-muted)]")}>
                      {money(actual, home, { compact: true })}
                      {r.budget !== null ? ` / ${money(r.budget, home, { compact: true })}` : ""}
                    </span>
                  </div>
                  <ProgressBar value={r.budget ? actual / r.budget : actual ? 1 : 0} color={over ? "var(--danger)" : undefined} />
                  {r.planned > 0 && <span className="text-[11px] tabular-nums text-[var(--text-muted)]">+ {money(r.planned, home, { compact: true })} planned in the itinerary</span>}
                </div>
              );
            })
        )}
        {b.missing.length > 0 && (
          <button type="button" onClick={() => setRates(true)} className="self-start text-sm font-medium text-[var(--warning)]">
            No rate for {b.missing.join(", ")} — those amounts aren't counted. Set rates
          </button>
        )}
      </Card>
    </Section>
  );

  const whoAmI = t.travellers.length > 1 && !me && userId && item.canEdit && (
    <Card className="flex flex-col gap-2">
      <p className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
        <UserRound className="h-4 w-4 text-[var(--item-accent)]" /> Which traveller are you?
      </p>
      <p className="text-xs text-[var(--text-muted)]">So "paid by me" (and the assistant's "I paid…") means you, on any device.</p>
      <div className="flex flex-wrap gap-2">
        {t.travellers.map((x) => (
          <Chip key={x.id} onClick={() => item.update((d) => claimMe(d, userId, x.id))}>
            {x.name}
          </Chip>
        ))}
      </div>
    </Card>
  );

  const settleCard = t.travellers.length > 1 && (
    <Section title="Settle up" hint={`In ${home}`}>
      <Card className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          {s.balances.map((x) => (
            <div key={x.id} className="flex items-center gap-3">
              <Avatar name={x.name} size={28} />
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">
                {x.name}
                {x.id === me && <span className="ml-1 text-xs text-[var(--text-muted)]">(you)</span>}
              </span>
              <span className="text-xs tabular-nums text-[var(--text-muted)]">paid {money(x.paid, home, { compact: true })}</span>
              <span className={cn("w-24 text-right text-sm font-semibold tabular-nums", x.balance > 0 ? "text-[var(--success)]" : x.balance < 0 ? "text-[var(--danger)]" : "text-[var(--text-muted)]")}>
                {x.balance > 0 ? "+" : ""}
                {money(x.balance, home)}
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3" aria-live="polite">
          {s.transfers.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">{t.expenses.length ? "All square 🎉" : "Log shared costs and this shows who owes whom."}</p>
          ) : (
            s.transfers.map((tr) => (
              <div key={`${tr.from}-${tr.to}`} className="flex items-center gap-2">
                <span className="text-sm font-medium text-[var(--text)]">{names[tr.from]}</span>
                <ArrowRight className="h-4 w-4 text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text)]">{names[tr.to]}</span>
                <span className="text-sm font-semibold tabular-nums text-[var(--text)]">{money(tr.amount, home)}</span>
                {item.canEdit && (
                  <ItemButton size="sm" onClick={() => settle(tr.from, tr.to, tr.amount)}>
                    Paid
                  </ItemButton>
                )}
              </div>
            ))
          )}
          {s.skipped > 0 && <p className="text-xs text-[var(--warning)]">{s.skipped} expense{s.skipped === 1 ? "" : "s"} left out (no payer or no exchange rate).</p>}
        </div>
        {t.settlements.length > 0 && (
          <details className="text-xs text-[var(--text-muted)]">
            <summary className="cursor-pointer">Repayments ({t.settlements.length})</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {t.settlements.map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-2">
                  <span>
                    {fmtDate(x.date)} · {names[x.from_id]} → {names[x.to_id]} {money(x.amount_minor, home)}
                  </span>
                  {item.canEdit && (
                    <button type="button" className="text-[var(--danger)]" onClick={() => item.update((d) => void (d.settlements = d.settlements.filter((z) => z.id !== x.id)))}>
                      Undo
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    </Section>
  );

  const ratesCard = (
    <Section
      title="Exchange rates"
      action={
        item.canEdit && (
          <ItemButton size="sm" icon={<ArrowRightLeft className="h-3.5 w-3.5" />} onClick={() => setRates(true)}>
            Edit
          </ItemButton>
        )
      }
    >
      <Card className="flex flex-col gap-1.5">
        {t.currencies.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Add the currencies you'll spend in, with your rate.</p>
        ) : (
          t.currencies.map((c) => (
            <div key={c.code} className="flex items-center justify-between text-sm">
              <span className="tabular-nums text-[var(--text)]">
                1 {home} = <b>{c.per_home.toLocaleString(undefined, { maximumFractionDigits: 6 })}</b> {c.code}
              </span>
              <span className="text-xs text-[var(--text-muted)]">{c.updated ? fmtDate(c.updated) : ""}</span>
            </div>
          ))
        )}
        {item.canEdit && (
          <button type="button" className="mt-1 self-start text-xs font-medium text-[var(--item-accent)]" onClick={() => ask("Look up today's exchange rates for this trip's currencies (cite the source and date) and set them.")}>
            Look up today's rates with the assistant
          </button>
        )}
      </Card>
    </Section>
  );

  const list = (
    <Section
      title="Expenses"
      hint={t.expenses.length ? `${t.expenses.length} logged` : undefined}
      action={
        !isPhone &&
        item.canEdit && (
          <ItemButton size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Expense
          </ItemButton>
        )
      }
    >
      {t.expenses.length > 0 && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:px-0">
          <Chip active={filter === "all"} onClick={() => setFilter("all")}>
            All
          </Chip>
          {CATEGORIES.filter((c) => t.expenses.some((e) => e.category === c)).map((c) => (
            <Chip key={c} active={filter === c} onClick={() => setFilter(c)}>
              {CATEGORY_LABEL[c]}
            </Chip>
          ))}
        </div>
      )}
      {t.expenses.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="No expenses yet"
          text="Log what you spend in any currency — it converts to your home currency and works out who owes whom."
          action={item.canEdit && <ItemButton variant="primary" onClick={() => setAdding(true)}>Add an expense</ItemButton>}
        />
      ) : (
        byDay.map(([day, list]) => {
          const total = list.reduce((a, e) => a + (toHome(t, e.amount_minor, e.currency, e.per_home) ?? 0), 0);
          return (
            <div key={day} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between px-1 text-xs text-[var(--text-muted)]">
                <span className="font-semibold uppercase tracking-wide">{fmtDate(day)}</span>
                <span className="tabular-nums">{money(total, home)}</span>
              </div>
              <List>
                {list.map((e) => {
                  const inHome = e.currency !== home ? toHome(t, e.amount_minor, e.currency, e.per_home) : null;
                  const split = e.split === "equal" ? (e.shares.length ? `split ${e.shares.length} ways` : t.travellers.length > 1 ? "split equally" : "") : e.split === "exact" ? "exact split" : "by shares";
                  return (
                    <ListRow
                      key={e.id}
                      title={e.title}
                      subtitle={[CATEGORY_LABEL[e.category], t.travellers.length > 1 && e.paid_by ? `${names[e.paid_by] ?? "?"} paid` : "", split].filter(Boolean).join(" · ")}
                      onClick={item.canEdit ? () => setEditing(e) : undefined}
                      trailing={
                        <span className="flex flex-col items-end">
                          <span className="text-sm font-semibold tabular-nums text-[var(--text)]">{money(e.amount_minor, e.currency)}</span>
                          {inHome !== null && <span className="text-[11px] tabular-nums text-[var(--text-muted)]">≈ {money(inHome, home)}</span>}
                        </span>
                      }
                    />
                  );
                })}
              </List>
            </div>
          );
        })
      )}
    </Section>
  );

  return (
    <Page wide={!narrow}>
      {summary}
      {whoAmI}
      {narrow ? (
        <>
          {settleCard}
          {list}
          {budgetCard}
          <BudgetSpentCard item={item} />
          {ratesCard}
        </>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(300px,400px)] gap-6">
          <div className="flex min-w-0 flex-col gap-5">{list}</div>
          <div className="flex flex-col gap-5">
            {settleCard}
            {budgetCard}
            <BudgetSpentCard item={item} />
            {ratesCard}
          </div>
        </div>
      )}
      {isPhone && item.canEdit && <Fab label="Expense" icon={Plus} onClick={() => setAdding(true)} />}
      {item.canEdit && <ExpenseSheet item={item} open={adding || !!editing} expense={editing} onClose={() => { setAdding(false); setEditing(null); }} />}
      {item.canEdit && <RatesSheet item={item} open={rates} onClose={() => setRates(false)} />}
      {item.canEdit && <BudgetSheet item={item} open={budgetOpen} onClose={() => setBudgetOpen(false)} />}
    </Page>
  );
}
