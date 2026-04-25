import { Target } from "lucide-react";

import type { ObjectiveMasteryEntry } from "@/api/types";
import { cn } from "@/utils/cn";

interface ObjectiveMasteryListProps {
  /** Mastery rows for a SINGLE unit. Caller filters. */
  entries: ObjectiveMasteryEntry[];
  /** Floor the completion gate enforces — shown as a tick mark on the bar. */
  floor?: number;
}

const DEFAULT_FLOOR = 75;

/** Per-objective mastery bars for one unit. Embedded inside the
 *  UnitCard's expanded view on the topic detail page. Shows each
 *  objective's score, floor, and a "last reviewed N days ago" hint
 *  so the student can see their spaced-repetition cadence at a glance.
 */
export function ObjectiveMasteryList({
  entries,
  floor = DEFAULT_FLOOR,
}: ObjectiveMasteryListProps) {
  if (!entries.length) {
    return null;
  }
  const sorted = [...entries].sort(
    (a, b) => a.objective_index - b.objective_index
  );
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
        <Target className="h-3 w-3" />
        Per-objective mastery
      </div>
      {sorted.map((row) => (
        <ObjectiveRow key={row.id} row={row} floor={floor} />
      ))}
    </div>
  );
}

function ObjectiveRow({
  row,
  floor,
}: {
  row: ObjectiveMasteryEntry;
  floor: number;
}) {
  const scoreColor =
    row.mastery_score >= floor
      ? "bg-emerald-500"
      : row.mastery_score >= Math.floor(floor * 0.5)
      ? "bg-amber-500"
      : "bg-[var(--accent)]";
  const hint =
    row.days_since_review == null
      ? "never reviewed"
      : row.days_since_review === 0
      ? "reviewed today"
      : `${row.days_since_review}d ago`;
  return (
    <div className="space-y-1">
      <div className="flex items-start justify-between gap-2 text-[11px]">
        <span className="line-clamp-2 flex-1 text-[var(--text)]">
          {row.objective_index + 1}. {row.objective_text}
        </span>
        <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
          {row.mastery_score}/100 · {hint}
          {row.is_due && (
            <span className="ml-1 rounded bg-amber-500/20 px-1 py-0.5 text-[9px] font-medium text-amber-700 dark:text-amber-300">
              due
            </span>
          )}
        </span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-[var(--border)]/50">
        <div
          className={cn("h-full transition-all", scoreColor)}
          style={{ width: `${Math.max(2, row.mastery_score)}%` }}
        />
        <div
          className="absolute top-0 h-full w-[1px] bg-[var(--text-muted)]/60"
          style={{ left: `${floor}%` }}
          title={`Unit-complete floor: ${floor}/100`}
        />
      </div>
    </div>
  );
}
