import { Suspense, useEffect, useState } from "react";
import { Loader2, Play } from "lucide-react";

import { lazyWithRetry } from "@/utils/lazyWithRetry";
import { useRunTask, useTask, useTaskRun, useTaskRuns } from "@/hooks/useTasks";
import { RunStatusChip } from "@/components/tasks/RunStatusChip";
import { RunModal } from "@/components/tasks/RunModal";
import { TaskRunDocument } from "@/components/tasks/TaskRunDocument";
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
 * like notes/canvases. Workspace automations are a separate area from the
 * user's personal /tasks — they're only reachable here, so there's no
 * "full page" escape hatch. A Runs⇄Flow toggle keeps the runs viewable.
 */
export function WorkspaceAutomationPane({ taskId }: { taskId: string }) {
  const { data: task } = useTask(taskId);
  const runTask = useRunTask();
  const { data: runs } = useTaskRuns(taskId, true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [showFlow, setShowFlow] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  // Default-select the newest run so the Runs view has something to show.
  useEffect(() => {
    if (!selectedRunId && runs && runs.length > 0) setSelectedRunId(runs[0].id);
  }, [runs, selectedRunId]);

  const selected = (runs ?? []).find((r) => r.id === selectedRunId);
  const polling =
    selected?.status === "pending" || selected?.status === "running";
  const { data: run } = useTaskRun(taskId, selectedRunId ?? undefined, polling);

  const onRunNow = async () => {
    const created = await runTask.mutateAsync(taskId);
    setSelectedRunId(created.id);
    if (showFlow) setModalOpen(true);
  };

  const onRunClick = (id: string) => {
    setSelectedRunId(id);
    if (showFlow) setModalOpen(true); // flow view → modal; runs view → report
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
        <span className="truncate text-xs font-medium text-[var(--text)]">
          {task?.title ?? "Automation"}
        </span>
        <div className="flex items-center gap-1.5">
          <div className="inline-flex rounded-md border border-[var(--border)] p-0.5 text-xs">
            {[
              { flow: false, label: "Runs" },
              { flow: true, label: "Flow" },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => setShowFlow(o.flow)}
                className={cn(
                  "rounded px-2.5 py-1 transition",
                  showFlow === o.flow
                    ? "bg-[var(--accent)] text-white"
                    : "text-[var(--text-muted)] hover:bg-[var(--hover)]"
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
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
                onClick={() => onRunClick(r.id)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-[var(--hover)]",
                  r.id === selectedRunId && "bg-[var(--hover)]"
                )}
                title="View this run"
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
          {showFlow ? (
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
          ) : (
            <div className="promptly-scroll h-full overflow-y-auto px-5 py-4">
              {run ? (
                <TaskRunDocument run={run} />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
                  {(runs ?? []).length === 0
                    ? "No runs yet — hit Run now."
                    : "Select a run."}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showFlow && (
        <RunModal
          run={run}
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onOpenRuns={() => {
            setModalOpen(false);
            setShowFlow(false);
          }}
        />
      )}
    </div>
  );
}
