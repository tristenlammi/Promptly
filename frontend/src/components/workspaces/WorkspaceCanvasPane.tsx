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
import { useThemeStore } from "@/store/themeStore";
// Re-points Excalidraw's indigo accent at the app's terracotta (scoped to
// the .promptly-canvas wrapper below).
import "@/styles/excalidraw.css";
import { ErrorState } from "@/components/shared/Callout";
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

// The canvas background, matched to the app's left rail (--bg light, #FAF9F7).
// Excalidraw needs a concrete colour string (no CSS vars in appState), and in
// dark mode it runs the whole <canvas> through `invert(93%) hue-rotate(180deg)`
// — which turns this warm off-white into a warm near-black (~#181715), almost
// exactly the dark rail (#1C1917). So one value reads as the rail in BOTH
// themes; the filter does the dark conversion for us.
const CANVAS_BG = "#FAF9F7";

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

  // The board follows the app theme by default; a manual flip of Excalidraw's
  // own toggle sticks (see canvasThemeStore). ``resolved()`` collapses the
  // app's light/dark/system into a concrete value.
  const appTheme = useThemeStore((s) => s.resolved());

  // The theme we last applied to / observed from Excalidraw. Lets ``handleChange``
  // tell a genuine user toggle apart from the echo of our own programmatic
  // ``updateScene`` when the app theme changes.
  const expectedThemeRef = useRef<"light" | "dark">(
    useCanvasThemeStore.getState().overridden
      ? useCanvasThemeStore.getState().theme
      : useThemeStore.getState().resolved()
  );

  // Initial scene data, built once at mount. Seeded from the overridden canvas
  // theme if the user set one, otherwise from the current app theme. ``getState()``
  // (not the hook) reads the persisted value without making theme a reactive dep.
  const initialData = useMemo(
    () => ({
      libraryItems: buildBundledLibraryItems(),
      appState: {
        theme: expectedThemeRef.current,
        viewBackgroundColor: CANVAS_BG,
      },
    }),
    []
  );

  // Follow the app theme: when it changes and the user hasn't overridden the
  // board, push the new theme into Excalidraw. We bump ``expectedThemeRef``
  // first so the resulting ``onChange`` echo isn't mistaken for a manual flip.
  // Also re-assert our app-matched background each mount so the canvas never
  // falls back to Excalidraw's white default (which the dark filter renders as
  // a cool #121212 that doesn't match the rest of the UI).
  useEffect(() => {
    if (!excalidrawAPI) return;
    const store = useCanvasThemeStore.getState();
    store.followApp(appTheme);
    const themeChanged =
      !store.overridden && appTheme !== expectedThemeRef.current;
    const bgWrong =
      excalidrawAPI.getAppState().viewBackgroundColor !== CANVAS_BG;
    if (themeChanged) expectedThemeRef.current = appTheme;
    // Separate literals (not a Partial<AppState> var) so each satisfies
    // updateScene under exactOptionalPropertyTypes.
    if (themeChanged && bgWrong) {
      excalidrawAPI.updateScene({
        appState: { theme: appTheme, viewBackgroundColor: CANVAS_BG },
      });
    } else if (themeChanged) {
      excalidrawAPI.updateScene({ appState: { theme: appTheme } });
    } else if (bgWrong) {
      excalidrawAPI.updateScene({
        appState: { viewBackgroundColor: CANVAS_BG },
      });
    }
  }, [appTheme, excalidrawAPI]);

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
      // A theme that differs from what we last applied means the user flipped
      // Excalidraw's own toggle. Record it as a sticky override (or clear the
      // override if they re-synced to the current app theme).
      const nextTheme = (appState as { theme?: "light" | "dark" }).theme;
      if (nextTheme && nextTheme !== expectedThemeRef.current) {
        expectedThemeRef.current = nextTheme;
        useCanvasThemeStore
          .getState()
          .setManual(nextTheme, useThemeStore.getState().resolved());
      }

      // Surface the "Remove background" button for a single selected image.
      const selectedIds = appState.selectedElementIds;
      const picked = Object.keys(selectedIds).filter((id) => selectedIds[id]);
      let next: ImageSelection | null = null;
      if (!readOnly && picked.length === 1) {
        const el = elements.find((e) => e.id === picked[0]);
        if (el && el.type === "image" && !el.isDeleted && el.fileId) {
          const p = sceneCoordsToViewportCoords(
            // Anchor at the image's bottom-centre so the button floats
            // below the image — keeps it clear of the rotation handle
            // that sits above the top edge.
            { sceneX: el.x + el.width / 2, sceneY: el.y + el.height },
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
    return <ErrorState>{error}</ErrorState>;
  }

  return (
    <div
      ref={containerRef}
      className="promptly-canvas relative h-full min-h-0 w-full flex-1"
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
            transform: "translate(-50%, 12px)",
          }}
        >
          <button
            type="button"
            onClick={handleRemoveBackground}
            disabled={bgState === "working"}
            title="Remove the background from this image"
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--text)] shadow-md transition hover:bg-[var(--surface-hover)] disabled:opacity-70"
          >
            {bgState === "working" ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Removing background…
              </>
            ) : bgState === "error" ? (
              <>
                <Wand2 className="h-3.5 w-3.5 text-[var(--danger)]" />
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
