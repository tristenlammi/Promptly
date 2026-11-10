import { Skeleton } from "@/components/shared/Skeleton";
import { cn } from "@/utils/cn";

/**
 * Placeholder rows shown while a Files list loads, shaped like the real
 * rows (icon, name, date) so the page doesn't jump when they arrive.
 * ``card`` matches the bordered lists on Home, Links and Devices.
 */
export function DriveListSkeleton({ rows = 8, card = false }: { rows?: number; card?: boolean }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className={cn(
        card
          ? "divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]"
          : "space-y-1.5"
      )}
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={cn("flex items-center gap-3", card ? "px-3 py-3" : "px-2 py-2")}>
          <Skeleton className="h-8 w-8 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={cn("h-3.5", i % 3 === 0 ? "w-1/2" : i % 3 === 1 ? "w-1/3" : "w-2/5")} />
            {card && <Skeleton className="h-3 w-1/4" />}
          </div>
          <Skeleton className="ml-auto hidden h-3 w-16 sm:block" />
        </div>
      ))}
    </div>
  );
}
