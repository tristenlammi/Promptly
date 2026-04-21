import { useMemo, useState } from "react";
import { AlertTriangle, Scissors, X } from "lucide-react";

import { useChatStore } from "@/store/chatStore";
import { useSelectedModel } from "@/store/modelStore";
import { computeContextBudget } from "@/utils/tokenEstimate";
import { cn } from "@/utils/cn";

/**
 * Proactive context-window warning that appears above the chat
 * window when the conversation crosses 85% of the active model's
 * context budget. Gives the user an unmissable one-click "Compact"
 * action so they can reclaim space before the model starts silently
 * dropping earlier messages.
 *
 * Rationale: the TopNav pill is small and easy to miss when a reply
 * is streaming and the user is reading along. A full-width banner
 * only at the dangerous threshold (≥85%) is visible enough to catch
 * the eye without nagging users with lots of context headroom.
 *
 * Dismissable — once dismissed it stays gone for the rest of the
 * session unless usage *drops* and then crosses back up above 85%
 * (i.e. the user compacted, wrote more, and is approaching the
 * limit again). Dismissing is useful because the user might already
 * know and want to save + start fresh instead.
 */

interface Props {
  conversationId: string | null;
  onCompact: () => void;
}

export function ContextWarningBanner({ conversationId, onCompact }: Props) {
  const model = useSelectedModel();
  const messages = useChatStore((s) => s.messages);

  // Dismissal state is latched against a "high-water mark" — the
  // percentage at which the user dismissed. If later usage drops
  // below that threshold and then comes back up we surface again.
  const [dismissedAtPct, setDismissedAtPct] = useState<number | null>(null);

  const budget = useMemo(() => {
    const msgs = messages.map((m) => ({ role: m.role, content: m.content }));
    return computeContextBudget({ messages: msgs });
  }, [messages]);

  if (!model || !model.context_window || model.context_window <= 0) {
    return null;
  }

  const ratio = budget.totalTokens / model.context_window;
  const pct = Math.round(ratio * 100);

  // Appear only in the danger zone. Once the user crosses back below
  // (via compaction) the latch resets so they can be warned again
  // on the next approach.
  if (ratio < 0.85) {
    if (dismissedAtPct !== null) setDismissedAtPct(null);
    return null;
  }

  if (dismissedAtPct !== null && pct <= dismissedAtPct) {
    return null;
  }

  const critical = ratio >= 0.95;

  return (
    <div
      role="status"
      className={cn(
        "mx-3 mt-2 flex items-start gap-3 rounded-lg border px-3 py-2 text-xs",
        critical
          ? "border-red-500/60 bg-red-500/10 text-red-700 dark:text-red-300"
          : "border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-200"
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">
          {critical
            ? "This chat is about to run out of context."
            : "This chat is getting long."}
        </div>
        <div className="mt-0.5 opacity-90">
          You've used <span className="font-mono tabular-nums">{pct}%</span>{" "}
          of {model.display_name}'s context window. Compact the middle to
          keep going without losing the start or the latest exchanges.
        </div>
      </div>
      <button
        type="button"
        onClick={onCompact}
        disabled={!conversationId}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition",
          critical
            ? "border-red-500/60 bg-red-500/20 hover:bg-red-500/30"
            : "border-amber-500/60 bg-amber-500/20 hover:bg-amber-500/30",
          "disabled:cursor-not-allowed disabled:opacity-50"
        )}
      >
        <Scissors className="h-3 w-3" />
        Compact
      </button>
      <button
        type="button"
        onClick={() => setDismissedAtPct(pct)}
        aria-label="Dismiss warning"
        className="shrink-0 rounded p-1 opacity-70 hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
