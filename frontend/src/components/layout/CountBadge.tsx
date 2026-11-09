import { badgeLabel, badgeText } from "@/lib/countBadge";
import { cn } from "@/utils/cn";

/**
 * The sidebar's count badge: a small terracotta circle with a number
 * ("99+" past 99) on an app's row. Nothing at all for 0.
 *
 * ``corner`` sits it on the top-right of a collapsed rail icon; otherwise it
 * sits at the end of an expanded row. The deeper terracotta
 * (``--accent-strong``) keeps white digits readable in light and dark.
 */
export function CountBadge({ app, n, corner = false, className }: { app: string; n: number | undefined; corner?: boolean; className?: string }) {
  const text = badgeText(n);
  if (!text) return null;
  return (
    <span
      role="img"
      aria-label={badgeLabel(app, n)}
      data-badge={app}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--accent-strong)] font-semibold tabular-nums text-white",
        corner
          ? "pointer-events-none absolute -right-1 -top-1 h-4 min-w-[16px] px-1 text-[9px] leading-none ring-2 ring-[var(--surface)]"
          : "ml-auto h-[18px] min-w-[18px] px-1.5 text-[10px] leading-none",
        className
      )}
    >
      {text}
    </span>
  );
}
