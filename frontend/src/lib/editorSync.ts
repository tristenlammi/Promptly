/**
 * Pure helpers for the document editor's sync state (WP-4.1). Kept free of
 * React and the editor so the Playwright runner can test them directly.
 */

/** What the save chip says — driven by the provider's real state, never
 *  by a timer (R-224). */
export type SaveChip =
  | { kind: "error"; label: string }
  | { kind: "loading"; label: string }
  | { kind: "saving"; label: string }
  | { kind: "saved"; label: string }
  | { kind: "offline"; label: string };

export function saveChip(s: {
  fatal: string | null;
  synced: boolean;
  status: "connecting" | "connected" | "disconnected";
  /** Local changes the server hasn't acknowledged yet. */
  unsynced: number;
  /** A manual Save that succeeded since the last local edit. */
  savedManuallyAt?: Date | null;
  lastLocalEditAt?: Date | null;
}): SaveChip {
  if (s.fatal) return { kind: "error", label: "Error" };
  if (!s.synced) {
    return s.status === "disconnected"
      ? { kind: "offline", label: "Offline" }
      : { kind: "loading", label: "Loading…" };
  }
  if (s.status === "connected") {
    return s.unsynced > 0 ? { kind: "saving", label: "Saving…" } : { kind: "saved", label: "Saved" };
  }
  // Not connected: a manual Save after the last edit means the server has
  // everything; otherwise say how much is only in this tab.
  const manualCoversEdits =
    s.savedManuallyAt && (!s.lastLocalEditAt || s.savedManuallyAt >= s.lastLocalEditAt);
  if (manualCoversEdits) return { kind: "saved", label: "Saved (manually)" };
  if (s.unsynced > 0) {
    return {
      kind: "offline",
      label: `Offline · ${s.unsynced} unsynced change${s.unsynced === 1 ? "" : "s"}`,
    };
  }
  return { kind: "offline", label: s.status === "connecting" ? "Reconnecting…" : "Offline" };
}

/** Is this collab-token failure final? Only a confirmed "you can't open
 *  this" (403 / 404). A timeout, a 502 while the backend restarts, a 401
 *  mid-refresh or a network error on laptop wake are transient: retry and
 *  keep the editor (R-221). */
export function isFatalCollabError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 403 || status === 404;
}

/** Backoff for collab retries: 1 s, 2 s, 4 s … capped at 30 s. */
export function collabRetryDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}
