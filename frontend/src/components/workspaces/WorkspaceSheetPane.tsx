import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Workbook } from "@fortune-sheet/react";
import type { Sheet } from "@fortune-sheet/core";
import "@fortune-sheet/react/dist/index.css";

import { workspacesApi } from "@/api/workspaces";

// Fortune-sheet wants at least one named sheet; seed one when a spreadsheet
// page has never been saved (``data`` is null).
const DEFAULT_SHEET: Sheet[] = [{ name: "Sheet1" }];

const SAVE_DEBOUNCE_MS = 800;

/**
 * A spreadsheet page of a multi-page document. Mounts Fortune-sheet against a
 * ``Spreadsheet`` row and persists edits with a debounced PUT (single-user
 * for now — live collaboration is a later phase). Lazy-loaded by the note
 * pane so the (large) editor chunk only downloads when a sheet page opens.
 */
export function WorkspaceSheetPane({
  workspaceId,
  sheetId,
  canEdit,
}: {
  workspaceId: string;
  sheetId: string;
  canEdit: boolean;
}) {
  const [data, setData] = useState<Sheet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Sheet[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData(null);
    latest.current = null;
    workspacesApi
      .getSpreadsheet(workspaceId, sheetId)
      .then((s) => {
        if (cancelled) return;
        const sheets = (s.data as Sheet[] | null) ?? null;
        setData(sheets && sheets.length ? sheets : DEFAULT_SHEET);
      })
      .catch((err) => {
        if (cancelled) return;
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data
            ?.detail ?? "Couldn't open this spreadsheet.";
        setError(detail);
      });
    return () => {
      cancelled = true;
      // Flush any pending edit on unmount / page switch so a quick edit →
      // tab-away doesn't lose the last keystrokes.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        if (latest.current && canEdit) {
          void workspacesApi
            .saveSpreadsheet(workspaceId, sheetId, { data: latest.current })
            .catch(() => {});
        }
      }
    };
    // canEdit intentionally excluded — flushing on unmount reads it via ref
    // semantics; re-running the loader on a permission flip isn't desired.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, sheetId]);

  const handleChange = useCallback(
    (next: Sheet[]) => {
      if (!canEdit) return;
      latest.current = next;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void workspacesApi
          .saveSpreadsheet(workspaceId, sheetId, {
            data: latest.current ?? next,
          })
          .catch(() => {});
      }, SAVE_DEBOUNCE_MS);
    },
    [workspaceId, sheetId, canEdit]
  );

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10 text-sm text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Opening spreadsheet…
        </span>
      </div>
    );
  }

  // Fortune-sheet positions its grid absolutely, so the wrapper needs a
  // concrete height — ``flex-1 min-h-0`` plus an explicit 100% height gives
  // it one inside the pane's flex column.
  return (
    <div className="relative min-h-0 flex-1" style={{ height: "100%" }}>
      <Workbook
        data={data}
        onChange={handleChange}
        allowEdit={canEdit}
        lang="en"
      />
    </div>
  );
}
