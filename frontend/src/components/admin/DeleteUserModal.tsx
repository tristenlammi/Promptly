import { useEffect, useRef, useState } from "react";
import { Loader2, Trash2, TriangleAlert } from "lucide-react";

import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";

interface DeleteUserModalProps {
  open: boolean;
  username: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

/**
 * Destructive-confirm modal for deleting a user account. Mirrors the chat
 * delete dialog (autofocus Cancel, inline errors, busy state). The caller is
 * responsible for preventing self-deletion — the backend enforces it too.
 */
export function DeleteUserModal({
  open,
  username,
  onConfirm,
  onClose,
}: DeleteUserModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      setBusy(false);
      requestAnimationFrame(() => cancelRef.current?.focus());
    }
  }, [open]);

  const handleClose = () => {
    if (busy) return;
    onClose();
  };

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Delete user"
      description="This account and all of its data will be permanently removed."
      widthClass="max-w-md"
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            onClick={handleClose}
            disabled={busy}
            className={cn(
              "inline-flex items-center justify-center rounded-input border px-3.5 py-1.5 text-sm",
              "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
              "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-input px-3.5 py-1.5 text-sm font-medium",
              "bg-red-600 text-white transition hover:bg-red-600/90",
              "disabled:cursor-not-allowed disabled:opacity-60"
            )}
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Deleting…
              </>
            ) : (
              <>
                <Trash2 className="h-3.5 w-3.5" />
                Delete user
              </>
            )}
          </button>
        </>
      }
    >
      <div className="flex gap-3">
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
            "bg-red-500/10 text-red-600 dark:text-red-400"
          )}
          aria-hidden
        >
          <TriangleAlert className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 text-sm text-[var(--text)]">
          <p>
            Are you sure you want to delete{" "}
            <span className="font-semibold">“{username}”</span>?
          </p>
          <p className="mt-1 text-[var(--text-muted)]">
            Their conversations, study projects and any model providers they
            configured will be removed. This action can&apos;t be undone.
          </p>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className={cn(
            "mt-4 rounded-card border px-3 py-2 text-sm",
            "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
          )}
        >
          {error}
        </div>
      )}
    </Modal>
  );
}
