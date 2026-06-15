import { Sparkles } from "lucide-react";

import { useWorkspace } from "@/hooks/useWorkspaces";

const GENERAL_SUGGESTIONS = [
  "Explain a hard concept simply",
  "Draft a project kickoff plan",
  "Summarise a document I'll attach",
  "What's the latest news on…",
];

const WORKSPACE_SUGGESTIONS = [
  "Summarise the files in this workspace",
  "What have we covered so far?",
  "Draft the next step",
  "Find an answer in the workspace docs",
];

interface EmptyStateProps {
  onSuggestion?: (text: string) => void;
  hasModel: boolean;
  /** Active model's display name — surfaced so the user knows who
   *  they're about to talk to. */
  modelName?: string | null;
  /** When this chat belongs to a workspace, the empty state greets with
   *  the workspace name and offers workspace-flavoured starters. */
  workspaceId?: string | null;
}

export function EmptyState({
  onSuggestion,
  hasModel,
  modelName,
  workspaceId,
}: EmptyStateProps) {
  const { data: workspace } = useWorkspace(workspaceId ?? undefined);
  const inWorkspace = Boolean(workspaceId);
  const suggestions = inWorkspace ? WORKSPACE_SUGGESTIONS : GENERAL_SUGGESTIONS;

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 pb-10 text-center">
      <div
        className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)]/10"
        aria-hidden
      >
        <Sparkles className="h-6 w-6 text-[var(--accent)]" />
      </div>
      <h2 className="text-2xl font-semibold tracking-tight">
        {inWorkspace && workspace
          ? `New chat in ${workspace.title || "this workspace"}`
          : "What can I help you with?"}
      </h2>
      <p className="mt-2 max-w-md text-sm text-[var(--text-muted)]">
        {!hasModel
          ? "Add a model provider in the Models tab to get started."
          : inWorkspace
            ? "This chat uses the workspace's instructions and files. Ask anything, or attach more — answers stream in as they're written."
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
