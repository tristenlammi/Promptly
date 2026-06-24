import { useEffect, useState } from "react";
import { AlertCircle, ExternalLink, RotateCw, X } from "lucide-react";

import type { StreamErrorMeta } from "@/store/chatStore";
import { cn } from "@/utils/cn";

interface Props {
  error: string;
  meta: StreamErrorMeta | null;
  onDismiss: () => void;
  /** Re-run the last turn with the same model. Optional: callers that
   *  don't wire it up simply don't render the "Try again" button. */
  onRetry?: () => void;
  /** Focuses the model selector (or any equivalent "pick another
   *  model" affordance). The TopNav mounts the actual ``ModelSelector``
   *  so we don't open a picker from the error card directly — instead
   *  the card just asks the page to surface whatever picker it has.
   *  Optional: callers that don't wire this up get a bare dismiss. */
  onPickAnotherModel?: () => void;
}

/**
 * Renders a chat-area error banner. Two modes:
 *
 *   * **Plain** (``meta === null``): a red banner with the raw
 *     backend ``error`` string — preserves the existing behaviour
 *     for unclassified failures.
 *   * **Classified** (``meta.code`` set): richer card with a short
 *     human title, helpful copy per code, and action buttons (e.g.
 *     "Open OpenRouter settings", "Pick another model", "Dismiss").
 *
 * Keeping the per-code copy in the frontend means we can iterate on
 * wording without a backend/redeploy. The backend only has to agree
 * on the stable ``code`` + optional ``helpUrl``.
 */
export function StreamErrorCard({
  error,
  meta,
  onDismiss,
  onRetry,
  onPickAnotherModel,
}: Props) {
  // Retry countdown for rate-limit errors: the provider told us how long
  // to wait, so we tick it down and keep "Try again" disabled until it
  // elapses (retrying sooner just earns another 429). No-op for every
  // other class — ``retryAfter`` is null, so ``remaining`` stays 0.
  const initialWait = meta?.retryAfter ?? null;
  const [remaining, setRemaining] = useState(() =>
    initialWait ? Math.ceil(initialWait) : 0
  );
  useEffect(() => {
    if (!initialWait) return;
    setRemaining(Math.ceil(initialWait));
    const t = setInterval(() => {
      setRemaining((r) => (r <= 1 ? 0 : r - 1));
    }, 1000);
    return () => clearInterval(t);
  }, [initialWait]);
  const retryBlocked = remaining > 0;

  if (!meta) {
    return (
      <div
        className={cn(
          "mx-4 my-3 rounded-card border px-4 py-3 text-sm",
          "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
        )}
        role="alert"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1 break-words">{error}</div>
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded p-0.5 opacity-70 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
            aria-label="Dismiss error"
            title="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {(onRetry || onPickAnotherModel) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-6">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium",
                  "bg-red-500/15 text-red-700 hover:bg-red-500/25 dark:text-red-300"
                )}
              >
                <RotateCw className="h-3 w-3" />
                Try again
              </button>
            )}
            {onPickAnotherModel && (
              <button
                type="button"
                onClick={onPickAnotherModel}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs",
                  "text-red-700/80 hover:text-red-700 dark:text-red-300/80 dark:hover:text-red-300"
                )}
              >
                Pick another model
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // Per-code copy. Adding a new classified error = one new case
  // here + a matching ``error_code`` branch in the backend.
  const body = describeClassifiedError(meta.code);
  const title = meta.title || body.fallbackTitle;

  return (
    <div
      className={cn(
        "mx-4 my-3 rounded-card border px-4 py-3",
        "border-amber-500/40 bg-amber-500/10 text-[var(--text)]"
      )}
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{title}</div>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            {body.explanation}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                disabled={retryBlocked}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium",
                  "bg-[var(--accent)] text-white hover:opacity-90",
                  retryBlocked && "cursor-not-allowed opacity-50 hover:opacity-50"
                )}
              >
                <RotateCw className="h-3 w-3" />
                {retryBlocked ? `Try again in ${remaining}s` : "Try again"}
              </button>
            )}
            {meta.helpUrl && (
              <a
                href={meta.helpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium",
                  onRetry
                    ? "border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
                    : "bg-[var(--accent)] text-white hover:opacity-90"
                )}
              >
                {body.helpLabel}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {onPickAnotherModel && (
              <button
                type="button"
                onClick={onPickAnotherModel}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs",
                  "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]/50 hover:text-[var(--text)]"
                )}
              >
                Pick another model
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs",
                "text-[var(--text-muted)] hover:text-[var(--text)]"
              )}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ClassifiedCopy {
  fallbackTitle: string;
  explanation: string;
  helpLabel: string;
}

function describeClassifiedError(code: string): ClassifiedCopy {
  switch (code) {
    case "openrouter_privacy_blocked":
      return {
        fallbackTitle:
          "This model isn't allowed by your OpenRouter privacy settings",
        explanation:
          "OpenRouter has privacy controls (ZDR, training opt-out, guardrails) that can block specific endpoints from handling your requests. None of this model's endpoints match your current settings, so no provider will respond. You can either adjust your OpenRouter privacy settings or pick a different model from the picker above.",
        helpLabel: "Open OpenRouter privacy settings",
      };

    case "invalid_image_attachment":
      return {
        fallbackTitle: "One of your image attachments couldn't be read",
        explanation:
          "The provider rejected the image bytes — usually because the upload was truncated (common on spotty mobile connections) or the photo was saved in a format the model doesn't support. Try removing the attachment and uploading the image again. If it keeps failing, re-save or re-take the photo as a standard JPEG or PNG.",
        helpLabel: "Learn more",
      };

    case "rate_limited":
      return {
        fallbackTitle: "Rate limited by the model provider",
        explanation:
          "The provider is throttling requests for this model — you've hit its rate or quota limit. Wait a moment and try again, or switch to a different model to keep going right now.",
        helpLabel: "Learn more",
      };

    case "auth_failed":
      return {
        fallbackTitle: "The provider rejected the API key",
        explanation:
          "Authentication with the upstream provider failed — the API key is missing, invalid, expired, or lacks access to this model. Check the provider's key in Settings, then try again. (If you're not an admin, let yours know.)",
        helpLabel: "Learn more",
      };

    case "provider_overloaded":
      return {
        fallbackTitle: "The model host hiccuped",
        explanation:
          "The provider hosting this model had a transient problem — it's overloaded, restarting, or briefly unreachable. This is on their end, not your request. Give it a few seconds and try again, or pick another model if it keeps happening.",
        helpLabel: "Learn more",
      };

    default:
      return {
        fallbackTitle: "Something went wrong with this request",
        explanation:
          "The upstream provider rejected the request. Try again or pick a different model.",
        helpLabel: "Learn more",
      };
  }
}
