import { useMemo } from "react";
import { Check, FlaskConical, Loader2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useResearchStore, type ResearchStep } from "@/store/researchStore";
import { cn } from "@/utils/cn";

interface Props {
  conversationId: string;
  onCancel: () => void;
}

function StepIndicator({
  status,
  label,
}: {
  status: "done" | "active" | "pending";
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
          status === "done" && "bg-emerald-500 text-white",
          status === "active" && "bg-[var(--accent)]/20 text-[var(--accent)]",
          status === "pending" && "bg-[var(--border)] text-[var(--text-muted)]"
        )}
      >
        {status === "done" ? (
          <Check className="h-2.5 w-2.5" />
        ) : status === "active" ? (
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
        )}
      </span>
      <span
        className={cn(
          status === "done" && "text-[var(--text-muted)] line-through",
          status === "active" && "font-medium text-[var(--text)]",
          status === "pending" && "text-[var(--text-muted)]"
        )}
      >
        {label}
      </span>
    </div>
  );
}

/**
 * Phase 11 — Live progress tracker shown while research is running.
 * Renders inside the chat message stream (ChatWindow) above the composer.
 *
 * Transitions:
 * • Steps 1-4 (decompose → search → read → gap): shows the step list
 * • Step 5 (synthesize): shows the streaming synthesis as markdown
 * • Done: removed from the DOM (the final message has been appended)
 */
export function ResearchProgressCard({ conversationId, onCancel }: Props) {
  const step = useResearchStore((s) => s.step);
  const query = useResearchStore((s) => s.query);
  const subquestions = useResearchStore((s) => s.subquestions);
  const streamingReport = useResearchStore((s) => s.streamingReport);
  const researchConvId = useResearchStore((s) => s.conversationId);

  if (researchConvId !== conversationId || step === "idle" || step === "done" || step === "error") {
    return null;
  }

  const isSynthesizing = step === "synthesizing";

  const doneSteps: ResearchStep[] = useMemo(() => {
    const order: ResearchStep[] = ["decomposing", "searching", "reading", "gap_check", "synthesizing"];
    const currentIndex = order.indexOf(step);
    return order.filter((_, i) => i < currentIndex);
  }, [step]);

  const searchDone = doneSteps.includes("searching") || step === "reading" || step === "gap_check" || step === "synthesizing";
  const readDone = doneSteps.includes("reading") || step === "gap_check" || step === "synthesizing";
  const gapDone = doneSteps.includes("gap_check") || step === "synthesizing";

  return (
    <div className="mx-4 my-3">
      <div className="overflow-hidden rounded-card border border-[var(--accent)]/30 bg-[var(--surface)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-[var(--accent)]" />
            <span className="text-sm font-semibold text-[var(--text)]">Deep Research</span>
            <span className="ml-1 max-w-[40ch] truncate text-xs text-[var(--text-muted)]">
              {query}
            </span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            title="Cancel research"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {isSynthesizing ? (
          /* Synthesis view — streaming markdown */
          <div className="px-4 py-3">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-[var(--accent)]">
              <Loader2 className="h-3 w-3 animate-spin" />
              Writing report…
            </div>
            <div className="prose prose-sm dark:prose-invert max-h-80 overflow-y-auto promptly-scroll text-[var(--text)]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {streamingReport || "…"}
              </ReactMarkdown>
            </div>
          </div>
        ) : (
          /* Steps view */
          <div className="px-4 py-3 space-y-2.5">
            <StepIndicator
              status={searchDone ? "done" : step === "decomposing" ? "active" : "pending"}
              label="Breaking down into angles"
            />

            {/* Sub-questions */}
            {subquestions.length > 0 && (
              <div className="ml-6 space-y-1.5">
                {subquestions.map((sq, i) => (
                  <div key={i} className="flex items-start gap-2 text-[11px]">
                    <span
                      className={cn(
                        "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full",
                        sq.status === "done" && "bg-emerald-500 text-white",
                        sq.status === "searching" && "bg-[var(--accent)]/20 text-[var(--accent)]",
                        sq.status === "reading" && "bg-amber-500/20 text-amber-600",
                        sq.status === "queued" && "border border-[var(--border)] text-[var(--text-muted)]"
                      )}
                    >
                      {sq.status === "done" ? (
                        <Check className="h-2 w-2" />
                      ) : sq.status === "searching" || sq.status === "reading" ? (
                        <Loader2 className="h-2 w-2 animate-spin" />
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "flex-1 leading-snug",
                        sq.status === "done"
                          ? "text-[var(--text-muted)]"
                          : "text-[var(--text)]"
                      )}
                    >
                      {sq.question}
                    </span>
                    {sq.status === "done" && sq.sources_found > 0 && (
                      <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                        {sq.sources_found} sources
                      </span>
                    )}
                    {sq.status === "searching" && (
                      <span className="shrink-0 text-[var(--text-muted)]">searching</span>
                    )}
                    {sq.status === "reading" && (
                      <span className="shrink-0 text-amber-600 dark:text-amber-400">reading</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <StepIndicator
              status={readDone ? "done" : step === "reading" ? "active" : "pending"}
              label="Reading key pages"
            />
            <StepIndicator
              status={gapDone ? "done" : step === "gap_check" ? "active" : "pending"}
              label="Checking for gaps"
            />
            <StepIndicator
              status="pending"
              label="Writing research report"
            />
          </div>
        )}

        {/* Footer hint */}
        <div className="border-t border-[var(--border)] px-4 py-1.5 text-[11px] text-[var(--text-muted)]">
          {isSynthesizing
            ? "Synthesising findings from multiple sources…"
            : "This usually takes 1–3 minutes · ~60k tokens"}
        </div>
      </div>
    </div>
  );
}
