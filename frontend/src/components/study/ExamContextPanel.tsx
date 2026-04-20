import { useEffect, useState } from "react";
import { Clock, GraduationCap } from "lucide-react";

import type { StudyExamSummary } from "@/api/types";
import { Button } from "@/components/shared/Button";
import { cn } from "@/utils/cn";

/** Sidebar + timer for an in-flight exam session.
 *
 *  Computes a "seconds remaining" locally off `started_at` +
 *  `time_limit_seconds` so the countdown stays accurate even if
 *  we re-render rarely. When the timer runs out we surface a
 *  "Time's up" banner and expose an explicit button so the user
 *  (or the parent) can flag the exam as timed-out on the server.
 */
export function ExamContextPanel({
  exam,
  projectTitle,
  totalUnits,
  completedUnits,
  onTimeout,
  timeoutPending,
}: {
  exam: StudyExamSummary;
  projectTitle: string;
  totalUnits: number;
  completedUnits: number;
  onTimeout: () => void;
  timeoutPending?: boolean;
}) {
  const secondsRemaining = useCountdown(exam);
  const expired = secondsRemaining <= 0;
  const critical = secondsRemaining <= 60 && secondsRemaining > 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
        {projectTitle} · Final exam
      </div>
      <h2 className="mt-1 flex items-center gap-2 text-lg font-semibold text-[var(--text)]">
        <GraduationCap className="h-5 w-5 text-[var(--accent)]" />
        Attempt #{exam.attempt_number}
      </h2>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        {completedUnits}/{totalUnits} units completed before this attempt. The
        examiner will dial the questions to your strongest and weakest areas.
      </p>

      <div
        className={cn(
          "mt-4 rounded-card border p-4 text-center",
          expired
            ? "border-red-500/50 bg-red-500/10"
            : critical
            ? "border-amber-500/50 bg-amber-500/10"
            : "border-[var(--accent)]/40 bg-[var(--accent)]/5"
        )}
      >
        <div className="flex items-center justify-center gap-2 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
          <Clock className="h-3.5 w-3.5" />
          {expired ? "Time's up" : "Time remaining"}
        </div>
        <div
          className={cn(
            "mt-1 font-mono text-3xl font-semibold tabular-nums",
            expired
              ? "text-red-600 dark:text-red-400"
              : critical
              ? "text-amber-700 dark:text-amber-300"
              : "text-[var(--text)]"
          )}
        >
          {formatRemaining(secondsRemaining)}
        </div>
        {expired ? (
          <>
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              Wrap up your current answer and end the exam to see your score.
            </p>
            <Button
              variant="primary"
              size="sm"
              className="mt-3"
              onClick={onTimeout}
              loading={timeoutPending}
            >
              End exam now
            </Button>
          </>
        ) : (
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            You can finish earlier — ask the examiner to wrap up whenever
            you're done.
          </p>
        )}
      </div>

      <div className="mt-5 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3 text-xs text-[var(--text-muted)]">
        <div className="mb-1 font-medium text-[var(--text)]">Exam rules</div>
        <ul className="space-y-1">
          <li>• The examiner sets the questions dynamically as you answer.</li>
          <li>• You need 70/100 or higher to pass.</li>
          <li>
            • If you don't pass, weak units will unlock again so you can brush
            up before retrying.
          </li>
        </ul>
      </div>
    </div>
  );
}

function useCountdown(exam: StudyExamSummary): number {
  const deadline = exam.started_at
    ? new Date(exam.started_at).getTime() + exam.time_limit_seconds * 1000
    : Date.now() + exam.time_limit_seconds * 1000;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return Math.max(0, Math.floor((deadline - now) / 1000));
}

function formatRemaining(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
