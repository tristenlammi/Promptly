import { CheckCircle2, X } from "lucide-react";

import { Button } from "@/components/shared/Button";
import type { UnitCompletedEvent } from "@/store/studyStore";

/** Celebratory banner that appears when the tutor marks the current unit
 *  as complete. Non-blocking — the user can keep chatting to brush up, or
 *  jump back to the topic overview to start the next unit.
 */
export function UnitCompletedToast({
  event,
  onDismiss,
  onBackToTopic,
}: {
  event: UnitCompletedEvent;
  onDismiss: () => void;
  onBackToTopic: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 mt-3 flex items-start gap-3 rounded-card border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm"
    >
      <div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-emerald-500/20 text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-emerald-800 dark:text-emerald-200">
          Unit complete!
          {typeof event.mastery_score === "number" &&
            ` Mastery ${event.mastery_score}/100.`}
        </div>
        {event.mastery_summary && (
          <div className="mt-0.5 text-xs text-[var(--text-muted)]">
            {event.mastery_summary}
          </div>
        )}
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="primary" onClick={onBackToTopic}>
            Back to topic
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Keep chatting
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
