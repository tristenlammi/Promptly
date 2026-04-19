import { Sparkles } from "lucide-react";

import { LoadingDots } from "@/components/shared/LoadingDots";
import { cn } from "@/utils/cn";

interface ThinkingBubbleProps {
  /** Optional status line rendered above the dots (e.g. "Thinking",
   *  "Reading sources", "Evaluating your answers"). Falls back to a
   *  simple "Thinking…" label. */
  label?: string;
  className?: string;
}

/**
 * Placeholder assistant bubble shown while the model is still composing
 * its first token. Mirrors the layout of {@link MessageBubble} for the
 * assistant role so that when real content starts streaming in the
 * transition is visually seamless (same avatar position, same left edge).
 */
export function ThinkingBubble({ label = "Thinking", className }: ThinkingBubbleProps) {
  return (
    <div
      className={cn("flex gap-3 px-4 py-4", className)}
      aria-live="polite"
      aria-busy="true"
    >
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          "bg-[var(--accent)] text-white"
        )}
      >
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-xs font-semibold text-[var(--text-muted)]">
          Promptly
        </div>
        <div className="inline-flex items-center gap-2 rounded-card bg-black/[0.03] px-3 py-2 text-sm text-[var(--text-muted)] dark:bg-white/[0.04]">
          <span>{label}</span>
          <LoadingDots />
        </div>
      </div>
    </div>
  );
}
