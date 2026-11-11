import { AlertCircle, Check, Loader2, X } from "lucide-react";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { cn } from "@/utils/cn";

import { dismissPosting, retryPosting, usePostingStore } from "../posting";

/**
 * How your post is getting on, shown in Porch while you carry on reading:
 * "Posting… 60%", then "Posted. View", or what went wrong with a way to try
 * again. Sits above the bottom bar on a phone, bottom-middle on a computer.
 */
export function PostingChip({ floating }: { floating: boolean }) {
  const job = usePostingStore((s) => s.job);
  const navigate = useNavigate();

  // While a chip is on screen the news is told here, not with a toast.
  useEffect(() => {
    usePostingStore.setState((s) => ({ watchers: s.watchers + 1 }));
    return () => usePostingStore.setState((s) => ({ watchers: Math.max(0, s.watchers - 1) }));
  }, []);

  if (!job) return null;
  const pct = Math.round(job.progress * 100);
  const uploadsLeft = job.draft.picks.some((p) => !p.fileId && !p.mediaId);
  const link =
    "inline-flex h-10 shrink-0 items-center rounded-lg px-2.5 text-sm font-semibold text-[var(--accent-text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]";
  const close = (
    <button
      type="button"
      aria-label="Hide this"
      onClick={dismissPosting}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
    >
      <X className="h-4 w-4" aria-hidden />
    </button>
  );

  return (
    <div className={cn("pointer-events-none z-30 flex justify-center px-3", floating ? "absolute inset-x-0 bottom-5" : "shrink-0 border-t border-[var(--border)] bg-[var(--bg)] py-2")}>
      <div
        role="status"
        aria-live="polite"
        className="porch-rise pointer-events-auto relative flex min-h-[48px] w-full max-w-md items-center gap-2 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-1 pl-3.5 pr-1 text-sm text-[var(--text)] shadow-[var(--shadow-md)]"
      >
        {job.state === "sending" && (
          <>
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--accent-text)] motion-reduce:animate-none" aria-hidden />
            <span className="min-w-0 flex-1 py-2 pr-2.5 font-medium">
              Posting… <span className="tabular-nums text-[var(--text-muted)]">{pct}%</span>
            </span>
            <span aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] bg-[var(--surface-2)]">
              <span className="block h-full bg-[var(--item-accent-fill)] transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${Math.max(4, pct)}%` }} />
            </span>
          </>
        )}
        {job.state === "done" && (
          <>
            <Check className="h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-medium">{job.where ? `Posted to ${job.where}.` : "Posted."}</span>
            {job.postId && (
              <button
                type="button"
                className={link}
                onClick={() => {
                  const id = job.postId;
                  dismissPosting();
                  navigate(`/porch/p/${id}`);
                }}
              >
                View
              </button>
            )}
            {close}
          </>
        )}
        {job.state === "failed" && (
          <>
            <AlertCircle className="h-4 w-4 shrink-0 text-[var(--danger)]" aria-hidden />
            <span className="min-w-0 flex-1 py-1.5">
              <span className="block font-medium">Your post didn't go.</span>
              <span className="block text-xs text-[var(--text-muted)]">
                {job.error}
                {job.kept ? " It's kept as a draft." : ""}
              </span>
            </span>
            {!uploadsLeft && (
              <button type="button" className={link} onClick={retryPosting}>
                Try again
              </button>
            )}
            {job.kept && (
              <button
                type="button"
                className={link}
                onClick={() => {
                  dismissPosting();
                  navigate("/porch/new");
                }}
              >
                Edit
              </button>
            )}
            {close}
          </>
        )}
      </div>
    </div>
  );
}
