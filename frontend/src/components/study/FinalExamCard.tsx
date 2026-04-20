import { GraduationCap, Lock, RotateCcw, Trophy } from "lucide-react";

import type { StudyExamSummary, StudyProjectDetail } from "@/api/types";
import { Button } from "@/components/shared/Button";
import { cn } from "@/utils/cn";

interface FinalExamCardProps {
  project: StudyProjectDetail;
  startPending?: boolean;
  onStart: () => void;
  onResume: (examId: string) => void;
  onRetry: () => void;
}

/** The "Final Exam" slot on the topic detail page. Locks until every
 *  unit is complete; once unlocked offers Start / Resume / Retry
 *  depending on the exam history for this project.
 */
export function FinalExamCard({
  project,
  startPending,
  onStart,
  onResume,
  onRetry,
}: FinalExamCardProps) {
  const attempts = project.exams;
  const lastExam: StudyExamSummary | null =
    attempts.length > 0
      ? [...attempts].sort((a, b) => b.attempt_number - a.attempt_number)[0]
      : null;
  const activeExam = attempts.find((e) => e.status === "in_progress") ?? null;
  const passedExam = attempts.find((e) => e.status === "passed") ?? null;

  const totalUnits = project.total_units;
  const completedUnits = project.completed_units;
  const remaining = totalUnits - completedUnits;
  const isLocked = !project.final_exam_unlocked && !activeExam && !passedExam;

  const minutes = Math.round(
    (activeExam?.time_limit_seconds ?? 1200) / 60
  );

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-card border p-5 transition",
        passedExam
          ? "border-emerald-500/40 bg-gradient-to-br from-emerald-500/5 to-[var(--surface)]"
          : isLocked
          ? "border-dashed border-[var(--border)] bg-[var(--surface)]"
          : "border-[var(--accent)]/40 bg-gradient-to-br from-[var(--accent)]/5 to-[var(--surface)]"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex h-10 w-10 flex-none items-center justify-center rounded-full",
              passedExam
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : isLocked
                ? "bg-[var(--border)]/40 text-[var(--text-muted)]"
                : "bg-[var(--accent)]/15 text-[var(--accent)]"
            )}
          >
            {passedExam ? (
              <Trophy className="h-5 w-5" />
            ) : isLocked ? (
              <Lock className="h-5 w-5" />
            ) : (
              <GraduationCap className="h-5 w-5" />
            )}
          </div>
          <div>
            <h3 className="text-base font-semibold text-[var(--text)]">
              Final exam
            </h3>
            <p className="mt-1 max-w-xl text-sm text-[var(--text-muted)]">
              {passedExam
                ? `Passed with ${passedExam.score ?? 0}/100 on attempt ${passedExam.attempt_number}. Nice work.`
                : activeExam
                ? `You have an exam in progress — resume before the timer runs out.`
                : isLocked
                ? `Unlocks once every unit is complete. ${remaining} to go.`
                : `Dynamic ${minutes}-minute exam. Questions adapt to what you've learned and where you struggled.`}
            </p>
            {lastExam && !passedExam && lastExam.status === "failed" && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                Last attempt scored {lastExam.score ?? 0}/100.
                {lastExam.summary ? ` ${lastExam.summary}` : ""}
                {" "}
                Revisit the flagged units, then retry.
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-none items-center">
          {passedExam ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              <Trophy className="h-3.5 w-3.5" />
              Passed
            </span>
          ) : activeExam ? (
            <Button
              variant="primary"
              onClick={() => onResume(activeExam.id)}
              leftIcon={<GraduationCap className="h-4 w-4" />}
            >
              Resume exam
            </Button>
          ) : project.final_exam_unlocked && lastExam?.status === "failed" ? (
            <Button
              variant="primary"
              onClick={onRetry}
              loading={startPending}
              leftIcon={<RotateCcw className="h-4 w-4" />}
            >
              Retry exam
            </Button>
          ) : project.final_exam_unlocked ? (
            <Button
              variant="primary"
              onClick={onStart}
              loading={startPending}
              leftIcon={<GraduationCap className="h-4 w-4" />}
            >
              Start exam
            </Button>
          ) : null}
        </div>
      </div>

      {/* Attempt history */}
      {attempts.length > 1 && (
        <div className="mt-4 border-t border-[var(--border)]/60 pt-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
            Exam history
          </div>
          <ul className="space-y-0.5 text-xs text-[var(--text-muted)]">
            {[...attempts]
              .sort((a, b) => b.attempt_number - a.attempt_number)
              .map((a) => (
                <li key={a.id} className="flex items-center justify-between">
                  <span>Attempt {a.attempt_number}</span>
                  <span
                    className={cn(
                      "font-medium",
                      a.status === "passed"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : a.status === "failed"
                        ? "text-red-600 dark:text-red-400"
                        : "text-[var(--text-muted)]"
                    )}
                  >
                    {a.status === "in_progress"
                      ? "in progress"
                      : `${a.status}${
                          a.score !== null ? ` · ${a.score}/100` : ""
                        }`}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
