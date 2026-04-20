import { AlertTriangle, X } from "lucide-react";

import { Button } from "@/components/shared/Button";
import type { CalibrationWarningEvent } from "@/store/studyStore";

/** Rose-coloured, one-shot honesty banner that appears when the tutor
 *  discovers a gap on a project whose calibration came from a skip.
 *  The backend guarantees only a single firing per project lifetime,
 *  so the toast intentionally has no localStorage gate — once the
 *  student dismisses it on this session, the next stream won't fire
 *  it again. Secondary CTA takes the student to the topic page where
 *  they can choose to regenerate or just carry on. */
export function CalibrationWarningToast({
  event,
  onDismiss,
  onReviewPlan,
}: {
  event: CalibrationWarningEvent;
  onDismiss: () => void;
  onReviewPlan: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 mt-3 flex items-start gap-3 rounded-card border border-rose-500/40 bg-rose-500/10 p-3 text-sm"
    >
      <div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-rose-500/20 text-rose-700 dark:text-rose-300">
        <AlertTriangle className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-rose-800 dark:text-rose-200">
          Heads up — you skipped the warm-up
        </div>
        <div className="mt-0.5 text-xs text-[var(--text-muted)]">
          Your tutor just found a gap a quick diagnostic would have caught
          {event.reason ? ` (${event.reason})` : ""}. It's not a problem — the
          plan already updated — but if the plan feels off, revisiting is an
          option.
        </div>
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="ghost" onClick={onReviewPlan}>
            Review plan
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Keep going
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
