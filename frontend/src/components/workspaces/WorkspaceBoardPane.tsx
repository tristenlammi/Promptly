import { useMemo, useState } from "react";
import {
  ArrowUpDown,
  CalendarDays,
  Check,
  Clock,
  Columns3,
  Globe,
  LayoutGrid,
  Link2,
  Loader2,
  Paperclip,
  Plus,
  Search,
  Settings,
  Square,
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
  useWorkspaceTree,
} from "@/hooks/useWorkspaces";
import { filesApi } from "@/api/files";
import type {
  BoardColumn,
  BoardLabel,
  BoardMember,
  TaskLink,
  TaskPriority,
  WorkspaceItemNode,
  WorkspaceTask,
} from "@/api/workspaces";
import { confirm } from "@/components/shared/ConfirmDialog";
import { cn } from "@/utils/cn";
import { WorkspaceBoardCalendar } from "./WorkspaceBoardCalendar";
import {
  WorkspaceBoardCardDetail,
  openTaskLink,
} from "./WorkspaceBoardCardDetail";
import { WorkspaceFileImage } from "./WorkspaceFileImage";

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

/** Columns a board falls back to when it hasn't customised any. The ids
 *  match the legacy ``status`` values so existing tasks land correctly. */
const DEFAULT_COLUMNS: BoardColumn[] = [
  { id: "todo", name: "To Do" },
  { id: "doing", name: "In Progress" },
  { id: "done", name: "Done", done: true },
];

const genColId = () => "c_" + Math.random().toString(36).slice(2, 9);

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

/** How much detail each card shows on the board.
 *  ``compact`` = title + due; ``detailed`` adds the description; ``full``
 *  adds labels, links, attachments (incl. cover) and the checklist. */
type Density = "compact" | "detailed" | "full";
const DENSITY_KEY = "promptly:board-density";
const DENSITIES: { key: Density; label: string }[] = [
  { key: "compact", label: "Compact" },
  { key: "detailed", label: "Detailed" },
  { key: "full", label: "Full" },
];
function loadDensity(): Density {
  const v = (typeof localStorage !== "undefined" &&
    localStorage.getItem(DENSITY_KEY)) as Density | null;
  return v === "compact" || v === "detailed" || v === "full" ? v : "detailed";
}

type SortKey = "manual" | "created" | "due" | "priority";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "manual", label: "Manual" },
  { key: "created", label: "Created" },
  { key: "due", label: "Due date" },
  { key: "priority", label: "Priority" },
];

function sortTasks(tasks: WorkspaceTask[], key: SortKey): WorkspaceTask[] {
  const out = [...tasks];
  if (key === "manual") {
    out.sort((a, b) => a.position - b.position);
  } else if (key === "due") {
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
  onOpenItem,
}: {
  workspaceId: string;
  boardItemId: string;
  canEdit: boolean;
  /** Open another navigator item inline (used by card links). */
  onOpenItem?: (node: WorkspaceItemNode) => void;
}) {
  const { data: tasks, isLoading } = useWorkspaceTasks(workspaceId, boardItemId);
  const { data: boardItem } = useWorkspaceItem(workspaceId, boardItemId);
  const { data: workspace } = useWorkspace(workspaceId);
  const { data: tree } = useWorkspaceTree(workspaceId);
  const create = useCreateWorkspaceTask(workspaceId);
  const update = useUpdateWorkspaceTask(workspaceId);
  const remove = useDeleteWorkspaceTask(workspaceId);
  const setConfig = useSetBoardConfig(workspaceId, boardItemId);

  const [view, setView] = useState<"board" | "calendar">("board");
  const [density, setDensity] = useState<Density>(loadDensity);
  const [sortKey, setSortKey] = useState<SortKey>("manual");

  const changeDensity = (d: Density) => {
    setDensity(d);
    try {
      localStorage.setItem(DENSITY_KEY, d);
    } catch {
      /* ignore quota / unavailable storage */
    }
  };
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  // Set to a card's id right after the "+" creates it so the detail panel
  // can focus + select the placeholder title for immediate renaming.
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [managingCols, setManagingCols] = useState(false);

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

  // Flatten the tree into linkable targets (everything but folders, and not
  // this board itself) for the card detail's link picker.
  const linkables = useMemo(() => {
    const out: WorkspaceItemNode[] = [];
    const walk = (nodes: WorkspaceItemNode[]) => {
      for (const n of nodes) {
        if (n.kind === "folder") {
          walk(n.children);
        } else {
          if (n.id !== boardItemId) out.push(n);
          if (n.children.length) walk(n.children);
        }
      }
    };
    walk(tree ?? []);
    return out;
  }, [tree, boardItemId]);

  const labels: BoardLabel[] = boardItem?.config?.labels ?? [];
  const labelMap = useMemo(
    () => Object.fromEntries(labels.map((l) => [l.id, l])),
    [labels]
  );
  const onLabelsChange = (next: BoardLabel[]) =>
    setConfig.mutate({ ...(boardItem?.config ?? {}), labels: next });

  const boardColumns: BoardColumn[] =
    boardItem?.config?.columns && boardItem.config.columns.length > 0
      ? boardItem.config.columns
      : DEFAULT_COLUMNS;
  const onColumnsChange = (next: BoardColumn[]) =>
    setConfig.mutate({ ...(boardItem?.config ?? {}), columns: next });

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
      // AND semantics: a card must carry *every* selected label (it may
      // carry others too).
      const tl = t.labels ?? [];
      if (!labelFilter.every((id) => tl.includes(id))) return false;
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
  const firstColId = boardColumns[0]?.id ?? "todo";
  const colIds = boardColumns.map((c) => c.id);
  const columns = useMemo(() => {
    const filtered = list.filter(matches);
    return boardColumns.map((col, idx) => ({
      col,
      // Tasks whose status isn't a known column fall into the first column.
      tasks: sortTasks(
        filtered.filter((t) => {
          const s = t.status ?? firstColId;
          return colIds.includes(s) ? s === col.id : idx === 0;
        }),
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
    boardItem?.config?.columns,
  ]);

  /** Create a placeholder card in ``colId`` and open its detail panel so the
   *  user edits it in full (title pre-selected for renaming). */
  const addTask = (colId: string) => {
    if (create.isPending) return;
    create.mutate(
      { title: "Untitled", status: colId, board_item_id: boardItemId },
      {
        onSuccess: (newTask) => {
          setJustCreatedId(newTask.id);
          setOpenTaskId(newTask.id);
        },
      }
    );
  };

  /** Delete a card behind a confirm modal; closes its detail panel if open. */
  const confirmDeleteTask = async (task: WorkspaceTask) => {
    const ok = await confirm({
      title: "Delete card",
      message: (
        <>
          Delete <span className="font-medium">“{task.title || "Untitled"}”</span>?
          This permanently removes the card and its comments, links, and
          attachments. This can’t be undone.
        </>
      ),
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    remove.mutate(task.id);
    setOpenTaskId((cur) => (cur === task.id ? null : cur));
  };

  /** Drop a card into a column, optionally before ``beforeTaskId`` (manual
   *  reorder). Position is the midpoint so neighbours don't renumber. */
  const drop = (task: WorkspaceTask, colId: string, beforeTaskId?: string) => {
    const colTasks = sortTasks(
      list.filter((t) => {
        const s = t.status ?? firstColId;
        return colIds.includes(s)
          ? s === colId
          : colId === firstColId;
      }),
      "manual"
    ).filter((t) => t.id !== task.id);

    let position = task.position;
    const idx = beforeTaskId
      ? colTasks.findIndex((t) => t.id === beforeTaskId)
      : -1;
    if (idx <= 0) {
      const first = colTasks[idx === 0 ? 0 : -1];
      if (idx === 0 && first) position = first.position - 1;
      else if (colTasks.length)
        position = colTasks[colTasks.length - 1].position + 1;
    } else {
      const prev = colTasks[idx - 1];
      const next = colTasks[idx];
      position = (prev.position + next.position) / 2;
    }

    const payload: { status?: string; position: number } = { position };
    if (task.status !== colId) payload.status = colId;
    update.mutate({ taskId: task.id, payload });
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
        <div className="flex items-center gap-2">
          {/* Board / Calendar view toggle */}
          <div className="inline-flex overflow-hidden rounded-md border border-[var(--border)]">
            <button
              type="button"
              onClick={() => setView("board")}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 text-xs transition",
                view === "board"
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]"
              )}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              Board
            </button>
            <button
              type="button"
              onClick={() => setView("calendar")}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 text-xs transition",
                view === "calendar"
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]"
              )}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              Calendar
            </button>
          </div>
          {/* Card density */}
          {view === "board" && (
            <div className="inline-flex overflow-hidden rounded-md border border-[var(--border)]">
              {DENSITIES.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => changeDensity(d.key)}
                  title={`${d.label} cards`}
                  className={cn(
                    "px-2 py-1 text-xs transition",
                    density === d.key
                      ? "bg-[var(--accent)] text-white"
                      : "bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]"
                  )}
                >
                  {d.label}
                </button>
              ))}
            </div>
          )}
          {view === "board" && canEdit && (
            <button
              type="button"
              onClick={() => setManagingCols((m) => !m)}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              <Columns3 className="h-3.5 w-3.5" />
              Columns
            </button>
          )}
          {view === "board" && (
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
          )}
        </div>
      </div>

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

      {/* Column manager */}
      {view === "board" && managingCols && canEdit && (
        <ColumnsManager
          columns={boardColumns}
          onChange={onColumnsChange}
          onClose={() => setManagingCols(false)}
        />
      )}

      {/* Calendar view */}
      {!isLoading && view === "calendar" && (
        <WorkspaceBoardCalendar
          tasks={list.filter(matches)}
          canEdit={canEdit}
          onOpen={(id) => setOpenTaskId(id)}
          onReschedule={(taskId, dueIso) =>
            update.mutate({ taskId, payload: { due_at: dueIso } })
          }
        />
      )}

      {/* Columns */}
      {isLoading ? (
        <p className="py-4 text-sm text-[var(--text-muted)]">Loading…</p>
      ) : view === "board" ? (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {columns.map(({ col, tasks: colTasks }) => {
            const overWip =
              typeof col.wip === "number" &&
              col.wip > 0 &&
              colTasks.length > col.wip;
            return (
              <div
                key={col.id}
                onDragOver={(e) => {
                  if (!canEdit || !dragId) return;
                  e.preventDefault();
                  setDropCol(col.id);
                }}
                onDragLeave={() =>
                  setDropCol((c) => (c === col.id ? null : c))
                }
                onDrop={(e) => {
                  e.preventDefault();
                  setDropCol(null);
                  const id = e.dataTransfer.getData("text/plain") || dragId;
                  const task = list.find((t) => t.id === id);
                  if (task) drop(task, col.id);
                  setDragId(null);
                }}
                className={cn(
                  "flex w-[270px] shrink-0 flex-col rounded-lg border bg-[var(--surface)]/40 transition md:flex-1",
                  dropCol === col.id
                    ? "border-[var(--accent)] bg-[var(--accent)]/5"
                    : "border-[var(--border)]"
                )}
              >
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="truncate text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    {col.name}
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span
                      className={cn(
                        "rounded-full px-1.5 text-[11px]",
                        overWip
                          ? "bg-[var(--danger-bg)] text-[var(--danger)]"
                          : "bg-[var(--hover)] text-[var(--text-muted)]"
                      )}
                    >
                      {colTasks.length}
                      {typeof col.wip === "number" && col.wip > 0
                        ? `/${col.wip}`
                        : ""}
                    </span>
                    {canEdit && (
                      <button
                        type="button"
                        title="New item"
                        disabled={create.isPending}
                        onClick={() => addTask(col.id)}
                        className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-[var(--accent)] text-white transition hover:bg-[var(--accent-hover)] disabled:opacity-50"
                      >
                        {create.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex min-h-[56px] flex-1 flex-col gap-2 px-2 pb-3">
                  {colTasks.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-[var(--text-muted)]">
                      No tasks
                    </p>
                  ) : (
                    colTasks.map((task) => (
                      <div
                        key={task.id}
                        onDragOver={(e) => {
                          if (!canEdit || !dragId || dragId === task.id) return;
                          e.preventDefault();
                          e.stopPropagation();
                          setDropCol(col.id);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDropCol(null);
                          const id =
                            e.dataTransfer.getData("text/plain") || dragId;
                          const dragged = list.find((t) => t.id === id);
                          if (dragged && dragged.id !== task.id)
                            drop(dragged, col.id, task.id);
                          setDragId(null);
                        }}
                      >
                        <BoardCard
                          task={task}
                          canEdit={canEdit}
                          density={density}
                          dragging={dragId === task.id}
                          onOpenItem={onOpenItem}
                          onToggleSubtask={(subId) => {
                            const next = (task.subtasks ?? []).map((s) =>
                              s.id === subId ? { ...s, done: !s.done } : s
                            );
                            update.mutate({
                              taskId: task.id,
                              payload: { subtasks: next.length ? next : null },
                            });
                          }}
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
                              payload: {
                                priority: PRIORITY_NEXT[task.priority],
                              },
                            })
                          }
                          onDelete={() => void confirmDeleteTask(task)}
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
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {openTask && (
        <WorkspaceBoardCardDetail
          task={openTask}
          workspaceId={workspaceId}
          canEdit={canEdit}
          labels={labels}
          onLabelsChange={onLabelsChange}
          members={members}
          columns={boardColumns}
          linkables={linkables}
          onOpenItem={onOpenItem}
          autoFocusTitle={openTask.id === justCreatedId}
          onClose={() => {
            setOpenTaskId(null);
            setJustCreatedId(null);
          }}
          onUpdate={(payload) =>
            update.mutate({ taskId: openTask.id, payload })
          }
          onDelete={() => void confirmDeleteTask(openTask)}
        />
      )}
    </section>
  );
}

function ColumnsManager({
  columns,
  onChange,
  onClose,
}: {
  columns: BoardColumn[];
  onChange: (cols: BoardColumn[]) => void;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");
  const update = (id: string, patch: Partial<BoardColumn>) =>
    onChange(columns.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const remove = (id: string) => {
    if (columns.length <= 1) return; // keep at least one column
    onChange(columns.filter((c) => c.id !== id));
  };
  const move = (id: string, dir: -1 | 1) => {
    const i = columns.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= columns.length) return;
    const next = [...columns];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const add = () => {
    const name = newName.trim();
    if (!name) return;
    onChange([...columns, { id: genColId(), name }]);
    setNewName("");
  };

  return (
    <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Columns
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-2">
        {columns.map((c, i) => (
          <div key={c.id} className="flex items-center gap-2">
            <div className="flex flex-col">
              <button
                type="button"
                disabled={i === 0}
                onClick={() => move(c.id, -1)}
                className="text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-30"
              >
                <ArrowUpDown className="h-3 w-3 rotate-180" />
              </button>
            </div>
            <input
              value={c.name}
              onChange={(e) => update(c.id, { name: e.target.value })}
              className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-sm text-[var(--text)] outline-none"
            />
            <label
              className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]"
              title="Cards in this column count as done"
            >
              <input
                type="checkbox"
                checked={Boolean(c.done)}
                onChange={(e) => update(c.id, { done: e.target.checked })}
              />
              Done
            </label>
            <input
              type="number"
              min={0}
              value={c.wip ?? ""}
              placeholder="WIP"
              onChange={(e) =>
                update(c.id, {
                  wip: e.target.value ? Number(e.target.value) : null,
                })
              }
              className="w-14 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-xs text-[var(--text)] outline-none"
            />
            <button
              type="button"
              disabled={columns.length <= 1}
              onClick={() => remove(c.id)}
              className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--danger)] disabled:opacity-30"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2 pt-1">
          <Plus className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Add a column…"
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </div>
      </div>
    </div>
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
  density,
  dragging,
  labels,
  assignee,
  onOpenItem,
  onToggleSubtask,
  onDragStart,
  onDragEnd,
  onCyclePriority,
  onDelete,
  onOpen,
}: {
  task: WorkspaceTask;
  canEdit: boolean;
  density: Density;
  dragging: boolean;
  labels: BoardLabel[];
  assignee?: BoardMember;
  onOpenItem?: (node: WorkspaceItemNode) => void;
  onToggleSubtask: (subId: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onCyclePriority: () => void;
  onDelete: () => void;
  /** Open the full edit panel (now via the cog, not a card-body click). */
  onOpen: () => void;
}) {
  const prio = PRIORITY_META[task.priority];
  const urgency = task.due_at ? dueUrgency(task.due_at, task.done) : null;
  const subs = task.subtasks ?? [];
  const subDone = subs.filter((s) => s.done).length;
  const hasDesc = Boolean((task.description ?? "").trim());
  const links = task.links ?? [];
  const attachments = task.attachments ?? [];
  const cover = attachments.find((a) => a.is_cover);

  const showDesc = density !== "compact";
  const full = density === "full";

  return (
    <div
      draggable={canEdit}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "group overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg)] shadow-sm transition hover:border-[var(--accent)]",
        canEdit && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-40"
      )}
    >
      {full && cover && (
        <WorkspaceFileImage
          fileId={cover.file_id}
          className="h-24 w-full object-cover"
        />
      )}
      <div className="p-2">
        {full && labels.length > 0 && (
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
              className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition hover:text-[var(--danger)] group-hover:opacity-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Description (detailed + full) */}
        {showDesc && hasDesc && (
          <p
            className={cn(
              "mt-1.5 whitespace-pre-wrap break-words pl-[18px] text-xs text-[var(--text-muted)]",
              full ? "line-clamp-6" : "line-clamp-2"
            )}
          >
            {task.description}
          </p>
        )}

        {/* Due date (all densities) */}
        {task.due_at && (
          <div className="mt-1.5 pl-[18px] text-[11px]">
            <span
              className={cn(
                "inline-flex items-center gap-1",
                urgency === "overdue"
                  ? "text-[var(--danger)]"
                  : urgency === "soon"
                    ? "text-[var(--warning)]"
                    : "text-[var(--text-muted)]"
              )}
            >
              <Clock className="h-3 w-3" />
              {formatDue(task.due_at)}
              {urgency === "overdue" && !task.done && " · overdue"}
            </span>
          </div>
        )}

        {/* Checklist, links, attachments (full only) */}
        {full && subs.length > 0 && (
          <div className="mt-2 pl-[18px]">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              Checklist · {subDone}/{subs.length}
            </div>
            <div className="flex flex-col gap-0.5">
              {subs.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={!canEdit}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleSubtask(s.id);
                  }}
                  className="flex items-center gap-1.5 text-left text-xs text-[var(--text-muted)] disabled:cursor-default"
                >
                  {s.done ? (
                    <Check className="h-3 w-3 shrink-0 text-[var(--success)]" />
                  ) : (
                    <Square className="h-3 w-3 shrink-0" />
                  )}
                  <span
                    className={cn(
                      "min-w-0 truncate",
                      s.done
                        ? "text-[var(--text-muted)] line-through"
                        : "text-[var(--text)]"
                    )}
                  >
                    {s.text}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {full && links.length > 0 && (
          <div className="mt-2 flex flex-col gap-0.5 pl-[18px]">
            {links.map((l) => {
              const isUrl = l.kind === "url";
              const LinkIcon = isUrl ? Globe : Link2;
              return (
                <button
                  key={l.item_id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openTaskLink(l as TaskLink, onOpenItem);
                  }}
                  title={isUrl ? l.url ?? l.title : `Open ${l.title}`}
                  className="inline-flex items-center gap-1.5 text-left text-xs text-[var(--text-muted)] transition hover:text-[var(--accent)]"
                >
                  <LinkIcon className="h-3 w-3 shrink-0" />
                  <span className="min-w-0 truncate underline-offset-2 hover:underline">
                    {l.title || l.url || "Untitled"}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {full && attachments.length > 0 && (
          <div className="mt-2 flex flex-col gap-0.5 pl-[18px]">
            {attachments.map((a) => (
              <a
                key={a.file_id}
                href={filesApi.downloadUrl(a.file_id)}
                target="_blank"
                rel="noreferrer"
                draggable={false}
                onClick={(e) => e.stopPropagation()}
                title={`Open ${a.filename || "file"}`}
                className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] transition hover:text-[var(--accent)]"
              >
                <Paperclip className="h-3 w-3 shrink-0" />
                <span className="min-w-0 truncate underline-offset-2 hover:underline">
                  {a.filename || "File"}
                </span>
              </a>
            ))}
          </div>
        )}

        {/* Edit cog — opens the full detail panel (card body is inert). */}
        <div className="mt-1.5 flex justify-end">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            title="Edit card"
            className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
