import { Sparkles } from "lucide-react";

const SUGGESTIONS = [
  "Explain a hard concept simply",
  "Draft a project kickoff plan",
  "Write a Python script to rename files",
  "Summarise this week's research notes",
];

interface EmptyStateProps {
  onSuggestion?: (text: string) => void;
  hasModel: boolean;
}

export function EmptyState({ onSuggestion, hasModel }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 pb-10 text-center">
      <div
        className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)]/10"
        aria-hidden
      >
        <Sparkles className="h-6 w-6 text-[var(--accent)]" />
      </div>
      <h2 className="text-2xl font-semibold tracking-tight">
        What can I help you with?
      </h2>
      <p className="mt-2 max-w-md text-sm text-[var(--text-muted)]">
        {hasModel
          ? "Ask anything — Promptly will stream the response as it arrives."
          : "Add a model provider in the Models tab to get started."}
      </p>

      {hasModel && (
        <div className="mt-6 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => onSuggestion?.(s)}
              className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left text-sm text-[var(--text)] transition hover:border-[var(--accent)]/50 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
