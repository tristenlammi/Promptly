import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Wand2 } from "lucide-react";
import {
  Excalidraw,
  getTextFromElements,
  sceneCoordsToViewportCoords,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { canvasApi } from "@/api/canvas";
import { useCanvasThemeStore } from "@/store/canvasThemeStore";
import { useCanvasCollabProvider } from "./useCanvasCollabProvider";
import { useExcalidrawCanvas } from "./useExcalidrawCanvas";
import { buildBundledLibraryItems } from "./canvas/libraries";
import { removeImageBackground } from "./canvas/backgroundRemoval";

// The onChange element list type, derived from the component so we don't
// reach into Excalidraw's internal element type-paths.
type OnChange = NonNullable<
  React.ComponentProps<typeof Excalidraw>["onChange"]
>;
type ChangeElements = Parameters<OnChange>[0];

// The currently-selected single image + where to float its action button
// (container-relative px). null when the selection isn't one ready image.
interface ImageSelection {
  elementId: string;
  fileId: string;
  left: number;
  top: number;
}
type BgState = "idle" | "working" | "error";

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

  // "Remove background" tool — tracks a single selected image and where to
  // float its button. containerRef converts Excalidraw's window-relative
  // viewport coords into coords inside our overlay.
  const containerRef = useRef<HTMLDivElement>(null);
  const [imageSel, setImageSel] = useState<ImageSelection | null>(null);
  const [bgState, setBgState] = useState<BgState>("idle");
  const selIdRef = useRef<string | null>(null);

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

      // Surface the "Remove background" button for a single selected image.
      const selectedIds = appState.selectedElementIds;
      const picked = Object.keys(selectedIds).filter((id) => selectedIds[id]);
      let next: ImageSelection | null = null;
      if (!readOnly && picked.length === 1) {
        const el = elements.find((e) => e.id === picked[0]);
        if (el && el.type === "image" && !el.isDeleted && el.fileId) {
          const p = sceneCoordsToViewportCoords(
            { sceneX: el.x + el.width / 2, sceneY: el.y },
            appState
          );
          const rect = containerRef.current?.getBoundingClientRect();
          next = {
            elementId: el.id,
            fileId: el.fileId,
            left: p.x - (rect?.left ?? 0),
            top: p.y - (rect?.top ?? 0),
          };
        }
      }
      // Reset the button state when the selected image changes.
      if ((next?.elementId ?? null) !== selIdRef.current) {
        selIdRef.current = next?.elementId ?? null;
        setBgState("idle");
      }
      setImageSel(next);
    },
    [binding.onChange, schedulePush, readOnly]
  );

  const handleRemoveBackground = useCallback(async () => {
    const api = excalidrawAPI;
    if (!api || !imageSel || bgState === "working") return;
    setBgState("working");
    try {
      await removeImageBackground(api, imageSel.elementId, imageSel.fileId);
      setBgState("idle");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Background removal failed", err);
      setBgState("error");
      window.setTimeout(() => setBgState("idle"), 4000);
    }
  }, [excalidrawAPI, imageSel, bgState]);

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
      ref={containerRef}
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
      {imageSel && (
        <div
          className="absolute z-20"
          style={{
            left: imageSel.left,
            top: imageSel.top,
            transform: "translate(-50%, calc(-100% - 12px))",
          }}
        >
          <button
            type="button"
            onClick={handleRemoveBackground}
            disabled={bgState === "working"}
            title="Remove the background from this image"
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-white shadow-md hover:bg-neutral-700 disabled:opacity-70"
          >
            {bgState === "working" ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Removing background…
              </>
            ) : bgState === "error" ? (
              <>
                <Wand2 className="h-3.5 w-3.5 text-red-400" />
                Failed — try again
              </>
            ) : (
              <>
                <Wand2 className="h-3.5 w-3.5" />
                Remove background
              </>
            )}
          </button>
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
