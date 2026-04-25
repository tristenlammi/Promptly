import { RotateCcw } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { useReviewQueueQuery } from "@/hooks/useStudy";

interface ReviewQueueWidgetProps {
  projectId: string;
  /** Invoked when the student clicks "Start review" on an item. The
   *  parent routes to the unit session with ``?review=<objective_id>``
   *  so the prompt builder can prioritise that item. */
  onStartReview: (unitId: string, objectiveId: string) => void;
}

/** Top-of-project strip showing spaced-repetition items due for review.
 *
 *  Hidden entirely when the queue is empty — no point showing an empty
 *  widget, it just adds noise. When items are present the student can
 *  click through to the relevant unit; the URL query string
 *  ``?review=<id>`` tells the tutor prompt to lead with that item.
 */
export function ReviewQueueWidget({
  projectId,
  onStartReview,
}: ReviewQueueWidgetProps) {
  const { data, isLoading } = useReviewQueueQuery(projectId);
  const items = data?.items ?? [];

  if (isLoading || items.length === 0) {
    return null;
  }

  return (
    <section className="rounded-card border border-amber-500/30 bg-amber-500/5 p-4">
      <header className="flex items-center gap-2">
        <RotateCcw className="h-4 w-4 text-amber-700 dark:text-amber-300" />
        <h3 className="text-sm font-semibold text-[var(--text)]">
          {items.length} {items.length === 1 ? "item" : "items"} due for review
        </h3>
      </header>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        Spaced repetition keeps material sticky. Start any of these and the
        tutor will weave a quick check of that concept into the session.
      </p>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li
            key={item.objective_id}
            className="flex items-start justify-between gap-3 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                {item.unit_title} · objective {item.objective_index + 1}
              </div>
              <div className="mt-0.5 line-clamp-2 text-xs text-[var(--text)]">
                {item.objective_text}
              </div>
              <div className="mt-1 text-[10px] text-[var(--text-muted)]">
                Mastery {item.mastery_score}/100 · {item.days_overdue}d overdue
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onStartReview(item.unit_id, item.objective_id)}
            >
              Start review
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
