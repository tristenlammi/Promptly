import { useEffect, useRef, useState } from "react";
import { Brain } from "lucide-react";

import { chatApi } from "@/api/chat";
import { useChatStore } from "@/store/chatStore";
import { cn } from "@/utils/cn";

interface Props {
  conversationId: string;
  /** Whether auto-capture is currently paused on this conversation. */
  capturePaused: boolean;
  /** Propagate the new paused state up so the parent can update its cache
   *  without a full refetch. */
  onCapturePausedChange: (next: boolean) => void;
  /** Collapse to icon-only (mobile headers). */
  compact?: boolean;
}

/**
 * Phase 9 — Memory header control. Two concerns in one small button:
 *
 * 1. **Transparency**: on hover / click shows which personal memories were
 *    injected into the last reply, replacing the noisy in-stream chip.
 * 2. **Per-conversation pause**: a toggle that stops auto-capture for
 *    sensitive conversations without touching the global memory setting.
 *
 * Only mounted when the user's memory mode is "auto" or "manual" and a
 * conversation id exists (new/unsaved chats have no id to PATCH).
 */
export function MemoryConversationButton({
  conversationId,
  capturePaused,
  onCapturePausedChange,
  compact = false,
}: Props) {
  const memoriesUsed = useChatStore((s) => s.memoriesUsed);
  const [open, setOpen] = useState(false);
  const [toggling, setToggling] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const togglePause = async () => {
    if (toggling) return;
    setToggling(true);
    try {
      await chatApi.update(conversationId, {
        memory_capture_paused: !capturePaused,
      });
      onCapturePausedChange(!capturePaused);
    } catch {
      // best-effort — don't surface an error toast for a minor control
    } finally {
      setToggling(false);
    }
  };

  const hasActive = memoriesUsed.length > 0;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={
          capturePaused
            ? "Memory capture paused for this chat"
            : hasActive
              ? `${memoriesUsed.length} ${memoriesUsed.length === 1 ? "memory" : "memories"} active`
              : "Memory"
        }
        title={
          capturePaused
            ? "Memory capture paused — click to manage"
            : "Memory — click to see active facts"
        }
        className={cn(
          "relative inline-flex items-center gap-1.5 rounded-input border text-xs transition",
          "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
          "hover:bg-[var(--hover)]",
          compact ? "h-9 w-9 justify-center" : "px-3 py-1.5"
        )}
      >
        <Brain
          className={cn(
            "h-4 w-4 shrink-0",
            capturePaused && "text-amber-500 opacity-60"
          )}
        />
        {!compact && (
          <span className={capturePaused ? "line-through opacity-60" : undefined}>
            Memory
          </span>
        )}
        {/* Dot indicator — accent when memories active, amber when paused */}
        {(hasActive || capturePaused) && (
          <span
            aria-hidden
            className={cn(
              "rounded-full",
              compact
                ? "absolute right-1 top-1 h-1.5 w-1.5"
                : "h-1.5 w-1.5",
              capturePaused ? "bg-amber-500" : "bg-[var(--accent)]"
            )}
          />
        )}
      </button>

      {open && (
        <div
          className={cn(
            "absolute right-0 top-full z-30 mt-1.5 w-72 origin-top-right",
            "rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-lg",
            "text-sm"
          )}
        >
          {/* Facts used this turn */}
          <div className="px-3 pb-2 pt-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              <Brain className="h-3 w-3" />
              {hasActive
                ? `${memoriesUsed.length} ${memoriesUsed.length === 1 ? "fact" : "facts"} active this turn`
                : "No memories used last turn"}
            </div>
            {hasActive ? (
              <ul className="space-y-0.5">
                {memoriesUsed.map((item, i) => (
                  <li key={`${i}-${item.id}`} className="flex items-start gap-1.5 text-xs">
                    <span className="mt-0.5 shrink-0 text-[var(--accent)]/60">·</span>
                    <span className="leading-snug text-[var(--text)]">{item.content}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs leading-snug text-[var(--text-muted)]">
                Personal memories are injected when relevant to the conversation.
              </p>
            )}
          </div>

          <div className="border-t border-[var(--border)]" />

          {/* Capture pause toggle */}
          <div className="px-3 py-2.5">
            <button
              type="button"
              onClick={() => void togglePause()}
              disabled={toggling}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs transition",
                "hover:bg-[var(--hover)] disabled:opacity-60"
              )}
            >
              <span className="flex items-center gap-2">
                <Brain className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                <span className="text-[var(--text)]">
                  Pause capture for this chat
                </span>
              </span>
              {/* Toggle pill */}
              <span
                aria-hidden
                className={cn(
                  "relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors",
                  capturePaused ? "bg-amber-500" : "bg-[var(--border)]"
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform",
                    capturePaused ? "translate-x-3.5" : "translate-x-0.5"
                  )}
                />
              </span>
            </button>
            <p className="mt-1 px-2 text-[11px] leading-snug text-[var(--text-muted)]">
              {capturePaused
                ? "Auto-capture is off for this conversation. Saved memories are still active."
                : "New facts won't be extracted from this conversation."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
