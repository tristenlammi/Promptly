import { useState } from "react";
import { Check, Plus, Square, Trash2, X } from "lucide-react";

import type {
  Subtask,
  TaskPriority,
  TaskStatus,
  WorkspaceTask,
  WorkspaceTaskUpdatePayload,
} from "@/api/workspaces";
import { cn } from "@/utils/cn";

/**
 * Card detail panel for a Kanban task — the full editor behind a board card.
 * Title, status (column), priority, due date, a markdown description, and a
 * subtask checklist. Every edit calls ``onUpdate`` with a partial payload;
 * the board's react-query invalidation refreshes the columns.
 */

const STATUS_OPTS: { value: TaskStatus; label: string }[] = [
  { value: "todo", label: "To Do" },
  { value: "doing", label: "In Progress" },
  { value: "done", label: "Done" },
];
const PRIORITY_OPTS: { value: TaskPriority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

const genId = () => Math.random().toString(36).slice(2, 10);

export function WorkspaceBoardCardDetail({
  task,
  canEdit,
  onClose,
  onUpdate,
  onDelete,
}: {
  task: WorkspaceTask;
  canEdit: boolean;
  onClose: () => void;
  onUpdate: (payload: WorkspaceTaskUpdatePayload) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const subtasks: Subtask[] = task.subtasks ?? [];
  const [newSub, setNewSub] = useState("");

  const commitTitle = () => {
    const next = title.trim();
    if (next && next !== task.title) onUpdate({ title: next });
    else setTitle(task.title);
  };
  const commitDescription = () => {
    if ((description ?? "") !== (task.description ?? ""))
      onUpdate({ description: description.trim() || null });
  };
  const setSubtasks = (next: Subtask[]) =>
    onUpdate({ subtasks: next.length ? next : null });

  const doneCount = subtasks.filter((s) => s.done).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="mt-4 w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--bg)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-2 border-b border-[var(--border)] p-4">
          <input
            value={title}
            disabled={!canEdit}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-base font-semibold text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {/* Status / priority / due */}
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              Column
              <select
                disabled={!canEdit}
                value={task.status}
                onChange={(e) =>
                  onUpdate({ status: e.target.value as TaskStatus })
                }
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)] outline-none"
              >
                {STATUS_OPTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              Priority
              <select
                disabled={!canEdit}
                value={task.priority}
                onChange={(e) =>
                  onUpdate({ priority: e.target.value as TaskPriority })
                }
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)] outline-none"
              >
                {PRIORITY_OPTS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              Due
              <input
                type="datetime-local"
                disabled={!canEdit}
                defaultValue={task.due_at ? toLocalInput(task.due_at) : ""}
                onChange={(e) =>
                  onUpdate({
                    due_at: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : null,
                  })
                }
                className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)] outline-none"
              />
            </label>
          </div>

          {/* Description */}
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              Description
            </div>
            <textarea
              value={description}
              disabled={!canEdit}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={commitDescription}
              rows={4}
              placeholder="Add more detail…"
              className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
            />
          </div>

          {/* Subtasks */}
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              <span>Checklist</span>
              {subtasks.length > 0 && (
                <span>
                  {doneCount}/{subtasks.length}
                </span>
              )}
            </div>
            <div className="space-y-1">
              {subtasks.map((s) => (
                <div key={s.id} className="group flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() =>
                      setSubtasks(
                        subtasks.map((x) =>
                          x.id === s.id ? { ...x, done: !x.done } : x
                        )
                      )
                    }
                    className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text)]"
                  >
                    {s.done ? (
                      <Check className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                  </button>
                  <input
                    value={s.text}
                    disabled={!canEdit}
                    onChange={(e) =>
                      setSubtasks(
                        subtasks.map((x) =>
                          x.id === s.id ? { ...x, text: e.target.value } : x
                        )
                      )
                    }
                    className={cn(
                      "min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm outline-none focus:border-[var(--accent)]",
                      s.done
                        ? "text-[var(--text-muted)] line-through"
                        : "text-[var(--text)]"
                    )}
                  />
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() =>
                        setSubtasks(subtasks.filter((x) => x.id !== s.id))
                      }
                      className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition hover:text-red-500 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {canEdit && (
              <div className="mt-1 flex items-center gap-2">
                <Plus className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                <input
                  value={newSub}
                  onChange={(e) => setNewSub(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newSub.trim()) {
                      e.preventDefault();
                      setSubtasks([
                        ...subtasks,
                        { id: genId(), text: newSub.trim(), done: false },
                      ]);
                      setNewSub("");
                    }
                  }}
                  placeholder="Add a checklist item…"
                  className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
                />
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        {canEdit && (
          <div className="flex justify-end border-t border-[var(--border)] p-3">
            <button
              type="button"
              onClick={() => {
                onDelete();
                onClose();
              }}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-500"
            >
              <Trash2 className="h-4 w-4" />
              Delete task
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
