import { cn } from "@/utils/cn";

import { monthLabel } from "./logic";

/*
 * Money in vs out per month as paired bars with the month's net under each
 * pair (Monarch's cash-flow card). Plain elements, not an axis chart: the
 * numbers that matter are printed, so nothing is lost to tiny axis labels.
 */
export function CashFlowBars({
  months,
  current,
  fmt,
  height = 132,
}: {
  months: { month: string; in: number; out: number }[];
  current: string;
  fmt: (c: number, o?: { sign?: boolean; whole?: boolean }) => string;
  height?: number;
}) {
  // Leading months with nothing in them (before the data starts) are noise.
  const first = months.findIndex((m) => m.in || m.out);
  const shown = first < 0 ? [] : months.slice(first);
  const max = Math.max(1, ...shown.map((m) => Math.max(m.in, m.out)));
  if (!shown.length) return <p className="py-6 text-center text-sm text-[var(--text-muted)]">No money in or out yet.</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2 sm:gap-3" style={{ height }} role="list" aria-label="Money in and out by month">
        {shown.map((m) => {
          const net = m.in - m.out;
          const label = monthLabel(m.month).split(" ")[0];
          return (
            <div
              key={m.month}
              role="listitem"
              aria-label={`${label}: in ${fmt(m.in, { whole: true })}, out ${fmt(m.out, { whole: true })}, net ${fmt(net, { sign: true, whole: true })}`}
              title={`${label}\nIn ${fmt(m.in, { whole: true })}\nOut ${fmt(m.out, { whole: true })}`}
              className={cn("flex h-full min-w-0 flex-1 items-end justify-center gap-1 rounded-lg px-1 pt-1", m.month === current && "bg-[color-mix(in_srgb,var(--item-accent)_7%,transparent)]")}
            >
              <span className="w-full max-w-[22px] rounded-t-md bg-[color-mix(in_srgb,var(--text-muted)_45%,transparent)]" style={{ height: `${Math.max(2, (m.in / max) * 100)}%` }} />
              <span className="w-full max-w-[22px] rounded-t-md bg-[var(--item-accent)]" style={{ height: `${Math.max(2, (m.out / max) * 100)}%` }} />
            </div>
          );
        })}
      </div>
      <div className="flex gap-2 sm:gap-3">
        {shown.map((m) => {
          const net = m.in - m.out;
          return (
            <div key={m.month} className="flex min-w-0 flex-1 flex-col items-center leading-tight">
              <span className={cn("text-[11px] font-medium", m.month === current ? "text-[var(--text)]" : "text-[var(--text-muted)]")}>
                {monthLabel(m.month).split(" ")[0].slice(0, 3)}
              </span>
              <span className={cn("truncate text-[11px] font-semibold tabular-nums", net >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]")}>
                {fmt(net, { sign: true, whole: true })}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 text-[11px] text-[var(--text-muted)]">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-[color-mix(in_srgb,var(--text-muted)_45%,transparent)]" /> Money in
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-[var(--item-accent)]" /> Spending
        </span>
        <span className="ml-auto">Net under each month</span>
      </div>
    </div>
  );
}
