import { useEffect } from "react";

import { useQueryClient } from "@tanstack/react-query";

import type { FileScope } from "@/api/files";
import { invalidateUploadTargets } from "@/hooks/useFiles";
import { invalidateWorkspaceDrive } from "@/hooks/useWorkspaces";
import { useFilesShellStore } from "@/store/filesShellStore";
import { toast } from "@/store/toastStore";
import { useUploadStore } from "@/store/uploadStore";

/**
 * Headless component — mounted once at ``AppLayout`` so completion
 * events from the module-level upload queue can be turned into
 * React-Query invalidations no matter where the user has navigated.
 *
 * The invalidations normally live in ``useUploadFile``'s
 * ``onSuccess``, but we've pulled the actual uploads out of React
 * (they run in the Zustand store) specifically so they survive
 * navigation. That means the React-Query boundary for invalidation
 * has to be established at the app layout instead of per-page.
 *
 * This component renders nothing. It does two things:
 *   1. Subscribes to ``pendingCompletions`` and drains them by
 *      refreshing the folders the files landed in (plus quota and
 *      Recent) — ``invalidateUploadTargets``.
 *   2. Nothing else. Cancelled and failed tasks also invalidate so
 *      the UI reflects a file that the server accepted before the
 *      abort reached it (rare but happens with tiny files).
 */
export function UploadQueueWatcher() {
  const qc = useQueryClient();

  useEffect(() => {
    // Coalesced (R-214): a 500-photo upload refetched the folder 500
    // times. Now at most every 1.5 s while uploads run, and once more as
    // soon as the queue is empty — and only the folders they landed in
    // (WP-7.6).
    const pending = new Map<string, { scope: FileScope; folderId: string | null }>();
    const done: string[] = [];
    const workspaces = new Set<string>();
    let timer: number | null = null;
    const flush = () => {
      timer = null;
      invalidateUploadTargets(qc, [...pending.values()]);
      pending.clear();
      workspaces.forEach((wid) => invalidateWorkspaceDrive(qc, wid));
      workspaces.clear();
      // One file uploaded on its own: show it (the list is virtualised, so
      // it may land out of view). A batch doesn't pull the view around.
      if (done.length === 1) useFilesShellStore.getState().reveal(`file:${done[0]}`);
      done.length = 0;
    };
    const unsubscribe = useUploadStore.subscribe((state, prev) => {
      if (state.pendingCompletions === prev.pendingCompletions) return;
      const events = useUploadStore.getState().consumeCompleted();
      if (events.length === 0) return;
      events.forEach((e) => {
        pending.set(`${e.scope}|${e.folderId ?? ""}`, { scope: e.scope, folderId: e.folderId });
        if (e.status === "done" && e.fileId) done.push(e.fileId);
        if (e.workspaceId) workspaces.add(e.workspaceId);
        // Somewhere else in the app: say so when one fails (WP-8.2) — the
        // panel only shows where files are.
        if (e.status === "error" && !/^\/(files|workspaces)(\/|$)/.test(window.location.pathname)) {
          toast.error(`“${e.name}” couldn't be uploaded${e.error ? `: ${e.error}` : "."}`);
        }
      });
      const busy = useUploadStore
        .getState()
        .tasks.some((t) => t.status === "uploading" || t.status === "queued");
      if (!busy) {
        if (timer !== null) window.clearTimeout(timer);
        flush();
      } else if (timer === null) {
        timer = window.setTimeout(flush, 1500);
      }
    });
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [qc]);

  return null;
}
