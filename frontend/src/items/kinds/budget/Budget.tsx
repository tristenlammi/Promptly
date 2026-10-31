import { ChevronDown, ChevronLeft, ChevronRight, PiggyBank, Plus, Repeat2, Sparkles, Target } from "lucide-react";
import { useMemo, useState } from "react";

import { toast } from "@/store/toastStore";
import type { ItemViewProps } from "@/items/types";
import { Card, EmptyState, Field, IconButton, ItemButton, List, ListRow, Page, ProgressRing, Section, Segmented, Select, Sheet, TextInput, Toggle, fmtDay, todayISO } from "@/items/ui";
import { cn } from "@/utils/cn";

import { errorText } from "./api";
import { Bar, Pill, useMoney, type H } from "./common";
import { addMonths, assignedFor, budgetTable, currentMonth, goalProgress, monthLabel, monthRange, parseMoney, txnLines, type BudgetRow } from "./logic";
import type { BudgetData, Category, Goal } from "./types";

export function BudgetView({ item, isPhone, ask }: ItemViewProps<BudgetData>) {
  const data = item.data;
  const fmt = useMoney(item);
  const sd = data.settings.month_start_day || 1;
  const thisMonth = currentMonth(data);
  const [month, setMonth] = useState(thisMonth);
  const table = useMemo(() => budgetTable(data, month), [data, month]);
  const [open, setOpen] = useState<string | null>(null);
  const [goal, setGoal] = useState<Goal | "new" | null>(null);
  // Categories with no budget, no spending and nothing carried are folded
  // away (most of the 40 starters, for most people), like YNAB's "hide unused".
  const [showUnused, setShowUnused] = useState<Set<string>>(new Set());
  const used = (r: BudgetRow) => r.assigned > 0 || r.spent !== 0 || r.carried !== 0;
  const envelope = data.settings.style === "envelope" || data.settings.zero_based;
  const anyBudget = table.rows.some((r) => r.assigned > 0);
  const byGroup = useMemo(
    () =>
      data.groups
        .filter((g) => !g.hidden)
        .map((g) => ({ g, rows: table.rows.filter((r) => r.group_id === g.id && !r.hidden) }))
        .filter((x) => x.rows.length),
    [data.groups, table.rows],
  );
  const [start, end] = monthRange(month, sd);
  const daysLeft = month === thisMonth ? Math.max(0, Math.round((new Date(`${end}T00:00:00`).getTime() - new Date(`${todayISO()}T00:00:00`).getTime()) / 86_400_000) + 1) : null;
  const left = table.assigned - table.spent;

  return (
    <Page wide>
      <div className="flex items-center justify-between gap-2">
        <IconButton label="Previous month" icon={ChevronLeft} onClick={() => setMonth(addMonths(month, -1))} />
        <div className="text-center">
          <h2 className="text-base font-semibold text-[var(--text)]">{monthLabel(month, sd)}</h2>
          <p className="text-xs text-[var(--text-muted)]">
            {fmtDay(start)} – {fmtDay(end)}
            {daysLeft !== null ? ` · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : ""}
          </p>
        </div>
        <IconButton label="Next month" icon={ChevronRight} onClick={() => setMonth(addMonths(month, 1))} />
      </div>

      {table.beforeStart && (
        <p className="rounded-2xl border border-dashed border-[var(--border)] p-3 text-sm text-[var(--text-muted)]" role="status">
          {table.budgetStart && month < table.budgetStart
            ? `Budgeting starts ${monthLabel(table.budgetStart, sd)} — this month shows what you spent, without rollover or “to be budgeted”. Change it in Accounts & settings → Budget.`
            : "This month is in an archive file — shown on its own, without rollover."}
        </p>
      )}
      <div className={cn("grid gap-3", envelope && !table.beforeStart ? "grid-cols-2 md:grid-cols-4" : "grid-cols-3")}>
        {envelope && !table.beforeStart && (
          <Card className={cn("flex flex-col gap-0.5", table.toBeBudgeted < 0 && "border-[var(--danger)]")}>
            <span className="text-xs font-medium text-[var(--text-muted)]">To be budgeted</span>
            <span className={cn("text-xl font-semibold tabular-nums", table.toBeBudgeted < 0 ? "text-[var(--danger)]" : table.toBeBudgeted > 0 ? "text-[var(--success)]" : "text-[var(--text)]")}>
              {fmt(table.toBeBudgeted, { whole: true })}
            </span>
            <span className="text-[11px] text-[var(--text-muted)]">{table.toBeBudgeted > 0 ? "Give these dollars a job" : table.toBeBudgeted < 0 ? "Assigned more than you've earned" : "Every dollar has a job"}</span>
          </Card>
        )}
        <Card className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-[var(--text-muted)]">Budgeted</span>
          <span className="text-xl font-semibold tabular-nums">{fmt(table.assigned, { whole: true })}</span>
        </Card>
        <Card className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-[var(--text-muted)]">Spent</span>
          <span className="text-xl font-semibold tabular-nums">{fmt(table.spent, { whole: true })}</span>
          {table.uncategorisedSpent > 0 && <span className="text-[11px] text-[var(--text-muted)]">{fmt(table.uncategorisedSpent, { whole: true })} uncategorised</span>}
        </Card>
        <Card className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-[var(--text-muted)]">Left</span>
          <span className={cn("text-xl font-semibold tabular-nums", left < 0 && "text-[var(--danger)]")}>{fmt(left, { whole: true })}</span>
          {left < 0 ? (
            <span className="text-[11px] font-medium text-[var(--danger)]">Overspent</span>
          ) : daysLeft ? (
            <span className="text-[11px] text-[var(--text-muted)]">{fmt(Math.floor(left / daysLeft), { whole: true })} a day</span>
          ) : null}
        </Card>
      </div>

      {table.overspent.length > 0 && (
        <div className="flex flex-col gap-2 rounded-2xl border border-[color-mix(in_srgb,var(--danger)_40%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] p-3 text-sm" role="status">
          <p>
            <span className="font-semibold">{table.overspent.length} overspent</span>
            <span className="text-[var(--text-muted)]">
              {" "}
              · {item.canEdit ? "tap one to cover it from a category with money left" : `${fmt(table.overspent.reduce((n, r) => n - r.available, 0), { whole: true })} in total`}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            {table.overspent.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setOpen(r.id)}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[var(--surface)] px-3 text-xs font-medium transition hover:border-[var(--danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--danger)]"
              >
                <span aria-hidden>{r.emoji}</span>
                {r.name}
                <span className="font-semibold tabular-nums text-[var(--danger)]">{fmt(r.available, { whole: true })}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!anyBudget && (
        <EmptyState
          icon={PiggyBank}
          title="No budgets set yet"
          text="Tap a category to set its monthly amount, or let the assistant draft a budget from your last three months of spending."
          action={
            <ItemButton variant="primary" icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Build me a monthly budget from my last 3 months of spending, including sinking funds and savings.")}>
              Draft my budget
            </ItemButton>
          }
        />
      )}

      {/* Columns (not a grid) so a short group never leaves a hole beside a long one. */}
      <div className={cn(isPhone ? "flex flex-col gap-5" : "columns-2 gap-5")}>
        {byGroup.map(({ g, rows }) => {
          const ga = rows.reduce((n, r) => n + r.assigned, 0);
          const gs = rows.reduce((n, r) => n + r.spent, 0);
          const expanded = showUnused.has(g.id) || !anyBudget;
          const shown = expanded ? rows : rows.filter(used);
          const hiddenN = rows.length - shown.length;
          const canFold = anyBudget && rows.some((r) => !used(r));
          return (
            <Section key={g.id} className={cn(!isPhone && "mb-5 break-inside-avoid")} title={g.name} action={ga || gs ? <span className="text-xs tabular-nums text-[var(--text-muted)]">{fmt(gs, { whole: true })} of {fmt(ga, { whole: true })}</span> : undefined}>
              <List>
                {shown.map((r) => (
                  <BudgetRowView key={r.id} r={r} fmt={fmt} onClick={() => setOpen(r.id)} envelope={envelope} />
                ))}
                {canFold && (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() =>
                      setShowUnused((cur) => {
                        const n = new Set(cur);
                        if (n.has(g.id)) n.delete(g.id);
                        else n.add(g.id);
                        return n;
                      })
                    }
                    className="flex min-h-[44px] w-full items-center gap-2 px-3 text-left text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    <ChevronDown className={cn("h-3.5 w-3.5 transition", expanded && "rotate-180")} />
                    {hiddenN > 0 ? `${hiddenN} more with no budget` : "Hide unused"}
                  </button>
                )}
              </List>
            </Section>
          );
        })}
      </div>

      <Section
        title="Savings goals"
        hint="Sinking funds and targets — link an Up saver to track it automatically"
        action={
          item.canEdit && (
            <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setGoal("new")}>
              Goal
            </ItemButton>
          )
        }
      >
        {data.goals.filter((g) => !g.done).length === 0 ? (
          <EmptyState
            icon={Target}
            title="No goals yet"
            text="An emergency fund of 3–6 months of expenses is a great first one."
            action={<ItemButton onClick={() => ask("Set up an emergency fund goal for 3 months of my essential expenses.")}>Suggest a goal</ItemButton>}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {data.goals
              .filter((g) => !g.done)
              .map((g) => (
                <GoalCard key={g.id} data={data} g={g} fmt={fmt} onClick={() => item.canEdit && setGoal(g)} />
              ))}
          </div>
        )}
      </Section>

      {open && <CategorySheet item={item} month={month} catId={open} onClose={() => setOpen(null)} />}
      {goal && <GoalSheet item={item} goal={goal === "new" ? null : goal} onClose={() => setGoal(null)} />}
    </Page>
  );
}

function BudgetRowView({ r, fmt, onClick, envelope }: { r: BudgetRow; fmt: (c: number, o?: { whole?: boolean }) => string; onClick: () => void; envelope: boolean }) {
  const budget = r.assigned + r.carried;
  const pct = budget > 0 ? r.spent / budget : r.spent > 0 ? 1 : 0;
  const over = r.available < 0;
  const has = budget > 0 || r.spent > 0;
  // The available "pill" (as in YNAB): green with money left, amber when
  // nearly gone, grey when spent exactly, red when overspent.
  const tone = !has ? "none" : over ? "bad" : r.available === 0 ? "done" : pct > 0.9 ? "warn" : budget > 0 ? "good" : "none";
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col gap-1.5 px-3 py-2.5 text-left transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
    >
      <div className="flex min-h-[28px] items-center gap-2.5">
        <span aria-hidden className="w-5 text-center text-base">
          {r.emoji || "•"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-[var(--text)]">{r.name}</span>
            {r.rollover && <Repeat2 aria-label="Rolls over" className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />}
          </span>
          {has && (
            <span className="block truncate text-[11px] tabular-nums text-[var(--text-muted)]">
              {fmt(r.spent, { whole: true })} of {fmt(budget, { whole: true })}
              {envelope && r.carried !== 0 ? ` · ${fmt(r.carried, { whole: true })} rolled in` : ""}
            </span>
          )}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-0.5 text-sm font-semibold tabular-nums",
            tone === "good" && "bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success)]",
            tone === "warn" && "bg-[color-mix(in_srgb,var(--warning,#d9902f)_16%,transparent)] text-[var(--warning,#b7791f)]",
            tone === "done" && "bg-[var(--surface-2)] text-[var(--text-muted)]",
            tone === "bad" && "bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-[var(--danger)]",
            tone === "none" && "text-xs font-medium text-[var(--text-muted)]",
          )}
          aria-label={has ? `${fmt(Math.abs(r.available), { whole: true })} ${over ? "overspent" : "available"}` : "No budget set"}
        >
          {has ? fmt(r.available, { whole: true }) : "Set budget"}
        </span>
      </div>
      {has && (
        <div className="pl-[30px]">
          <Bar value={pct} over={over} thin />
        </div>
      )}
    </button>
  );
}

function CategorySheet({ item, month, catId, onClose }: { item: H; month: string; catId: string; onClose: () => void }) {
  const data = item.data;
  const fmt = useMoney(item);
  const cat = data.categories.find((c) => c.id === catId) as Category;
  const sd = data.settings.month_start_day || 1;
  const table = budgetTable(data, month);
  const row = table.rows.find((r) => r.id === catId);
  const current = assignedFor(data, month, cat);
  const [amount, setAmount] = useState((current / 100).toFixed(0));
  const [scope, setScope] = useState<"default" | "month">("default");
  const [moveFrom, setMoveFrom] = useState<string>("");
  const [moveAmt, setMoveAmt] = useState(row && row.available < 0 ? (Math.ceil(-row.available / 100)).toString() : "");
  const avg = useMemo(() => {
    let total = 0;
    for (let i = 1; i <= 3; i++) {
      const [s, e] = monthRange(addMonths(month, -i), sd);
      for (const t of data.transactions) {
        if (t.transfer || t.date < s || t.date > e) continue;
        for (const [cid, c] of txnLines(t)) if (cid === catId) total -= c;
      }
    }
    return Math.max(0, Math.round(total / 3));
  }, [data.transactions, month, sd, catId]);
  const recent = data.transactions.filter((t) => t.category_id === catId || t.splits.some((s) => s.category_id === catId)).slice(0, 6);
  const sources = table.rows.filter((r) => r.id !== catId && r.available > 0).sort((a, b) => b.available - a.available);

  const saveBudget = async () => {
    const cents = parseMoney(amount);
    if (!Number.isFinite(cents) || cents < 0) return;
    try {
      await item.runAction("set_budget", { items: [{ category_id: catId, amount: cents / 100, ...(scope === "month" ? { month } : {}) }] });
      toast.success(`${cat.name}: ${fmt(cents)} ${scope === "month" ? `in ${monthLabel(month)}` : "a month"}`);
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  const move = async () => {
    const cents = parseMoney(moveAmt);
    if (!Number.isFinite(cents) || cents <= 0) return;
    try {
      const r = await item.runAction("move_money", { amount: cents / 100, from_category_id: moveFrom || null, to_category_id: catId, month });
      toast.success(r.summary);
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  const overspent = !!row && row.available < 0;
  const moveBox = (
    <div className={cn("flex flex-col gap-2 rounded-2xl border p-3", overspent ? "border-[color-mix(in_srgb,var(--danger)_40%,transparent)] bg-[color-mix(in_srgb,var(--danger)_6%,transparent)]" : "border-[var(--border)]")}>
      <p className="text-sm font-medium">{overspent ? `Cover the ${fmt(-row!.available, { whole: true })} overspend` : "Move money in"}</p>
      <Select value={moveFrom} onChange={(e) => setMoveFrom(e.target.value)} aria-label="Move from">
        <option value="">From “to be budgeted”</option>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            From {s.name} ({fmt(s.available, { whole: true })} left)
          </option>
        ))}
      </Select>
      <div className="flex gap-2">
        <TextInput inputMode="decimal" value={moveAmt} onChange={(e) => setMoveAmt(e.target.value)} placeholder="0" className="min-w-0 flex-1 text-right tabular-nums" aria-label="Amount to move" />
        <ItemButton variant={overspent ? "primary" : "secondary"} className="shrink-0" onClick={() => void move()} disabled={!moveAmt}>
          Move
        </ItemButton>
      </div>
    </div>
  );
  return (
    <Sheet open onClose={onClose} title={`${cat.emoji} ${cat.name}`} size="md">
      <div className="flex flex-col gap-5">
        {row && (
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              ["Assigned", row.assigned],
              ["Spent", row.spent],
              ["Available", row.available],
            ].map(([l, v]) => (
              <div key={l as string} className="rounded-xl bg-[var(--surface-2)] p-2">
                <p className="text-[11px] text-[var(--text-muted)]">{l}</p>
                <p className={cn("text-sm font-semibold tabular-nums", (v as number) < 0 && l === "Available" && "text-[var(--danger)]")}>{fmt(v as number)}</p>
              </div>
            ))}
          </div>
        )}
        {item.canEdit && overspent && moveBox}
        {item.canEdit && (
          <>
            <div className="flex flex-col gap-2">
              <Field label="Monthly budget" hint={avg ? `You spent about ${fmt(avg, { whole: true })} a month over the last 3 months` : undefined}>
                <div className="flex gap-2">
                  <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="text-right tabular-nums" aria-label="Budget amount" />
                  {avg > 0 && (
                    <ItemButton size="md" className="shrink-0 whitespace-nowrap" onClick={() => setAmount(String(Math.ceil(avg / 1000) * 10))}>
                      Use {fmt(Math.ceil(avg / 1000) * 1000, { whole: true })}
                    </ItemButton>
                  )}
                </div>
              </Field>
              <Segmented
                size="sm"
                value={scope}
                onChange={setScope}
                options={[
                  { value: "default", label: "Every month" },
                  { value: "month", label: `Just ${monthLabel(month).split(" ")[0]}` },
                ]}
              />
              <ItemButton variant="primary" onClick={() => void saveBudget()}>
                Save budget
              </ItemButton>
            </div>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>
                <span className="block font-medium">Roll over</span>
                <span className="block text-xs text-[var(--text-muted)]">What's left (or overspent) carries into next month — great for sinking funds</span>
              </span>
              <Toggle
                checked={cat.rollover}
                onChange={(v) =>
                  item.update((d) => {
                    const c = d.categories.find((x) => x.id === catId);
                    if (c) c.rollover = v;
                  })
                }
                label="Roll over"
              />
            </div>
            {!overspent && moveBox}
          </>
        )}
        {recent.length > 0 && (
          <Section title="Recent">
            <List>
              {recent.map((t) => (
                <ListRow key={t.id} title={t.payee} subtitle={fmtDay(t.date)} trailing={<span className="tabular-nums">{fmt(t.amount_cents)}</span>} />
              ))}
            </List>
          </Section>
        )}
      </div>
    </Sheet>
  );
}

function GoalCard({ data, g, fmt, onClick }: { data: BudgetData; g: Goal; fmt: (c: number, o?: { whole?: boolean }) => string; onClick: () => void }) {
  const have = goalProgress(data, g.account_id, g.saved_cents);
  const pct = g.target_cents ? have / g.target_cents : 0;
  let need: string | null = null;
  if (g.target_date && have < g.target_cents) {
    const days = Math.round((new Date(`${g.target_date}T00:00:00`).getTime() - Date.now()) / 86_400_000);
    if (days > 0) need = `${fmt(Math.ceil((g.target_cents - have) / Math.max(1, Math.floor(days / 14))), { whole: true })} a fortnight to ${fmtDay(g.target_date)}`;
    else need = "Past its date";
  }
  const acct = data.accounts.find((a) => a.id === g.account_id);
  return (
    <Card onClick={onClick} className="flex items-center gap-4">
      <ProgressRing value={pct} size={60}>
        {Math.round(pct * 100)}%
      </ProgressRing>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">
          {g.emoji} {g.name}
        </p>
        <p className="text-xs tabular-nums text-[var(--text-muted)]">
          {fmt(have, { whole: true })} of {fmt(g.target_cents, { whole: true })}
        </p>
        {need && <p className="text-xs text-[var(--text-muted)]">{need}</p>}
        {acct && <Pill className="mt-1">{acct.name}</Pill>}
      </div>
    </Card>
  );
}

function GoalSheet({ item, goal, onClose }: { item: H; goal: Goal | null; onClose: () => void }) {
  const data = item.data;
  const [name, setName] = useState(goal?.name ?? "");
  const [target, setTarget] = useState(goal ? String(goal.target_cents / 100) : "");
  const [date, setDate] = useState(goal?.target_date ?? "");
  const [account, setAccount] = useState(goal?.account_id ?? "");
  const [saved, setSaved] = useState(goal ? String(goal.saved_cents / 100) : "0");
  const [emoji, setEmoji] = useState(goal?.emoji ?? "🎯");
  const savers = data.accounts.filter((a) => !a.archived);
  const t = parseMoney(target);
  const save = async () => {
    if (!name.trim() || !Number.isFinite(t) || t <= 0) return;
    try {
      if (!goal) {
        const r = await item.runAction("add_goal", { name: name.trim(), target: t / 100, target_date: date || null, account_id: account || null, saved: account ? 0 : Math.max(0, parseMoney(saved) || 0) / 100, emoji });
        toast.success(r.summary);
      } else {
        // Only what changed in the sheet (the goal may have moved on meanwhile — an AI top-up…).
        const next: Partial<Goal> = {
          name: name.trim(),
          target_cents: t,
          target_date: date || null,
          account_id: account || null,
          saved_cents: Math.max(0, parseMoney(saved) || 0),
          emoji,
        };
        const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => goal[k as keyof Goal] !== v)) as Partial<Goal>;
        item.update((d) => {
          const g = d.goals.find((x) => x.id === goal.id);
          if (g) Object.assign(g, changed);
        });
      }
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={goal ? "Edit goal" : "New savings goal"}
      footer={
        <>
          {goal && (
            <ItemButton
              variant="ghost"
              onClick={() => {
                item.update((d) => {
                  const g = d.goals.find((x) => x.id === goal.id);
                  if (g) g.done = true;
                });
                onClose();
              }}
            >
              Mark done
            </ItemButton>
          )}
          <ItemButton variant="primary" className="flex-1" disabled={!name.trim() || !Number.isFinite(t) || t <= 0} onClick={() => void save()}>
            {goal ? "Save" : "Create goal"}
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-[72px_1fr] gap-3">
          <Field label="Emoji">
            <TextInput value={emoji} onChange={(e) => setEmoji(e.target.value.slice(0, 4))} className="text-center" />
          </Field>
          <Field label="Name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Emergency fund" maxLength={80} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Target">
            <TextInput inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="10000" className="tabular-nums" />
          </Field>
          <Field label="By (optional)">
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Track with an account" hint="Its balance is the progress — perfect for an Up saver">
          <Select value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">No — I'll enter what's saved</option>
            {savers.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        {!account && (
          <Field label="Saved so far">
            <TextInput inputMode="decimal" value={saved} onChange={(e) => setSaved(e.target.value)} className="tabular-nums" />
          </Field>
        )}
      </div>
    </Sheet>
  );
}
