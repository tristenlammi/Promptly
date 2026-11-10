import type { ReactNode } from "react";

import { cn } from "@/utils/cn";

/**
 * THE empty state (UI plan A11): what every app shows when a list, folder,
 * search or page has nothing in it. One look across the suite; the item
 * kit's ``EmptyState`` (``@/items/ui``) draws this same component.
 *
 *   <EmptyState
 *     icon={<Images className="h-5 w-5" />}
 *     title="No photos yet"
 *     description="Photos you add or back up from your phone show up here."
 *     action={<Button variant="primary" onClick={upload}>Add photos</Button>}
 *     secondaryAction={<Button variant="ghost" onClick={setup}>Set up phone backup</Button>}
 *   />
 *
 * Props
 *   icon             a small icon (20px reads best), shown in a soft circle.
 *   title            one short line: what's missing, in plain words.
 *   description      optional sentence on what will appear here or what to do.
 *   action           the main next step (one primary button).
 *   secondaryAction  a quieter second step; sits beside the first.
 *   compact          a smaller version for side panels, cards, popovers and
 *                    "no results" inside a list: less padding, no dashed card.
 *   bare             keep the full size but drop the dashed card (when the
 *                    state already sits in its own card or fills a page).
 *   className        extra classes on the wrapper (margins, min-height).
 *
 * Writing: say what will show up here, not that something failed. One
 * action is best; two at most. For errors use ``Callout`` / an error state
 * with Retry instead.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  compact = false,
  bare = false,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  compact?: boolean;
  bare?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-center",
        compact ? "px-4 py-6" : "px-6 py-12",
        !compact && !bare && "rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)]",
        className,
      )}
    >
      {icon && (
        <div
          className={cn(
            "mx-auto inline-flex items-center justify-center rounded-full text-[var(--text-muted)]",
            compact ? "mb-2 h-8 w-8 bg-[var(--surface-2)]" : "mb-3 h-10 w-10",
            !compact && (bare ? "bg-[var(--surface-2)]" : "bg-[var(--bg)]"),
          )}
        >
          {icon}
        </div>
      )}
      <h2 className={cn("font-semibold text-[var(--text)]", compact ? "text-sm" : "text-base")}>{title}</h2>
      {description && (
        <p className={cn("mx-auto mt-1 text-[var(--text-muted)]", compact ? "max-w-xs text-xs" : "max-w-md text-sm")}>
          {description}
        </p>
      )}
      {(action || secondaryAction) && (
        <div className={cn("flex flex-wrap items-center justify-center gap-2", compact ? "mt-3" : "mt-4")}>
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
