import {
  Archive,
  ArchiveRestore,
  BookOpen,
  CheckCircle2,
  Loader2,
  Trash2,
} from "lucide-react";

import type { StudyProjectSummary } from "@/api/types";
import { cn } from "@/utils/cn";

interface StudyTopicCardProps {
  project: StudyProjectSummary;
  onOpen: () => void;
  onDelete: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
}

/** Card for a single study topic. Shows title, difficulty, goal,
 *  unit progress, and status-appropriate quick-actions in the
 *  hover-only action row at the bottom.
 */
export function StudyTopicCard({
  project,
  onOpen,
  onDelete,
  onArchive,
  onUnarchive,
}: StudyTopicCardProps) {
  const updated = new Date(project.updated_at);
  const progressPct =
    project.total_units > 0
      ? Math.round((project.completed_units / project.total_units) * 100)
      : 0;

  const isArchived = project.status === "archived";
  const isCompleted = project.status === "completed";
  const isPlanning = project.status === "planning";

  return (
    <div
      className={cn(
        "group relative flex min-h-[180px] flex-col justify-between overflow-hidden rounded-card border p-4 transition",
        "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/40",
        isCompleted && "border-emerald-500/30",
        isArchived && "opacity-80"
      )}
    >
      <button
        onClick={onOpen}
        className="absolute inset-0 rounded-card"
        aria-label={`Open ${project.title}`}
      />

      {/* Status ribbon top-right */}
      {(isCompleted || isPlanning) && (
        <div
          className={cn(
            "pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
            isCompleted
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-amber-500/15 text-amber-700 dark:text-amber-300"
          )}
        >
          {isCompleted ? (
            <>
              <CheckCircle2 className="h-3 w-3" />
              Completed
            </>
          ) : (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Planning
            </>
          )}
        </div>
      )}

      <div className="pointer-events-none relative">
        <h3 className="truncate pr-16 text-sm font-semibold text-[var(--text)]">
          {project.title}
        </h3>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {project.difficulty && (
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] capitalize text-[var(--text-muted)]">
              {project.difficulty}
            </span>
          )}
          {project.topics.slice(0, 3).map((t) => (
            <span
              key={t}
              className="rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[11px] text-[var(--accent)]"
            >
              {t}
            </span>
          ))}
          {project.topics.length > 3 && (
            <span className="text-[11px] text-[var(--text-muted)]">
              +{project.topics.length - 3}
            </span>
          )}
        </div>
        {project.goal && (
          <p className="mt-2 line-clamp-2 text-xs text-[var(--text-muted)]">
            {project.goal}
          </p>
        )}

        {/* Progress bar */}
        {project.total_units > 0 && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)]">
              <span>
                {project.completed_units}/{project.total_units} units
              </span>
              <span>{progressPct}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--border)]/40">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  isCompleted ? "bg-emerald-500" : "bg-[var(--accent)]"
                )}
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      <div className="relative mt-4 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1">
          <BookOpen className="h-3 w-3" />
          Updated {updated.toLocaleDateString()}
        </span>
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
