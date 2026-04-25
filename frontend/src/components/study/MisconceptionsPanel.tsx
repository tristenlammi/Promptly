import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronUp } from "lucide-react";

import { Button } from "@/components/shared/Button";
import {
  useMisconceptionsQuery,
  useResolveMisconception,
} from "@/hooks/useStudy";

interface MisconceptionsPanelProps {
  projectId: string;
}

/** Collapsed-by-default panel listing unresolved misconceptions the
 *  tutor has flagged on this project. Each entry has an "I've got
 *  this now" dismiss button that marks it resolved, which drops it
 *  out of the prompt hydration block so the tutor stops framing new
 *  explanations around the old mistake.
 */
export function MisconceptionsPanel({ projectId }: MisconceptionsPanelProps) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useMisconceptionsQuery(projectId, false);
  const resolve = useResolveMisconception();
  const entries = data?.entries ?? [];
  const count = entries.length;

  if (!isLoading && count === 0) {
    return null;
  }

  return (
    <section className="rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <span className="text-sm font-semibold text-[var(--text)]">
            Misconceptions the tutor is watching
          </span>
          <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
            {count}
          </span>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-[var(--text-muted)]" />
        ) : (
          <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" />
        )}
      </button>
      {open && (
        <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
          {entries.map((m) => (
            <li key={m.id} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-[var(--text)]">
                  {m.description}
                </div>
                <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                  Correction: {m.correction}
                </div>
                <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">
                  Seen {m.times_seen}×
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  resolve.mutate({ projectId, misconceptionId: m.id })
                }
                disabled={resolve.isPending}
              >
                <Check className="h-3.5 w-3.5" />
                I&rsquo;ve got this
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
