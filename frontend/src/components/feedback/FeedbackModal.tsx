import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, MessageSquare, X } from "lucide-react";

import { feedbackApi } from "@/api/feedback";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Subtle feedback form. Submits through the instance's own SMTP (server-side)
 * so it works across isolated self-host networks with no external service. If
 * the instance has no SMTP configured — or the send fails — we fall back to a
 * ``mailto:`` compose in the user's own mail client, so feedback always has a
 * path out.
 */
export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const user = useAuthStore((s) => s.user);
  const [message, setMessage] = useState("");
  const [includeEmail, setIncludeEmail] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const hasEmail = Boolean(user?.email);
  // The destination address (from the server, so a self-hoster's override is
  // respected), shown as a direct-email link for anyone who'd rather email.
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void feedbackApi
      .getConfig()
      .then((c) => {
        if (!cancelled) setAddress(c.email);
      })
      .catch(() => {
        /* non-fatal — the form still works without the direct link */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openMailto = (to: string) => {
    const subject = encodeURIComponent("Promptly feedback");
    const body = encodeURIComponent(message.trim());
    window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
  };

  const submit = async () => {
    const text = message.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const res = await feedbackApi.submit(text, includeEmail && hasEmail);
      if (res.delivered) {
        toast.success("Thanks — your feedback was sent.");
        onClose();
      } else if (res.fallback_to) {
        // No SMTP on this instance (or the send failed): hand off to the
        // user's own mail client with the message pre-filled.
        toast.info("Opening your email app to send this…");
        openMailto(res.fallback_to);
        onClose();
      } else {
        toast.error("Couldn't send feedback right now. Please try again.");
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't send feedback."));
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
      <div className="w-full max-w-md overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-[var(--accent)]" />
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
            Found a bug or have an idea? Send it straight to the maintainer
            {address ? (
              <>
                , or email{" "}
                <a
                  href={`mailto:${address}?subject=${encodeURIComponent(
                    "Promptly feedback"
                  )}`}
                  className="text-[var(--accent)] underline"
                >
                  {address}
                </a>{" "}
                directly.
              </>
            ) : (
              "."
            )}
          </p>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, 5000))}
            rows={5}
            autoFocus
            placeholder="What's on your mind?"
            className="w-full resize-y rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/60"
          />
          {hasEmail && (
            <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <input
                type="checkbox"
                checked={includeEmail}
                onChange={(e) => setIncludeEmail(e.target.checked)}
              />
              Include my email ({user?.email}) so I can reply
            </label>
          )}
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
              "inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white transition",
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
