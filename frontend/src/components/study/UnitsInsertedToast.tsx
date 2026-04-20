import { ListPlus, X } from "lucide-react";

import { Button } from "@/components/shared/Button";
import type { UnitsInsertedEvent } from "@/store/studyStore";

/** Non-blocking banner that surfaces when the tutor splices new
 *  prerequisite units into the plan mid-session. Deliberately NOT a
 *  redirect — the student sees what was added and why, and picks
 *  their next move themselves. The primary CTA jumps back to the
 *  topic overview where the new units now appear just before the
 *  current one. */
export function UnitsInsertedToast({
  event,
  onDismiss,
  onBackToTopic,
}: {
  event: UnitsInsertedEvent;
  onDismiss: () => void;
  onBackToTopic: () => void;
}) {
  const count = event.units.length;
  if (count === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 mt-3 flex items-start gap-3 rounded-card border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300">
        <ListPlus className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-amber-800 dark:text-amber-200">
          {count === 1
            ? "Added a prerequisite unit"
            : `Added ${count} prerequisite units`}
        </div>
        {event.reason && (
          <div className="mt-0.5 text-xs text-[var(--text-muted)]">
            {event.reason}
          </div>
        )}
        <ul className="mt-1.5 space-y-0.5 text-xs text-[var(--text-muted)]">
          {event.units.map((u) => (
            <li key={u.id} className="line-clamp-1">
              • {u.title}
            </li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="primary" onClick={onBackToTopic}>
            See new units
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Keep going here
          </Button>
        </div>
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-[var(--text-muted)] transition hover:text-[var(--text)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
