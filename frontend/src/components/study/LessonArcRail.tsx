import { Fragment, useEffect } from "react";
import { Check, CheckCircle2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { studyApi } from "@/api/study";
import { cn } from "@/utils/cn";

// ---- Phase → step mapping -------------------------------------------

const LOOP_PHASES = new Set(["present", "guided", "independent", "interleave"]);
const LOOP_INNER = ["present", "guided", "independent"] as const;

const LOOP_INNER_LABELS: Record<string, string> = {
  present: "Present",
  guided: "Guided",
  independent: "Practice",
  interleave: "Review",
};

type StepId = "hook" | "activate" | "learn" | "teachback" | "transfer" | "close";

const STEPS: { id: StepId; label: string }[] = [
  { id: "hook",      label: "Hook"      },
  { id: "activate",  label: "Activate"  },
  { id: "learn",     label: "Learn"     },
  { id: "teachback", label: "Teach-back"},
  { id: "transfer",  label: "Transfer"  },
  { id: "close",     label: "Close"     },
];

function phaseToStep(phase: string): StepId {
  if (LOOP_PHASES.has(phase)) return "learn";
  return phase as StepId;
}

// ---- Component ------------------------------------------------------

interface LessonArcRailProps {
  sessionId: string;
  /** Bump to trigger a re-fetch when the session phase may have changed. */
  phaseVersion?: number;
}

export function LessonArcRail({ sessionId, phaseVersion = 0 }: LessonArcRailProps) {
  const { data: arc, refetch } = useQuery({
    queryKey: ["study", "arc", sessionId],
    queryFn: () => studyApi.getSessionArc(sessionId),
    staleTime: 10_000,
  });

  useEffect(() => {
    if (phaseVersion > 0) void refetch();
  }, [phaseVersion, refetch]);

  if (!arc || !arc.phase) return null;

  const phase = arc.phase;
  const currentStep = phaseToStep(phase);
  const currentStepIdx = STEPS.findIndex((s) => s.id === currentStep);
  const isInLoop = LOOP_PHASES.has(phase);

  const totalObj = arc.total_objectives || arc.objectives.length;
  const currentObjIdx = arc.current_objective_index;
  const masteredCount = arc.objectives.filter((o) => o.mastered).length;

  // Progress fraction: 0 at first step, 1 at last step.
  const progressFraction = STEPS.length > 1 ? currentStepIdx / (STEPS.length - 1) : 0;

  return (
    <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-5">

      {/* ── Phase stepper ──────────────────────────────────────────── */}
      {/*
        Layout: dots are in a justify-between flex row, padded inward by
        half the dot width (10px) so the track line can run left-[10px]
        to right-[10px] and perfectly bisect each dot.

        Fill width formula: calc(fraction × (100% − 20px))
        This maps [0,1] onto the distance between the centres of the
        first and last dots — verified for all six step positions.
      */}
      <div className="relative px-[10px]">
        {/* Track — muted full-width line */}
        <div className="pointer-events-none absolute inset-x-0 top-[10px] mx-[10px] h-px bg-[var(--border)]" />
        {/* Fill — accent line up to current step centre */}
        <div
          className="pointer-events-none absolute left-[10px] top-[10px] h-px bg-[var(--accent)] transition-[width] duration-500"
          style={{ width: `calc(${progressFraction} * (100% - 20px))` }}
        />

        {/* Step dots */}
        <div className="relative z-10 flex justify-between">
          {STEPS.map((step, i) => {
            const isDone    = currentStepIdx > i;
            const isCurrent = currentStepIdx === i;

            return (
              <div key={step.id} className="flex flex-col items-center gap-2">
                {/* Dot */}
                <div
                  className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full transition-all",
                    isDone    && "bg-[var(--accent)]",
                    isCurrent && "bg-[var(--accent)] ring-4 ring-[var(--accent)]/20",
                    !isDone && !isCurrent && "border-2 border-[var(--border)] bg-[var(--surface)]",
                  )}
                >
                  {isDone    && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                  {isCurrent && <span className="h-2 w-2 rounded-full bg-white" />}
                </div>

                {/* Step label */}
                <span
                  className={cn(
                    "text-center text-[10px] font-medium leading-tight",
                    isCurrent ? "text-[var(--accent)]"
                      : isDone  ? "text-[var(--text-muted)] opacity-60"
                      : "text-[var(--text-muted)]",
                  )}
                >
                  {step.label}
                </span>

                {/* Loop sub-indicator — only on the active Learn step */}
                {isCurrent && isInLoop && (
                  <div className="flex items-center gap-1">
                    {phase === "interleave" ? (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] font-semibold text-amber-600 dark:text-amber-400">
                        Review
                      </span>
                    ) : (
                      LOOP_INNER.map((p, li) => {
                        const isActive = phase === p;
                        const isPast   = LOOP_INNER.indexOf(phase as (typeof LOOP_INNER)[number]) > li;
                        return (
                          <Fragment key={p}>
                            <span
                              className={cn(
                                "text-[9px] font-medium transition-colors",
                                isActive ? "text-[var(--accent)]"
                                  : isPast  ? "text-[var(--accent)] opacity-40"
                                  : "text-[var(--text-muted)] opacity-50",
                              )}
                            >
                              {LOOP_INNER_LABELS[p]}
                            </span>
                            {li < LOOP_INNER.length - 1 && (
                              <span className="text-[9px] text-[var(--text-muted)] opacity-30">·</span>
                            )}
                          </Fragment>
                        );
                      })
                    )}
                    {totalObj > 1 && (
                      <span className="ml-1.5 rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[9px] font-semibold text-[var(--accent)]">
                        {currentObjIdx !== null ? currentObjIdx + 1 : totalObj}/{totalObj}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Objectives list ────────────────────────────────────────── */}
      {arc.objectives.length > 0 && (
        <div className="mt-5">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              Objectives
            </span>
            <span className="text-[11px] tabular-nums text-[var(--text-muted)]">
              {masteredCount} / {totalObj} mastered
            </span>
          </div>

          <div className="space-y-1">
            {arc.objectives.map((obj) => {
              const isCurrent = obj.index === currentObjIdx;

              return (
                <div
                  key={obj.index}
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors",
                    isCurrent  && "bg-[var(--accent)]/[0.07] ring-1 ring-inset ring-[var(--accent)]/20",
                    obj.mastered && !isCurrent && "opacity-50",
                  )}
                >
                  {/* Status indicator */}
                  <div className="mt-0.5 shrink-0">
                    {obj.mastered ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-[var(--accent)]" />
                    ) : isCurrent ? (
                      <div className="h-2.5 w-2.5 rounded-full bg-[var(--accent)]" />
                    ) : (
                      <div className="h-2.5 w-2.5 rounded-full border-2 border-[var(--border)]" />
                    )}
                  </div>

                  {/* Objective text — full, no truncation */}
                  <span
                    className={cn(
                      "text-xs leading-snug",
                      isCurrent   ? "font-medium text-[var(--text)]"
                        : obj.mastered ? "text-[var(--text-muted)] line-through"
                        : "text-[var(--text-muted)]",
                    )}
                  >
                    {obj.text}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
