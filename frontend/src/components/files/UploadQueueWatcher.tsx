import { useEffect } from "react";

import { useInvalidateFiles } from "@/hooks/useFiles";
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
 *      calling ``invalidateFiles()``. One drain pass per scope is
 *      enough — ``invalidateFiles`` already wipes browse + recent
 *      + starred + trash + search at once.
 *   2. Nothing else. Cancelled and failed tasks also invalidate so
 *      the UI reflects a file that the server accepted before the
 *      abort reached it (rare but happens with tiny files).
 */
export function UploadQueueWatcher() {
  const invalidate = useInvalidateFiles();

  useEffect(() => {
    const unsubscribe = useUploadStore.subscribe((state, prev) => {
      if (state.pendingCompletions === prev.pendingCompletions) return;
      const events = useUploadStore.getState().consumeCompleted();
      if (events.length === 0) return;
      // De-dupe scopes — if a user drops five files in ``mine``, we
      // only need one invalidate call for that scope.
      const scopes = new Set(events.map((e) => e.scope));
      scopes.forEach((scope) => invalidate(scope));
    });
    return unsubscribe;
  }, [invalidate]);

  return null;
}
