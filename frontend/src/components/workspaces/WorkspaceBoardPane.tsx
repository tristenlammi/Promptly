import { useMemo, useState } from "react";
import {
  ArrowUpDown,
  CalendarPlus,
  Clock,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import {
  useCreateWorkspaceTask,
  useDeleteWorkspaceTask,
  useUpdateWorkspaceTask,
  useWorkspaceTasks,
} from "@/hooks/useWorkspaces";
import type {
  TaskPriority,
  TaskStatus,
  WorkspaceTask,
} from "@/api/workspaces";
import { cn } from "@/utils/cn";

/**
 * The workspace "Board" — a 3-column Kanban (To Do / In Progress / Done).
 *
 * Status is the column; priority is a coloured dot on the card; an optional
 * due date shows a clock badge that turns orange as it approaches and red
 * once it's overdue. Cards drag between columns (native HTML5 DnD). The
 * sort control orders cards *within* each column by due date, priority, or
 * creation order. Read-only collaborators see the board but can't mutate it.
 */

const COLUMNS: { key: TaskStatus; label: string; hint: string }[] = [
  { key: "todo", label: "To Do", hint: "Not started" },
  { key: "doing", label: "In Progress", hint: "Being worked on" },
  { key: "done", label: "Done", hint: "Completed" },
];

const PRIORITY_META: Record<
  TaskPriority,
  { dot: string; label: string }
> = {
  high: { dot: "bg-red-500", label: "High priority" },
  medium: { dot: "bg-amber-400", label: "Medium priority" },
  low: { dot: "bg-slate-400", label: "Low priority" },
};
const PRIORITY_RANK: Record<TaskPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};
const PRIORITY_NEXT: Record<TaskPriority, TaskPriority> = {
  low: "medium",
  medium: "high",
  high: "low",
};

type SortKey = "created" | "due" | "priority";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "created", label: "Created" },
  { key: "due", label: "Due date" },
  { key: "priority", label: "Priority" },
];

function sortTasks(tasks: WorkspaceTask[], key: SortKey): WorkspaceTask[] {
  const out = [...tasks];
  if (key === "due") {
    // Dated tasks first (soonest → latest), undated tasks last.
    out.sort((a, b) => {
      if (!a.due_at && !b.due_at) return a.position - b.position;
      if (!a.due_at) return 1;
      if (!b.due_at) return -1;
      return Date.parse(a.due_at) - Date.parse(b.due_at);
    });
  } else if (key === "priority") {
    out.sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.position - b.position
    );
  } else {
    out.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  }
  return out;
}

// ---- due-date helpers ------------------------------------------------------
type Urgency = "overdue" | "soon" | "later";

function dueUrgency(iso: string, done: boolean): Urgency {
  if (done) return "later";
  const diff = Date.parse(iso) - Date.now();
  if (diff < 0) return "overdue";
  if (diff < 24 * 60 * 60 * 1000) return "soon";
  return "later";
}

function formatDue(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** ISO (UTC) → value for <input type="datetime-local"> (local wall time). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

export function WorkspaceBoardPane({
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

  const [sortKey, setSortKey] = useState<SortKey>("created");
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<TaskStatus | null>(null);

  const list = tasks ?? [];
  const columns = useMemo(() => {
    return COLUMNS.map((col) => ({
      ...col,
      tasks: sortTasks(
        list.filter((t) => (t.status ?? "todo") === col.key),
        sortKey
      ),
    }));
  }, [list, sortKey]);

  const addTask = () => {
    const title = draft.trim();
    if (!title || create.isPending) return;
    create.mutate(
      { title, status: "todo" },
      { onSuccess: () => setDraft("") }
    );
  };

  const moveTo = (task: WorkspaceTask, status: TaskStatus) => {
    if (task.status === status) return;
    update.mutate({ taskId: task.id, payload: { status } });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text)]">Board</h1>
          <p className="text-xs text-[var(--text-muted)]">
            {list.length} {list.length === 1 ? "task" : "tasks"} ·{" "}
            {list.filter((t) => !t.done).length} open
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <ArrowUpDown className="h-3.5 w-3.5" />
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] outline-none"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Add row */}
      {canEdit && (
        <div className="flex shrink-0 items-center gap-2 px-4 py-2">
          <Plus className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTask();
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

      {/* Columns */}
      {isLoading ? (
        <p className="px-4 py-6 text-sm text-[var(--text-muted)]">Loading…</p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-4 md:grid-cols-3">
          {columns.map((col) => (
            <div
              key={col.key}
              onDragOver={(e) => {
                if (!canEdit || !dragId) return;
                e.preventDefault();
                setDropCol(col.key);
              }}
              onDragLeave={() => setDropCol((c) => (c === col.key ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                setDropCol(null);
                const id = e.dataTransfer.getData("text/plain") || dragId;
                const task = list.find((t) => t.id === id);
                if (task) moveTo(task, col.key);
                setDragId(null);
              }}
              className={cn(
                "flex min-h-0 flex-col rounded-lg border bg-[var(--surface)]/40 transition",
                dropCol === col.key
                  ? "border-[var(--accent)] bg-[var(--accent)]/5"
                  : "border-[var(--border)]"
              )}
            >
              <div className="flex shrink-0 items-center justify-between px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  {col.label}
                </span>
                <span className="rounded-full bg-[var(--hover)] px-1.5 text-[11px] text-[var(--text-muted)]">
                  {col.tasks.length}
                </span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
                {col.tasks.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-[var(--text-muted)]">
                    {col.hint}
                  </p>
                ) : (
                  col.tasks.map((task) => (
                    <BoardCard
                      key={task.id}
                      task={task}
                      canEdit={canEdit}
                      dragging={dragId === task.id}
                      onDragStart={(e) => {
                        setDragId(task.id);
                        e.dataTransfer.setData("text/plain", task.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setDropCol(null);
                      }}
                      onRename={(title) =>
                        update.mutate({ taskId: task.id, payload: { title } })
                      }
                      onCyclePriority={() =>
                        update.mutate({
                          taskId: task.id,
                          payload: { priority: PRIORITY_NEXT[task.priority] },
                        })
                      }
                      onSetDue={(due_at) =>
                        update.mutate({ taskId: task.id, payload: { due_at } })
                      }
                      onDelete={() => remove.mutate(task.id)}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BoardCard({
  task,
  canEdit,
  dragging,
  onDragStart,
  onDragEnd,
  onRename,
  onCyclePriority,
  onSetDue,
  onDelete,
}: {
  task: WorkspaceTask;
  canEdit: boolean;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onRename: (title: string) => void;
  onCyclePriority: () => void;
  onSetDue: (due_at: string | null) => void;
  onDelete: () => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [editingDue, setEditingDue] = useState(false);

  const prio = PRIORITY_META[task.priority];
  const urgency = task.due_at ? dueUrgency(task.due_at, task.done) : null;

  const commitTitle = () => {
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (next && next !== task.title) onRename(next);
    else setTitleDraft(task.title);
  };

  return (
    <div
      draggable={canEdit && !editingTitle && !editingDue}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "group rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 shadow-sm transition",
        canEdit && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-40"
      )}
    >
      <div className="flex items-start gap-2">
        {/* Priority dot — click cycles low → medium → high */}
        <button
          type="button"
          disabled={!canEdit}
          onClick={onCyclePriority}
          title={`${prio.label} — click to change`}
          className={cn(
            "mt-1 h-2.5 w-2.5 shrink-0 rounded-full",
            prio.dot,
            !canEdit && "cursor-default"
          )}
        />

        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") {
                setEditingTitle(false);
                setTitleDraft(task.title);
              }
            }}
            className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--surface)] px-1 py-0.5 text-sm outline-none"
          />
        ) : (
          <span
            onDoubleClick={() => canEdit && setEditingTitle(true)}
            className={cn(
              "min-w-0 flex-1 break-words text-sm",
              task.done
                ? "text-[var(--text-muted)] line-through"
                : "text-[var(--text)]"
            )}
          >
            {task.title}
          </span>
        )}

        {canEdit && (
          <button
            type="button"
            onClick={onDelete}
            title="Delete task"
            className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition hover:text-red-500 group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Due date row */}
      <div className="mt-1.5 pl-[18px]">
        {editingDue ? (
          <div className="flex items-center gap-1">
            <input
              type="datetime-local"
              autoFocus
              defaultValue={task.due_at ? toLocalInput(task.due_at) : ""}
              onChange={(e) => {
                onSetDue(e.target.value ? new Date(e.target.value).toISOString() : null);
              }}
              onBlur={() => setEditingDue(false)}
              className="rounded border border-[var(--border)] bg-[var(--surface)] px-1 py-0.5 text-[11px] text-[var(--text)] outline-none"
            />
            <button
              type="button"
              title="Close"
              onClick={() => setEditingDue(false)}
              className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : task.due_at ? (
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => canEdit && setEditingDue(true)}
            title={canEdit ? "Change due date" : undefined}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] disabled:cursor-default",
              urgency === "overdue"
                ? "text-red-500"
                : urgency === "soon"
                  ? "text-orange-500"
                  : "text-[var(--text-muted)]"
            )}
          >
            <Clock className="h-3 w-3" />
            {formatDue(task.due_at)}
            {urgency === "overdue" && !task.done && " · overdue"}
          </button>
        ) : (
          canEdit && (
            <button
              type="button"
              onClick={() => setEditingDue(true)}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-[var(--text-muted)] opacity-0 transition hover:text-[var(--text)] group-hover:opacity-100"
            >
              <CalendarPlus className="h-3 w-3" />
              Add due date
            </button>
          )
        )}
      </div>
    </div>
  );
}
