import { Suspense, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Play } from "lucide-react";

import { lazyWithRetry } from "@/utils/lazyWithRetry";
import {
  useRunTask,
  useTask,
  useTaskRun,
  useTaskRuns,
  useUpdateTask,
} from "@/hooks/useTasks";
import type { WorkspaceItemNode } from "@/api/workspaces";
import { RunStatusChip } from "@/components/tasks/RunStatusChip";
import { TaskRunDocument } from "@/components/tasks/TaskRunDocument";
import { Button } from "@/components/shared/Button";
import { cn } from "@/utils/cn";
import { ItemPaneHeader } from "./ItemPaneHeader";

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
export function WorkspaceAutomationPane({
  taskId,
  workspaceId,
  node,
  canEdit = true,
}: {
  taskId: string;
  /** With ``node``, the unified ItemPaneHeader replaces the bespoke title
   *  strip (adds rename-in-place). */
  workspaceId?: string;
  node?: WorkspaceItemNode;
  canEdit?: boolean;
}) {
  const { data: task } = useTask(taskId);
  const updateTask = useUpdateTask();
  const qc = useQueryClient();
  const runTask = useRunTask();
  const { data: runs } = useTaskRuns(taskId, true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [showFlow, setShowFlow] = useState(true);
  // The run just kicked off by "Run now" — the flow canvas animates this one
  // (rather than instantly painting an old run picked from the rail).
  const [animateRunId, setAnimateRunId] = useState<string | null>(null);

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
    setAnimateRunId(created.id);
  };

  // Picking a run always shows it — flip out of the Flow tab if needed,
  // otherwise the selection highlights but nothing visible changes.
  const onRunClick = (id: string) => {
    setSelectedRunId(id);
    setShowFlow(false);
  };

  const controls = (
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
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {workspaceId && node ? (
        <ItemPaneHeader
          workspaceId={workspaceId}
          itemId={node.id}
          kind="task"
          fallbackTitle={task?.title ?? node.title ?? "Automation"}
          canEdit={canEdit}
          extra={controls}
          onRename={async (title) => {
            await updateTask.mutateAsync({ id: taskId, input: { title } });
            // The rail node is synthesised from the task — refresh the tree
            // so the navigator label follows the rename.
            void qc.invalidateQueries({
              queryKey: ["workspaces", "tree", workspaceId],
            });
          }}
        />
      ) : (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
          <span className="truncate text-xs font-medium text-[var(--text)]">
            {task?.title ?? "Automation"}
          </span>
          {controls}
        </div>
      )}

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
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[var(--text-muted)]">
                    {r.title || "Run"}
                  </span>
                  {/* Runs often share a title — the timestamp is what tells
                      them apart in the rail. */}
                  <span className="block truncate text-[10px] text-[var(--text-muted)]/70">
                    {new Date(r.created_at).toLocaleString([], {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
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
              <TaskFlowEditor
                taskId={taskId}
                activeRun={run ?? null}
                animateRunId={animateRunId}
              />
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
    </div>
  );
}
