import { useEffect, useRef, useState } from "react";
import { Loader2, Trash2, TriangleAlert } from "lucide-react";

import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";

interface DeleteChatModalProps {
  open: boolean;
  /** Title of the conversation being deleted — shown in the body copy. */
  conversationTitle: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

/**
 * Destructive-confirm modal for deleting a chat conversation.
 *
 * Design notes:
 *  - Cancel is auto-focused (not Delete) so hitting Enter on an accidental
 *    trigger doesn't destroy data.
 *  - While the mutation is in flight we disable both buttons and show a
 *    spinner on the destructive one; Escape still works because the Modal
 *    shell handles it, but `onClose` is a no-op during `busy`.
 *  - Errors surface inline rather than being thrown up to a toast layer so
 *    the user can retry without losing context.
 */
export function DeleteChatModal({
  open,
  conversationTitle,
  onConfirm,
  onClose,
}: DeleteChatModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Reset the transient state every time the modal re-opens so stale errors
  // from a previous attempt don't bleed through.
  useEffect(() => {
    if (open) {
      setError(null);
      setBusy(false);
      // Focus cancel on next frame so the portal has rendered.
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
    // On success the parent closes us and unmounts, so no need to reset busy.
  };

  const displayTitle = conversationTitle.trim() || "Untitled chat";

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Delete chat"
      description="This conversation will be permanently removed."
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
                Delete chat
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
            <span className="font-semibold">“{displayTitle}”</span>?
          </p>
          <p className="mt-1 text-[var(--text-muted)]">
            All of its messages will be permanently removed. This action
            can&apos;t be undone.
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
