import { Loader2, X } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import { shareApi, type ShareOfficeView } from "@/api/share";
import { SheetTable } from "./SheetTable";

// Excalidraw is a big chunk — only fetched when a shared whiteboard opens.
const SharedWhiteboardCanvas = lazy(() =>
  import("./SharedWhiteboardCanvas").then((m) => ({ default: m.SharedWhiteboardCanvas }))
);

export const SHEET_MIME = "application/vnd.promptly.sheet+json";
export const WHITEBOARD_MIME = "application/vnd.promptly.whiteboard+json";

export function isOfficeShellMime(mime: string | null | undefined): boolean {
  return mime === SHEET_MIME || mime === WHITEBOARD_MIME;
}

/** A shared spreadsheet or whiteboard, read-only, on the share-link
 *  landing page (WP-3.4). ``fileId`` for a file inside a shared folder. */
export function PublicOfficePreview({
  token,
  fileId,
  unlockToken,
  onClose,
}: {
  token: string;
  fileId?: string | null;
  unlockToken: string | null;
  onClose: () => void;
}) {
  const [view, setView] = useState<ShareOfficeView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    shareApi
      .office(token, { fileId: fileId ?? null, unlockToken })
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Couldn't open it.");
      });
    return () => {
      cancelled = true;
    };
  }, [token, fileId, unlockToken]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--bg)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
        <span className="truncate text-sm font-semibold">{view?.title ?? "Preview"}</span>
        <span className="rounded bg-[var(--hover)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">View only</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--hover)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {err && <div className="p-6 text-sm text-red-500">{err}</div>}
        {!err && !view && (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
        {view?.kind === "sheet" && <SheetTable sheets={view.data} />}
        {view?.kind === "whiteboard" && (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading whiteboard…
              </div>
            }
          >
            <SharedWhiteboardCanvas scene={view.scene} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
