import { useMemo, useState } from "react";
import { AlertTriangle, Gauge, Scissors } from "lucide-react";

import { useSelectedModel } from "@/store/modelStore";
import { useChatStore } from "@/store/chatStore";
import {
  computeContextBudget,
  formatTokens,
} from "@/utils/tokenEstimate";
import { cn } from "@/utils/cn";

/**
 * Model-aware context-window indicator for the chat TopNav.
 *
 * Reads the active model's ``context_window`` (hidden gracefully
 * when the provider doesn't expose one — better than showing a
 * number we'd have to make up), estimates the current conversation's
 * token usage client-side via ``utils/tokenEstimate`` (heuristic,
 * not byte-perfect — plenty accurate for a soft warning), and
 * renders a compact pill with a mini progress bar.
 *
 * Thresholds:
 *   green  &nbsp; &lt;60%
 *   amber  &nbsp; 60–85%
 *   red    &nbsp; ≥85%
 *
 * Click-to-expand a details popover showing the breakdown (history
 * vs reserved reply headroom) plus a **Compact conversation**
 * action that calls the backend to summarise the middle while
 * keeping the start and end intact.
 */

interface Props {
  conversationId: string | null;
  /** Fires the "Compact conversation" flow when the user chooses
   *  to compress history. Undefined disables the action (e.g. in
   *  compare mode or on brand-new unsaved chats). */
  onCompact?: () => void;
  compact?: boolean;
}

export function ContextWindowPill({
  conversationId,
  onCompact,
  compact: mobileCompact,
}: Props) {
  const model = useSelectedModel();
  const messages = useChatStore((s) => s.messages);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const [open, setOpen] = useState(false);

  const budget = useMemo(() => {
    const msgs = messages.map((m) => ({ role: m.role, content: m.content }));
    if (isStreaming && streamingContent) {
      // Fold the in-flight assistant stream into the count so the
      // pill updates live as the model replies — otherwise the user
      // only sees the jump after the stream resolves.
      msgs.push({ role: "assistant", content: streamingContent });
    }
    return computeContextBudget({ messages: msgs });
  }, [messages, streamingContent, isStreaming]);

  // Hide when we have no model selected or the model lacks a known
  // context-window size. Displaying a guess would be worse than
  // displaying nothing — users would trust the number and hit real
  // silent truncation later.
  if (!model || !model.context_window || model.context_window <= 0) {
    return null;
  }

  const ctx = model.context_window;
  const ratio = Math.min(1, budget.totalTokens / ctx);
  const pct = Math.round(ratio * 100);
  const tone =
    ratio >= 0.85 ? "red" : ratio >= 0.6 ? "amber" : "green";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={`Context: ${pct}% of ${formatTokens(ctx)} window`}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border font-medium transition",
          "border-[var(--border)] hover:border-[var(--accent)]/50",
          mobileCompact ? "h-9 px-2.5 text-[10px]" : "h-8 px-2.5 text-xs",
          tone === "green" &&
            "text-[var(--text-muted)] hover:text-[var(--text)]",
          tone === "amber" &&
            "border-amber-400/60 bg-amber-500/10 text-amber-700 dark:text-amber-300",
          tone === "red" &&
            "border-red-500/60 bg-red-500/10 text-red-600 dark:text-red-400"
        )}
      >
        {tone === "red" ? (
          <AlertTriangle className="h-3 w-3 shrink-0" />
        ) : (
          <Gauge className="h-3 w-3 shrink-0" />
        )}
        <span className="font-mono tabular-nums">
          {formatTokens(budget.totalTokens)} / {formatTokens(ctx)}
        </span>
        <span
          className={cn(
            "relative h-1 w-6 overflow-hidden rounded-full",
            "bg-black/[0.08] dark:bg-white/[0.08]"
          )}
          aria-hidden="true"
        >
          <span
            className={cn(
              "absolute inset-y-0 left-0 rounded-full transition-[width] duration-300",
              tone === "green" && "bg-emerald-500/70",
              tone === "amber" && "bg-amber-500",
              tone === "red" && "bg-red-500"
            )}
            style={{ width: `${pct}%` }}
          />
        </span>
      </button>

      {open && (
        <>
          {/* Click-outside scrim (invisible) */}
          <div
            aria-hidden="true"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40"
          />
          <div
            role="dialog"
            className={cn(
              "absolute right-0 top-full z-50 mt-1 w-72 rounded-xl border p-3 shadow-xl",
              "border-[var(--border)] bg-[var(--bg)] text-[var(--text)]"
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold">
                {model.display_name}
              </div>
              <div className="text-[10px] text-[var(--text-muted)]">
                {pct}% full
              </div>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
              <span className="font-mono tabular-nums">
                {formatTokens(budget.totalTokens, false)}
              </span>
              <span>/</span>
              <span className="font-mono tabular-nums">
                {formatTokens(ctx, false)} tokens
              </span>
            </div>

            <div className="mt-3 space-y-1 text-[11px]">
              <Row
                label="Chat history"
                value={budget.historyTokens}
              />
              <Row
                label="Response headroom (reserved)"
                value={budget.responseReserveTokens}
              />
              <Row
                label="Remaining"
                value={Math.max(0, ctx - budget.totalTokens)}
                dim
              />
            </div>

            <div className="mt-3 border-t border-[var(--border)] pt-2 text-[10px] text-[var(--text-muted)]">
              Estimated — actual token counts vary by model. The pill
              turns amber at 60% and red at 85%.
            </div>

            {onCompact && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onCompact();
                }}
                disabled={!conversationId || messages.length < 8}
                className={cn(
                  "mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition",
                  "border-[var(--border)] hover:border-[var(--accent)]/60 hover:bg-[var(--surface-2)]",
                  "disabled:cursor-not-allowed disabled:opacity-50"
                )}
                title={
                  messages.length < 8
                    ? "Not enough history to compact yet"
                    : "Summarise older messages to free up context"
                }
              >
                <Scissors className="h-3 w-3" />
                Compact conversation
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  dim,
}: {
  label: string;
  value: number;
  dim?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3",
        dim && "text-[var(--text-muted)]"
      )}
    >
      <span>{label}</span>
      <span className="font-mono tabular-nums">{formatTokens(value, false)}</span>
    </div>
  );
}
