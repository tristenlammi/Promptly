import { useMemo } from "react";

import { addDays, parseDay, todayISO } from "@/items/ui";
import { cn } from "@/utils/cn";

import { CatBadge } from "./common";
import { catIndex, upcoming } from "./logic";
import type { BudgetData, Subscription } from "./types";

/*
 * Five weeks of bills and subscriptions on a calendar (Monarch's recurring
 * calendar): when the big ones land relative to payday is the whole point.
 * Desktop only — a phone reads the grouped list better.
 */
export function BillsCalendar({
  data,
  fmt,
  onOpen,
}: {
  data: BudgetData;
  fmt: (c: number, o?: { whole?: boolean }) => string;
  onOpen: (s: Subscription) => void;
}) {
  const today = todayISO();
  const cats = useMemo(() => catIndex(data), [data]);
  const { days, byDay, total } = useMemo(() => {
    const dow = (parseDay(today).getDay() + 6) % 7; // Monday = 0
    const first = addDays(today, -dow);
    const days = Array.from({ length: 35 }, (_, i) => addDays(first, i));
    const due = upcoming(data, 35 - dow - 1, today);
    const byDay = new Map<string, Subscription[]>();
    for (const x of due) byDay.set(x.date, [...(byDay.get(x.date) ?? []), x.sub]);
    return { days, byDay, total: due.reduce((n, x) => n + x.sub.amount_cents, 0) };
  }, [data, today]);
  const payday = data.settings.next_payday;
  const paydays = useMemo(() => {
    // Paydays inside the window, from the next one stepping by the pay cycle.
    const out = new Set<string>();
    if (!payday) return out;
    const step = data.settings.pay_frequency === "weekly" ? 7 : data.settings.pay_frequency === "fortnightly" ? 14 : 0;
    let d = payday;
    while (d >= days[0] && step) d = addDays(d, -step);
    for (let i = 0; i < 12 && d <= days[days.length - 1]; i++) {
      if (d >= days[0]) out.add(d);
      if (!step) break;
      d = addDays(d, step);
    }
    return out;
  }, [payday, data.settings.pay_frequency, days]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-sm font-semibold text-[var(--text)]">Next five weeks</h2>
        <span className="text-xs tabular-nums text-[var(--text-muted)]">{fmt(total, { whole: true })} due</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="grid grid-cols-7 border-b border-[var(--border)] bg-[var(--surface-2)] text-center text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <span key={d} className="py-1.5">
              {d}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((d, i) => {
            const subs = byDay.get(d) ?? [];
            const past = d < today;
            const date = parseDay(d);
            return (
              <div
                key={d}
                className={cn(
                  "flex min-h-[68px] min-w-0 flex-col gap-1 border-[var(--border)] p-1.5",
                  i % 7 !== 6 && "border-r",
                  i < 28 && "border-b",
                  past && "opacity-40",
                  d === today && "bg-[color-mix(in_srgb,var(--item-accent)_8%,transparent)]",
                )}
              >
                <span className="flex items-center gap-1 text-[11px] tabular-nums text-[var(--text-muted)]">
                  <span className={cn(d === today && "flex h-5 w-5 items-center justify-center rounded-full bg-[var(--item-accent)] font-semibold text-white")}>
                    {date.getDate() === 1 ? date.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : date.getDate()}
                  </span>
                  {paydays.has(d) && <span className="truncate rounded bg-[color-mix(in_srgb,var(--success)_16%,transparent)] px-1 text-[10px] font-semibold text-[var(--success)]">Payday</span>}
                </span>
                {subs.slice(0, 2).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onOpen(s)}
                    title={`${s.name} · ${fmt(s.amount_cents)}`}
                    className="flex min-w-0 items-center gap-1 rounded-md bg-[var(--surface-2)] px-1 py-0.5 text-left text-[10px] font-medium text-[var(--text)] transition hover:bg-[var(--hover)]"
                  >
                    <CatBadge cat={s.category_id ? cats.get(s.category_id) : null} size={14} />
                    <span className="shrink-0 tabular-nums">{fmt(s.amount_cents, { whole: true })}</span>
                    <span className="min-w-0 truncate font-normal text-[var(--text-muted)]">{s.name}</span>
                  </button>
                ))}
                {subs.length > 2 && <span className="px-1 text-[10px] text-[var(--text-muted)]">+{subs.length - 2} more</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
