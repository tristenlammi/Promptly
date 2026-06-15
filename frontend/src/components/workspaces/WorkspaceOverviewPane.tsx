import {
  CheckSquare,
  FileText,
  MessageSquare,
  Shapes,
  Square,
} from "lucide-react";

import type { WorkspaceItemNode } from "@/api/workspaces";
import {
  useWorkspaceOverview,
  useWorkspaceTasks,
} from "@/hooks/useWorkspaces";
import { WorkspaceTasksPanel } from "./WorkspaceTasksPanel";

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

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="text-xl font-semibold text-[var(--text)]">{title}</h1>
      <p className="mt-0.5 text-sm text-[var(--text-muted)]">
        Workspace overview
      </p>

      {/* Counts */}
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Notes" value={counts?.notes ?? 0} />
        <StatCard label="Canvases" value={counts?.canvases ?? 0} />
        <StatCard label="Chats" value={counts?.chats ?? 0} />
        <StatCard label="Open tasks" value={openTaskCount} accent />
      </div>

      {/* First-class workspace task list */}
      <div className="mt-8">
        <WorkspaceTasksPanel workspaceId={workspaceId} canEdit={canEdit} />
      </div>

      {/* Secondary: checkboxes found inside notes (rollup) */}
      {tasks.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            From your notes
          </h2>
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
