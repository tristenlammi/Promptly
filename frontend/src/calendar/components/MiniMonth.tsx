import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/utils/cn";

import { addDays, addMonths, fmt, monthGrid, sameDay, startOfMonth, weekdayHeaders, ymd } from "../dates";

/** A small month to jump around with; ``dots`` marks days with events. */
export function MiniMonth({
  selected,
  onPick,
  dots,
  onMonthChange,
  className,
}: {
  selected: Date;
  onPick: (d: Date) => void;
  dots?: Set<string>;
  onMonthChange?: (month: Date) => void;
  className?: string;
}) {
  const [month, setMonth] = useState(() => startOfMonth(selected));
  const selKey = selected.getFullYear() * 12 + selected.getMonth();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setMonth(startOfMonth(selected));
  }, [selKey]);
  useEffect(() => {
    onMonthChange?.(month);
  }, [month, onMonthChange]);
  const { start, weeks } = monthGrid(month);
  const today = new Date();
  const heads = weekdayHeaders();

  return (
    <div className={cn("select-none", className)}>
      <div className="mb-1 flex items-center justify-between pl-1">
        <span className="text-sm font-semibold text-[var(--text)]">{fmt(month, { month: "long", year: "numeric" })}</span>
        <div className="flex">
          <button type="button" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button type="button" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-xs font-medium uppercase text-[var(--text-muted)]">
        {heads.map((h, i) => (
          <span key={i} className="py-1">
            {h.narrow}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 text-center">
        {Array.from({ length: weeks * 7 }, (_, i) => {
          const d = addDays(start, i);
          const inMonth = d.getMonth() === month.getMonth();
          const isToday = sameDay(d, today);
          const isSel = sameDay(d, selected);
          return (
            <button
              key={i}
              type="button"
              onClick={() => onPick(d)}
              aria-label={fmt(d, { weekday: "long", month: "long", day: "numeric" })}
              aria-current={isToday ? "date" : undefined}
              className="relative flex h-8 items-center justify-center"
            >
              <span
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full text-xs tabular-nums transition",
                  isToday
                    ? "bg-[var(--item-accent)] font-semibold text-white"
                    : isSel
                      ? "bg-[color-mix(in_srgb,var(--item-accent)_18%,transparent)] font-semibold text-[var(--text)]"
                      : inMonth
                        ? "text-[var(--text)] hover:bg-[var(--hover)]"
                        : "text-[var(--text-muted)] opacity-60 hover:bg-[var(--hover)]",
                )}
              >
                {d.getDate()}
              </span>
              {dots?.has(ymd(d)) && !isToday && <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-[var(--item-accent)]" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
