import { useEffect, useState } from "react";

import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";

interface Props {
  open: boolean;
  /** Pre-filled from the current composer draft. */
  initialQuery: string;
  onStart: (query: string) => void;
  onClose: () => void;
}

/**
 * Phase 11 — Deep Research confirmation dialog.
 * Shows the topic, estimated scope, and lets the user start or cancel.
 */
export function ResearchDialog({ open, initialQuery, onStart, onClose }: Props) {
  const [query, setQuery] = useState(initialQuery);

  // Sync query from the composer draft whenever the dialog opens.
  useEffect(() => {
    if (open) setQuery(initialQuery);
  }, [open, initialQuery]);

  const canStart = query.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="🔬 Deep Research"
      description="Promptly will break down your topic, search multiple sources, read the most relevant pages, and synthesise a cited report. This takes 1–3 minutes and uses ~60k tokens."
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { if (canStart) { onStart(query.trim()); onClose(); } }}
            disabled={!canStart}
            className={cn(
              "rounded-md px-4 py-1.5 text-sm font-medium",
              "bg-[var(--accent)] text-white hover:opacity-90",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            Start research
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
            Research topic
          </label>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value.slice(0, 4000))}
            rows={3}
            autoFocus
            placeholder="What do you want to research?"
            className={cn(
              "w-full resize-y rounded-md border bg-[var(--bg)] px-3 py-2 text-sm",
              "border-[var(--border)] text-[var(--text)]",
              "outline-none focus:border-[var(--accent)]"
            )}
          />
        </div>

        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-3 text-xs text-[var(--text-muted)]">
          <div className="mb-1.5 font-semibold text-[var(--text)]">What happens</div>
          <ol className="space-y-1 list-none">
            {[
              "Breaks your topic into 5 focused sub-questions",
              "Searches the web for each angle",
              "Reads the most relevant pages",
              "Identifies and fills any gaps",
              "Writes a structured report with inline citations",
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[10px] font-semibold text-[var(--accent)]">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
          <div className="mt-2 border-t border-[var(--border)] pt-2 text-[11px]">
            Estimated: ~60k tokens · usually A$0.04–0.20 depending on your model.
            Actual cost shown in the report.
          </div>
        </div>
      </div>
    </Modal>
  );
}
