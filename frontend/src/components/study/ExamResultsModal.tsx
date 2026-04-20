import { GraduationCap, RotateCcw, Sparkles, Trophy } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import type { ExamGradedEvent } from "@/store/studyStore";
import { cn } from "@/utils/cn";

/** Shown right after an exam is graded. Passing routes back to the
 *  topic so the user can archive / celebrate; failing lets them jump
 *  straight into the flagged weak units. */
export function ExamResultsModal({
  open,
  event,
  onClose,
  onBackToTopic,
  onArchive,
  archivePending,
}: {
  open: boolean;
  event: ExamGradedEvent | null;
  onClose: () => void;
  onBackToTopic: () => void;
  onArchive: () => void;
  archivePending?: boolean;
}) {
  if (!event) return null;
  const passed = event.passed;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={passed ? "You passed!" : "Almost there"}
    >
      <div className="flex flex-col items-center text-center">
        <div
          className={cn(
            "flex h-14 w-14 items-center justify-center rounded-full",
            passed
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          )}
        >
          {passed ? (
            <Trophy className="h-7 w-7" />
          ) : (
            <GraduationCap className="h-7 w-7" />
          )}
        </div>
        <div className="mt-3 text-3xl font-bold tabular-nums text-[var(--text)]">
          {event.score}
          <span className="text-base font-normal text-[var(--text-muted)]">
            /100
          </span>
        </div>
        {event.summary && (
          <p className="mt-2 max-w-sm text-sm text-[var(--text-muted)]">
            {event.summary}
          </p>
        )}
      </div>

      {!passed && event.weak_unit_ids && event.weak_unit_ids.length > 0 && (
        <div className="mt-4 rounded-card border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <div className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300">
            <Sparkles className="h-4 w-4" />
            Units unlocked for revision
          </div>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {event.weak_unit_ids.length} unit
            {event.weak_unit_ids.length === 1 ? "" : "s"} have been re-opened
            with focus notes based on your answers. Brush up and retake the
            exam whenever you're ready.
          </p>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
        {passed ? (
          <>
            <Button variant="ghost" onClick={onBackToTopic}>
              Back to topic
            </Button>
            <Button
              variant="primary"
              onClick={onArchive}
              loading={archivePending}
            >
              Archive this topic
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              onClick={onBackToTopic}
              leftIcon={<RotateCcw className="h-4 w-4" />}
            >
              Revisit units
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
