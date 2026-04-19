import { useNavigate } from "react-router-dom";
import { BookOpen, Trash2 } from "lucide-react";

import { useDeleteStudyProject } from "@/hooks/useStudy";
import type { StudyProjectSummary } from "@/api/types";
import { cn } from "@/utils/cn";

interface StudyProjectListProps {
  projects: StudyProjectSummary[];
  onOpen: (projectId: string) => void;
}

export function StudyProjectList({ projects, onOpen }: StudyProjectListProps) {
  if (projects.length === 0) {
    return (
      <div className="mt-10 rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent)]/10">
          <BookOpen className="h-5 w-5 text-[var(--accent)]" />
        </div>
        <h2 className="text-lg font-semibold">Start your first study session</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-muted)]">
          Add a topic you're learning, tell Promptly what you're trying to
          achieve, and get a focused tutor with a whiteboard to work through
          problems.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((p) => (
        <ProjectCard key={p.id} project={p} onOpen={onOpen} />
      ))}
    </div>
  );
}

function ProjectCard({
  project,
  onOpen,
}: {
  project: StudyProjectSummary;
  onOpen: (id: string) => void;
}) {
  const navigate = useNavigate();
  const remove = useDeleteStudyProject();
  const updated = new Date(project.updated_at);

  return (
    <div
      className={cn(
        "group relative flex min-h-[140px] flex-col justify-between rounded-card border p-4 transition",
        "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/40"
      )}
    >
      <button
        onClick={() => onOpen(project.id)}
        className="absolute inset-0 rounded-card"
        aria-label={`Open ${project.title}`}
      />

      <div className="relative pointer-events-none">
        <h3 className="truncate text-sm font-semibold text-[var(--text)]">
          {project.title}
        </h3>
        {project.topics.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {project.topics.slice(0, 4).map((t) => (
              <span
                key={t}
                className="rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[11px] text-[var(--accent)]"
              >
                {t}
              </span>
            ))}
            {project.topics.length > 4 && (
              <span className="text-[11px] text-[var(--text-muted)]">
                +{project.topics.length - 4}
              </span>
            )}
          </div>
        )}
        {project.goal && (
          <p className="mt-2 line-clamp-2 text-xs text-[var(--text-muted)]">
            {project.goal}
          </p>
        )}
      </div>

      <div className="relative mt-4 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
        <span>Updated {updated.toLocaleDateString()}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm(`Delete "${project.title}"?`)) {
              remove.mutate(project.id, {
                onSuccess: () => {
                  // If we're viewing a session of this project, bail to /study.
                  navigate("/study");
                },
              });
            }
          }}
          className="relative z-10 rounded p-1 text-[var(--text-muted)] opacity-0 transition hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
          title="Delete"
          aria-label={`Delete ${project.title}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
