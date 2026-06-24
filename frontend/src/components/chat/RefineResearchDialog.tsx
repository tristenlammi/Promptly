import { useEffect, useState } from "react";

import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";

interface Props {
  open: boolean;
  onSubmit: (refinement: string) => void;
  onClose: () => void;
}

/**
 * "Dig deeper" dialog — runs a focused follow-up pass on an existing
 * research report. The user names the angle to deepen (e.g. "expand on
 * the regulatory risks"); the engine searches just that, then rewrites
 * the full report rather than starting over.
 */
export function RefineResearchDialog({ open, onSubmit, onClose }: Props) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (open) setText("");
  }, [open]);

  const canStart = text.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="🔬 Dig deeper"
      description="Name the angle to expand. Promptly searches just that, then rewrites the full report with the new findings — no need to start over."
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
            onClick={() => {
              if (canStart) {
                onSubmit(text.trim());
                onClose();
              }
            }}
            disabled={!canStart}
            className={cn(
              "rounded-md px-4 py-1.5 text-sm font-medium",
              "bg-[var(--accent)] text-white hover:opacity-90",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            Dig deeper
          </button>
        </>
      }
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, 2000))}
        rows={3}
        autoFocus
        placeholder="e.g. Go deeper on the cost trade-offs and cite recent pricing."
        className={cn(
          "w-full resize-y rounded-md border bg-[var(--bg)] px-3 py-2 text-sm",
          "border-[var(--border)] text-[var(--text)]",
          "outline-none focus:border-[var(--accent)]"
        )}
      />
    </Modal>
  );
}
