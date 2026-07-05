import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Brain,
  CheckSquare,
  ChevronRight,
  Clock,
  Columns3,
  FileText,
  Folder,
  Layers,
  Loader2,
  MessageSquare,
  PenTool,
  RefreshCw,
  Settings2,
  Shapes,
  Sparkles,
  Square,
  StickyNote,
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
} from "@/api/workspaces";
import {
  useRegenerateWorkspaceMemory,
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
 * Workspace overview "home" (Phase 4) — shown in the main pane when no
 * item is selected. At-a-glance counts, the workspace's first-class task
 * list, a secondary rollup of checkboxes found in notes, and a few
 * recently-touched items. Clicking a task or recent row opens the item.
 */
export function WorkspaceOverviewPane({
  workspaceId,
  title,
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
  const { data: workspaceTasks } = useWorkspaceTasks(workspaceId);
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
      (counts?.boards ?? 0) +
      (counts?.sheets ?? 0) +
      (counts?.chats ?? 0) +
      (counts?.files ?? 0) ===
    0;
  // Stat tiles cover every item kind that actually exists in this
  // workspace — no misleading "0 Boards" on a workspace that has none,
  // and nothing silently omitted on one that does. Open tasks is always
  // shown as the headline action metric.
  const contentStats = [
    { one: "Note", many: "Notes", value: counts?.notes ?? 0 },
    { one: "Canvas", many: "Canvases", value: counts?.canvases ?? 0 },
    { one: "Board", many: "Boards", value: counts?.boards ?? 0 },
    { one: "Sheet", many: "Sheets", value: counts?.sheets ?? 0 },
    { one: "File", many: "Files", value: counts?.files ?? 0 },
    { one: "Chat", many: "Chats", value: counts?.chats ?? 0 },
  ]
    .filter((s) => s.value > 0)
    .map((s) => ({ label: s.value === 1 ? s.one : s.many, value: s.value }));

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="text-xl font-semibold text-[var(--text)]">{title}</h1>
      <p className="mt-0.5 text-sm text-[var(--text-muted)]">
        Workspace overview
      </p>

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

      {/* Counts — every kind that exists, plus the open-tasks headline */}
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {contentStats.map((s) => (
          <StatCard key={s.label} label={s.label} value={s.value} />
        ))}
        <StatCard
          label={openTaskCount === 1 ? "Open task" : "Open tasks"}
          value={openTaskCount}
          accent
        />
      </div>

      {/* Indexing health — what the AI can currently see. */}
      {!isEmpty && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
            {indexing.inContext} item{indexing.inContext === 1 ? "" : "s"} in
            context
          </span>
          {indexing.pending > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              {indexing.pending} still indexing
            </span>
          )}
          {indexing.failedNames.length > 0 && (
            <span
              className="inline-flex items-center gap-1.5 text-[var(--danger)]"
              title={`Failed to index: ${indexing.failedNames.join(", ")}`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--danger)]" />
              {indexing.failedNames.length} failed to index
            </span>
          )}
        </div>
      )}

      {/* Workspace drive — compact summary; the full browser (folders,
          search, bulk actions) lives behind Open drive. Dropping files
          here still works as the quick-add path. */}
      <div className="mt-8">
        <WorkspaceFilesPanel
          workspaceId={workspaceId}
          canEdit={canEdit}
          compact
          onOpenDrive={onOpenDrive}
        />
      </div>

      {/* Workspace map — the catalog every chat sees, rendered as a real
          clickable tree (icons per kind, click to open) instead of a raw
          markdown dump. The model still receives the markdown version. */}
      {(tree ?? []).length > 0 && (
        <details open className="group mt-8">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] transition hover:text-[var(--text)]">
            <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" />
            Workspace map
          </summary>
          <p className="mb-2 ml-4 mt-1 text-[11px] text-[var(--text-muted)]">
            The catalog every chat sees, so the AI knows what exists and where.
            Updates automatically as you add, rename, or remove items — click
            any entry to open it.
          </p>
          <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
            <MapTree nodes={tree ?? []} onOpen={onOpenItem} />
          </div>
        </details>
      )}

      {/* Workspace memory — surfaced here so freshness is never a mystery;
          the full editor stays in Settings. */}
      <MemoryCard
        workspaceId={workspaceId}
        canEdit={canEdit}
        onOpenSettings={onOpenSettings}
      />

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

      {/* Activity — what changed since you were last here (Batch 3). */}
      <ActivitySection workspaceId={workspaceId} onOpen={open} />
    </div>
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
    <section className="mt-8">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        Activity
      </h2>
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

// --------------------------------------------------------------------
// Workspace map — clickable tree
// --------------------------------------------------------------------

const KIND_ICONS: Record<string, typeof FileText> = {
  folder: Folder,
  note: StickyNote,
  canvas: PenTool,
  board: Columns3,
  sheet: Table2,
  chat: MessageSquare,
  container: Layers,
  task: Clock,
};

function MapTree({
  nodes,
  onOpen,
  depth = 0,
}: {
  nodes: WorkspaceItemNode[];
  onOpen: (node: WorkspaceItemNode) => void;
  depth?: number;
}) {
  return (
    <ul
      className={cn(
        "m-0 list-none p-0",
        depth > 0 && "ml-3 border-l border-[var(--border)] pl-2"
      )}
    >
      {nodes.map((n) => {
        const Icon = KIND_ICONS[n.kind] ?? FileText;
        const isFolder = n.kind === "folder";
        return (
          <li key={n.id} className="my-0.5">
            {isFolder ? (
              <span className="flex items-center gap-1.5 px-1.5 py-0.5 text-sm font-medium text-[var(--text)]">
                <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                <span className="truncate">{n.title || "Untitled"}</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onOpen(n)}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-sm text-[var(--text)] transition hover:bg-[var(--hover)]"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                <span className="truncate">{n.title || "Untitled"}</span>
                {n.context_enabled === false && (
                  <span className="ml-auto shrink-0 text-[10px] text-[var(--text-muted)]">
                    not in context
                  </span>
                )}
              </button>
            )}
            {n.children.length > 0 && (
              <MapTree nodes={n.children} onOpen={onOpen} depth={depth + 1} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

// --------------------------------------------------------------------
// Workspace memory card
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
    <section className="mt-8">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        <Brain className="h-3.5 w-3.5" />
        Workspace memory
      </h2>
      <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
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
              ? "No memory is kept or used for this workspace."
              : memory.exists && memory.updated_at
                ? `Updated ${formatRelativeTime(memory.updated_at)}`
                : "Not created yet — it builds from your chats and documents."}
          </span>
          <span className="ml-auto flex items-center gap-1.5">
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
          </span>
        </div>
        {!off && memory.last_status === "failed" && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-2.5 py-1.5 text-xs text-[var(--danger)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Last refresh failed
              {memory.last_attempt_at
                ? ` ${formatRelativeTime(memory.last_attempt_at)}`
                : ""}
              {memory.last_error ? ` — ${memory.last_error}` : "."}
              {canEdit ? " Check the memory model in Settings, then try again." : ""}
            </span>
          </div>
        )}
        {!off && memory.exists && memory.markdown.trim() && (
          <p className="mt-2 line-clamp-3 whitespace-pre-line text-xs leading-relaxed text-[var(--text-muted)]">
            {memoryPreview(memory.markdown)}
          </p>
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
