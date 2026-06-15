import { useState } from "react";
import { CheckSquare, Plus, Square, Trash2, Loader2 } from "lucide-react";

import {
  useCreateWorkspaceTask,
  useDeleteWorkspaceTask,
  useUpdateWorkspaceTask,
  useWorkspaceTasks,
} from "@/hooks/useWorkspaces";
import type { WorkspaceTask } from "@/api/workspaces";

/**
 * The workspace's first-class task list — a project-level to-do list that
 * lives on the overview "home", distinct from the checkbox rollup parsed
 * out of notes. Add, check off, and delete tasks for the workspace as a
 * whole. Read-only collaborators see the list but can't mutate it.
 */
export function WorkspaceTasksPanel({
  workspaceId,
  canEdit,
}: {
  workspaceId: string;
  canEdit: boolean;
}) {
  const { data: tasks, isLoading } = useWorkspaceTasks(workspaceId);
  const create = useCreateWorkspaceTask(workspaceId);
  const update = useUpdateWorkspaceTask(workspaceId);
  const remove = useDeleteWorkspaceTask(workspaceId);

  const [draft, setDraft] = useState("");

  const list = tasks ?? [];
  const openCount = list.filter((t) => !t.done).length;

  const submit = () => {
    const title = draft.trim();
    if (!title || create.isPending) return;
    create.mutate(title, { onSuccess: () => setDraft("") });
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Tasks
        </h2>
        {list.length > 0 && (
          <span className="text-[11px] text-[var(--text-muted)]">
            {openCount} open · {list.length - openCount} done
          </span>
        )}
      </div>

      {/* Add row */}
      {canEdit && (
        <div className="mb-2 flex items-center gap-2">
          <Plus className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Add a task and press Enter…"
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
          />
          {create.isPending && (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
          )}
        </div>
      )}

      {/* List */}
      {isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          {canEdit
            ? "No tasks yet. Add the first one above to start planning this workspace."
            : "No tasks yet."}
        </p>
      ) : (
        <div className="space-y-0.5">
          {list.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              canEdit={canEdit}
              onToggle={() =>
                update.mutate({
                  taskId: t.id,
                  payload: { done: !t.done },
                })
              }
              onDelete={() => remove.mutate(t.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TaskRow({
  task,
  canEdit,
  onToggle,
  onDelete,
}: {
  task: WorkspaceTask;
  canEdit: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--hover)]">
      <button
        type="button"
        disabled={!canEdit}
        onClick={onToggle}
        title={task.done ? "Mark as not done" : "Mark as done"}
        className="mt-0.5 shrink-0 disabled:cursor-default"
      >
        {task.done ? (
          <CheckSquare className="h-4 w-4 text-[var(--text-muted)]" />
        ) : (
          <Square className="h-4 w-4 text-[var(--accent)]" />
        )}
      </button>
      <span
        className={
          "min-w-0 flex-1 break-words text-sm " +
          (task.done
            ? "text-[var(--text-muted)] line-through"
            : "text-[var(--text)]")
        }
      >
        {task.title}
      </span>
      {canEdit && (
        <button
          type="button"
          onClick={onDelete}
          title="Delete task"
          className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition hover:bg-[var(--surface)] hover:text-red-500 group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
