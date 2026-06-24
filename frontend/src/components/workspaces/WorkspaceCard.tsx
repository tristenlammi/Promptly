import {
  Archive,
  ArchiveRestore,
  FileText,
  FolderKanban,
  MessageSquare,
  Trash2,
  Users,
} from "lucide-react";

import type { WorkspaceSummary } from "@/api/workspaces";
import { cn } from "@/utils/cn";

interface WorkspaceCardProps {
  workspace: WorkspaceSummary;
  onOpen: () => void;
  onDelete: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
}

/** Card for a single workspace — deliberately mirrors
 * ``StudyTopicCard`` so the two features feel like siblings on the
 * sidebar. Shows title, description excerpt, conv/file counts, and
 * hover-only quick actions. */
export function WorkspaceCard({
  workspace,
  onOpen,
  onDelete,
  onArchive,
  onUnarchive,
}: WorkspaceCardProps) {
  const updated = new Date(workspace.updated_at);
  const isArchived = Boolean(workspace.archived_at);
  // ``role`` may be absent on older cached payloads — default to
  // owner so the card still renders while TanStack refetches the
  // enriched shape.
  const isCollaborator = workspace.role === "collaborator";
  // Deterministic per-workspace accent so cards are scannable at a
  // glance — same workspace always gets the same hue. Purely cosmetic,
  // derived client-side from the id (no backend field needed).
  const hue = hueForId(workspace.id);
  const accent = `hsl(${hue} 62% 52%)`;
  const accentSoft = `hsl(${hue} 62% 52% / 0.14)`;

  return (
    <div
      className={cn(
        "group relative flex min-h-[170px] flex-col justify-between overflow-hidden rounded-card border p-4 transition",
        "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/40",
        isArchived && "opacity-80",
        isCollaborator && "border-[var(--accent)]/30"
      )}
    >
      {/* Per-workspace identity strip along the top edge. */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-1"
        style={{ backgroundColor: accent }}
      />
      <button
        onClick={onOpen}
        className="absolute inset-0 rounded-card"
        aria-label={`Open ${workspace.title}`}
      />

      <div className="pointer-events-none relative">
        <div className="flex items-start gap-2">
          <div
            className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
            style={{ backgroundColor: accentSoft, color: accent }}
          >
            <FolderKanban className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-[var(--text)]">
                {workspace.title}
              </h3>
              {isCollaborator && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]"
                  title={
                    workspace.shared_by
                      ? `Shared by ${workspace.shared_by.username}`
                      : "Shared with you"
                  }
                >
                  <Users className="h-2.5 w-2.5" />
                  Shared
                </span>
              )}
            </div>
            {workspace.description ? (
              <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">
                {workspace.description}
              </p>
            ) : isCollaborator && workspace.shared_by ? (
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Shared by{" "}
                <span className="font-medium text-[var(--text)]">
                  {workspace.shared_by.username}
                </span>
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Stats + footer anchored to the card bottom so they line up
          across cards regardless of whether a description is present. */}
      <div className="relative mt-4 space-y-2">
        <div className="flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="h-3 w-3" />
            {workspace.conversation_count} chat
            {workspace.conversation_count === 1 ? "" : "s"}
          </span>
          <span className="inline-flex items-center gap-1">
            <FileText className="h-3 w-3" />
            {workspace.file_count} file
            {workspace.file_count === 1 ? "" : "s"}
          </span>
        </div>

        <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
          <span>Updated {updated.toLocaleDateString()}</span>
        {!isCollaborator && (
          <div className="pointer-events-auto flex items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
            {isArchived && onUnarchive && (
              <IconActionButton
                label="Unarchive"
                onClick={(e) => {
                  e.stopPropagation();
                  onUnarchive();
                }}
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
              </IconActionButton>
            )}
            {!isArchived && onArchive && (
              <IconActionButton
                label="Archive"
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive();
                }}
              >
                <Archive className="h-3.5 w-3.5" />
              </IconActionButton>
            )}
            <IconActionButton
              label="Delete"
              destructive
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </IconActionButton>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

/** Stable hue (0–359) derived from a workspace id, so each workspace
 *  gets a consistent identity colour without any backend field. */
function hueForId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

function IconActionButton({
  label,
  destructive,
  children,
  onClick,
}: {
  label: string;
  destructive?: boolean;
  children: React.ReactNode;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "relative z-10 rounded p-1 text-[var(--text-muted)] transition",
        destructive
          ? "hover:bg-red-500/10 hover:text-red-500"
          : "hover:bg-[var(--accent)]/10 hover:text-[var(--accent)]"
      )}
    >
      {children}
    </button>
  );
}
