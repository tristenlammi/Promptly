import { Target } from "lucide-react";

/**
 * Chat-inline affordance shown when the tutor emits ``<request_predict/>``.
 * Tells the student to commit a prediction before the tutor reveals the
 * worked example on the next turn — the predict-before-reveal beat that
 * eliminates passive reading windows in PRESENT and GUIDED phases.
 */
export function PredictBanner() {
  return (
    <div className="flex items-start gap-2 rounded-card border border-amber-400/40 bg-amber-50/60 px-3 py-2 text-xs text-[var(--text)] dark:bg-amber-900/10">
      <Target className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
      <div>
        <div className="font-medium">Commit your prediction first.</div>
        <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">
          Type your answer before the reveal — getting it wrong teaches you
          more than reading the right answer cold.
        </div>
      </div>
    </div>
  );
}
