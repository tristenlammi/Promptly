import { useState } from "react";
import {
  ArrowRight,
  CheckSquare,
  Clock,
  FileText,
  Loader2,
  MessageSquare,
  Plus,
  Shapes,
  Sparkles,
  Square,
} from "lucide-react";

import type { TaskStatus, WorkspaceItemNode, WorkspaceTask } from "@/api/workspaces";
import {
  useCreateWorkspaceTask,
  useWorkspaceOverview,
  useWorkspaceTasks,
} from "@/hooks/useWorkspaces";
import { WorkspaceFilesPanel } from "./WorkspaceFilesPanel";
import { cn } from "@/utils/cn";

/**
 * Workspace overview "home" (Phase 4) — shown in the main pane when no
 * item is selected. At-a-glance counts, the workspace's first-class task
 * list, a secondary rollup of checkboxes found in notes, and a few
 * recently-touched items. Clicking a task or recent row opens the item.
 */
export function WorkspaceOverviewPane({
  workspaceId,
  title,
  onOpenItem,
  onOpenBoard,
  canEdit,
}: {
  workspaceId: string;
  title: string;
  onOpenItem: (node: WorkspaceItemNode) => void;
  onOpenBoard: () => void;
  canEdit: boolean;
}) {
  const { data: overview } = useWorkspaceOverview(workspaceId);
  const { data: workspaceTasks } = useWorkspaceTasks(workspaceId);

  const open = (
    partial: Pick<WorkspaceItemNode, "id" | "kind" | "ref_id" | "title">
  ) =>
    onOpenItem({
      ...partial,
      icon: null,
      position: 0,
      indexing_status: null,
      children: [],
    });

  const counts = overview?.counts;
  const tasks = overview?.tasks ?? [];
  const openTasks = tasks.filter((t) => !t.checked);
  const doneTasks = tasks.filter((t) => t.checked);
  const recent = overview?.recent ?? [];
  // Headline "Open tasks" stat now reflects the first-class task list.
  const openTaskCount = (workspaceTasks ?? []).filter((t) => !t.done).length;
  // A brand-new workspace gets a guided "get started" card instead of a
  // wall of empty sections.
  const isEmpty =
    (counts?.notes ?? 0) +
      (counts?.canvases ?? 0) +
      (counts?.chats ?? 0) +
      (counts?.files ?? 0) ===
    0;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="text-xl font-semibold text-[var(--text)]">{title}</h1>
      <p className="mt-0.5 text-sm text-[var(--text-muted)]">
        Workspace overview
      </p>

      {isEmpty && canEdit ? (
        <GettingStarted />
      ) : (
        <div className="mt-4 flex items-start gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)]">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
          <span>
            Everything you add here — notes, canvases, and files — becomes{" "}
            <span className="font-medium text-[var(--text)]">context</span> your
            chats can draw on. Toggle any item's ⚡ to include or exclude it.
          </span>
        </div>
      )}

      {/* Counts */}
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Notes" value={counts?.notes ?? 0} />
        <StatCard label="Canvases" value={counts?.canvases ?? 0} />
        <StatCard label="Chats" value={counts?.chats ?? 0} />
        <StatCard label="Open tasks" value={openTaskCount} accent />
      </div>

      {/* Board summary — a glance at the workspace's task board */}
      <div className="mt-8">
        <BoardSummary
          workspaceId={workspaceId}
          tasks={workspaceTasks ?? []}
          canEdit={canEdit}
          onOpenBoard={onOpenBoard}
        />
      </div>

      {/* Workspace drive — upload photos/documents, RAG-indexed on add */}
      <div className="mt-8">
        <WorkspaceFilesPanel workspaceId={workspaceId} canEdit={canEdit} />
      </div>

      {/* Secondary: checkboxes found inside notes (rollup) */}
      {tasks.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            From your notes
          </h2>
          <p className="mb-2 text-[11px] text-[var(--text-muted)]">
            Checklist items found inside this workspace's notes — separate from
            the task list above. Click one to open its note.
          </p>
          <div className="space-y-1">
            {[...openTasks, ...doneTasks].map((t, i) => (
              <button
                key={`${t.note_item_id}-${i}`}
                type="button"
                onClick={() =>
                  open({
                    id: t.note_item_id,
                    kind: "note",
                    ref_id: t.note_ref_id,
                    title: t.note_title,
                  })
                }
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--hover)]"
              >
                {t.checked ? (
                  <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                ) : (
                  <Square className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
                )}
                <span className="min-w-0 flex-1">
                  <span
                    className={
                      t.checked
                        ? "text-[var(--text-muted)] line-through"
                        : "text-[var(--text)]"
                    }
                  >
                    {t.text}
                  </span>
                  <span className="ml-2 text-[11px] text-[var(--text-muted)]">
                    {t.note_title}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Recent */}
      {recent.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Recent
          </h2>
          <div className="space-y-1">
            {recent.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() =>
                  open({
                    id: r.id,
                    kind: r.kind as WorkspaceItemNode["kind"],
                    ref_id: r.ref_id,
                    title: r.title,
                  })
                }
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]"
              >
                <RecentIcon kind={r.kind} />
                <span className="min-w-0 flex-1 truncate">{r.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---- Board summary ---------------------------------------------------------
const COLUMN_LABELS: Record<TaskStatus, string> = {
  todo: "To Do",
  doing: "In Progress",
  done: "Done",
};

function dueUrgency(iso: string, done: boolean): "overdue" | "soon" | "later" {
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

/** A compact, glanceable view of the board on the workspace home: per-column
 *  counts, a quick-add, and a "needs attention" list of overdue / due-soon
 *  cards. Full editing lives on the board itself (one click away). */
function BoardSummary({
  workspaceId,
  tasks,
  canEdit,
  onOpenBoard,
}: {
  workspaceId: string;
  tasks: WorkspaceTask[];
  canEdit: boolean;
  onOpenBoard: () => void;
}) {
  const create = useCreateWorkspaceTask(workspaceId);
  const [draft, setDraft] = useState("");

  const counts: Record<TaskStatus, number> = {
    todo: tasks.filter((t) => (t.status ?? "todo") === "todo").length,
    doing: tasks.filter((t) => t.status === "doing").length,
    done: tasks.filter((t) => t.status === "done").length,
  };

  // Overdue + due-soon open tasks, soonest first — the "do this next" list.
  const attention = tasks
    .filter((t) => !t.done && t.due_at && dueUrgency(t.due_at, false) !== "later")
    .sort((a, b) => Date.parse(a.due_at as string) - Date.parse(b.due_at as string))
    .slice(0, 5);

  const submit = () => {
    const title = draft.trim();
    if (!title || create.isPending) return;
    create.mutate({ title, status: "todo" }, { onSuccess: () => setDraft("") });
  };

  return (
    <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--text)]">Board</h2>
        <button
          type="button"
          onClick={onOpenBoard}
          className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline"
        >
          Open board
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Column counts */}
      <div className="grid grid-cols-3 gap-2">
        {(Object.keys(COLUMN_LABELS) as TaskStatus[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={onOpenBoard}
            className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-left transition hover:border-[var(--accent)]"
          >
            <div className="text-xl font-semibold text-[var(--text)]">
              {counts[key]}
            </div>
            <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              {COLUMN_LABELS[key]}
            </div>
          </button>
        ))}
      </div>

      {/* Quick add */}
      {canEdit && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5">
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

      {/* Needs attention */}
      {attention.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Needs attention
          </p>
          <div className="space-y-0.5">
            {attention.map((t) => {
              const urgency = dueUrgency(t.due_at as string, false);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={onOpenBoard}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-[var(--hover)]"
                >
                  <span className="min-w-0 flex-1 truncate text-[var(--text)]">
                    {t.title}
                  </span>
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 text-[11px]",
                      urgency === "overdue" ? "text-red-500" : "text-orange-500"
                    )}
                  >
                    <Clock className="h-3 w-3" />
                    {formatDue(t.due_at as string)}
                    {urgency === "overdue" && " · overdue"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {tasks.length === 0 && (
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          {canEdit
            ? "No tasks yet. Add one above, then open the board to organise it."
            : "No tasks yet."}
        </p>
      )}
    </section>
  );
}

/** First-run guidance shown on an empty workspace home. */
function GettingStarted() {
  const steps: Array<{ icon: typeof FileText; title: string; body: string }> = [
    {
      icon: FileText,
      title: "Add a note or upload a file",
      body: "Use “+ New” in the rail, or drop files into the drive below. Notes, canvases, and files become the AI's context for this workspace.",
    },
    {
      icon: MessageSquare,
      title: "Start a chat",
      body: "New chat from “+ New”. Chats here automatically draw on everything in the workspace — no attaching needed.",
    },
    {
      icon: Sparkles,
      title: "Ask this workspace (⌘K)",
      body: "Get a grounded answer with citations across all your notes, canvases, and files.",
    },
  ];
  return (
    <section className="mt-5 rounded-card border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 className="text-sm font-semibold text-[var(--text)]">
        Get started
      </h2>
      <p className="mt-0.5 text-xs text-[var(--text-muted)]">
        A workspace is a shared space where your chats, notes, and canvases all
        feed one AI knowledge pool.
      </p>
      <ol className="mt-4 space-y-3">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-xs font-semibold text-[var(--accent)]">
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
                <s.icon className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                {s.title}
              </div>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
      <div
        className={
          accent && value > 0
            ? "text-2xl font-semibold text-[var(--accent)]"
            : "text-2xl font-semibold text-[var(--text)]"
        }
      >
        {value}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </div>
    </div>
  );
}

function RecentIcon({ kind }: { kind: string }) {
  const cls = "h-4 w-4 shrink-0 text-[var(--text-muted)]";
  if (kind === "canvas") return <Shapes className={cls} />;
  if (kind === "chat") return <MessageSquare className={cls} />;
  return <FileText className={cls} />;
}
