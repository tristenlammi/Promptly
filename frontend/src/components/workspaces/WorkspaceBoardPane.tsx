import { useMemo, useState } from "react";
import {
  AlignLeft,
  ArrowUpDown,
  CheckSquare,
  Clock,
  Loader2,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";

import {
  useCreateWorkspaceTask,
  useDeleteWorkspaceTask,
  useSetBoardConfig,
  useUpdateWorkspaceTask,
  useWorkspace,
  useWorkspaceItem,
  useWorkspaceTasks,
} from "@/hooks/useWorkspaces";
import type {
  BoardLabel,
  BoardMember,
  TaskPriority,
  TaskStatus,
  WorkspaceTask,
} from "@/api/workspaces";
import { cn } from "@/utils/cn";
import { WorkspaceBoardCardDetail } from "./WorkspaceBoardCardDetail";

/**
 * The workspace task board — a 3-column Kanban (To Do / In Progress / Done)
 * embedded directly on the workspace home.
 *
 * Status is the column; priority is a coloured dot on the card; an optional
 * due date shows a clock badge that turns orange as it approaches and red
 * once it's overdue. Cards drag between columns (native HTML5 DnD). The
 * sort control orders cards *within* each column by due date, priority, or
 * creation order. Read-only collaborators see the board but can't mutate it.
 *
 * Self-sizing: columns grow with their cards and the home page scrolls —
 * the board is a section in the flow, not a full-height pane.
 */

const COLUMNS: { key: TaskStatus; label: string; hint: string }[] = [
  { key: "todo", label: "To Do", hint: "Not started" },
  { key: "doing", label: "In Progress", hint: "Being worked on" },
  { key: "done", label: "Done", hint: "Completed" },
];

const PRIORITY_META: Record<TaskPriority, { dot: string; label: string }> = {
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

export function WorkspaceBoardPane({
  workspaceId,
  boardItemId,
  canEdit,
}: {
  workspaceId: string;
  boardItemId: string;
  canEdit: boolean;
}) {
  const { data: tasks, isLoading } = useWorkspaceTasks(workspaceId, boardItemId);
  const { data: boardItem } = useWorkspaceItem(workspaceId, boardItemId);
  const { data: workspace } = useWorkspace(workspaceId);
  const create = useCreateWorkspaceTask(workspaceId);
  const update = useUpdateWorkspaceTask(workspaceId);
  const remove = useDeleteWorkspaceTask(workspaceId);
  const setConfig = useSetBoardConfig(workspaceId, boardItemId);

  const [sortKey, setSortKey] = useState<SortKey>("created");
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<TaskStatus | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  // Filters (client-side over the loaded task list).
  const [search, setSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "all">(
    "all"
  );
  const [dueFilter, setDueFilter] = useState<
    "all" | "overdue" | "soon" | "has" | "none"
  >("all");
  const [labelFilter, setLabelFilter] = useState<string[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");

  const members = useMemo(() => {
    const out: BoardMember[] = [];
    if (workspace?.owner)
      out.push({
        id: workspace.owner.user_id,
        username: workspace.owner.username,
      });
    for (const c of workspace?.collaborators ?? [])
      out.push({ id: c.user_id, username: c.username });
    return out;
  }, [workspace]);
  const memberMap = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, m])),
    [members]
  );

  const labels: BoardLabel[] = boardItem?.config?.labels ?? [];
  const labelMap = useMemo(
    () => Object.fromEntries(labels.map((l) => [l.id, l])),
    [labels]
  );
  const onLabelsChange = (next: BoardLabel[]) =>
    setConfig.mutate({ ...(boardItem?.config ?? {}), labels: next });

  const filtersActive =
    Boolean(search.trim()) ||
    priorityFilter !== "all" ||
    dueFilter !== "all" ||
    labelFilter.length > 0 ||
    assigneeFilter !== "all";

  const matches = (t: WorkspaceTask): boolean => {
    if (search.trim()) {
      const q = search.toLowerCase();
      const hay = `${t.title} ${t.description ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (priorityFilter !== "all" && t.priority !== priorityFilter) return false;
    if (labelFilter.length) {
      const tl = t.labels ?? [];
      if (!labelFilter.some((id) => tl.includes(id))) return false;
    }
    if (assigneeFilter !== "all") {
      if (assigneeFilter === "none" && t.assignee_user_id) return false;
      if (assigneeFilter !== "none" && t.assignee_user_id !== assigneeFilter)
        return false;
    }
    if (dueFilter !== "all") {
      const u = t.due_at ? dueUrgency(t.due_at, t.done) : null;
      if (dueFilter === "overdue" && u !== "overdue") return false;
      if (dueFilter === "soon" && u !== "soon") return false;
      if (dueFilter === "has" && !t.due_at) return false;
      if (dueFilter === "none" && t.due_at) return false;
    }
    return true;
  };

  const list = tasks ?? [];
  const openTask = list.find((t) => t.id === openTaskId) ?? null;
  const columns = useMemo(() => {
    const filtered = list.filter(matches);
    return COLUMNS.map((col) => ({
      ...col,
      tasks: sortTasks(
        filtered.filter((t) => (t.status ?? "todo") === col.key),
        sortKey
      ),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    list,
    sortKey,
    search,
    priorityFilter,
    dueFilter,
    labelFilter,
    assigneeFilter,
  ]);

  const addTask = () => {
    const title = draft.trim();
    if (!title || create.isPending) return;
    create.mutate(
      { title, status: "todo", board_item_id: boardItemId },
      { onSuccess: () => setDraft("") }
    );
  };

  const moveTo = (task: WorkspaceTask, status: TaskStatus) => {
    if (task.status === status) return;
    update.mutate({ taskId: task.id, payload: { status } });
  };

  return (
    <section>
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Board</h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            {list.length} {list.length === 1 ? "task" : "tasks"} ·{" "}
            {list.filter((t) => !t.done).length} open
          </p>
        </div>
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

      {/* Add row */}
      {canEdit && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
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

      {/* Filter bar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1">
          <Search className="h-3.5 w-3.5 text-[var(--text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="w-28 bg-transparent text-xs text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </div>
        <select
          value={priorityFilter}
          onChange={(e) =>
            setPriorityFilter(e.target.value as TaskPriority | "all")
          }
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] outline-none"
        >
          <option value="all">Any priority</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select
          value={dueFilter}
          onChange={(e) =>
            setDueFilter(
              e.target.value as "all" | "overdue" | "soon" | "has" | "none"
            )
          }
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] outline-none"
        >
          <option value="all">Any due</option>
          <option value="overdue">Overdue</option>
          <option value="soon">Due soon</option>
          <option value="has">Has due date</option>
          <option value="none">No due date</option>
        </select>
        {members.length > 0 && (
          <select
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] outline-none"
          >
            <option value="all">Anyone</option>
            <option value="none">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.username}
              </option>
            ))}
          </select>
        )}
        {labels.map((l) => {
          const on = labelFilter.includes(l.id);
          return (
            <button
              key={l.id}
              type="button"
              onClick={() =>
                setLabelFilter((cur) =>
                  cur.includes(l.id)
                    ? cur.filter((x) => x !== l.id)
                    : [...cur, l.id]
                )
              }
              style={
                on
                  ? { backgroundColor: l.color, borderColor: l.color }
                  : { borderColor: l.color, color: l.color }
              }
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs",
                on ? "text-white" : "bg-transparent"
              )}
            >
              {l.name}
            </button>
          );
        })}
        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setPriorityFilter("all");
              setDueFilter("all");
              setLabelFilter([]);
              setAssigneeFilter("all");
            }}
            className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        )}
      </div>

      {/* Columns */}
      {isLoading ? (
        <p className="py-4 text-sm text-[var(--text-muted)]">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
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
                "flex flex-col rounded-lg border bg-[var(--surface)]/40 transition",
                dropCol === col.key
                  ? "border-[var(--accent)] bg-[var(--accent)]/5"
                  : "border-[var(--border)]"
              )}
            >
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  {col.label}
                </span>
                <span className="rounded-full bg-[var(--hover)] px-1.5 text-[11px] text-[var(--text-muted)]">
                  {col.tasks.length}
                </span>
              </div>
              <div className="flex min-h-[56px] flex-1 flex-col gap-2 px-2 pb-3">
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
                      onCyclePriority={() =>
                        update.mutate({
                          taskId: task.id,
                          payload: { priority: PRIORITY_NEXT[task.priority] },
                        })
                      }
                      onDelete={() => remove.mutate(task.id)}
                      onOpen={() => setOpenTaskId(task.id)}
                      labels={(task.labels ?? [])
                        .map((id) => labelMap[id])
                        .filter(Boolean)}
                      assignee={
                        task.assignee_user_id
                          ? memberMap[task.assignee_user_id]
                          : undefined
                      }
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {openTask && (
        <WorkspaceBoardCardDetail
          task={openTask}
          canEdit={canEdit}
          labels={labels}
          onLabelsChange={onLabelsChange}
          members={members}
          onClose={() => setOpenTaskId(null)}
          onUpdate={(payload) =>
            update.mutate({ taskId: openTask.id, payload })
          }
          onDelete={() => remove.mutate(openTask.id)}
        />
      )}
    </section>
  );
}

/** Small initials avatar, colour derived from the user id so it's stable. */
export function MemberAvatar({
  member,
  size = 18,
}: {
  member: BoardMember;
  size?: number;
}) {
  const hue =
    Array.from(member.id).reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <span
      title={member.username}
      style={{
        width: size,
        height: size,
        backgroundColor: `hsl(${hue} 55% 45%)`,
        fontSize: size * 0.5,
      }}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold uppercase text-white"
    >
      {member.username.slice(0, 1)}
    </span>
  );
}

function BoardCard({
  task,
  canEdit,
  dragging,
  labels,
  assignee,
  onDragStart,
  onDragEnd,
  onCyclePriority,
  onDelete,
  onOpen,
}: {
  task: WorkspaceTask;
  canEdit: boolean;
  dragging: boolean;
  labels: BoardLabel[];
  assignee?: BoardMember;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onCyclePriority: () => void;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const prio = PRIORITY_META[task.priority];
  const urgency = task.due_at ? dueUrgency(task.due_at, task.done) : null;
  const subs = task.subtasks ?? [];
  const subDone = subs.filter((s) => s.done).length;
  const hasDesc = Boolean((task.description ?? "").trim());
  const hasMeta = Boolean(task.due_at) || subs.length > 0 || hasDesc;

  return (
    <div
      draggable={canEdit}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={cn(
        "group cursor-pointer rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 shadow-sm transition hover:border-[var(--accent)]",
        dragging && "opacity-40"
      )}
    >
      {labels.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {labels.map((l) => (
            <span
              key={l.id}
              style={{ backgroundColor: l.color }}
              className="rounded-full px-1.5 py-px text-[10px] font-medium text-white"
            >
              {l.name}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-start gap-2">
        {/* Priority dot — click cycles low → medium → high */}
        <button
          type="button"
          disabled={!canEdit}
          onClick={(e) => {
            e.stopPropagation();
            onCyclePriority();
          }}
          title={`${prio.label} — click to change`}
          className={cn(
            "mt-1 h-2.5 w-2.5 shrink-0 rounded-full",
            prio.dot,
            !canEdit && "cursor-default"
          )}
        />

        <span
          className={cn(
            "min-w-0 flex-1 break-words text-sm",
            task.done
              ? "text-[var(--text-muted)] line-through"
              : "text-[var(--text)]"
          )}
        >
          {task.title}
        </span>

        {assignee && (
          <span className="mt-0.5 shrink-0">
            <MemberAvatar member={assignee} />
          </span>
        )}

        {canEdit && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete task"
            className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition hover:text-red-500 group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Meta row: due + checklist + description indicator */}
      {hasMeta && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-[18px] text-[11px] text-[var(--text-muted)]">
          {task.due_at && (
            <span
              className={cn(
                "inline-flex items-center gap-1",
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
            </span>
          )}
          {subs.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <CheckSquare className="h-3 w-3" />
              {subDone}/{subs.length}
            </span>
          )}
          {hasDesc && (
            <AlignLeft className="h-3 w-3" aria-label="Has description" />
          )}
        </div>
      )}
    </div>
  );
}
