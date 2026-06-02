import { useEffect } from "react";
import { CheckCircle2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { studyApi } from "@/api/study";
import { cn } from "@/utils/cn";

// ---- Phase metadata -------------------------------------------------

const PHASE_LABELS: Record<string, string> = {
  hook: "Hook",
  activate: "Activate",
  present: "Present",
  guided: "Guided",
  independent: "Practice",
  teachback: "Teach-back",
  transfer: "Transfer",
  close: "Close",
};

// Phases that belong to the per-objective teach loop.
const LOOP_PHASES = new Set(["present", "guided", "independent", "interleave"]);
const LOOP_INNER = ["present", "guided", "independent"] as const;

// Canonical order used to decide isDone for non-loop phases.
// Interleave lives inside the loop and is handled via LOOP_PHASES above.
const PRE_LOOP = ["hook", "activate"] as const;
const POST_LOOP = ["teachback", "transfer", "close"] as const;

// ---- Component ------------------------------------------------------

interface LessonArcRailProps {
  sessionId: string;
  /** Invalidation counter — bump when session phase might have changed. */
  phaseVersion?: number;
}

export function LessonArcRail({
  sessionId,
  phaseVersion = 0,
}: LessonArcRailProps) {
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
  const isInLoop = LOOP_PHASES.has(phase);
  const isPostLoop = (POST_LOOP as readonly string[]).includes(phase);
  // Which pre-loop phase index are we currently on (or past)?
  const preLoopIdx = PRE_LOOP.indexOf(phase as (typeof PRE_LOOP)[number]);

  // Objective progress: 1-indexed display
  const totalObj = arc.total_objectives || arc.objectives.length;
  const currentObjIdx = arc.current_objective_index; // 0-indexed, null = all done
  const objLabel =
    isInLoop && totalObj > 0
      ? currentObjIdx !== null
        ? `obj ${currentObjIdx + 1}/${totalObj}`
        : `${totalObj}/${totalObj}`
      : null;

  return (
    <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      {/* Phase strip */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1">

        {/* Pre-loop phases */}
        {PRE_LOOP.map((p, i) => {
          const isCurrent = phase === p;
          const isDone = preLoopIdx > i || isInLoop || isPostLoop;
          return (
            <PhaseChip key={p} label={PHASE_LABELS[p] ?? p} isDone={isDone} isCurrent={isCurrent} />
          );
        })}

        {/* Teach loop group */}
        <LoopGroup
          currentPhase={phase}
          isInLoop={isInLoop}
          isDone={isPostLoop}
          totalObjectives={totalObj}
          objLabel={objLabel}
        />

        {/* Post-loop phases */}
        {POST_LOOP.map((p, i) => {
          const isCurrent = phase === p;
          const isDone = isPostLoop && POST_LOOP.indexOf(phase as (typeof POST_LOOP)[number]) > i;
          return (
            <PhaseChip key={p} label={PHASE_LABELS[p] ?? p} isDone={isDone} isCurrent={isCurrent} />
          );
        })}
      </div>

      {/* Objective promises */}
      {arc.objectives.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {arc.objectives.map((obj) => (
            <ObjectiveChip
              key={obj.index}
              text={obj.text}
              mastered={obj.mastered}
              isCurrent={obj.index === currentObjIdx}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Loop group chip -----------------------------------------------

function LoopGroup({
  currentPhase,
  isInLoop,
  isDone,
  totalObjectives,
  objLabel,
}: {
  currentPhase: string;
  isInLoop: boolean;
  isDone: boolean;
  totalObjectives: number;
  objLabel: string | null;
}) {
  const isInterleave = currentPhase === "interleave";

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-0.5 transition-colors",
        isDone && "border-[var(--accent)]/20 bg-[var(--accent)]/5 opacity-50",
        isInLoop && "border-[var(--accent)]/40 bg-[var(--accent)]/10",
        !isDone && !isInLoop && "border-[var(--border)] bg-[var(--surface-muted)]"
      )}
    >
      {/* Inner phase chips */}
      {LOOP_INNER.map((p) => {
        const isCurrent = !isInterleave && currentPhase === p;
        const innerDone = isInLoop && !isCurrent
          ? LOOP_INNER.indexOf(p) < LOOP_INNER.indexOf(currentPhase as (typeof LOOP_INNER)[number])
          : isDone;
        return (
          <span
            key={p}
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[9px] font-medium transition-colors",
              isCurrent && "bg-[var(--accent)] text-white shadow-sm",
              innerDone && !isCurrent && "text-[var(--accent)] opacity-60",
              !isCurrent && !innerDone && "text-[var(--text-muted)]"
            )}
          >
            {PHASE_LABELS[p] ?? p}
          </span>
        );
      })}

      {/* Interleave indicator */}
      {isInterleave && (
        <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[9px] font-medium text-white shadow-sm">
          Review
        </span>
      )}

      {/* Repeat count */}
      {totalObjectives > 1 && (
        <span
          className={cn(
            "ml-0.5 shrink-0 text-[9px] tabular-nums",
            isInLoop ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
          )}
        >
          ×{totalObjectives}
        </span>
      )}

      {/* Current objective counter */}
      {objLabel && (
        <span className="ml-0.5 shrink-0 text-[9px] text-[var(--accent)] opacity-75">
          ({objLabel})
        </span>
      )}
    </div>
  );
}

// ---- Shared chip components ----------------------------------------

function PhaseChip({
  label,
  isDone,
  isCurrent,
}: {
  label: string;
  isDone: boolean;
  isCurrent: boolean;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
        isDone &&
          "bg-[var(--accent)]/10 text-[var(--accent)] line-through opacity-50",
        isCurrent &&
          "bg-[var(--accent)] text-white shadow-sm",
        !isDone &&
          !isCurrent &&
          "bg-[var(--surface-muted)] text-[var(--text-muted)]"
      )}
    >
      {label}
    </span>
  );
}

function ObjectiveChip({
  text,
  mastered,
  isCurrent,
}: {
  text: string;
  mastered: boolean;
  isCurrent: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] leading-tight",
        mastered
          ? "border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[var(--accent)]"
          : isCurrent
            ? "border-[var(--accent)]/50 bg-[var(--accent)]/5 text-[var(--text)]"
            : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]"
      )}
    >
      {mastered && <CheckCircle2 className="h-3 w-3 shrink-0" />}
      <span className="max-w-[160px] truncate">{text}</span>
    </span>
  );
}
