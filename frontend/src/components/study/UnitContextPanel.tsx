import { CheckCircle2, Target } from "lucide-react";

import type { StudyUnitSummary } from "@/api/types";
import { cn } from "@/utils/cn";

/** Read-only sidebar showing the learning objectives and mastery
 *  status for the current unit — keeps context visible while the
 *  user chats with the tutor. */
export function UnitContextPanel({
  unit,
  projectTitle,
  totalUnits,
}: {
  unit: StudyUnitSummary;
  projectTitle: string;
  totalUnits: number;
}) {
  const done = unit.status === "completed";
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
        {projectTitle} · Unit {unit.order_index + 1}/{totalUnits}
      </div>
      <h2 className="mt-1 text-lg font-semibold text-[var(--text)]">
        {unit.title}
      </h2>
      {unit.description && (
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          {unit.description}
        </p>
      )}

      <div
        className={cn(
          "mt-3 inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
          done
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : "bg-[var(--accent)]/10 text-[var(--accent)]"
        )}
      >
        {done ? (
          <>
            <CheckCircle2 className="h-3.5 w-3.5" />
            Completed
            {unit.mastery_score !== null && ` · ${unit.mastery_score}/100`}
          </>
        ) : (
          <>In progress</>
        )}
      </div>

      {unit.learning_objectives.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-muted)]">
            <Target className="h-3.5 w-3.5" />
            Learning objectives
          </div>
          <ul className="space-y-1.5">
            {unit.learning_objectives.map((o) => (
              <li
                key={o}
                className="flex items-start gap-2 text-xs text-[var(--text)]"
              >
                <span className="mt-1 h-1.5 w-1.5 flex-none rounded-full bg-[var(--accent)]" />
                <span>{o}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {unit.exam_focus && (
        <div className="mt-5 rounded-card border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
          <div className="font-medium text-amber-700 dark:text-amber-300">
            Focus for this revisit
          </div>
          <p className="mt-1 text-[var(--text-muted)]">{unit.exam_focus}</p>
        </div>
      )}

      {unit.mastery_summary && (
        <div className="mt-5 rounded-card border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
          <div className="font-medium text-emerald-700 dark:text-emerald-300">
            Tutor summary
          </div>
          <p className="mt-1 text-[var(--text-muted)]">{unit.mastery_summary}</p>
        </div>
      )}
    </div>
  );
}
