import { Sparkles } from "lucide-react";
import { Link } from "react-router-dom";

import { useWorkspace } from "@/hooks/useWorkspaces";
import { useAuthStore } from "@/store/authStore";

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
  /** When this chat belongs to a workspace, the empty state greets with
   *  the workspace name and offers workspace-flavoured starters. */
  workspaceId?: string | null;
}

export function EmptyState({
  onSuggestion,
  hasModel,
  workspaceId,
}: EmptyStateProps) {
  const { data: workspace } = useWorkspace(workspaceId ?? undefined);
  const inWorkspace = Boolean(workspaceId);
  const suggestions = inWorkspace ? WORKSPACE_SUGGESTIONS : GENERAL_SUGGESTIONS;
  // The no-provider state is the one a fresh install lands in, so it has to
  // say something the reader can act on. An admin gets a link to the right
  // tab; a non-admin can't fix it themselves and is told who can, rather
  // than being pointed at a page that just bounces them back here.
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

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
          ? isAdmin
            ? "No model provider is connected yet, so Promptly can't answer anything."
            : "No model provider is connected yet, so Promptly can't answer anything. Ask an administrator to add one."
          : inWorkspace
            ? "This chat uses the workspace's instructions and files. Ask anything, or attach more — answers stream in as they're written."
            : "Ask anything, attach a file, or turn on web search. Answers stream in as they're written."}
      </p>

      {!hasModel && isAdmin && (
        <Link
          to="/admin?tab=models"
          className="mt-5 inline-flex items-center gap-1.5 rounded-input bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
        >
          Connect a model provider
        </Link>
      )}

      {hasModel && (
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
      )}
    </div>
  );
}
