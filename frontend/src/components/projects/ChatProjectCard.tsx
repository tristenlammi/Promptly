import {
  Archive,
  ArchiveRestore,
  FileText,
  FolderKanban,
  MessageSquare,
  Trash2,
  Users,
} from "lucide-react";

import type { ChatProjectSummary } from "@/api/chatProjects";
import { cn } from "@/utils/cn";

interface ChatProjectCardProps {
  project: ChatProjectSummary;
  onOpen: () => void;
  onDelete: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
}

/** Card for a single chat project — deliberately mirrors
 * ``StudyTopicCard`` so the two features feel like siblings on the
 * sidebar. Shows title, description excerpt, conv/file counts, and
 * hover-only quick actions. */
export function ChatProjectCard({
  project,
  onOpen,
  onDelete,
  onArchive,
  onUnarchive,
}: ChatProjectCardProps) {
  const updated = new Date(project.updated_at);
  const isArchived = Boolean(project.archived_at);
  // ``role`` may be absent on older cached payloads — default to
  // owner so the card still renders while TanStack refetches the
  // enriched shape.
  const isCollaborator = project.role === "collaborator";

  return (
    <div
      className={cn(
        "group relative flex min-h-[170px] flex-col justify-between overflow-hidden rounded-card border p-4 transition",
        "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/40",
        isArchived && "opacity-80",
        isCollaborator && "border-[var(--accent)]/30"
      )}
    >
      <button
        onClick={onOpen}
        className="absolute inset-0 rounded-card"
        aria-label={`Open ${project.title}`}
      />

      <div className="pointer-events-none relative">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--accent)]/10 text-[var(--accent)]">
            <FolderKanban className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-[var(--text)]">
                {project.title}
              </h3>
              {isCollaborator && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]"
                  title={
                    project.shared_by
                      ? `Shared by ${project.shared_by.username}`
                      : "Shared with you"
                  }
                >
                  <Users className="h-2.5 w-2.5" />
                  Shared
                </span>
              )}
            </div>
            {project.description ? (
              <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">
                {project.description}
              </p>
            ) : isCollaborator && project.shared_by ? (
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Shared by{" "}
                <span className="font-medium text-[var(--text)]">
                  {project.shared_by.username}
                </span>
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="h-3 w-3" />
            {project.conversation_count} chat
            {project.conversation_count === 1 ? "" : "s"}
          </span>
          <span className="inline-flex items-center gap-1">
            <FileText className="h-3 w-3" />
            {project.file_count} file
            {project.file_count === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <div className="relative mt-4 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
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
  );
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
