import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, CircleCheck, CircleAlert } from "lucide-react";

import type { StudyExamSummary, StudyUnitSummary } from "@/api/types";
import { cn } from "@/utils/cn";

interface ExamBreakdownProps {
  exams: StudyExamSummary[];
  units: StudyUnitSummary[];
}

/** Pick the most recent exam that actually carries a grade — pass/fail
 *  is fine, but we want to skip pending/in_progress rows which won't
 *  have unit_notes yet. Returns null if no graded exam exists. */
function pickLatestGradedExam(exams: StudyExamSummary[]): StudyExamSummary | null {
  const graded = exams.filter(
    (e) => e.status === "passed" || e.status === "failed"
  );
  if (graded.length === 0) return null;
  const sorted = [...graded].sort((a, b) => b.attempt_number - a.attempt_number);
  return sorted[0];
}

/** Determine which side of the breakdown a unit falls on — strong,
 *  weak, or neither (the student either aced or skipped it and the
 *  grader didn't call it out explicitly). Preference order: weak wins
 *  over strong when a unit is listed in both, because a callout on
 *  weakness is more actionable than a callout on strength. */
function classifyUnit(
  unit: StudyUnitSummary,
  exam: StudyExamSummary
): "weak" | "strong" | "neutral" {
  if (exam.weak_unit_ids?.includes(unit.id)) return "weak";
  if (exam.strong_unit_ids?.includes(unit.id)) return "strong";
  return "neutral";
}

/** Collapsible per-unit grader breakdown for the most recent graded
 *  final exam on a topic. Default-collapsed on pass (student's done
 *  and probably just scanning) and default-open on fail (they want to
 *  see exactly what to re-study). Silent render when there's no
 *  graded exam yet. */
export function ExamBreakdown({ exams, units }: ExamBreakdownProps) {
  const exam = useMemo(() => pickLatestGradedExam(exams), [exams]);
  const [open, setOpen] = useState<boolean>(() =>
    exam ? exam.status === "failed" : false
  );

  if (!exam) return null;

  // Gather the rows we actually want to render — any unit that's
  // either flagged weak/strong OR has a unit_note. We drop the
  // completely untouched units so the section stays readable.
  const rows = units
    .map((unit) => {
      const klass = classifyUnit(unit, exam);
      const note = exam.unit_notes?.[unit.id] ?? null;
      return { unit, klass, note };
    })
    .filter((r) => r.klass !== "neutral" || r.note)
    .sort((a, b) => a.unit.order_index - b.unit.order_index);

  if (rows.length === 0) return null;

  const scoreLabel =
    exam.score != null
      ? `${exam.score}/100 — ${exam.passed ? "passed" : "not yet"}`
      : exam.passed
        ? "passed"
        : "not yet";

  return (
    <section className="mt-6 rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 rounded-card px-4 py-3 text-left transition hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
            Exam breakdown
            <span className="rounded-full bg-[var(--border)]/40 px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
              Attempt {exam.attempt_number}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-[var(--text-muted)]">
            {scoreLabel}
            {exam.summary ? ` · ${exam.summary}` : ""}
          </div>
        </div>
        {open ? (
          <ChevronDown className="h-4 w-4 flex-none text-[var(--text-muted)]" />
        ) : (
          <ChevronRight className="h-4 w-4 flex-none text-[var(--text-muted)]" />
        )}
      </button>

      {open && (
        <ul className="divide-y divide-[var(--border)]/60 border-t border-[var(--border)]/60">
          {rows.map(({ unit, klass, note }) => (
            <li key={unit.id} className="flex items-start gap-3 px-4 py-3">
              <div
                className={cn(
                  "mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full",
                  klass === "weak"
                    ? "bg-red-500/15 text-red-600 dark:text-red-400"
                    : klass === "strong"
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-[var(--border)]/40 text-[var(--text-muted)]"
                )}
              >
                {klass === "weak" ? (
                  <CircleAlert className="h-4 w-4" />
                ) : (
                  <CircleCheck className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm text-[var(--text)]">
                  <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                    Unit {unit.order_index + 1}
                  </span>
                  <span className="line-clamp-1 font-medium">{unit.title}</span>
                </div>
                {note ? (
                  <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                    {note}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs italic text-[var(--text-muted)]">
                    {klass === "weak"
                      ? "Flagged for re-study."
                      : "Handled cleanly."}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
