import { useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, MessageSquare, X } from "lucide-react";

import { feedbackApi } from "@/api/feedback";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * A short message to this server's admins. It is kept on the server and
 * shown to them under Admin → Feedback; it goes nowhere else.
 */
export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const text = message.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      await feedbackApi.submit(text);
      toast.success("Sent to your admin. Thank you.");
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't send that. Please try again."));
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Send feedback"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-[var(--accent-text)]" />
            <h2 className="text-sm font-semibold">Send feedback</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            This goes to your server's admin.
          </p>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, 5000))}
            rows={4}
            autoFocus
            aria-label="Your message"
            placeholder="What's on your mind?"
            className="w-full resize-y rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/60"
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!message.trim() || submitting}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-strong)] px-3 py-1.5 text-sm font-medium text-white transition",
              "hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Send
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
