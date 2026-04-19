import { CheckCircle2, Circle, ClipboardList, Loader2 } from "lucide-react";

import type { WhiteboardExerciseSummary } from "@/api/types";
import { cn } from "@/utils/cn";

interface ExerciseHistoryProps {
  exercises: WhiteboardExerciseSummary[];
  activeExerciseId: string | null;
  onSelect: (exerciseId: string) => void;
  isLoading?: boolean;
}

/**
 * Vertical list of past exercises in the current session. Clicking a row
 * re-hydrates the whiteboard iframe with that exercise's HTML so the student
 * can revisit earlier problems.
 */
export function ExerciseHistory({
  exercises,
  activeExerciseId,
  onSelect,
  isLoading,
}: ExerciseHistoryProps) {
  if (isLoading && exercises.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-8 text-sm text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading exercises…
      </div>
    );
  }
  if (exercises.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-[var(--text-muted)]">
        <ClipboardList className="h-6 w-6 opacity-60" />
        <div>
          <div className="font-medium text-[var(--text)]">No exercises yet</div>
          <div className="mt-1">
            Ask the tutor for a quiz or practice problem to get started.
          </div>
        </div>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-[var(--border)]">
      {exercises.map((ex) => {
        const isActive = ex.id === activeExerciseId;
        return (
          <li key={ex.id}>
            <button
              type="button"
              onClick={() => onSelect(ex.id)}
              className={cn(
                "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors",
                "hover:bg-[var(--surface-muted)]",
                isActive && "bg-[var(--surface-muted)]"
              )}
            >
              <StatusDot status={ex.status} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--text)]">
                  {ex.title ?? "Untitled exercise"}
                </div>
                <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                  {statusLabel(ex.status)} · {formatRelative(ex.created_at)}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function StatusDot({ status }: { status: WhiteboardExerciseSummary["status"] }) {
  if (status === "reviewed") {
    return (
      <CheckCircle2
        className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--accent)]"
        aria-hidden
      />
    );
  }
  if (status === "submitted") {
    return (
      <Loader2
        className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin text-[var(--text-muted)]"
        aria-hidden
      />
    );
  }
  return (
    <Circle
      className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--text-muted)]"
      aria-hidden
    />
  );
}

function statusLabel(status: WhiteboardExerciseSummary["status"]): string {
  if (status === "reviewed") return "Reviewed";
  if (status === "submitted") return "Awaiting feedback";
  return "In progress";
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
