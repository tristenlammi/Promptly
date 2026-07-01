import { Suspense, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, Loader2, Play } from "lucide-react";

import { lazyWithRetry } from "@/utils/lazyWithRetry";
import { useRunTask, useTask, useTaskRun, useTaskRuns } from "@/hooks/useTasks";
import { RunStatusChip } from "@/components/tasks/RunStatusChip";
import { RunStepsDrawer } from "@/components/tasks/RunStepsDrawer";
import { Button } from "@/components/shared/Button";
import { cn } from "@/utils/cn";

// React Flow is heavy — only load it when an automation is opened.
const TaskFlowEditor = lazyWithRetry(
  () =>
    import("@/components/tasks/TaskFlowEditor").then((m) => ({
      default: m.TaskFlowEditor,
    })),
  "TaskFlowEditor"
);

/**
 * Renders an automation *inside* the workspace shell (rail + top bar stay put),
 * the same way notes/canvases/boards do — instead of navigating away to the
 * standalone Tasks page. Flow editor in the middle, a runs rail on the left,
 * and a per-node steps drawer when a run is clicked.
 */
export function WorkspaceAutomationPane({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  const { data: task } = useTask(taskId);
  const runTask = useRunTask();
  const { data: runs } = useTaskRuns(taskId, true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);

  const selected = (runs ?? []).find((r) => r.id === selectedRunId);
  const polling =
    selected?.status === "pending" || selected?.status === "running";
  const { data: run } = useTaskRun(taskId, selectedRunId ?? undefined, polling);

  const onRunNow = async () => {
    const created = await runTask.mutateAsync(taskId);
    setSelectedRunId(created.id);
    setStepsOpen(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
        <span className="truncate text-xs font-medium text-[var(--text)]">
          {task?.title ?? "Automation"}
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
            onClick={() => navigate(`/tasks/${taskId}`)}
            title="Open the full automation page"
          >
            Full page
          </Button>
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Play className="h-3.5 w-3.5" />}
            onClick={() => void onRunNow()}
            loading={runTask.isPending}
          >
            Run now
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {(runs ?? []).length > 0 && (
          <aside className="hidden w-48 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--bg)] md:flex">
            <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Runs
            </div>
            {(runs ?? []).map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setSelectedRunId(r.id);
                  setStepsOpen(true);
                }}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-[var(--hover)]",
                  stepsOpen && r.id === selectedRunId && "bg-[var(--hover)]"
                )}
                title="Inspect this run's per-node outputs"
              >
                <RunStatusChip status={r.status} />
                <span className="truncate text-[var(--text-muted)]">
                  {r.title || new Date(r.created_at).toLocaleDateString()}
                </span>
              </button>
            ))}
          </aside>
        )}

        <div className="min-w-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading flow…
              </div>
            }
          >
            <TaskFlowEditor taskId={taskId} />
          </Suspense>
        </div>

        {stepsOpen && run && (
          <RunStepsDrawer
            run={run}
            onClose={() => setStepsOpen(false)}
            onOpenReport={() => navigate(`/tasks/${taskId}`)}
          />
        )}
      </div>
    </div>
  );
}
