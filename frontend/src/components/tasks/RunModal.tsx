import { Loader2 } from "lucide-react";

import { Modal } from "@/components/shared/Modal";
import { RunStatusChip } from "@/components/tasks/RunStatusChip";
import { TaskRunDocument } from "@/components/tasks/TaskRunDocument";
import { DiagnoseRun, RunSteps } from "@/components/tasks/RunSteps";
import type { TaskRun } from "@/api/tasks";

/**
 * A run viewer in a modal — per-node steps + the full report — opened by
 * clicking a run in the flow view, so the user can inspect a run without
 * leaving the flow board. They can still jump to the Runs page via
 * ``onOpenRuns``.
 */
export function RunModal({
  run,
  open,
  onClose,
  onOpenRuns,
}: {
  run: TaskRun | undefined;
  open: boolean;
  onClose: () => void;
  onOpenRuns?: () => void;
}) {
  const steps = run?.node_runs ?? [];
  return (
    <Modal
      open={open}
      onClose={onClose}
      widthClass="max-w-3xl"
      title={run ? "Run details" : "Run"}
    >
      {!run ? (
        <div className="flex items-center justify-center py-10 text-sm text-[var(--text-muted)]">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading run…
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
              <RunStatusChip status={run.status} />
              {new Date(run.created_at).toLocaleString()}
            </span>
            {onOpenRuns && (
              <button
                type="button"
                onClick={onOpenRuns}
                className="text-xs font-medium text-[var(--accent-text)] hover:underline"
              >
                Open in Runs →
              </button>
            )}
          </div>

          <DiagnoseRun run={run} />
          {steps.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Steps
              </div>
              <RunSteps steps={steps} />
            </div>
          )}

          <div className="border-t border-[var(--border)] pt-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Report
            </div>
            <div className="promptly-scroll max-h-[50vh] overflow-y-auto">
              <TaskRunDocument run={run} />
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
