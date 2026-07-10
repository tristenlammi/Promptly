import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Brain,
  Database,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  Columns3,
  FileText,
  Layers,
  Loader2,
  MessageSquare,
  PenTool,
  RefreshCw,
  Settings2,
  Shapes,
  Sparkles,
  Table2,
  X,
} from "lucide-react";

// One-time (until manually dismissed) context-banner flag, shared across
// every workspace — once the user understands that items become context,
// they don't need reminding on each one.
const CONTEXT_BANNER_KEY = "promptly.ws.contextBannerDismissed";

import { useQuery } from "@tanstack/react-query";

import {
  workspacesApi,
  type WorkspaceActivityEvent,
  type WorkspaceItemNode,
  type WorkspaceTask,
} from "@/api/workspaces";
import {
  useRegenerateWorkspaceMemory,
  useUpdateWorkspaceTask,
  useWorkspace,
  useWorkspaceMemory,
  useWorkspaceOverview,
  useWorkspaceTasks,
  useWorkspaceTree,
} from "@/hooks/useWorkspaces";
import { formatRelativeTime } from "@/components/files/helpers";
import { relativeTime } from "@/components/tasks/RunStatusChip";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";
import { WorkspaceFilesPanel } from "./WorkspaceFilesPanel";

/**
 * Workspace home (redesigned, Batch 8).
 *
 * The old home led with stat tiles and a catalog dump; this one is built
 * around the four questions a project hub must answer the moment it
 * opens:
 *
 *   1. *What is this?*      — identity header (accent, members, freshness)
 *   2. *Ask me anything*    — grounded Q&A hero, answers inline with
 *                             citations that jump to the exact passage
 *   3. *What needs me?*     — due/overdue cards, completable in place
 *   4. *Where was I?*       — resume cards + the activity feed
 *
 * Housekeeping (drive, memory, indexing health, counts) lives in a quiet
 * side rail. The workspace map is gone from the page — it's AI plumbing,
 * and the real tree is 20px to the left.
 */
export function WorkspaceOverviewPane({
  workspaceId,
  onOpenItem,
  canEdit,
  onOpenSettings,
  onOpenDrive,
}: {
  workspaceId: string;
  title: string;
  onOpenItem: (node: WorkspaceItemNode) => void;
  canEdit: boolean;
  /** Opens the workspace settings pane (full memory editor lives there). */
  onOpenSettings?: () => void;
  /** Opens the workspace drive (full file browser). */
  onOpenDrive?: () => void;
}) {
  const { data: overview } = useWorkspaceOverview(workspaceId);
  const { data: boardTasks } = useWorkspaceTasks(workspaceId);
  const { data: tree } = useWorkspaceTree(workspaceId);
  const { data: workspace } = useWorkspace(workspaceId);
  const [bannerDismissed, setBannerDismissed] = useState(
    () => localStorage.getItem(CONTEXT_BANNER_KEY) === "1"
  );
  const dismissBanner = () => {
    localStorage.setItem(CONTEXT_BANNER_KEY, "1");
    setBannerDismissed(true);
  };

  // Indexing-health rollup across tree items + pinned files, so "the AI
  // hasn't caught up with X yet" stops being invisible.
  const indexing = useMemo(() => {
    const flat: WorkspaceItemNode[] = [];
    const walk = (nodes: WorkspaceItemNode[]) => {
      for (const n of nodes) {
        if (n.kind !== "folder") flat.push(n);
        if (n.children.length) walk(n.children);
      }
    };
    walk(tree ?? []);
    const inContext = flat.filter(
      (n) => n.kind !== "task" && n.context_enabled !== false
    ).length;
    const files = workspace?.files ?? [];
    const contextFiles = files.filter((f) => f.context_enabled).length;
    const isPendingStatus = (s: string | null | undefined) =>
      s === "queued" || s === "embedding";
    const pending =
      flat.filter(
        (n) => n.context_enabled !== false && isPendingStatus(n.indexing_status)
      ).length +
      files.filter(
        (f) =>
          f.context_enabled &&
          isPendingStatus(f.indexing_status) &&
          // Images never index (they ride the vision path) and sit at
          // "queued" forever — don't report them as stuck.
          !f.mime_type.toLowerCase().startsWith("image/")
      ).length;
    const failedNames = [
      ...flat
        .filter((n) => n.indexing_status === "failed")
        .map((n) => n.title || "Untitled"),
      ...files
        .filter((f) => f.indexing_status === "failed")
        .map((f) => f.filename),
    ];
    return { inContext: inContext + contextFiles, pending, failedNames };
  }, [tree, workspace?.files]);

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

  // Deep-citation jump for the Ask hero: seed the highlight, then open.
  const flatTree = useMemo(() => {
    const out: WorkspaceItemNode[] = [];
    const walk = (nodes: WorkspaceItemNode[]) => {
      for (const n of nodes) {
        out.push(n);
        if (n.children.length) walk(n.children);
      }
    };
    walk(tree ?? []);
    return out;
  }, [tree]);
  const counts = overview?.counts;
  const recent = overview?.recent ?? [];
  const noteChecks = overview?.tasks ?? [];
  // A brand-new workspace gets a guided "get started" card instead of a
  // wall of empty sections.
  const isEmpty =
    (counts?.notes ?? 0) +
      (counts?.canvases ?? 0) +
      (counts?.boards ?? 0) +
      (counts?.sheets ?? 0) +
      (counts?.chats ?? 0) +
      (counts?.files ?? 0) ===
    0;

  const members = workspace?.members ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      {/* ---- Identity header ------------------------------------------ */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* The workspace name is the page title in the top bar now (titleSize
            "lg"), so the overview leads with context, not a duplicate title. */}
        <div className="min-w-0">
          {workspace?.description ? (
            <p className="max-w-xl text-sm text-[var(--text-muted)]">
              {workspace.description}
            </p>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">
              Everything here — notes, boards, files, chats — feeds one
              project brain.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 pt-1">
          {members.length > 0 && (
            <span
              className="inline-flex items-center"
              title={members.map((m) => m.username).join(", ")}
            >
              {members.slice(0, 5).map((m, i) => (
                <UserAvatar
                  key={m.user_id}
                  name={m.username}
                  userId={m.user_id}
                  avatarUrl={m.avatar_url}
                  color={m.avatar_color}
                  size={26}
                  className={cn(
                    "border-2 border-[var(--bg)]",
                    i > 0 && "-ml-2"
                  )}
                />
              ))}
              {members.length > 5 && (
                <span className="ml-1.5 text-xs text-[var(--text-muted)]">
                  +{members.length - 5}
                </span>
              )}
            </span>
          )}
          {workspace?.updated_at && (
            <span className="text-xs text-[var(--text-muted)]">
              Updated {formatRelativeTime(workspace.updated_at)}
            </span>
          )}
        </div>
      </div>

      {isEmpty && canEdit ? (
        <GettingStarted />
      ) : !bannerDismissed ? (
        <div className="relative mt-4 flex items-start gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2 pr-8 text-xs text-[var(--text-muted)]">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
          <span>
            Everything you add here — notes, canvases, and files — becomes{" "}
            <span className="font-medium text-[var(--text)]">context</span> your
            chats can draw on. Toggle any item's ⚡ to include or exclude it.
          </span>
          <button
            type="button"
            onClick={dismissBanner}
            aria-label="Dismiss"
            title="Dismiss"
            className="absolute right-1.5 top-1.5 rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {/* Ask hero removed — the single Ask/Search surface is the ⌘K palette
          (the "Ask" button by Back). */}

      {/* ---- Two-column body ------------------------------------------ */}
      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-3">
        {/* Main column */}
        <div className="min-w-0 space-y-8 lg:col-span-2">
          <NeedsAttention
            workspaceId={workspaceId}
            tasks={boardTasks ?? []}
            tree={flatTree}
            canEdit={canEdit}
            onOpen={open}
          />

          {recent.length > 0 && (
            <section>
              <SectionTitle>Pick up where you left off</SectionTitle>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {recent.slice(0, 6).map((r) => (
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
                    className="group flex flex-col gap-1.5 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-left transition hover:border-[var(--accent)]/40 hover:bg-[var(--hover)]"
                  >
                    <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                      <KindIcon kind={r.kind} className="h-3.5 w-3.5" />
                      {r.kind}
                    </span>
                    <span className="line-clamp-2 text-sm font-medium leading-snug text-[var(--text)]">
                      {r.title || "Untitled"}
                    </span>
                    {r.updated_at && (
                      <span className="mt-auto text-[11px] text-[var(--text-muted)]">
                        {formatRelativeTime(r.updated_at)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          )}

          <ActivitySection workspaceId={workspaceId} onOpen={open} />

          {/* Checkboxes living inside notes — secondary, collapsed. */}
          {noteChecks.length > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] transition hover:text-[var(--text)]">
                <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" />
                Checklists in notes ({noteChecks.filter((t) => !t.checked).length}{" "}
                open)
              </summary>
              <div className="mt-2 space-y-0.5">
                {noteChecks.slice(0, 12).map((t, i) => (
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
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-[var(--hover)]"
                  >
                    {t.checked ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                    ) : (
                      <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
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
            </details>
          )}
        </div>

        {/* Side rail — housekeeping */}
        <div className="min-w-0 space-y-6">
          {!isEmpty && (
            <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
                {(
                  [
                    // [key, singular, plural, count, Icon] — explicit plural so
                    // "canvas" reads "canvases", not the naive +"s" "canvass".
                    ["note", "note", "notes", counts?.notes ?? 0, FileText],
                    ["board", "board", "boards", counts?.boards ?? 0, Columns3],
                    ["sheet", "sheet", "sheets", counts?.sheets ?? 0, Table2],
                    ["canvas", "canvas", "canvases", counts?.canvases ?? 0, PenTool],
                    ["chat", "chat", "chats", counts?.chats ?? 0, MessageSquare],
                    ["file", "file", "files", counts?.files ?? 0, Layers],
                  ] as const
                )
                  .filter(([, , , v]) => v > 0)
                  .map(([key, one, many, v, Icon]) => (
                    <span key={key} className="inline-flex items-center gap-1">
                      <Icon className="h-3 w-3" />
                      {v} {v === 1 ? one : many}
                    </span>
                  ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border)] pt-2 text-[11px] text-[var(--text-muted)]">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
                  {indexing.inContext} in context
                </span>
                {indexing.pending > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {indexing.pending} indexing
                  </span>
                )}
                {indexing.failedNames.length > 0 && (
                  <span
                    className="inline-flex items-center gap-1.5 text-[var(--danger)]"
                    title={`Failed to index: ${indexing.failedNames.join(", ")}`}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--danger)]" />
                    {indexing.failedNames.length} failed
                  </span>
                )}
              </div>
            </section>
          )}

          <WorkspaceFilesPanel
            workspaceId={workspaceId}
            canEdit={canEdit}
            compact
            onOpenDrive={onOpenDrive}
          />

          <MemoryCard
            workspaceId={workspaceId}
            canEdit={canEdit}
            onOpenSettings={onOpenSettings}
          />

          {overview?.health &&
            (overview.health.stale.length > 0 ||
              overview.health.heavy.length > 0) && (
              <KnowledgeHealthCard health={overview.health} onOpen={open} />
            )}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
      {children}
    </h2>
  );
}

// --------------------------------------------------------------------
// Needs attention — open cards, worst first, completable in place
// --------------------------------------------------------------------
function NeedsAttention({
  workspaceId,
  tasks,
  tree,
  canEdit,
  onOpen,
}: {
  workspaceId: string;
  tasks: WorkspaceTask[];
  tree: WorkspaceItemNode[];
  canEdit: boolean;
  onOpen: (
    node: Pick<WorkspaceItemNode, "id" | "kind" | "ref_id" | "title">
  ) => void;
}) {
  const update = useUpdateWorkspaceTask(workspaceId);
  const boardsById = useMemo(
    () => new Map(tree.filter((n) => n.kind === "board").map((n) => [n.id, n])),
    [tree]
  );

  const openTasks = useMemo(() => {
    const now = Date.now();
    const soonCutoff = now + 3 * 24 * 3600 * 1000;
    const bucket = (t: WorkspaceTask) => {
      if (!t.due_at) return 2;
      const due = +new Date(t.due_at);
      if (due < now) return 0; // overdue
      if (due < soonCutoff) return 1; // due within 3 days
      return 2;
    };
    return tasks
      .filter((t) => t.status !== "done")
      .sort((a, b) => {
        const ba = bucket(a);
        const bb = bucket(b);
        if (ba !== bb) return ba - bb;
        const da = a.due_at ? +new Date(a.due_at) : Infinity;
        const dbb = b.due_at ? +new Date(b.due_at) : Infinity;
        if (da !== dbb) return da - dbb;
        const prio = { high: 0, medium: 1, low: 2 } as const;
        return (prio[a.priority] ?? 1) - (prio[b.priority] ?? 1);
      });
  }, [tasks]);

  if (openTasks.length === 0) return null;

  const dueLabel = (t: WorkspaceTask): { text: string; cls: string } | null => {
    if (!t.due_at) return null;
    const due = +new Date(t.due_at);
    const now = Date.now();
    if (due < now)
      return { text: `overdue — ${relativeTime(t.due_at)}`, cls: "text-[var(--danger)]" };
    if (due < now + 3 * 24 * 3600 * 1000)
      return {
        text: `due ${new Date(t.due_at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`,
        cls: "text-[var(--warning)]",
      };
    return {
      text: `due ${new Date(t.due_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`,
      cls: "text-[var(--text-muted)]",
    };
  };

  return (
    <section>
      <SectionTitle>
        Needs attention ({openTasks.length} open)
      </SectionTitle>
      <div className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
        {openTasks.slice(0, 6).map((t, i) => {
          const board = t.board_item_id
            ? boardsById.get(t.board_item_id)
            : undefined;
          const due = dueLabel(t);
          return (
            <div
              key={t.id}
              className={cn(
                "group flex items-center gap-2.5 px-3 py-2",
                i > 0 && "border-t border-[var(--border)]"
              )}
            >
              <button
                type="button"
                disabled={!canEdit || update.isPending}
                title={canEdit ? "Mark done" : undefined}
                onClick={() =>
                  update.mutate(
                    { taskId: t.id, payload: { status: "done", done: true } },
                    {
                      onSuccess: () => toast.success(`Completed “${t.title}”`),
                    }
                  )
                }
                className="shrink-0 text-[var(--text-muted)] transition hover:text-[var(--success)] disabled:cursor-default"
              >
                <Circle className="h-4 w-4 group-hover:hidden" />
                <CheckCircle2 className="hidden h-4 w-4 group-hover:block" />
              </button>
              <button
                type="button"
                disabled={!board}
                onClick={() => board && onOpen(board)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
                title={board ? `Open “${board.title}”` : undefined}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    t.priority === "high"
                      ? "bg-[var(--danger)]"
                      : t.priority === "medium"
                        ? "bg-[var(--warning)]"
                        : "bg-[var(--text-muted)]/50"
                  )}
                  title={`${t.priority} priority`}
                />
                <span className="truncate text-sm text-[var(--text)]">
                  {t.title}
                </span>
                {due && (
                  <span className={cn("shrink-0 text-[11px]", due.cls)}>
                    {due.text}
                  </span>
                )}
                {board && (
                  <span className="ml-auto hidden shrink-0 items-center gap-1 text-[11px] text-[var(--text-muted)] sm:inline-flex">
                    {board.title}
                    <ArrowRight className="h-3 w-3 opacity-0 transition group-hover:opacity-100" />
                  </span>
                )}
              </button>
            </div>
          );
        })}
        {openTasks.length > 6 && (
          <div className="border-t border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
            +{openTasks.length - 6} more on the board
          </div>
        )}
      </div>
    </section>
  );
}

/** Merged newest-first feed: item creations, comments, card activity. */
function ActivitySection({
  workspaceId,
  onOpen,
}: {
  workspaceId: string;
  onOpen: (node: Pick<WorkspaceItemNode, "id" | "kind" | "ref_id" | "title">) => void;
}) {
  const { data } = useQuery({
    queryKey: ["workspaces", "activity", workspaceId],
    queryFn: () => workspacesApi.activity(workspaceId),
    refetchInterval: 60_000,
  });
  const events = data?.events ?? [];
  if (events.length === 0) return null;

  const verb = (e: WorkspaceActivityEvent) => {
    switch (e.kind) {
      case "item_created":
        return `created ${e.item_kind === "folder" ? "folder" : e.item_kind} “${e.item_title}”`;
      case "item_comment":
        return `commented on “${e.item_title}”`;
      case "card_comment":
        return `commented on card “${e.item_title}”`;
      default:
        return `${e.text} — “${e.item_title}”`;
    }
  };

  return (
    <section>
      <SectionTitle>Activity</SectionTitle>
      <div className="space-y-0.5">
        {events.slice(0, 15).map((e, i) => (
          <button
            key={`${e.kind}-${e.created_at}-${i}`}
            type="button"
            disabled={!e.item_id}
            onClick={() =>
              e.item_id &&
              onOpen({
                id: e.item_id,
                kind: (e.item_kind ?? "note") as WorkspaceItemNode["kind"],
                ref_id: null,
                title: e.item_title,
              })
            }
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--hover)] disabled:cursor-default disabled:hover:bg-transparent"
          >
            {e.actor ? (
              <UserAvatar
                name={e.actor.username}
                avatarUrl={e.actor.avatar_url}
                color={e.actor.avatar_color}
                size={20}
                className="mt-0.5"
              />
            ) : (
              <span className="mt-0.5 inline-block h-5 w-5 shrink-0 rounded-full bg-[var(--surface-2)]" />
            )}
            <span className="min-w-0 flex-1">
              <span className="text-[var(--text)]">
                <span className="font-medium">
                  {e.actor?.username ?? "Someone"}
                </span>{" "}
                <span className="text-[var(--text-muted)]">{verb(e)}</span>
              </span>
              {(e.kind === "item_comment" || e.kind === "card_comment") &&
                e.text && (
                  <span className="mt-0.5 line-clamp-1 block text-xs text-[var(--text-muted)]">
                    {e.text}
                  </span>
                )}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--text-muted)]/70">
              {relativeTime(e.created_at)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Knowledge health (4.8) — stale + oversized context items (side rail). */
function KnowledgeHealthCard({
  health,
  onOpen,
}: {
  health: NonNullable<
    import("@/api/workspaces").WorkspaceOverview["health"]
  >;
  onOpen: (
    node: Pick<WorkspaceItemNode, "id" | "kind" | "ref_id" | "title">
  ) => void;
}) {
  return (
    <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        <AlertTriangle className="h-3.5 w-3.5 text-[var(--warning)]" />
        Knowledge health
      </h2>
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        The AI treats everything in context as current — these items may be
        quietly skewing its answers.
      </p>
      {health.stale.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Untouched for 60+ days
          </div>
          <div className="flex flex-wrap gap-1.5">
            {health.stale.map((s) => (
              <button
                key={s.item_id}
                type="button"
                onClick={() =>
                  onOpen({
                    id: s.item_id,
                    kind: s.kind as WorkspaceItemNode["kind"],
                    ref_id: s.ref_id,
                    title: s.title,
                  })
                }
                className="inline-flex max-w-full items-center gap-1.5 truncate rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
                title={`Last touched ${s.updated_at ? formatRelativeTime(s.updated_at) : "long ago"} — refresh it or flip its ⚡ off`}
              >
                <Clock className="h-3 w-3 shrink-0 text-[var(--warning)]" />
                <span className="truncate">{s.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {health.heavy.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Biggest context consumers
          </div>
          <div className="flex flex-wrap gap-1.5">
            {health.heavy.map((h) => (
              <button
                key={h.item_id}
                type="button"
                onClick={() =>
                  onOpen({
                    id: h.item_id,
                    kind: h.kind as WorkspaceItemNode["kind"],
                    ref_id: h.ref_id,
                    title: h.title,
                  })
                }
                className="inline-flex max-w-full items-center gap-1.5 truncate rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)] transition hover:bg-[var(--hover)]"
                title="Large items crowd out retrieval budget — consider splitting or flipping ⚡ off"
              >
                <Layers className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
                <span className="truncate">{h.title}</span>
                <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                  ~{Math.round((h.chars ?? 0) / 4 / 1000)}k tok
                </span>
              </button>
            ))}
          </div>
        </div>
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

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const cls = className ?? "h-4 w-4 shrink-0";
  switch (kind) {
    case "canvas":
      return <Shapes className={cls} />;
    case "chat":
      return <MessageSquare className={cls} />;
    case "board":
      return <Columns3 className={cls} />;
    case "sheet":
      return <Table2 className={cls} />;
    case "chart":
      return <BarChart3 className={cls} />;
    case "dataview":
      return <Database className={cls} />;
    default:
      return <FileText className={cls} />;
  }
}

// --------------------------------------------------------------------
// Workspace memory card (side rail)
// --------------------------------------------------------------------

const MEMORY_MODE_LABELS: Record<string, string> = {
  off: "Off",
  auto: "Auto",
  manual: "Self-managed",
};

function MemoryCard({
  workspaceId,
  canEdit,
  onOpenSettings,
}: {
  workspaceId: string;
  canEdit: boolean;
  onOpenSettings?: () => void;
}) {
  const { data: memory } = useWorkspaceMemory(workspaceId);
  const regenerate = useRegenerateWorkspaceMemory(workspaceId);
  if (!memory) return null;

  const mode = memory.memory_mode;
  const off = mode === "off";

  return (
    <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        <Brain className="h-3.5 w-3.5" />
        Workspace memory
      </h2>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 font-medium",
            off
              ? "bg-[var(--hover-strong)] text-[var(--text-muted)]"
              : "bg-[var(--accent)]/10 text-[var(--accent)]"
          )}
        >
          {MEMORY_MODE_LABELS[mode] ?? mode}
        </span>
        <span className="text-[var(--text-muted)]">
          {off
            ? "No memory is kept or used."
            : memory.exists && memory.updated_at
              ? `Updated ${formatRelativeTime(memory.updated_at)}`
              : "Builds from chats + documents."}
        </span>
      </div>
      {!off && memory.exists && memory.markdown.trim() && (
        <p className="mt-2 line-clamp-3 whitespace-pre-line text-xs leading-relaxed text-[var(--text-muted)]">
          {memoryPreview(memory.markdown)}
        </p>
      )}
      {!off && memory.last_status === "failed" && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-2.5 py-1.5 text-xs text-[var(--danger)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Last refresh failed
            {memory.last_attempt_at
              ? ` ${formatRelativeTime(memory.last_attempt_at)}`
              : ""}
            {memory.last_error ? ` — ${memory.last_error}` : "."}
            {canEdit ? " Check the memory model in Settings." : ""}
          </span>
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-1.5">
        {canEdit && !off && (
          <button
            type="button"
            onClick={() =>
              regenerate.mutate(undefined, {
                onError: () =>
                  toast.error(
                    "Couldn't regenerate the memory. Check the memory model in Settings."
                  ),
              })
            }
            disabled={regenerate.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--text-muted)] transition hover:border-[var(--accent)]/50 hover:text-[var(--text)] disabled:opacity-50"
          >
            {regenerate.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {regenerate.isPending ? "Updating…" : "Update now"}
          </button>
        )}
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--text-muted)] transition hover:border-[var(--accent)]/50 hover:text-[var(--text)]"
            title={
              off
                ? "Turn memory on in Settings"
                : "View or edit the memory in Settings"
            }
          >
            <Settings2 className="h-3 w-3" />
            {off ? "Turn on" : "View / edit"}
          </button>
        )}
      </div>
    </section>
  );
}

/** Strip markdown headings/fences so the 3-line preview reads as prose. */
function memoryPreview(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").replace(/^[-*]\s+/, "• ").trim())
    .filter(Boolean)
    .slice(0, 6)
    .join("\n");
}
