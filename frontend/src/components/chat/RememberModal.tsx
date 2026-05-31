/**
 * RememberModal — Phase 3.3 "Remember this" inline action.
 *
 * A small dialog that lets the user edit any message's text before saving
 * it as a manual memory. Opened by the Brain icon in the message action row.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Brain, Check, Loader2, X } from "lucide-react";

import { memoryApi, MEMORY_CATEGORIES } from "@/api/memory";
import { Button } from "@/components/shared/Button";
import { cn } from "@/utils/cn";

interface RememberModalProps {
  /** Pre-filled text (the message content). */
  initialText: string;
  onClose: () => void;
}

export function RememberModal({ initialText, onClose }: RememberModalProps) {
  const qc = useQueryClient();
  const [text, setText] = useState(() => {
    // Trim to the max content length and strip leading/trailing whitespace.
    return initialText.slice(0, 600).trim();
  });
  const [category, setCategory] = useState("");
  const [pinned, setPinned] = useState(false);
  const [done, setDone] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the textarea on mount.
  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);

  // Close on Escape.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const saveMut = useMutation({
    mutationFn: () =>
      memoryApi.create(text.trim(), {
        category: category || null,
        pinned,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["memories"] });
      setDone(true);
      // Auto-close after a brief success moment.
      window.setTimeout(onClose, 1000);
    },
  });

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Scrim */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Dialog */}
      <div
        className={cn(
          "relative z-10 w-full max-w-md rounded-card border shadow-xl",
          "border-[var(--border)] bg-[var(--surface)]"
        )}
        role="dialog"
        aria-modal="true"
        aria-label="Save to memory"
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Brain className="h-4 w-4 text-[var(--accent)]" />
          <h3 className="flex-1 text-sm font-semibold">Save to memory</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-3 p-4">
          <p className="text-xs text-[var(--text-muted)]">
            Edit the text below, then save it as a durable memory fact.
          </p>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            maxLength={600}
            placeholder="Enter a fact to remember…"
            disabled={saveMut.isPending || done}
            className={cn(
              "w-full resize-y rounded-input border border-[var(--border)]",
              "bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]",
              "placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none",
              "disabled:opacity-60"
            )}
          />

          <div className="flex items-center gap-3">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={saveMut.isPending || done}
              className={cn(
                "h-8 flex-1 rounded-input border border-[var(--border)] bg-[var(--bg)] px-2 text-xs",
                "text-[var(--text)] focus:border-[var(--accent)] focus:outline-none",
                "disabled:opacity-60"
              )}
            >
              <option value="">No category</option>
              {MEMORY_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-muted)]">
              <input
                type="checkbox"
                checked={pinned}
                onChange={(e) => setPinned(e.target.checked)}
                disabled={saveMut.isPending || done}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              Always inject
            </label>
          </div>

          {saveMut.isError && (
            <p className="text-xs text-[var(--danger)]">
              {saveMut.error instanceof Error
                ? saveMut.error.message
                : "Failed to save — try again."}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saveMut.isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!text.trim() || saveMut.isPending || done}
            onClick={() => saveMut.mutate()}
          >
            {done ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Saved!
              </>
            ) : saveMut.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Brain className="h-3.5 w-3.5" />
                Save to memory
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
