import { Check, X } from "lucide-react";

import { RunStatusChip } from "@/components/tasks/RunStatusChip";
import type { TaskRun } from "@/api/tasks";

function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Per-node output inspector for one flow run — shown beside the canvas when a
 * run is clicked. Lists what each node produced (n8n-style). Shared by the
 * standalone task page and the in-workspace automation pane.
 */
export function RunStepsDrawer({
  run,
  onClose,
  onOpenReport,
}: {
  run: TaskRun;
  onClose: () => void;
  onOpenReport?: () => void;
}) {
  const steps = run.node_runs ?? [];
  return (
    <aside className="hidden w-96 shrink-0 flex-col overflow-y-auto border-l border-[var(--border)] bg-[var(--bg)] md:flex">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <RunStatusChip status={run.status} />
          {fmt(run.created_at)}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 space-y-3 p-4">
        {run.error && (
          <div className="rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-xs text-[var(--danger)]">
            {run.error}
          </div>
        )}
        {steps.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">
            No per-step details for this run.
          </p>
        ) : (
          steps.map((s, i) => (
            <div
              key={`${s.node_id}-${i}`}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--text)]">
                <span className="truncate">{s.label}</span>
                {s.status === "success" ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-[var(--success)]" />
                ) : (
                  <X className="h-3.5 w-3.5 shrink-0 text-[var(--danger)]" />
                )}
              </div>
              <pre className="promptly-scroll mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--text-muted)]">
                {s.output}
              </pre>
              {s.completion_tokens != null && (
                <div className="mt-1 text-[10px] text-[var(--text-muted)]">
                  {s.completion_tokens} output tokens
                </div>
              )}
            </div>
          ))
        )}
        {onOpenReport && run.output_markdown && (
          <button
            type="button"
            onClick={onOpenReport}
            className="text-xs font-medium text-[var(--accent)] hover:underline"
          >
            Open full report →
          </button>
        )}
      </div>
    </aside>
  );
}
