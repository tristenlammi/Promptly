import { cn } from "@/utils/cn";
import type { TaskRunStatus } from "@/api/tasks";

const STYLES: Record<TaskRunStatus, string> = {
  pending: "bg-[var(--accent)]/10 text-[var(--accent)]",
  running: "bg-[var(--accent)]/10 text-[var(--accent)]",
  success: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  warning: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
};

const LABELS: Record<TaskRunStatus, string> = {
  pending: "Queued",
  running: "Running",
  success: "Done",
  warning: "Check",
  failed: "Failed",
};

export function RunStatusChip({ status }: { status: TaskRunStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        STYLES[status]
      )}
    >
      {(status === "running" || status === "pending") && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {LABELS[status]}
    </span>
  );
}

/** Compact relative time, e.g. "2h ago" / "in 3h". */
export function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const future = diff > 0;
  let label: string;
  if (mins < 1) label = "now";
  else if (mins < 60) label = `${mins}m`;
  else if (mins < 60 * 24) label = `${Math.round(mins / 60)}h`;
  else label = `${Math.round(mins / (60 * 24))}d`;
  if (label === "now") return "just now";
  return future ? `in ${label}` : `${label} ago`;
}
