import { HardDrive, Infinity as InfinityIcon } from "lucide-react";

import { useStorageQuota } from "@/hooks/useFiles";
import { cn } from "@/utils/cn";

import { humanSize } from "./helpers";

/**
 * Compact storage-usage pill rendered inside ``DriveSubNav`` on
 * every Drive surface. Purposefully **tiny** — the sub-nav is
 * already busy with tab buttons, so the pill should feel like a
 * status chip rather than a second column of UI.
 *
 * Three visual states:
 *   - Loading:   dimmed placeholder ("··")
 *   - Unlimited: "∞ Unlimited storage" (no bar)
 *   - Capped:    "1.2 GB of 10 GB" + progress bar; bar shifts to
 *                amber past 80% and red past 95% so the user gets
 *                a visual nudge before they hit a quota-reject.
 */
export function StorageUsageIndicator({ className }: { className?: string }) {
  const { data, isLoading } = useStorageQuota();

  if (isLoading || !data) {
    return (
      <div
        className={cn(
          "inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]",
          className
        )}
        aria-hidden="true"
      >
        <HardDrive className="h-3 w-3" />
        <span>··</span>
      </div>
    );
  }

  const uncapped = data.cap_bytes === null || data.cap_bytes === 0;
  const pct = uncapped
    ? 0
    : Math.min(1, data.used_bytes / Math.max(1, data.cap_bytes ?? 1));
  const pctRounded = Math.round(pct * 100);
  const tone: "ok" | "warn" | "crit" = uncapped
    ? "ok"
    : pct >= 0.95
      ? "crit"
      : pct >= 0.8
        ? "warn"
        : "ok";

  const title = uncapped
    ? `Using ${humanSize(data.used_bytes)} — no storage cap`
    : `${humanSize(data.used_bytes)} of ${humanSize(
        data.cap_bytes!
      )} used · ${pctRounded}%`;

  return (
    <>
      {/* Mobile variant — tiny pill with an icon + percentage only.
          Visible on phones where the sub-nav is already crowded
          with tabs. Falls back to "∞" when the account has no cap. */}
      <div
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)]/80 px-2 py-0.5 text-[11px] md:hidden",
          className
        )}
        title={title}
      >
        {uncapped ? (
          <InfinityIcon className="h-3 w-3 text-[var(--text-muted)]" />
        ) : (
          <HardDrive className={cn("h-3 w-3", toneTextClass(tone))} />
        )}
        <span className={cn("tabular-nums font-medium", toneTextClass(tone))}>
          {uncapped ? humanSize(data.used_bytes) : `${pctRounded}%`}
        </span>
      </div>

      {/* Desktop variant — full pill with numbers + progress bar. */}
      <div
        className={cn(
          "hidden items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)]/80 px-2.5 py-1 text-[11px] md:inline-flex",
          className
        )}
        title={title}
      >
        {uncapped ? (
          <>
            <InfinityIcon className="h-3 w-3 text-[var(--text-muted)]" />
            <span className="tabular-nums text-[var(--text-muted)]">
              {humanSize(data.used_bytes)} used
            </span>
          </>
        ) : (
          <>
            <HardDrive className={cn("h-3 w-3", toneTextClass(tone))} />
            <span className="tabular-nums text-[var(--text-muted)]">
              <span className={cn("font-medium", toneTextClass(tone))}>
                {humanSize(data.used_bytes)}
              </span>{" "}
              of {humanSize(data.cap_bytes!)}
            </span>
            <div
              className="h-1 w-16 overflow-hidden rounded-full bg-[var(--border)]/60"
              role="progressbar"
              aria-valuenow={pctRounded}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Storage used"
            >
              <div
                className={cn(
                  "h-1 rounded-full transition-[width] duration-500",
                  toneBarClass(tone)
                )}
                style={{ width: `${pctRounded}%` }}
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}

function toneBarClass(tone: "ok" | "warn" | "crit"): string {
  switch (tone) {
    case "crit":
      return "bg-red-500";
    case "warn":
      return "bg-amber-500";
    default:
      return "bg-[var(--accent)]";
  }
}

function toneTextClass(tone: "ok" | "warn" | "crit"): string {
  switch (tone) {
    case "crit":
      return "text-red-600 dark:text-red-400";
    case "warn":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-[var(--text)]";
  }
}
