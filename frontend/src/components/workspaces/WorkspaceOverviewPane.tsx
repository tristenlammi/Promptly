import { useState } from "react";
import {
  CheckSquare,
  ChevronRight,
  FileText,
  MessageSquare,
  Shapes,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// One-time (until manually dismissed) context-banner flag, shared across
// every workspace — once the user understands that items become context,
// they don't need reminding on each one.
const CONTEXT_BANNER_KEY = "promptly.ws.contextBannerDismissed";

import type { WorkspaceItemNode } from "@/api/workspaces";
import {
  useWorkspaceMap,
  useWorkspaceOverview,
  useWorkspaceTasks,
} from "@/hooks/useWorkspaces";
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
}: {
  workspaceId: string;
  title: string;
  onOpenItem: (node: WorkspaceItemNode) => void;
  canEdit: boolean;
}) {
  const { data: overview } = useWorkspaceOverview(workspaceId);
  const { data: workspaceTasks } = useWorkspaceTasks(workspaceId);
  const { data: mapData } = useWorkspaceMap(workspaceId);
  const [bannerDismissed, setBannerDismissed] = useState(
    () => localStorage.getItem(CONTEXT_BANNER_KEY) === "1"
  );
  const dismissBanner = () => {
    localStorage.setItem(CONTEXT_BANNER_KEY, "1");
    setBannerDismissed(true);
  };
  // Drop the map's "## Workspace contents" header + intro (the panel below
  // supplies its own) and show just the catalog tree.
  const mapTree = (mapData?.markdown ?? "")
    .split("\n\n")
    .slice(1)
    .join("\n\n")
    .trim();

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
    { label: "Notes", value: counts?.notes ?? 0 },
    { label: "Canvases", value: counts?.canvases ?? 0 },
    { label: "Boards", value: counts?.boards ?? 0 },
    { label: "Sheets", value: counts?.sheets ?? 0 },
    { label: "Files", value: counts?.files ?? 0 },
    { label: "Chats", value: counts?.chats ?? 0 },
  ].filter((s) => s.value > 0);

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
        <StatCard label="Open tasks" value={openTaskCount} accent />
      </div>

      {/* Workspace drive — upload photos/documents, RAG-indexed on add */}
      <div className="mt-8">
        <WorkspaceFilesPanel workspaceId={workspaceId} canEdit={canEdit} />
      </div>

      {/* Workspace map — the catalog every chat sees, rendered as a clean
          collapsible tree (open by default) rather than a raw code block. */}
      {mapTree && (
        <details open className="group mt-8">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] transition hover:text-[var(--text)]">
            <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" />
            Workspace map
          </summary>
          <p className="mb-2 ml-4 mt-1 text-[11px] text-[var(--text-muted)]">
            The catalog every chat sees, so the AI knows what exists and where.
            Updates automatically as you add, rename, or remove items.
          </p>
          <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm leading-relaxed text-[var(--text)] [&_a]:text-[var(--accent)] [&_a:hover]:underline [&_li]:my-0.5 [&_ul]:m-0 [&_ul]:list-none [&_ul]:p-0 [&_ul_ul]:ml-4 [&_ul_ul]:border-l [&_ul_ul]:border-[var(--border)] [&_ul_ul]:pl-3">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {mapTree}
            </ReactMarkdown>
          </div>
        </details>
      )}

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
