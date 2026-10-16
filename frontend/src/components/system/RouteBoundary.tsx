import { type ReactNode, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, Copy } from "lucide-react";

import { ErrorBoundary } from "./ErrorBoundary";

/** Error boundary around the page content (inside the app shell).
 *
 *  There used to be one boundary, outside the router: any render crash
 *  replaced the whole app — sidebar included — and since its fallback sat
 *  outside the router it couldn't even navigate away, which in the
 *  installed app meant no way out (R-085/R-106). This one keeps the
 *  sidebar, and resets when you go somewhere else. */
export function RouteBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <ErrorBoundary
      resetKey={location.pathname}
      fallback={({ error, reset }) => <PageCrash error={error} reset={reset} />}
    >
      {children}
    </ErrorBoundary>
  );
}

function PageCrash({ error, reset }: { error: Error; reset: () => void }) {
  const navigate = useNavigate();
  return (
    <div role="alert" className="mx-auto mt-16 w-full max-w-md px-4">
      <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <AlertTriangle className="h-4 w-4 text-[var(--danger)]" aria-hidden />
          This page hit a problem
        </div>
        <p className="mb-3 text-sm text-[var(--text-muted)]">
          The rest of Promptly is fine — try again, or go somewhere else.
        </p>
        <pre className="mb-4 max-h-24 overflow-auto rounded-md border border-[var(--border)] px-3 py-2 text-xs">
          {error.name}: {error.message}
        </pre>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-9 items-center rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-white transition hover:opacity-90"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => navigate("/chat")}
            className="inline-flex h-9 items-center rounded-md border border-[var(--border)] px-3 text-sm font-medium transition hover:bg-[var(--hover)]"
          >
            Go to chats
          </button>
        </div>
      </div>
    </div>
  );
}

/** Boundary around one chat message: a message that can't be drawn shows
 *  its raw text instead of taking the whole conversation down. */
export function MessageBoundary({ content, children }: { content: unknown; children: ReactNode }) {
  return (
    <ErrorBoundary fallback={() => <MessageCrash content={content} />}>{children}</ErrorBoundary>
  );
}

function MessageCrash({ content }: { content: unknown }) {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "", null, 2);
  const [copied, setCopied] = useState(false);
  return (
    <div role="alert" className="mx-4 my-3 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--text-muted)]">
          Couldn't display this message
        </span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true));
          }}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <Copy className="h-3 w-3" aria-hidden /> {copied ? "Copied" : "Copy text"}
        </button>
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">{text}</pre>
    </div>
  );
}
