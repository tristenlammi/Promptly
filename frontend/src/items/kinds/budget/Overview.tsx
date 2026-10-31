import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Banknote, CalendarClock, CheckCircle2, ChevronRight, CreditCard, Home, Info, LineChart, PiggyBank, Settings2, Sparkles, Tag, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { Card, ItemButton, List, ListRow, Page, ProgressRing, Section, addDays, fmtDay, todayISO } from "@/items/ui";
import { cn } from "@/utils/cn";

import { CashFlowBars } from "./CashFlow";
import { Bar, CatBadge, Pill, useMoney } from "./common";
import { budgetTable, cashflowMonths, catIndex, counts, currentMonth, daysUntil, excludedAccounts, goalProgress, isLive, monthLabel, monthRange, nextPayday, spendingByCategory, upcoming, addMonths } from "./logic";
import { SettingsSheet, UpConnect } from "./Settings";
import type { BudgetData } from "./types";

export function OverviewView({ item, isPhone, ask, goTo }: ItemViewProps<BudgetData>) {
  const data = item.data;
  const fmt = useMoney(item);
  const [settings, setSettings] = useState(false);
  const today = todayISO();
  const sd = data.settings.month_start_day || 1;
  const month = currentMonth(data, today);
  const [start, end] = monthRange(month, sd);
  const table = useMemo(() => budgetTable(data, month), [data, month]);
  const flow = useMemo(() => cashflowMonths(data, month, 6), [data, month]);
  const spend = useMemo(() => spendingByCategory(data, start, end), [data, start, end]);
  const bills = useMemo(() => upcoming(data, 14, today), [data, today]);
  const cats = useMemo(() => catIndex(data), [data]);
  const thisFlow = flow[flow.length - 1] ?? { in: 0, out: 0 };
  const accounts = data.accounts.filter((a) => !a.archived);
  const cash = accounts.filter((a) => a.on_budget && ["transactional", "saver", "cash"].includes(a.type)).reduce((n, a) => n + a.balance_cents, 0);
  const netWorth = accounts.reduce((n, a) => n + a.balance_cents, 0);
  const daysLeft = Math.max(1, daysUntil(end, today) + 1);
  const payday = nextPayday(data, today);
  const toPayday = payday ? Math.max(1, daysUntil(payday, today)) : null;
  const budgeted = table.assigned > 0;
  const left = table.assigned - table.spent;
  const billsBeforeEnd = bills.filter((b) => b.date <= end).reduce((n, b) => n + b.sub.amount_cents, 0);
  const safe = budgeted ? Math.max(0, left - billsBeforeEnd) : null;

  const insights = useMemo(() => {
    const out: { tone: "warn" | "bad" | "good" | "neutral"; icon?: "tag" | "up" | "down"; text: string; action?: () => void; cta?: string }[] = [];
    const unc = data.transactions.filter((t) => !t.category_id && !t.splits.length && !t.transfer && t.date >= start).length;
    if (unc) out.push({ tone: "warn", icon: "tag", text: `${unc} transaction${unc === 1 ? "" : "s"} this month need a category.`, action: () => goTo("transactions"), cta: "Sort" });
    const off = excludedAccounts(data);
    const check = data.transactions.filter((t) => t.review).length;
    if (check) out.push({ tone: "warn", text: `${check} split transaction${check === 1 ? "" : "s"} changed at the bank — check the parts.`, action: () => goTo("transactions"), cta: "Check" });
    for (const r of table.overspent.slice(0, 2)) out.push({ tone: "bad", text: `${r.name} is ${fmt(-r.available, { whole: true })} over budget.`, action: () => goTo("budget"), cta: "Cover" });
    // Pace vs the same point last month.
    const [ps, pe] = monthRange(addMonths(month, -1), sd);
    const elapsed = daysUntil(today, start); // days since the month started
    const lastAtPoint = data.transactions
      .filter((t) => counts(t, off) && t.amount_cents < 0 && t.date >= ps && t.date <= pe && t.date <= addDays(ps, elapsed))
      .reduce((n, t) => n - t.amount_cents, 0);
    const nowSpent = thisFlow.out;
    if (lastAtPoint > 0 && nowSpent > 0) {
      const d = (nowSpent - lastAtPoint) / lastAtPoint;
      if (Math.abs(d) >= 0.15)
        out.push({ tone: d > 0 ? "warn" : "good", icon: d > 0 ? "up" : "down", text: `You've spent ${Math.round(Math.abs(d) * 100)}% ${d > 0 ? "more" : "less"} than at this point last month.` });
    }
    const pc = data.subscriptions.filter((s) => isLive(s) && s.price_change && s.price_change.on >= addDays(today, -60));
    for (const s of pc.slice(0, 2)) out.push({ tone: "warn", icon: "up", text: `${s.name} went up to ${fmt(s.price_change!.to_cents)}.`, action: () => goTo("subscriptions"), cta: "Review" });
    const maybe = data.subscriptions.filter((s) => (s.user_status ?? s.status) === "maybe_cancelled").length;
    if (maybe) out.push({ tone: "neutral", text: `${maybe} subscription${maybe === 1 ? " has" : "s have"} stopped charging — confirm they're cancelled.`, action: () => goTo("subscriptions"), cta: "Check" });
    const done = flow.slice(0, -1).filter((f) => f.in > 0);
    if (done.length >= 2) {
      const inn = done.reduce((n, f) => n + f.in, 0);
      const o = done.reduce((n, f) => n + f.out, 0);
      const rate = (inn - o) / inn;
      out.push({ tone: rate >= 0.2 ? "good" : rate >= 0 ? "neutral" : "bad", text: `You've kept ${Math.round(rate * 100)}% of your income over the last ${done.length} months${rate >= 0.2 ? " — great work." : rate < 0 ? " — spending is above income." : "."}` });
    }
    return out.slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, table, flow, month]);

  const totalDays = daysUntil(end, start) + 1;
  const dayNo = Math.min(totalDays, daysUntil(today, start) + 1);
  const pace = Math.min(1, dayNo / Math.max(1, totalDays));
  const goals = data.goals.filter((g) => !g.done);
  const perDay = safe !== null ? Math.floor(safe / (toPayday ?? daysLeft)) : null;

  const hero = (
    <Card className="flex flex-col gap-3">
      {budgeted ? (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-[var(--text-muted)]">{left < 0 ? "Over budget by" : "Left to spend"}</p>
              <p className={cn("text-4xl font-semibold tabular-nums tracking-tight", left < 0 ? "text-[var(--danger)]" : "text-[var(--text)]")} aria-live="polite">
                {fmt(Math.abs(left), { whole: true })}
              </p>
            </div>
            {perDay !== null && left > 0 && (
              <div className="shrink-0 rounded-xl bg-[var(--surface-2)] px-3 py-2 text-right">
                <p className="text-lg font-semibold leading-tight tabular-nums">{fmt(perDay, { whole: true })}</p>
                <p className="text-[11px] text-[var(--text-muted)]">a day {toPayday ? "to payday" : "this month"}</p>
              </div>
            )}
          </div>
          <div className="relative pt-1">
            <Bar value={table.assigned ? table.spent / table.assigned : 0} over={left < 0} />
            {/* Where spending would be today if it were even across the month. */}
            <span aria-hidden title="Today" className="absolute top-0 h-4 w-0.5 rounded-full bg-[var(--text)] opacity-60" style={{ left: `calc(${pace * 100}% - 1px)` }} />
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
            <span className="tabular-nums">
              {fmt(table.spent, { whole: true })} spent of {fmt(table.assigned, { whole: true })}
            </span>
            <span className="tabular-nums">
              Day {dayNo} of {totalDays}
            </span>
          </div>
          {left < 0 ? (
            <div className="flex items-center gap-2 rounded-xl bg-[color-mix(in_srgb,var(--danger)_9%,transparent)] px-3 py-2 text-xs">
              <span className="flex-1">
                {table.overspent.length} categor{table.overspent.length === 1 ? "y is" : "ies are"} over. Move money from one with some left, or raise the budget.
              </span>
              <ItemButton size="sm" onClick={() => goTo("budget")}>
                Fix
              </ItemButton>
            </div>
          ) : (
            billsBeforeEnd > 0 && <p className="text-xs text-[var(--text-muted)]">Allows for {fmt(billsBeforeEnd, { whole: true })} of bills still to come this month.</p>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-[var(--text-muted)]">Spent this month</p>
          <p className="text-4xl font-semibold tabular-nums tracking-tight">{fmt(thisFlow.out, { whole: true })}</p>
          <div className="flex flex-wrap gap-2">
            <ItemButton size="sm" variant="primary" icon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => ask("Build me a monthly budget from my last 3 months of spending.")}>
              Draft a budget
            </ItemButton>
            <ItemButton size="sm" onClick={() => goTo("budget")}>
              Set budgets
            </ItemButton>
          </div>
        </div>
      )}
    </Card>
  );

  const stats = (
    <div className="grid grid-cols-3 gap-3">
      {[
        { label: "In", icon: ArrowDownLeft, value: fmt(thisFlow.in, { whole: true }), cls: "text-[var(--success)]" },
        { label: "Out", icon: ArrowUpRight, value: fmt(thisFlow.out, { whole: true }), cls: "" },
        { label: "Cash", icon: Wallet, value: accounts.length ? fmt(cash, { whole: true }) : "—", cls: "" },
      ].map((x) => (
        <Card key={x.label} className="flex min-w-0 flex-col gap-0.5 !p-3 sm:!p-4">
          <span className="flex items-center gap-1 text-xs font-medium text-[var(--text-muted)]">
            <x.icon className="h-3.5 w-3.5" /> {x.label}
          </span>
          <span className={cn("truncate text-lg font-semibold tabular-nums", x.cls)}>{x.value}</span>
        </Card>
      ))}
    </div>
  );

  const insightBlock = insights.length > 0 && (
    <Section title="Insights">
      <List>
        {insights.map((x, i) => {
          const Icon = x.icon === "tag" ? Tag : x.icon === "up" ? TrendingUp : x.icon === "down" ? TrendingDown : x.tone === "bad" ? AlertTriangle : x.tone === "good" ? CheckCircle2 : Info;
          const tint = x.tone === "bad" ? "var(--danger)" : x.tone === "good" ? "var(--success)" : x.tone === "warn" ? "var(--warning,#b7791f)" : "var(--text-muted)";
          const body = (
            <>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: `color-mix(in srgb, ${tint} 14%, transparent)`, color: tint }}>
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 text-[var(--text)]">{x.text}</span>
              {x.action && (
                <span className="flex shrink-0 items-center gap-0.5 text-xs font-semibold text-[var(--item-accent)]">
                  {x.cta}
                  <ChevronRight className="h-3.5 w-3.5" />
                </span>
              )}
            </>
          );
          return x.action ? (
            <button
              key={i}
              type="button"
              onClick={x.action}
              className="flex min-h-[52px] w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
            >
              {body}
            </button>
          ) : (
            <div key={i} className="flex min-h-[52px] items-center gap-3 px-3 py-2.5 text-sm">
              {body}
            </div>
          );
        })}
      </List>
    </Section>
  );

  const cashflowBlock = data.transactions.length > 0 && (
    <Section
      title="Cash flow"
      hint="Money in vs spending by month"
      action={
        <ItemButton size="sm" variant="ghost" icon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => ask("Review my last month: where did my money go, what changed, and one thing to improve.")}>
          Review
        </ItemButton>
      }
    >
      <Card>
        <CashFlowBars months={flow} current={month} fmt={fmt} height={isPhone ? 110 : 140} />
      </Card>
    </Section>
  );

  const whereBlock = spend.rows.length > 0 && (
    <Section
      title="Where it went"
      hint={`${fmt(spend.total, { whole: true })} this month`}
      action={
        <ItemButton size="sm" variant="ghost" onClick={() => goTo("budget")}>
          Budget
        </ItemButton>
      }
    >
      <List>
        {spend.rows.slice(0, 6).map((r) => {
          const row = table.rows.find((x) => x.id === r.id);
          const budget = row ? row.assigned + row.carried : 0;
          return (
            <div key={r.id} className="flex flex-col gap-1.5 px-3 py-2.5">
              <div className="flex items-center gap-2 text-sm">
                <span aria-hidden>{r.emoji}</span>
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                <span className="font-semibold tabular-nums">{fmt(r.spent, { whole: true })}</span>
                {budget > 0 && <span className="min-w-[4.5rem] text-right text-xs tabular-nums text-[var(--text-muted)]">of {fmt(budget, { whole: true })}</span>}
              </div>
              <Bar value={budget ? r.spent / budget : r.spent / spend.rows[0].spent} over={budget > 0 && r.spent > budget} />
            </div>
          );
        })}
      </List>
    </Section>
  );

  const comingBlock = (
    <Section
      title="Coming up"
      hint={bills.length ? `${fmt(bills.reduce((n, b) => n + b.sub.amount_cents, 0), { whole: true })} in the next 14 days` : undefined}
      action={
        <ItemButton size="sm" variant="ghost" onClick={() => goTo("subscriptions")}>
          All bills
        </ItemButton>
      }
    >
      {bills.length === 0 ? (
        <Card className="flex items-center gap-3 text-sm text-[var(--text-muted)]">
          <CalendarClock className="h-5 w-5 shrink-0" />
          No bills or subscriptions due in the next two weeks.
        </Card>
      ) : (
        <List>
          {bills.slice(0, isPhone ? 4 : 6).map((b) => {
            const d = daysUntil(b.date, today);
            return (
              <ListRow
                key={`${b.sub.id}${b.date}`}
                onClick={() => goTo("subscriptions")}
                leading={<CatBadge cat={b.sub.category_id ? cats.get(b.sub.category_id) : null} size={34} />}
                title={b.sub.name}
                subtitle={d <= 0 ? "Today" : d === 1 ? "Tomorrow" : `${fmtDay(b.date)} · in ${d} days`}
                trailing={
                  <span className="font-semibold tabular-nums text-[var(--text)]">
                    {b.sub.variable ? "~" : ""}
                    {fmt(b.sub.amount_cents)}
                  </span>
                }
              />
            );
          })}
        </List>
      )}
    </Section>
  );

  const goalsBlock = goals.length > 0 && (
    <Section
      title="Goals"
      action={
        <ItemButton size="sm" variant="ghost" onClick={() => goTo("budget")}>
          All
        </ItemButton>
      }
    >
      <List>
        {goals.slice(0, 4).map((g) => {
          const have = goalProgress(data, g.account_id, g.saved_cents);
          const pct = g.target_cents ? Math.min(1, have / g.target_cents) : 0;
          return (
            <ListRow
              key={g.id}
              onClick={() => goTo("budget")}
              leading={
                <ProgressRing value={pct} size={38}>
                  <span className="text-[10px]">{Math.round(pct * 100)}%</span>
                </ProgressRing>
              }
              title={`${g.emoji ? `${g.emoji} ` : ""}${g.name}`}
              subtitle={`${fmt(have, { whole: true })} of ${fmt(g.target_cents, { whole: true })}${g.target_date ? ` · by ${fmtDay(g.target_date)}` : ""}`}
            />
          );
        })}
      </List>
    </Section>
  );

  const accountsBlock = (
    <Section title="Accounts" hint={accounts.length ? `Net worth ${fmt(netWorth, { whole: true })}` : undefined}>
      {accounts.length === 0 ? (
        <UpConnect item={item} compact />
      ) : (
        <List>
          {accounts.slice(0, 8).map((a) => (
            <ListRow
              key={a.id}
              onClick={() => setSettings(true)}
              leading={(() => {
                const Icon = a.type === "saver" ? PiggyBank : a.type === "credit" || a.type === "loan" ? CreditCard : a.type === "home_loan" ? Home : a.type === "investment" ? LineChart : a.type === "cash" ? Banknote : Wallet;
                return (
                  <span className="flex h-[34px] w-[34px] items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--item-accent)_12%,var(--surface-2))] text-[var(--item-accent)]">
                    <Icon className="h-4 w-4" />
                  </span>
                );
              })()}
              title={
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{a.name}</span>
                  {a.source === "up" && <Pill tone="accent">Up</Pill>}
                </span>
              }
              trailing={<span className={cn("font-semibold tabular-nums", a.balance_cents < 0 ? "text-[var(--danger)]" : "text-[var(--text)]")}>{fmt(a.balance_cents)}</span>}
            />
          ))}
        </List>
      )}
    </Section>
  );

  return (
    <Page wide>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold tracking-tight text-[var(--text)]">{monthLabel(month, sd)}</h2>
          <p className="text-xs text-[var(--text-muted)]">
            {daysLeft} day{daysLeft === 1 ? "" : "s"} left{payday ? ` · payday ${fmtDay(payday)}` : ""}
          </p>
        </div>
        <ItemButton size="sm" icon={<Settings2 className="h-4 w-4" />} onClick={() => setSettings(true)}>
          {isPhone ? "Accounts" : "Accounts & settings"}
        </ItemButton>
      </div>

      {data.up.status === "disconnected" && (
        <button type="button" onClick={() => setSettings(true)} className="flex items-center gap-3 rounded-2xl border border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] p-3 text-left text-sm" role="alert">
          <AlertTriangle className="h-5 w-5 shrink-0 text-[var(--danger)]" />
          <span className="flex-1">Up stopped accepting your token, so syncing has paused. Tap to paste a new one.</span>
        </button>
      )}

      {isPhone ? (
        // Phone: what needs doing first, then the story of the month.
        <div className="flex flex-col gap-5">
          {hero}
          {stats}
          {insightBlock}
          {comingBlock}
          {whereBlock}
          {cashflowBlock}
          {goalsBlock}
          {accountsBlock}
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-5">
          <div className="flex min-w-0 flex-col gap-5">
            {hero}
            {stats}
            {cashflowBlock}
            {whereBlock}
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            {insightBlock}
            {comingBlock}
            {goalsBlock}
            {accountsBlock}
          </div>
        </div>
      )}

      {/* Room under the last card so the Add button never covers it. */}
      {isPhone && <div aria-hidden className="h-14" />}
      <SettingsSheet item={item} open={settings} onClose={() => setSettings(false)} />
    </Page>
  );
}
