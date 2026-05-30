import { Sparkles } from "lucide-react";

import { useChatProject } from "@/hooks/useChatProjects";

const GENERAL_SUGGESTIONS = [
  "Explain a hard concept simply",
  "Draft a project kickoff plan",
  "Summarise a document I'll attach",
  "What's the latest news on…",
];

const PROJECT_SUGGESTIONS = [
  "Summarise the files in this project",
  "What have we covered so far?",
  "Draft the next step",
  "Find an answer in the project docs",
];

interface EmptyStateProps {
  onSuggestion?: (text: string) => void;
  hasModel: boolean;
  /** Active model's display name — surfaced so the user knows who
   *  they're about to talk to. */
  modelName?: string | null;
  /** When this chat belongs to a project, the empty state greets with
   *  the project name and offers project-flavoured starters. */
  projectId?: string | null;
}

export function EmptyState({
  onSuggestion,
  hasModel,
  modelName,
  projectId,
}: EmptyStateProps) {
  const { data: project } = useChatProject(projectId ?? undefined);
  const inProject = Boolean(projectId);
  const suggestions = inProject ? PROJECT_SUGGESTIONS : GENERAL_SUGGESTIONS;

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 pb-10 text-center">
      <div
        className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)]/10"
        aria-hidden
      >
        <Sparkles className="h-6 w-6 text-[var(--accent)]" />
      </div>
      <h2 className="text-2xl font-semibold tracking-tight">
        {inProject && project
          ? `New chat in ${project.title || "this project"}`
          : "What can I help you with?"}
      </h2>
      <p className="mt-2 max-w-md text-sm text-[var(--text-muted)]">
        {!hasModel
          ? "Add a model provider in the Models tab to get started."
          : inProject
            ? "This chat uses the project's instructions and files. Ask anything, or attach more — answers stream in as they're written."
            : "Ask anything, attach a file, or turn on web search. Answers stream in as they're written."}
      </p>

      {hasModel && (
        <>
          <div className="mt-6 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => onSuggestion?.(s)}
                className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left text-sm text-[var(--text)] transition hover:border-[var(--accent)]/50 hover:bg-[var(--hover)]"
              >
                {s}
              </button>
            ))}
          </div>
          {modelName && (
            <p className="mt-5 text-xs text-[var(--text-muted)]">
              Talking to{" "}
              <span className="font-medium text-[var(--text)]">
                {modelName}
              </span>
            </p>
          )}
        </>
      )}
    </div>
  );
}
