import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";

interface ConfirmDoubleModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  /** Title of the first confirmation. */
  firstTitle: string;
  firstDescription: string;
  firstConfirmLabel: string;
  /** Title of the second (final) confirmation. */
  secondTitle: string;
  secondDescription: string;
  /** Free-text the user has to type verbatim before the second confirm
   *  unlocks. Optional — omit for "just click twice" flows. */
  typeToConfirm?: string;
  secondConfirmLabel: string;
  destructive?: boolean;
  /** Disable all close affordances while the server-side action is in
   *  flight so the user can't double-submit or dismiss halfway through. */
  pending?: boolean;
}

/** Two-step confirmation modal for irreversible actions (delete, archive).
 *
 *  The first step explains what is about to happen and asks the user to
 *  continue; the second step demands an explicit confirm (and optionally
 *  a typed confirmation phrase for truly dangerous actions). Only after
 *  both steps have been confirmed does ``onConfirm`` fire.
 */
export function ConfirmDoubleModal({
  open,
  onClose,
  onConfirm,
  firstTitle,
  firstDescription,
  firstConfirmLabel,
  secondTitle,
  secondDescription,
  typeToConfirm,
  secondConfirmLabel,
  destructive,
  pending,
}: ConfirmDoubleModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) {
      // Reset step when the caller reopens later.
      setStep(1);
      setTyped("");
    }
  }, [open]);

  const handleClose = () => {
    if (pending) return;
    onClose();
  };

  const typedOk =
    !typeToConfirm || typed.trim().toLowerCase() === typeToConfirm.trim().toLowerCase();

  const variant = destructive ? "danger" : "primary";

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={step === 1 ? firstTitle : secondTitle}
      footer={
        step === 1 ? (
          <>
            <Button variant="ghost" onClick={handleClose} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant={variant}
              onClick={() => setStep(2)}
              disabled={pending}
            >
              {firstConfirmLabel}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              onClick={() => setStep(1)}
              disabled={pending}
            >
              Back
            </Button>
            <Button
              variant={variant}
              onClick={onConfirm}
              loading={pending}
              disabled={!typedOk}
            >
              {secondConfirmLabel}
            </Button>
          </>
        )
      }
    >
      <div className="flex gap-3">
        {destructive && (
          <div className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-red-500/10 text-red-600 dark:text-red-400">
            <AlertTriangle className="h-4 w-4" />
          </div>
        )}
        <div className="flex-1 text-sm text-[var(--text)]">
          {step === 1 ? (
            <p>{firstDescription}</p>
          ) : (
            <div className="space-y-3">
              <p>{secondDescription}</p>
              {typeToConfirm && (
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--text-muted)]">
                    Type <span className="font-mono text-[var(--text)]">{typeToConfirm}</span> to confirm.
                  </span>
                  <input
                    autoFocus
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={typeToConfirm}
                    className="block w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)]/60 focus:outline-none"
                  />
                </label>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
