import { CheckCircle2, Circle, Clock, Play, RotateCcw, Sparkles } from "lucide-react";

import type { ObjectiveMasteryEntry, StudyUnitSummary } from "@/api/types";
import { cn } from "@/utils/cn";

interface UnitCardProps {
  unit: StudyUnitSummary;
  onOpen: () => void;
  disabled?: boolean;
  /** Mastery rows for THIS unit's objectives, filtered client-side
   *  from the project-level ``useObjectiveMasteryQuery``. Undefined
   *  = data not loaded yet or a unit that predates the 10/10
   *  migration; in that case the summary row stays collapsed. */
  masteryEntries?: ObjectiveMasteryEntry[];
}

/** Per-objective mastery threshold — must stay in sync with
 *  ``study_config.PER_OBJECTIVE_FLOOR`` on the backend. If the
 *  backend moves it this number moves with it, otherwise the UI
 *  cheerfully lies about what's completable. */
const PER_OBJECTIVE_FLOOR = 75;

/** A single unit tile on the topic detail page.
 *
 *  Three visual states for completion: not-started (neutral), in-progress
 *  (accent border), completed (emerald border + checkmark). A small
 *  "Revisit for exam" hint surfaces when a failed exam has flagged this
 *  unit for re-study.
 */
/** Staleness tier thresholds — kept in sync with
 *  ``backend/app/study/staleness.py``. If those constants move, move
 *  these too. */
const STALE_NUDGE_DAYS = 7;
const STALE_SOFT_DAYS = 14;

/** Choose the footer tone / copy for the "Last studied N days ago"
 *  line on completed units. Returns ``null`` for fresh units, units
 *  that haven't been studied yet, and anything not-complete (the
 *  in-progress state already carries its own visual signal — no need
 *  to double up). */
function stalenessFooter(
  unit: StudyUnitSummary
): { label: string; toneClass: string } | null {
  if (unit.status !== "completed") return null;
  const days = unit.days_since_studied;
  if (days == null || days < STALE_NUDGE_DAYS) return null;
  const label = `Last studied ${days} day${days === 1 ? "" : "s"} ago`;
  const toneClass =
    days >= STALE_SOFT_DAYS
      ? "text-amber-700 dark:text-amber-300"
      : "text-[var(--text-muted)]";
  return { label, toneClass };
}

export function UnitCard({
  unit,
  onOpen,
  disabled,
  masteryEntries,
}: UnitCardProps) {
  const objectivesPreview = (unit.learning_objectives ?? []).slice(0, 3);
  const hasExamFocus = Boolean(unit.exam_focus);
  const staleFooter = stalenessFooter(unit);
  // Compact mastery rollup for the card footer. Only rendered when
  // we actually have per-objective rows for this unit — skips the
  // line entirely for fresh plans that haven't been studied yet.
  const objectiveCount = unit.learning_objectives?.length ?? 0;
  const scoredEntries = masteryEntries ?? [];
  const meetsFloor = scoredEntries.filter(
    (e) => e.mastery_score >= PER_OBJECTIVE_FLOOR
  ).length;
  const dueCount = scoredEntries.filter((e) => e.is_due).length;
  const showMasterySummary =
    objectiveCount > 0 && scoredEntries.length > 0;

  const statusMeta = (() => {
    switch (unit.status) {
      case "completed":
        return {
          label: "Completed",
          icon: <CheckCircle2 className="h-3.5 w-3.5" />,
          tone: "text-emerald-600 dark:text-emerald-400",
          border: "border-emerald-500/40",
          cta: "Revisit",
          ctaIcon: <RotateCcw className="h-3.5 w-3.5" />,
        };
      case "in_progress":
        return {
          label: "In progress",
          icon: <Clock className="h-3.5 w-3.5" />,
          tone: "text-[var(--accent)]",
          border: "border-[var(--accent)]/40",
          cta: "Continue",
          ctaIcon: <Play className="h-3.5 w-3.5" />,
        };
      default:
        return {
          label: "Not started",
          icon: <Circle className="h-3.5 w-3.5" />,
          tone: "text-[var(--text-muted)]",
          border: "border-[var(--border)]",
          cta: "Start",
          ctaIcon: <Play className="h-3.5 w-3.5" />,
        };
    }
  })();

  return (
    <button
      onClick={onOpen}
      disabled={disabled}
      className={cn(
        "group relative flex min-h-[180px] w-full flex-col items-stretch rounded-card border bg-[var(--surface)] p-4 text-left transition",
        statusMeta.border,
        !disabled && "hover:border-[var(--accent)]/60 hover:shadow-sm",
        disabled && "cursor-not-allowed opacity-60"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
            <span>Unit {unit.order_index + 1}</span>
            {unit.inserted_as_prereq && (
              <span
                className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:text-amber-300"
                title="Added by the tutor to fill a knowledge gap"
              >
                <Sparkles className="h-2.5 w-2.5" />
                Added by tutor
              </span>
            )}
          </div>
          <h3 className="mt-0.5 line-clamp-2 text-sm font-semibold text-[var(--text)]">
            {unit.title}
          </h3>
        </div>
        <div
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
            statusMeta.tone,
            unit.status === "completed" &&
              "bg-emerald-500/10",
            unit.status === "in_progress" && "bg-[var(--accent)]/10",
            unit.status === "not_started" && "bg-[var(--border)]/30"
          )}
        >
          {statusMeta.icon}
          {statusMeta.label}
        </div>
      </div>

      {unit.description && (
        <p className="mt-2 line-clamp-2 text-xs text-[var(--text-muted)]">
          {unit.description}
        </p>
      )}

      {objectivesPreview.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-[var(--text-muted)]">
          {objectivesPreview.map((o) => (
            <li key={o} className="line-clamp-1">
              • {o}
            </li>
          ))}
        </ul>
      )}

      {hasExamFocus && (
        <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300">
          Flagged from the last exam — revisit this unit.
        </div>
      )}

      {/* Honest "what's still pending" hint on in-progress units. The
          backend computes a single most-informative blocker
          (``gate_blocker``) per unit so the student isn't left
          wondering why a fully-green-looking card refuses to close.
          Only renders when a blocker exists — fully-ready in-progress
          units (all 5 conditions met but tutor hasn't emitted
          mark_complete yet) still show the bare "In progress" chip. */}
      {unit.status === "in_progress" && unit.gate_blocker && (
        <div
          className="mt-2 inline-flex items-center gap-1 self-start rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]"
          title="The tutor will close this unit automatically once all conditions are met."
        >
          <Clock className="h-2.5 w-2.5" />
          {unit.gate_blocker}
        </div>
      )}

      <div className="mt-auto flex items-end justify-between gap-2 pt-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="text-[10px] text-[var(--text-muted)]">
            {unit.mastery_score !== null
              ? `Mastery ${unit.mastery_score}/100`
              : `${objectiveCount} objectives`}
          </div>
          {showMasterySummary && (
            <div
              className="text-[10px] text-[var(--text-muted)]"
              title={`${meetsFloor} of ${objectiveCount} objectives at ${PER_OBJECTIVE_FLOOR}%+` +
                (dueCount > 0 ? ` · ${dueCount} due for review` : "")}
            >
              <span
                className={cn(
                  meetsFloor === objectiveCount
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-[var(--text-muted)]"
                )}
              >
                {meetsFloor}/{objectiveCount} at {PER_OBJECTIVE_FLOOR}%
              </span>
              {dueCount > 0 && (
                <span className="ml-1 text-amber-700 dark:text-amber-300">
                  · {dueCount} due
                </span>
              )}
            </div>
          )}
          {staleFooter && (
            <div
              className={cn("text-[10px]", staleFooter.toneClass)}
              title="Mastery decays gradually without practice."
            >
              {staleFooter.label}
            </div>
          )}
        </div>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] opacity-0 transition group-hover:opacity-100">
          {statusMeta.ctaIcon}
          {statusMeta.cta}
        </span>
      </div>
    </button>
  );
}
