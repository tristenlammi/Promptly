import { AlertTriangle, Bell, BellOff, Check, CircleSlash, Plus, Radar, RefreshCw, Sparkles, TrendingUp, X } from "lucide-react";
import { useMemo, useState } from "react";

import { toast } from "@/store/toastStore";
import type { ItemViewProps } from "@/items/types";
import { Card, EmptyState, Field, IconButton, ItemButton, List, ListRow, Page, Section, Segmented, Select, Sheet, TextInput, Toggle, addDays, fmtDay, todayISO } from "@/items/ui";
import { cn } from "@/utils/cn";

import { errorText } from "./api";
import { BillsCalendar } from "./BillsCalendar";
import { CatBadge, Pill, useMoney, useWidth, type H } from "./common";
import { CADENCE_LABEL, PER_MONTH, catIndex, daysUntil, effectiveStatus, isLive, parseMoney } from "./logic";
import type { BudgetData, Cadence, Subscription } from "./types";

type View = "active" | "check" | "off";

export function SubscriptionsView({ item, ask, isPhone }: ItemViewProps<BudgetData>) {
  const data = item.data;
  const fmt = useMoney(item);
  const cats = useMemo(() => catIndex(data), [data]);
  const [view, setView] = useState<View>("active");
  const [sort, setSort] = useState<"next" | "cost">("next");
  const [open, setOpen] = useState<Subscription | null>(null);
  const [adding, setAdding] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [widthRef, pageW] = useWidth<HTMLDivElement>();
  const sideBySide = !isPhone && pageW >= 980;
  const subs = data.subscriptions;
  const live = subs.filter(isLive);
  const monthly = live.reduce((n, s) => n + s.monthly_cents, 0);
  const subsOnly = live.filter((s) => s.kind === "subscription").reduce((n, s) => n + s.monthly_cents, 0);
  const alerts = subs.filter(
    (s) => s.charged_after_cancel || (s.price_change && s.price_change.on >= new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10) && isLive(s)),
  );
  const list = useMemo(() => {
    const pick = subs.filter((s) => {
      const st = effectiveStatus(s);
      if (view === "active") return st === "active" || st === "confirmed";
      if (view === "check") return st === "maybe_cancelled";
      return st === "ignored" || st === "cancelled";
    });
    return pick.sort((a, b) => (sort === "cost" ? b.monthly_cents - a.monthly_cents : (a.next_due ?? "9999").localeCompare(b.next_due ?? "9999")));
  }, [subs, view, sort]);
  const checkCount = subs.filter((s) => effectiveStatus(s) === "maybe_cancelled").length;
  // By next charge, the list reads as a timeline: this week, the next few weeks, later.
  const groups = useMemo(() => {
    if (sort !== "next" || view !== "active") return [{ label: "", items: list }];
    const today = todayISO();
    const wk = addDays(today, 7);
    const mo = addDays(today, 31);
    const out = [
      { label: "Next 7 days", items: [] as Subscription[] },
      { label: "Within a month", items: [] as Subscription[] },
      { label: "Later", items: [] as Subscription[] },
    ];
    for (const s of list) out[!s.next_due || s.next_due > mo ? 2 : s.next_due <= wk ? 0 : 1].items.push(s);
    return out.filter((g) => g.items.length);
  }, [list, sort, view]);

  const rescan = async () => {
    setScanning(true);
    try {
      const r = await item.runAction("detect_subscriptions");
      toast.success(r.summary);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setScanning(false);
    }
  };

  const calendar = !isPhone && live.length > 0 && <BillsCalendar data={data} fmt={fmt} onOpen={(s) => setOpen(s)} />;

  return (
    <Page wide>
      <div ref={widthRef} aria-hidden className="-mb-5 h-0" />
      <div className={cn("grid gap-3", isPhone ? "grid-cols-2" : "grid-cols-4")}>
        <Card className="col-span-2 flex flex-col gap-1 md:col-span-2">
          <span className="text-xs font-medium text-[var(--text-muted)]">Recurring each month</span>
          <span className="text-3xl font-semibold tabular-nums tracking-tight text-[var(--text)]">{fmt(monthly)}</span>
          <span className="text-xs text-[var(--text-muted)]">
            {fmt(monthly * 12, { whole: true })} a year · {live.length} active
          </span>
        </Card>
        <Card className="flex flex-col gap-1">
          <span className="text-xs font-medium text-[var(--text-muted)]">Subscriptions</span>
          <span className="text-xl font-semibold tabular-nums">{fmt(subsOnly, { whole: true })}</span>
          <span className="text-[11px] text-[var(--text-muted)]">a month</span>
        </Card>
        <Card className="flex flex-col gap-1">
          <span className="text-xs font-medium text-[var(--text-muted)]">Bills</span>
          <span className="text-xl font-semibold tabular-nums">{fmt(monthly - subsOnly, { whole: true })}</span>
          <span className="text-[11px] text-[var(--text-muted)]">a month</span>
        </Card>
      </div>

      {alerts.length > 0 && (
        <div className="flex flex-col gap-2" role="status">
          {alerts.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setOpen(s)}
              className="flex items-center gap-3 rounded-2xl border border-[color-mix(in_srgb,var(--warning,#d9902f)_45%,transparent)] bg-[color-mix(in_srgb,var(--warning,#d9902f)_10%,transparent)] p-3 text-left text-sm"
            >
              {s.charged_after_cancel ? (
                <AlertTriangle className="h-5 w-5 shrink-0 text-[var(--danger)]" />
              ) : (
                <TrendingUp className="h-5 w-5 shrink-0 text-[var(--warning,#b7791f)]" />
              )}
              <span className="min-w-0 flex-1">
                {s.charged_after_cancel ? (
                  <>
                    <b>{s.name}</b> charged you again on {fmtDay(s.last_date ?? todayISO())} after you marked it cancelled.
                  </>
                ) : (
                  <>
                    <b>{s.name}</b> went from {fmt(s.price_change!.from_cents)} to {fmt(s.price_change!.to_cents)} (
                    {fmt((s.price_change!.to_cents - s.price_change!.from_cents) * 12 * PER_MONTH[s.cadence], { whole: true })} a year more).
                  </>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      {!sideBySide && calendar}
      <div className={cn(sideBySide && "grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-start gap-5")}>
        <div className="flex min-w-0 flex-col gap-5">
          <div className={cn("flex gap-2", isPhone ? "flex-col" : "flex-wrap items-center")}>
            <Segmented
              value={view}
              onChange={setView}
              className={isPhone ? "w-full" : undefined}
              options={[
                { value: "active", label: "Active" },
                {
                  value: "check",
                  label: `To check${checkCount ? ` · ${checkCount}` : ""}`,
                },
                { value: "off", label: "Cancelled" },
              ]}
            />
            <div className={cn("flex items-center gap-2", !isPhone && "contents")}>
              <Segmented
                size="sm"
                value={sort}
                onChange={setSort}
                options={[
                  { value: "next", label: "By date" },
                  { value: "cost", label: "By cost" },
                ]}
              />
              <div className="ml-auto flex items-center gap-1.5">
                {isPhone ? (
                  <IconButton
                    label="Audit with AI"
                    icon={Sparkles}
                    onClick={() => ask("Audit my subscriptions: which could I cancel or downgrade, and how much would I save a year?")}
                  />
                ) : (
                  <ItemButton
                    size="sm"
                    icon={<Sparkles className="h-3.5 w-3.5" />}
                    onClick={() => ask("Audit my subscriptions: which could I cancel or downgrade, and how much would I save a year?")}
                  >
                    Audit
                  </ItemButton>
                )}
                {item.canEdit && (
                  <>
                    {isPhone ? (
                      <IconButton
                        label={scanning ? "Scanning…" : "Rescan transactions"}
                        icon={RefreshCw}
                        disabled={scanning}
                        className={scanning ? "animate-spin" : ""}
                        onClick={() => void rescan()}
                      />
                    ) : (
                      <ItemButton size="sm" icon={<RefreshCw className={cn("h-3.5 w-3.5", scanning && "animate-spin")} />} disabled={scanning} onClick={() => void rescan()}>
                        Rescan
                      </ItemButton>
                    )}
                    <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
                      Add
                    </ItemButton>
                  </>
                )}
              </div>
            </div>
          </div>

          {list.length === 0 ? (
            <EmptyState
              icon={Radar}
              title={view === "active" ? "No recurring charges found yet" : view === "check" ? "Nothing to check" : "Nothing cancelled or ignored"}
              text={
                view === "active"
                  ? "Subscriptions and bills are found automatically after a few months of transactions (3 charges, or 2 for yearly ones). Add one by hand any time."
                  : view === "check"
                    ? "Charges that stop arriving show up here so you can confirm you've cancelled them."
                    : "Mark a charge as cancelled and you'll be warned if it ever charges again."
              }
            />
          ) : (
            groups.map((g) => (
              <Section
                key={g.label || "all"}
                title={g.label || undefined}
                action={g.label ? <span className="text-xs tabular-nums text-[var(--text-muted)]">{fmt(g.items.reduce((n, x) => n + x.amount_cents, 0), { whole: true })}</span> : undefined}
              >
                <List>
                  {g.items.map((s) => {
                    const st = effectiveStatus(s);
                    const days = s.next_due ? daysUntil(s.next_due) : null;
                    return (
                      <ListRow
                        key={s.id}
                        onClick={() => setOpen(s)}
                        leading={<CatBadge cat={s.category_id ? cats.get(s.category_id) : null} size={40} />}
                        title={
                          <span className="flex items-center gap-1.5">
                            <span className="truncate">{s.name}</span>
                            {s.kind === "bill" && <Pill>Bill</Pill>}
                            {st === "confirmed" && <Check aria-label="Confirmed" className="h-3.5 w-3.5 text-[var(--success)]" />}
                            {s.price_change && <TrendingUp aria-label="Price changed" className="h-3.5 w-3.5 text-[var(--warning,#b7791f)]" />}
                            {!s.remind && <BellOff aria-label="No reminder" className="h-3.5 w-3.5 text-[var(--text-muted)]" />}
                          </span>
                        }
                        subtitle={
                          st === "maybe_cancelled"
                            ? `No charge since ${fmtDay(s.last_date ?? "")} — cancelled?`
                            : st === "cancelled"
                              ? `Cancelled ${s.cancelled_on ? fmtDay(s.cancelled_on) : ""}`
                              : `${CADENCE_LABEL[s.cadence]} · ${s.next_due ? (days !== null && days >= 0 && days <= 1 ? fmtDay(s.next_due) : `next ${fmtDay(s.next_due)}`) : "no date"}`
                        }
                        trailing={
                          <span className="flex flex-col items-end">
                            <span className="font-semibold tabular-nums text-[var(--text)]">
                              {s.variable ? "~" : ""}
                              {fmt(s.amount_cents)}
                            </span>
                            {s.cadence !== "monthly" && <span className="text-[11px] tabular-nums">{fmt(s.monthly_cents)}/mo</span>}
                          </span>
                        }
                      />
                    );
                  })}
                </List>
              </Section>
            ))
          )}
          <p className="px-1 text-xs text-[var(--text-muted)]">
            Found by looking for charges from the same merchant on a regular cycle (weekly to yearly) with a steady amount. Confidence, price changes and missed charges update
            after every sync.
          </p>
        </div>
        {sideBySide && <div className="sticky top-4">{calendar}</div>}
      </div>

      {open && <SubSheet item={item} sub={data.subscriptions.find((x) => x.id === open.id) ?? open} onClose={() => setOpen(null)} />}
      {adding && <AddSubSheet item={item} onClose={() => setAdding(false)} />}
    </Page>
  );
}

function SubSheet({ item, sub, onClose }: { item: H; sub: Subscription; onClose: () => void }) {
  const fmt = useMoney(item);
  const data = item.data;
  const [name, setName] = useState(sub.name);
  const charges = data.transactions.filter((t) => sub.transaction_ids.includes(t.id));
  const st = effectiveStatus(sub);
  const mark = async (status: "confirmed" | "ignored" | "cancelled" | "active") => {
    try {
      const r = await item.runAction("mark_subscription", {
        id: sub.id,
        status,
        ...(name.trim() && name.trim() !== sub.name ? { name: name.trim() } : {}),
      });
      toast.success(r.summary);
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  return (
    <Sheet open onClose={onClose} title={sub.name} size="md">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-[var(--surface-2)] p-2">
            <p className="text-[11px] text-[var(--text-muted)]">{CADENCE_LABEL[sub.cadence]}</p>
            <p className="text-sm font-semibold tabular-nums">
              {sub.variable ? "~" : ""}
              {fmt(sub.amount_cents)}
            </p>
          </div>
          <div className="rounded-xl bg-[var(--surface-2)] p-2">
            <p className="text-[11px] text-[var(--text-muted)]">Per year</p>
            <p className="text-sm font-semibold tabular-nums">{fmt(sub.monthly_cents * 12, { whole: true })}</p>
          </div>
          <div className="rounded-xl bg-[var(--surface-2)] p-2">
            <p className="text-[11px] text-[var(--text-muted)]">Next</p>
            <p className="text-sm font-semibold">{sub.next_due ? fmtDay(sub.next_due) : "—"}</p>
          </div>
        </div>
        {sub.price_change && (
          <p className="flex items-center gap-2 rounded-xl bg-[color-mix(in_srgb,var(--warning,#d9902f)_10%,transparent)] p-3 text-sm">
            <TrendingUp className="h-4 w-4 shrink-0" /> Price changed from {fmt(sub.price_change.from_cents)} to {fmt(sub.price_change.to_cents)} on {fmtDay(sub.price_change.on)}.
          </p>
        )}
        {sub.source === "detected" && (
          <p className="text-xs text-[var(--text-muted)]">
            Detected from {sub.occurrences} charges · {Math.round(sub.confidence * 100)}% confident
            {st === "maybe_cancelled" ? " · overdue, may be cancelled" : ""}
          </p>
        )}
        {item.canEdit && (
          <>
            <Field label="Name">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </Field>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-[var(--text-muted)]" /> Remind me the day before
              </span>
              <Toggle
                checked={sub.remind}
                onChange={(v) =>
                  item.update((d) => {
                    const s = d.subscriptions.find((x) => x.id === sub.id);
                    if (s) s.remind = v;
                  })
                }
                label="Remind me the day before"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {st !== "confirmed" && (
                <ItemButton icon={<Check className="h-4 w-4" />} onClick={() => void mark("confirmed")}>
                  Yes, it's recurring
                </ItemButton>
              )}
              {st !== "cancelled" && (
                <ItemButton icon={<CircleSlash className="h-4 w-4" />} onClick={() => void mark("cancelled")}>
                  I've cancelled it
                </ItemButton>
              )}
              {st !== "ignored" && sub.source === "detected" && (
                <ItemButton icon={<X className="h-4 w-4" />} onClick={() => void mark("ignored")}>
                  Not a subscription
                </ItemButton>
              )}
              {sub.user_status && (
                <ItemButton variant="ghost" onClick={() => void mark("active")}>
                  Back to automatic
                </ItemButton>
              )}
              {sub.source === "manual" && (
                <ItemButton
                  variant="ghost"
                  onClick={() => {
                    item.update((d) => {
                      d.subscriptions = d.subscriptions.filter((x) => x.id !== sub.id);
                    });
                    onClose();
                  }}
                >
                  Delete
                </ItemButton>
              )}
            </div>
          </>
        )}
        {charges.length > 0 && (
          <Section title="Charges">
            <List>
              {charges.map((t) => (
                <ListRow key={t.id} title={fmtDay(t.date, { long: true })} trailing={<span className="tabular-nums">{fmt(-t.amount_cents)}</span>} />
              ))}
            </List>
          </Section>
        )}
      </div>
    </Sheet>
  );
}

function AddSubSheet({ item, onClose }: { item: H; onClose: () => void }) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<Cadence>("monthly");
  const [next, setNext] = useState(todayISO());
  const [kind, setKind] = useState<"subscription" | "bill">("subscription");
  const cents = parseMoney(amount);
  const ok = name.trim() && Number.isFinite(cents) && cents > 0 && next;
  const save = async () => {
    try {
      const r = await item.runAction("add_subscription", {
        name: name.trim(),
        amount: Math.abs(cents) / 100,
        cadence,
        next_due: next,
        kind,
      });
      toast.success(r.summary);
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title="Track a subscription or bill"
      footer={
        <ItemButton variant="primary" block disabled={!ok} onClick={() => void save()}>
          Add
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-3">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "subscription", label: "Subscription" },
            { value: "bill", label: "Bill" },
          ]}
        />
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Car rego" maxLength={120} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="tabular-nums" />
          </Field>
          <Field label="How often">
            <Select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
              {(Object.keys(CADENCE_LABEL) as Cadence[]).map((c) => (
                <option key={c} value={c}>
                  {CADENCE_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Next due">
          <TextInput type="date" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
      </div>
    </Sheet>
  );
}
