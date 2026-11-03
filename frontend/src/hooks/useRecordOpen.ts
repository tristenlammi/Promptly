import { useEffect } from "react";

import { recordOpen, type RecentKind } from "@/api/recents";

/** Record an open for Today's "Recent" strip once ``id`` is known (and again
 *  whenever it changes). Debounced in ``recordOpen``. */
export function useRecordOpen(kind: RecentKind, id: string | null | undefined): void {
  useEffect(() => {
    if (id) recordOpen(kind, id);
  }, [kind, id]);
}
