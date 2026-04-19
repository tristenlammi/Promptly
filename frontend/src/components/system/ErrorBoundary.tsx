import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional override for the rendered fallback. Receives the error
   *  and a ``reset`` callback that re-renders the children. */
  fallback?: (args: { error: Error; reset: () => void }) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Top-level React error boundary.
 *
 *  Without one of these, an unhandled render error blanks the whole UI
 *  with React's default empty `<div id="root" />`. With it, the user
 *  gets a friendly recovery panel and we get the stack copied to the
 *  clipboard so they can send it on. The boundary deliberately
 *  resets when the user clicks "Try again" — most render errors are
 *  transient (a network blip during a Suspense boundary, an undefined
 *  field on a brand-new server build) and worth one retry before
 *  asking for a hard reload.
 *
 *  This is a class component because React's error boundary API is
 *  only available via class lifecycles (``getDerivedStateFromError`` /
 *  ``componentDidCatch``). The functional version is still in the RFC
 *  graveyard as of React 18.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the browser console in dev. In production this is the
    // only place we capture the error today; once the in-app log
    // pipeline lands (Phase 2) we'll forward it through the same
    // request-id channel the backend uses.
    // eslint-disable-next-line no-console
    console.error("Promptly UI crash:", error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  hardReload = (): void => {
    window.location.reload();
  };

  copyStack = async (): Promise<void> => {
    const { error } = this.state;
    if (!error) return;
    const payload = [
      `${error.name}: ${error.message}`,
      error.stack ?? "(no stack)",
      "",
      `URL: ${window.location.href}`,
      `User-Agent: ${navigator.userAgent}`,
      `Time: ${new Date().toISOString()}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      // Older browsers / non-secure contexts. Fall back to a textarea.
      const ta = document.createElement("textarea");
      ta.value = payload;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* swallow — best-effort */
      }
      ta.remove();
    }
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback({ error, reset: this.reset });
    }

    return (
      <div className="flex min-h-screen w-screen items-center justify-center bg-[var(--bg)] px-4 py-8 text-[var(--text)]">
        <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-lg">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--accent)]">
            Promptly
          </div>
          <h1 className="mb-2 text-lg font-semibold">Something went wrong</h1>
          <p className="mb-4 text-sm text-[var(--text-muted)]">
            The app hit an unexpected error and couldn't render this view.
            Most of the time a quick retry fixes it. If it keeps happening,
            copy the technical details and send them to your admin.
          </p>
          <pre className="mb-4 max-h-32 overflow-auto rounded-md border border-[var(--border)] bg-black/[0.04] px-3 py-2 text-xs text-[var(--text)] dark:bg-white/[0.04]">
            {error.name}: {error.message}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-white transition hover:opacity-90"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.hardReload}
              className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border)] bg-transparent px-3 text-sm font-medium transition hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            >
              Reload page
            </button>
            <button
              type="button"
              onClick={this.copyStack}
              className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border)] bg-transparent px-3 text-sm font-medium transition hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            >
              Copy details
            </button>
          </div>
        </div>
      </div>
    );
  }
}
