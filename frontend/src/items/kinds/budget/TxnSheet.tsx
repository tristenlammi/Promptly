import { ArrowLeftRight, ChevronDown, Globe, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { toast } from "@/store/toastStore";
import { Field, ItemButton, Segmented, Select, Sheet, TextArea, TextInput, Toggle, fmtDay, todayISO, uid } from "@/items/ui";
import { cn } from "@/utils/cn";

import { errorText } from "./api";
import { CatBadge, CategoryPicker, Pill, useMoney, type H } from "./common";
import { catIndex, currencySymbol, parseMoney } from "./logic";
import { TripTag } from "./TripTag";
import type { Split, Txn } from "./types";

/** Re-categorise one or more transactions; "always for this payee" saves a rule. */
export function RecategoriseSheet({ item, txns, open, onClose }: { item: H; txns: Txn[]; open: boolean; onClose: () => void }) {
  const [always, setAlways] = useState(false);
  useEffect(() => {
    if (open) setAlways(false);
  }, [open]);
  const payees = [...new Set(txns.map((t) => t.payee).filter(Boolean))];
  const pick = async (cid: string | null) => {
    onClose();
    const ids = txns.map((t) => t.id);
    if (always && cid) {
      try {
        const r = await item.runAction("categorise", { ids, category_id: cid, always_for_payee: true });
        toast.success(r.summary);
      } catch (e) {
        toast.error(errorText(e, "Couldn't save that."));
      }
      return;
    }
    const want = new Set(ids);
    item.update((d) => {
      for (const t of d.transactions) {
        if (!want.has(t.id)) continue;
        t.category_id = cid;
        t.category_by = "user";
        if (t.splits?.length) t.splits = [];
        if (t.review) t.review = "";
        if (cid && t.transfer) {
          t.transfer = false; // categorised = real spending/income, and a sync won't flip it back
          t.transfer_by = "user";
        }
      }
    });
  };
  return (
    <CategoryPicker
      data={item.data}
      open={open}
      onClose={onClose}
      onPick={(c) => void pick(c)}
      value={txns.length === 1 ? txns[0].category_id : undefined}
      allowNone
      title={txns.length === 1 ? txns[0].payee || "Category" : `${txns.length} transactions`}
      header={
        payees.length > 0 && payees.length <= 5 ? (
          <label className="flex w-full items-center justify-between gap-3 text-sm text-[var(--text)]">
            <span className="min-w-0">
              <span className="block font-medium">Always for {payees.length === 1 ? `“${payees[0]}”` : "these payees"}</span>
              <span className="block text-xs text-[var(--text-muted)]">Saves a rule and fixes their other transactions</span>
            </span>
            <Toggle checked={always} onChange={setAlways} label="Always use this category for this payee" />
          </label>
        ) : undefined
      }
    />
  );
}

interface Draft {
  dir: "out" | "in";
  amount: string;
  payee: string;
  date: string;
  category_id: string | null;
  account_id: string | null;
  notes: string;
  tags: string;
  transfer: boolean;
  pending: boolean;
  splits: { key: string; category_id: string | null; amount: string; note: string }[];
}

function toDraft(t: Txn | null, defaults: { account_id: string | null }): Draft {
  if (!t) {
    return { dir: "out", amount: "", payee: "", date: todayISO(), category_id: null, account_id: defaults.account_id, notes: "", tags: "", transfer: false, pending: false, splits: [] };
  }
  return {
    dir: t.amount_cents > 0 ? "in" : "out",
    amount: (Math.abs(t.amount_cents) / 100).toFixed(2),
    payee: t.payee,
    date: t.date,
    category_id: t.category_id,
    account_id: t.account_id,
    notes: t.notes,
    tags: t.tags.join(", "),
    transfer: t.transfer,
    pending: t.pending,
    splits: t.splits.map((s) => ({ key: uid("s"), category_id: s.category_id, amount: (Math.abs(s.amount_cents) / 100).toFixed(2), note: s.note })),
  };
}

/** Add a transaction (``txn`` null) or edit one — a bank one keeps its bank facts. */
export function TxnSheet({ item, txn, open, onClose }: { item: H; txn: Txn | null; open: boolean; onClose: () => void }) {
  const fmt = useMoney(item);
  const data = item.data;
  const cats = useMemo(() => catIndex(data), [data]);
  const liveAccounts = data.accounts.filter((a) => !a.archived);
  const [d, setD] = useState<Draft>(() => toDraft(txn, { account_id: liveAccounts[0]?.id ?? null }));
  const [picker, setPicker] = useState<null | "main" | string>(null);
  const [always, setAlways] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (open) {
      setD(toDraft(txn, { account_id: data.accounts.find((a) => !a.archived && a.source !== "up")?.id ?? null }));
      setAlways(false);
      // Notes, tags, splits and "pending" fold away when adding; an edit shows them if used.
      setMore(!!txn && (!!txn.notes || txn.tags.length > 0 || txn.splits.length > 0 || txn.pending));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, txn?.id]);
  const bank = txn?.source === "up";
  const cents = parseMoney(d.amount);
  const signed = Number.isFinite(cents) ? (d.dir === "out" ? -Math.abs(cents) : Math.abs(cents)) : NaN;
  const splitTotal = d.splits.reduce((n, s) => n + (parseMoney(s.amount) || 0), 0);
  const splitOk = !d.splits.length || splitTotal === Math.abs(signed);
  const valid = Number.isFinite(signed) && signed !== 0 && d.payee.trim() && splitOk && /^\d{4}-\d{2}-\d{2}$/.test(d.date);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  // Payees you add by hand most often, with the category they last had: one
  // tap fills both (like YNAB's memorised payees).
  const quick = useMemo(() => {
    if (txn) return [];
    const by = new Map<string, { payee: string; n: number; cat: string | null; dir: "in" | "out" }>();
    for (const t of data.transactions.slice(0, 600)) {
      if (!t.payee || t.transfer) continue;
      const k = t.payee.toLowerCase();
      const e = by.get(k);
      if (e) e.n += 1;
      else by.set(k, { payee: t.payee, n: 1, cat: t.category_id, dir: t.amount_cents > 0 ? "in" : "out" });
    }
    return [...by.values()].filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 8);
  }, [data.transactions, txn]);
  const typed = d.payee.trim().toLowerCase();
  const suggestions = typed ? quick.filter((x) => x.payee.toLowerCase().includes(typed) && x.payee.toLowerCase() !== typed) : quick;

  const save = async () => {
    if (!valid) return;
    const sign = signed < 0 ? -1 : 1;
    const splits: Split[] = d.splits.map((s) => ({ category_id: s.category_id, amount_cents: sign * Math.abs(parseMoney(s.amount) || 0), note: s.note }));
    const tags = d.tags.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 12);
    const changedCat = txn ? d.category_id !== txn.category_id : !!d.category_id;
    onClose();
    if (!txn) {
      try {
        const r = await item.runAction("add_transactions", {
          items: [{ date: d.date, amount: signed / 100, payee: d.payee.trim(), category_id: d.splits.length ? null : d.category_id, account_id: d.account_id, notes: d.notes, tags, transfer: d.transfer, pending: d.pending, splits: splits.map((s) => ({ ...s, amount: s.amount_cents / 100 })) }],
        });
        toast.success(r.summary);
      } catch (e) {
        toast.error(errorText(e, "Couldn't add that."));
      }
      return;
    }
    // Only the fields the person changed in the sheet: the draft may be newer
    // (a sync settled it, someone else edited it) and this can be replayed on it.
    const was = toDraft(txn, { account_id: null });
    const sameSplits = JSON.stringify(txn.splits) === JSON.stringify(splits);
    const payee = d.payee.trim() !== txn.payee ? d.payee.trim() : null;
    const notes = d.notes !== txn.notes ? d.notes : null;
    const newTags = tags.join(",") !== txn.tags.join(",") ? tags : null;
    const transfer = d.transfer !== txn.transfer ? d.transfer : null;
    item.update((draft) => {
      const t = draft.transactions.find((x) => x.id === txn.id);
      if (!t) return;
      if (!bank) {
        if (signed !== txn.amount_cents) t.amount_cents = signed;
        if (d.date !== was.date) t.date = d.date;
        if (d.account_id !== was.account_id) t.account_id = d.account_id;
        if (d.pending !== was.pending) t.pending = d.pending;
      }
      if (payee !== null) {
        t.payee = payee;
        t.payee_by = "user";
      }
      if (changedCat) {
        t.category_id = d.category_id;
        t.category_by = "user";
      }
      if (notes !== null) t.notes = notes;
      if (newTags !== null) t.tags = newTags;
      if (transfer !== null) {
        t.transfer = transfer;
        t.transfer_by = "user"; // the person's call — a sync or rule never flips it back
        if (transfer) t.category_id = null;
      }
      if (!sameSplits) {
        // Parts were entered against the amount shown; if the bank moved it meanwhile, the
        // difference goes on the largest part (as the server does).
        const total = t.amount_cents;
        const next = splits.map((x) => ({ ...x }));
        const diff = total - next.reduce((n, x) => n + x.amount_cents, 0);
        if (next.length && diff) {
          let big = 0;
          next.forEach((x, i) => {
            if (Math.abs(x.amount_cents) > Math.abs(next[big].amount_cents)) big = i;
          });
          next[big].amount_cents += diff;
        }
        t.splits = next;
        if (next.length) {
          t.category_id = null;
          t.category_by = "user";
        }
      }
      if (t.review) t.review = "";
    });
    if (changedCat && always && d.category_id && !d.splits.length) {
      try {
        const r = await item.runAction("categorise", { ids: [txn.id], category_id: d.category_id, always_for_payee: true });
        toast.success(r.summary);
      } catch (e) {
        toast.error(errorText(e, "Couldn't save the rule."));
      }
    }
  };

  const remove = () => {
    if (!txn) return;
    onClose();
    item.update((draft) => {
      draft.transactions = draft.transactions.filter((x) => x.id !== txn.id);
    });
    toast.success("Transaction deleted — Undo is in the header");
  };

  const cat = d.category_id ? cats.get(d.category_id) : null;
  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title={txn ? (bank ? txn.payee || "Transaction" : "Edit transaction") : "New transaction"}
        size="md"
        footer={
          item.canEdit ? (
            <>
              {txn && !bank && (
                <ItemButton variant="ghost" aria-label="Delete transaction" icon={<Trash2 className="h-4 w-4" />} onClick={remove} />
              )}
              <ItemButton variant="secondary" onClick={onClose} className="flex-1">
                Cancel
              </ItemButton>
              <ItemButton variant="primary" disabled={!valid} onClick={() => void save()} className="flex-1">
                {txn ? "Save" : "Add"}
              </ItemButton>
            </>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-4">
          {txn?.review && (
            <p className="rounded-xl bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] p-2.5 text-xs text-[var(--text)]" role="status">
              {txn.review}
            </p>
          )}
          {bank && txn && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--surface-2)] p-3 text-xs text-[var(--text-muted)]">
              <Pill tone="accent">Up</Pill>
              {txn.pending && <Pill tone="warn">Pending</Pill>}
              <span className="min-w-0 flex-1 truncate" title={txn.description}>
                {txn.description}
              </span>
              {txn.foreign && (
                <span className="inline-flex items-center gap-1">
                  <Globe className="h-3.5 w-3.5" />
                  {(Math.abs(txn.foreign.amount_cents) / 100).toLocaleString()} {txn.foreign.currency}
                </span>
              )}
              {txn.round_up_cents !== 0 && <span>Round-up {fmt(Math.abs(txn.round_up_cents))}</span>}
              {txn.cashback_cents !== 0 && <span>Cashback {fmt(txn.cashback_cents)}</span>}
            </div>
          )}
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-[var(--surface-2)] px-4 py-4">
            <label className={cn("flex items-baseline justify-center gap-1 font-semibold tabular-nums", d.dir === "in" ? "text-[var(--success)]" : "text-[var(--text)]")}>
              <span className="text-2xl opacity-70" aria-hidden>
                {d.dir === "in" ? "+" : "−"}
                {currencySymbol(data.settings.currency)}
              </span>
              <input
                inputMode="decimal"
                aria-label="Amount"
                value={d.amount}
                disabled={bank}
                autoFocus={!txn}
                onChange={(e) => set({ amount: e.target.value })}
                placeholder="0.00"
                size={Math.max(4, d.amount.length + 1)}
                className="min-w-0 bg-transparent text-center text-4xl tracking-tight outline-none placeholder:text-[var(--text-muted)] placeholder:opacity-50 disabled:opacity-70"
              />
            </label>
            <Segmented
              size="sm"
              value={d.dir}
              onChange={(v) => !bank && set({ dir: v })}
              options={[
                { value: "out", label: "Spent" },
                { value: "in", label: "Received" },
              ]}
            />
          </div>
          <Field label="Payee">
            <TextInput value={d.payee} onChange={(e) => set({ payee: e.target.value })} placeholder="Who was it?" maxLength={120} />
          </Field>
          {suggestions.length > 0 && (
            <div className="-mt-2 flex flex-wrap gap-1.5" aria-label="Recent payees">
              {suggestions.slice(0, 6).map((x) => {
                const c = x.cat ? cats.get(x.cat) : null;
                return (
                  <button
                    key={x.payee}
                    type="button"
                    onClick={() => set({ payee: x.payee, ...(d.category_id ? {} : { category_id: x.cat }), ...(d.amount ? {} : { dir: x.dir }) })}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs font-medium text-[var(--text)] transition hover:border-[var(--item-accent)]"
                  >
                    <span aria-hidden>{c?.emoji ?? "•"}</span>
                    {x.payee}
                  </button>
                );
              })}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <TextInput type="date" value={d.date} disabled={bank} onChange={(e) => set({ date: e.target.value })} />
            </Field>
            <Field label="Account">
              <Select value={d.account_id ?? ""} disabled={bank} onChange={(e) => set({ account_id: e.target.value || null })}>
                <option value="">No account</option>
                {liveAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {!d.transfer && !d.splits.length && (
            <Field label="Category">
              <button
                type="button"
                onClick={() => setPicker("main")}
                className="flex h-11 w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)] md:h-10"
              >
                <CatBadge cat={cat} size={28} />
                <span className="flex-1 truncate">{cat?.name ?? "Choose a category"}</span>
              </button>
            </Field>
          )}
          {txn && d.category_id !== txn.category_id && d.category_id && txn.payee && !d.splits.length && (
            <label className="flex items-center justify-between gap-3 rounded-xl bg-[var(--surface-2)] p-3 text-sm">
              <span>Always use {cat?.name} for “{txn.payee}”</span>
              <Toggle checked={always} onChange={setAlways} label="Always for this payee" />
            </label>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm text-[var(--text)]">
              <ArrowLeftRight className="h-4 w-4 text-[var(--text-muted)]" />
              Transfer between my accounts
            </span>
            <Toggle checked={d.transfer} onChange={(v) => set({ transfer: v, splits: v ? [] : d.splits })} label="Transfer between my accounts" />
          </div>
          {txn && !d.transfer && <TripTag item={item} txn={txn} date={d.date} />}
          {!more && (
            <button
              type="button"
              onClick={() => setMore(true)}
              aria-expanded={false}
              className="flex min-h-[44px] items-center gap-2 rounded-xl px-1 text-left text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              <ChevronDown className="h-4 w-4" />
              Split, notes, tags{!bank ? ", pending" : ""}
            </button>
          )}
          {more && !d.transfer && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--text-muted)]">Split</span>
                <ItemButton
                  size="sm"
                  variant="ghost"
                  icon={<Plus className="h-3.5 w-3.5" />}
                  onClick={() =>
                    set({
                      splits: [
                        ...(d.splits.length ? d.splits : [{ key: uid("s"), category_id: d.category_id, amount: Number.isFinite(cents) ? (Math.abs(cents) / 100).toFixed(2) : "", note: "" }]),
                        { key: uid("s"), category_id: null, amount: "", note: "" },
                      ],
                    })
                  }
                >
                  {d.splits.length ? "Add part" : "Split across categories"}
                </ItemButton>
              </div>
              {d.splits.map((s, i) => {
                const sc = s.category_id ? cats.get(s.category_id) : null;
                return (
                  <div key={s.key} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPicker(s.key)}
                      className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2 text-left text-sm md:h-10"
                    >
                      <CatBadge cat={sc} size={24} />
                      <span className="truncate">{sc?.name ?? "Category"}</span>
                    </button>
                    <TextInput
                      inputMode="decimal"
                      aria-label={`Part ${i + 1} amount`}
                      value={s.amount}
                      onChange={(e) => set({ splits: d.splits.map((x) => (x.key === s.key ? { ...x, amount: e.target.value } : x)) })}
                      className="w-28 text-right tabular-nums"
                    />
                    <button
                      type="button"
                      aria-label={`Remove part ${i + 1}`}
                      onClick={() => set({ splits: d.splits.filter((x) => x.key !== s.key) })}
                      className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
              {d.splits.length > 0 && (
                <p className={splitOk ? "text-xs text-[var(--text-muted)]" : "text-xs font-medium text-[var(--danger)]"} aria-live="polite">
                  Parts add up to {fmt(splitTotal)}
                  {Number.isFinite(cents) ? ` of ${fmt(Math.abs(cents))}` : ""}
                  {!splitOk && Number.isFinite(cents) ? ` — ${fmt(Math.abs(Math.abs(cents) - splitTotal))} ${splitTotal > Math.abs(cents) ? "too much" : "left"}` : ""}
                </p>
              )}
            </div>
          )}
          {more && (
            <Field label="Notes">
              <TextArea value={d.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} maxLength={1000} />
            </Field>
          )}
          {more && (
            <Field label="Tags" hint="Comma separated">
              <TextInput value={d.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="work, holiday" />
            </Field>
          )}
          {more && !bank && (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>Pending (not settled yet)</span>
              <Toggle checked={d.pending} onChange={(v) => set({ pending: v })} label="Pending" />
            </div>
          )}
          {txn && (
            <p className="text-xs text-[var(--text-muted)]">
              {fmtDay(txn.date, { long: true })} · {txn.source === "up" ? "From Up" : txn.source === "csv" ? "Imported" : "Added by hand"}
              {txn.category_by === "rule" ? " · categorised by a rule" : ""}
            </p>
          )}
        </div>
      </Sheet>
      <CategoryPicker
        data={data}
        open={picker !== null}
        onClose={() => setPicker(null)}
        value={picker === "main" ? d.category_id : d.splits.find((s) => s.key === picker)?.category_id}
        onPick={(cid) => {
          if (picker === "main") set({ category_id: cid });
          else if (picker) set({ splits: d.splits.map((x) => (x.key === picker ? { ...x, category_id: cid } : x)) });
          setPicker(null);
        }}
      />
    </>
  );
}
