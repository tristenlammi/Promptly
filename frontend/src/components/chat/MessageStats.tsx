import { Clock, Coins, Cpu, Info, Zap } from "lucide-react";

import { cn } from "@/utils/cn";

interface MessageStatsProps {
  promptTokens?: number | null;
  completionTokens?: number | null;
  ttftMs?: number | null;
  totalMs?: number | null;
  costUsd?: number | null;
  className?: string;
}

/** Render a USD figure with appropriate precision.
 *
 *  Tiny figures (<$0.01) get four decimals — typical model token costs
 *  land around $0.0001-$0.01, and rounding to two would just print
 *  "$0.00" for almost every message. Larger figures collapse back to
 *  the conventional two decimals.
 */
function formatCostUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/** Format a millisecond duration as a compact human string. */
function formatMs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(2)} s`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remainder}s`;
}

function formatTokens(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  return n.toLocaleString();
}

/**
 * Tiny Info icon + hover/focus tooltip showing per-message performance
 * metrics. Renders nothing if no metrics are available (e.g. historical
 * messages from before the metrics migration). Pure CSS — no portal — so
 * it works inside the message column without extra plumbing.
 */
export function MessageStats({
  promptTokens,
  completionTokens,
  ttftMs,
  totalMs,
  costUsd,
  className,
}: MessageStatsProps) {
  const ttft = formatMs(ttftMs);
  const total = formatMs(totalMs);
  const prompt = formatTokens(promptTokens);
  const completion = formatTokens(completionTokens);
  const cost =
    typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0
      ? formatCostUsd(costUsd)
      : null;

  // If we have literally nothing to show, skip the UI entirely.
  if (!ttft && !total && !prompt && !completion && !cost) return null;

  const rows: Array<{
    icon: React.ReactNode;
    label: string;
    value: string;
  }> = [];
  if (ttft) {
    rows.push({
      icon: <Zap className="h-3 w-3" />,
      label: "Thought for",
      value: ttft,
    });
  }
  if (total) {
    rows.push({
      icon: <Clock className="h-3 w-3" />,
      label: "Total time",
      value: total,
    });
  }
  if (prompt) {
    rows.push({
      icon: <Cpu className="h-3 w-3" />,
      label: "Prompt tokens",
      value: prompt,
    });
  }
  if (completion) {
    rows.push({
      icon: <Cpu className="h-3 w-3" />,
      label: "Response tokens",
      value: completion,
    });
  }

  const summary = [
    ttft && `thought ${ttft}`,
    total && `total ${total}`,
    prompt && `${prompt} prompt tokens`,
    completion && `${completion} response tokens`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {/* Performance metrics — grey info icon, present whenever any
          token / latency value is available. */}
      {(ttft || total || prompt || completion) && (
        <span className="group/stats relative inline-flex">
          <button
            type="button"
            className={cn(
              "inline-flex h-4 w-4 items-center justify-center rounded-full",
              "text-[var(--text-muted)] transition",
              "hover:bg-black/[0.05] hover:text-[var(--text)]",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
              "dark:hover:bg-white/[0.08]"
            )}
            aria-label={`Message stats: ${summary}`}
          >
            <Info className="h-3 w-3" aria-hidden />
          </button>
          <div
            role="tooltip"
            className={cn(
              "pointer-events-none absolute left-0 top-full z-20 mt-1.5",
              "w-max min-w-[10rem] max-w-[16rem] rounded-card border shadow-lg",
              "border-[var(--border)] bg-[var(--surface)] px-3 py-2",
              "opacity-0 transition-opacity duration-100",
              "group-hover/stats:opacity-100 group-focus-within/stats:opacity-100"
            )}
          >
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Response stats
            </div>
            <ul className="space-y-1 text-xs">
              {rows.map((row) => (
                <li
                  key={row.label}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
                    {row.icon}
                    {row.label}
                  </span>
                  <span className="font-medium tabular-nums text-[var(--text)]">
                    {row.value}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </span>
      )}

      {/* Cost — green sibling icon. Only renders when the provider
          actually reported a cost (cost > 0). Same hover/focus
          tooltip pattern as the stats icon for consistency. */}
      {cost && (
        <span className="group/cost relative inline-flex">
          <button
            type="button"
            className={cn(
              "inline-flex h-4 w-4 items-center justify-center rounded-full",
              "text-emerald-600 transition",
              "hover:bg-emerald-500/10 hover:text-emerald-700",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500",
              "dark:text-emerald-400 dark:hover:bg-emerald-400/10 dark:hover:text-emerald-300"
            )}
            aria-label={`Estimated cost: ${cost}`}
          >
            <Info className="h-3 w-3" aria-hidden />
          </button>
          <div
            role="tooltip"
            className={cn(
              "pointer-events-none absolute left-0 top-full z-20 mt-1.5",
              "w-max min-w-[10rem] max-w-[16rem] rounded-card border shadow-lg",
              "border-[var(--border)] bg-[var(--surface)] px-3 py-2",
              "opacity-0 transition-opacity duration-100",
              "group-hover/cost:opacity-100 group-focus-within/cost:opacity-100"
            )}
          >
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              Estimated cost
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Coins className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              <span className="font-medium tabular-nums text-[var(--text)]">
                {cost} USD
              </span>
            </div>
            <div className="mt-1 text-[10px] text-[var(--text-muted)]">
              Provider-reported total for this reply (model + tools).
            </div>
          </div>
        </span>
      )}
    </span>
  );
}
