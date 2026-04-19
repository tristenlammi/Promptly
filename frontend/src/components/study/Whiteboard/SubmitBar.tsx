import { Loader2, Send } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { useStudyStore } from "@/store/studyStore";
import { cn } from "@/utils/cn";

interface SubmitBarProps {
  /** Title of the currently-active exercise, for the helper label. */
  title: string | null;
  disabled?: boolean;
  onSubmit: () => void;
}

/**
 * Sticky bar under the whiteboard that triggers the active exercise's submit
 * handler. The actual answer payload is built inside the iframe — this bar
 * only dispatches a ``REQUEST_SUBMIT`` message via the renderer ref.
 */
export function SubmitBar({ title, disabled, onSubmit }: SubmitBarProps) {
  const status = useStudyStore((s) => s.submissionStatus);
  const error = useStudyStore((s) => s.submissionError);

  const submitting = status === "submitting" || status === "awaiting_review";

  let label = "Submit answers";
  if (status === "submitting") label = "Submitting…";
  else if (status === "awaiting_review") label = "Awaiting feedback…";

  return (
    <div
      className={cn(
        "flex flex-col gap-1 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-2.5"
      )}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-xs text-[var(--text-muted)]">
          {title ? (
            <>
              Working on <span className="font-medium text-[var(--text)]">{title}</span>
            </>
          ) : (
            "No active exercise"
          )}
        </div>
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={disabled || submitting}
          leftIcon={
            submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )
          }
        >
          {label}
        </Button>
      </div>
      {error && (
        <div className="text-xs text-red-500 dark:text-red-400">{error}</div>
      )}
    </div>
  );
}
