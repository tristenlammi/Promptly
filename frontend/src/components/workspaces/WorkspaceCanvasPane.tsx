import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Excalidraw, getTextFromElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { canvasApi } from "@/api/canvas";
import { useCanvasThemeStore } from "@/store/canvasThemeStore";
import { useCanvasCollabProvider } from "./useCanvasCollabProvider";
import { useExcalidrawCanvas } from "./useExcalidrawCanvas";
import { buildBundledLibraryItems } from "./canvas/libraries";

// The onChange element list type, derived from the component so we don't
// reach into Excalidraw's internal element type-paths.
type OnChange = NonNullable<
  React.ComponentProps<typeof Excalidraw>["onChange"]
>;
type ChangeElements = Parameters<OnChange>[0];

/**
 * Live, multiplayer Excalidraw board for a workspace canvas item.
 *
 * Mirrors the document collab path: a Hocuspocus provider feeds a shared
 * ``Y.Doc``; ``useExcalidrawCanvas`` binds the Excalidraw scene to it
 * (elements + image files + presence). The board's flattened text is
 * pushed back to the backend on a 1.5s debounce so workspace RAG stays
 * grounded in what's on the canvas.
 *
 * The container is ``h-full`` + ``relative`` because Excalidraw fills its
 * positioned parent — without an explicitly sized parent it collapses to
 * zero height.
 */
const TEXT_DEBOUNCE_MS = 1500;

export function WorkspaceCanvasPane({
  canvasId,
  readOnly = false,
}: {
  canvasId: string;
  /** Viewer-role access → board opens read-only. */
  readOnly?: boolean;
}) {
  const { ydoc, provider, user, error } = useCanvasCollabProvider(canvasId);
  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI | null>(null);

  // Initial scene data, built once at mount. The canvas theme is seeded
  // from the (per-user, light-by-default) canvas theme store and from then
  // on is owned by Excalidraw's own toggle — we persist the user's choice
  // back to the store in ``handleChange`` below. ``getState()`` (not the
  // hook) reads the persisted value without making theme a reactive dep.
  const initialData = useMemo(
    () => ({
      libraryItems: buildBundledLibraryItems(),
      appState: { theme: useCanvasThemeStore.getState().theme },
    }),
    []
  );

  const binding = useExcalidrawCanvas({
    excalidrawAPI,
    ydoc,
    provider,
    user,
    readOnly,
  });

  // --- RAG text push (debounced) --------------------------------------
  const debounceRef = useRef<number | null>(null);
  // Keep the last text we pushed so cosmetic edits (moving a shape) don't
  // trigger no-op POSTs.
  const lastTextRef = useRef<string>("");

  const schedulePush = useCallback(
    (elements: ChangeElements) => {
      if (readOnly) return;
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        const text = getTextFromElements(elements, "\n").trim();
        if (text === lastTextRef.current) return;
        lastTextRef.current = text;
        void canvasApi.updateText(canvasId, text).catch(() => {
          // Best-effort; a failed RAG sync shouldn't disrupt drawing.
        });
      }, TEXT_DEBOUNCE_MS);
    },
    [canvasId, readOnly]
  );

  // One onChange feeds the collab binding, the RAG text push, and
  // persistence of the user's light/dark choice (Excalidraw owns the theme
  // toggle; we mirror it into the store so it sticks across sessions).
  const handleChange = useCallback<OnChange>(
    (elements, appState, files) => {
      binding.onChange(elements, appState, files);
      schedulePush(elements);
      const nextTheme = (appState as { theme?: "light" | "dark" }).theme;
      if (nextTheme && nextTheme !== useCanvasThemeStore.getState().theme) {
        useCanvasThemeStore.getState().setTheme(nextTheme);
      }
    },
    [binding.onChange, schedulePush]
  );

  // Clear any pending debounce on unmount / canvas swap.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      lastTextRef.current = "";
    };
  }, [canvasId]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative h-full min-h-0 w-full flex-1"
      // Stop publishing our cursor once the pointer leaves the board, so
      // peers don't see a stranded cursor sitting where we last were.
      onPointerLeave={binding.clearPointer}
    >
      {/* Gate interaction until the binding is live so early strokes can't
       *  land before the Yjs doc is wired (they'd be dropped). Excalidraw
       *  mounts underneath; remote content streams in once synced. */}
      {!binding.ready && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg)]/60 text-sm text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Connecting canvas…
          </span>
        </div>
      )}
      <Excalidraw
        excalidrawAPI={setExcalidrawAPI}
        onChange={handleChange}
        onPointerUpdate={binding.onPointerUpdate}
        viewModeEnabled={readOnly}
        initialData={initialData}
      />
    </div>
  );
}
