/**
 * Delete with Undo: the thing disappears at once and a toast offers Undo.
 * It's only really deleted once the toast has gone, so Undo is always
 * honest. Leaving the page (or closing the tab) deletes it straight away.
 */
import { toast, useToastStore } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

const WAIT_MS = 10_000;

const waiting = new Set<() => void>();

export function removeWithUndo({
  message,
  hide,
  restore,
  commit,
  failed,
}: {
  /** "Post deleted." */
  message: string;
  /** Take it off the screen. */
  hide: () => void;
  /** Put it back (Undo, or the delete didn't work). */
  restore: () => void;
  /** Really delete it. */
  commit: () => Promise<unknown>;
  /** What to say if the delete didn't work. */
  failed: string;
}): void {
  let settled = false;
  let toastId = "";
  const go = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    waiting.delete(go);
    if (toastId) useToastStore.getState().dismiss(toastId);
    void commit().catch((err) => {
      restore();
      toast.error(apiErrorMessage(err, failed));
    });
  };
  hide();
  const timer = window.setTimeout(go, WAIT_MS);
  waiting.add(go);
  toastId = toast.success(message, {
    duration: WAIT_MS,
    action: {
      label: "Undo",
      onClick: () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        waiting.delete(go);
        restore();
      },
    },
  });
}

// Going away with a delete still waiting: do it now.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const go of [...waiting]) go();
  });
}
