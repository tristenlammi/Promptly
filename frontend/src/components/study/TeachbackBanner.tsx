import { BookOpenCheck } from "lucide-react";

interface TeachbackBannerProps {
  /** Whether the tutor has already accepted a teach-back this session.
   *  When true the banner shifts to the "passed" treatment. */
  passed: boolean;
}

/** Chat-inline affordance reminding the student the tutor has asked for
 *  a teach-back (Feynman-style explanation in the student's own words).
 *  Until ``session.teachback_passed_at`` is set by the tutor emitting
 *  ``<teachback_passed>``, the mark_complete gate will reject
 *  completion. This banner simply surfaces that requirement; the actual
 *  pass is judged by the AI from the student's typed explanation.
 */
export function TeachbackBanner({ passed }: TeachbackBannerProps) {
  if (passed) {
    return (
      <div className="flex items-center gap-2 rounded-card border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
        <BookOpenCheck className="h-3.5 w-3.5" />
        Teach-back accepted — you explained the idea clearly.
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-card border border-[var(--accent)]/40 bg-[var(--accent)]/5 px-3 py-2 text-xs text-[var(--text)]">
      <BookOpenCheck className="h-3.5 w-3.5 mt-0.5 text-[var(--accent)] shrink-0" />
      <div>
        <div className="font-medium">Your turn to teach it back.</div>
        <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">
          Explain the idea in your own words — no jargon, no checking notes.
          The tutor will tell you if something needs another pass.
        </div>
      </div>
    </div>
  );
}
