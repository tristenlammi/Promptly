import { Compass } from "lucide-react";

import { Button } from "@/components/shared/Button";

/** Slim notice that appears above the chat on the very first Unit-1
 *  session of a brand-new project — before calibration has happened.
 *  Tells the student what the warm-up diagnostic is for and gives
 *  them a single-click way out if they'd rather just start learning.
 *  Disappears as soon as the tutor emits ``set_calibrated`` (or an
 *  ``insert_prerequisites`` with ``mark_calibrated: true``), OR the
 *  student clicks Skip here. */
export function DiagnosticBanner({
  onSkip,
  skipping,
}: {
  onSkip: () => void;
  skipping: boolean;
}) {
  return (
    <div
      role="note"
      className="mx-4 mt-3 flex items-start gap-3 rounded-card border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-3 text-sm"
    >
      <div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-[var(--accent)]/15 text-[var(--accent)]">
        <Compass className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-[var(--text)]">
          Quick warm-up before we start
        </div>
        <div className="mt-0.5 text-xs text-[var(--text-muted)]">
          Your tutor is going to ask 3 short questions to confirm where
          you&rsquo;re at — the answer shapes how Unit 1 is taught, and
          if there&rsquo;s a gap the tutor can splice in a couple of
          foundation units before proceeding.
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={onSkip}
        disabled={skipping}
      >
        {skipping ? "Skipping..." : "Skip diagnostic"}
      </Button>
    </div>
  );
}
