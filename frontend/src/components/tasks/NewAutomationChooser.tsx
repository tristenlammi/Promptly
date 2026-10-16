import { Sparkles, Workflow } from "lucide-react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { Modal } from "@/components/shared/Modal";

/**
 * First step of creating an automation: pick Simple or Advanced.
 *
 * Simple → the classic single-prompt task (a schedule + one prompt → a report
 * each run; no flow board). Advanced → drops the user into the node-graph flow
 * editor to chain AI steps and route results (e.g. file a card on a board).
 */
export function NewAutomationChooser({
  open,
  onClose,
  onChoose,
}: {
  open: boolean;
  onClose: () => void;
  onChoose: (mode: "simple" | "advanced") => void;
}) {
  // The flow canvas needs a bigger screen — offer Simple only on a phone
  // instead of creating a flow nobody can edit there (R-154).
  const isMobile = useIsMobile();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New automation"
      description="How do you want to build it?"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onChoose("simple")}
          className="flex flex-col gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 text-left transition hover:border-[var(--accent)] hover:bg-[var(--surface-hover)]"
        >
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[var(--surface-2)] text-[var(--accent-text)]">
            <Sparkles className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold text-[var(--text)]">Simple</span>
          <span className="text-xs text-[var(--text-muted)]">
            One prompt on a schedule → a fresh report each run. Quick to set up.
          </span>
        </button>

        {isMobile ? (
          <p className="rounded-card border border-dashed border-[var(--border)] p-4 text-xs text-[var(--text-muted)]">
            Advanced flows are built on a computer — the flow canvas needs a
            bigger screen. You can still run and follow them here.
          </p>
        ) : (
        <button
          type="button"
          onClick={() => onChoose("advanced")}
          className="flex flex-col gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 text-left transition hover:border-[var(--accent)] hover:bg-[var(--surface-hover)]"
        >
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[var(--surface-2)] text-[var(--accent-text)]">
            <Workflow className="h-4 w-4" />
          </span>
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
            Advanced flow
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            A node graph — chain AI steps and send the result somewhere, like a
            card on a board. More power.
          </span>
        </button>
        )}
      </div>
    </Modal>
  );
}
