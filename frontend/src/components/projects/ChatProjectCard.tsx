import {
  Archive,
  ArchiveRestore,
  FileText,
  FolderKanban,
  MessageSquare,
  Trash2,
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

  return (
    <div
      className={cn(
        "group relative flex min-h-[170px] flex-col justify-between overflow-hidden rounded-card border p-4 transition",
        "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/40",
        isArchived && "opacity-80"
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
            <h3 className="truncate text-sm font-semibold text-[var(--text)]">
              {project.title}
            </h3>
            {project.description && (
              <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">
                {project.description}
              </p>
            )}
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
