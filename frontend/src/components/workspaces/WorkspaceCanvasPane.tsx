import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link2, Link2Off, Loader2, Plus, Wand2 } from "lucide-react";
import {
  convertToExcalidrawElements,
  Excalidraw,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { canvasApi } from "@/api/canvas";
import { useCanvasThemeStore } from "@/store/canvasThemeStore";
import { useThemeStore } from "@/store/themeStore";
// Re-points Excalidraw's indigo accent at the app's terracotta (scoped to
// the .promptly-canvas wrapper below).
import "@/styles/excalidraw.css";
import type { WorkspaceItemNode } from "@/api/workspaces";
import {
  buildWikiHref,
  parseWikiHref,
} from "@/components/files/documents/WikiLinkExtension";
import { ErrorState } from "@/components/shared/Callout";
import { useItemPreview } from "./itemPreviewContext";
import { ItemPaneHeader } from "./ItemPaneHeader";
import { PresenceChips, usePresencePeers } from "./PresenceChips";
import { WorkspaceItemPicker } from "./WorkspaceItemPicker";
import { useCanvasCollabProvider } from "./useCanvasCollabProvider";
import { useExcalidrawCanvas } from "./useExcalidrawCanvas";
import { buildBundledLibraryItems } from "./canvas/libraries";
import { removeImageBackground } from "./canvas/backgroundRemoval";
import { canvasSceneToText } from "./canvas/sceneText";

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

// A single selected linkable element + where to float the "Link" button,
// plus whether it already carries a workspace-item link.
interface LinkSelection {
  elementId: string;
  left: number;
  top: number;
  linked: boolean;
}

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

// The board's drawing-surface colour, matched to the app ``--bg`` in each
// theme so the canvas reads as part of the app rather than Excalidraw's own
// cool white / #121212 defaults. Excalidraw needs a concrete colour string
// (no CSS vars in appState), so we resolve it per theme and re-assert it
// whenever the board theme changes. (The board uses Excalidraw's NATIVE dark
// theme — there is no invert filter.)
const CANVAS_BG_LIGHT = "#FAF9F7";
const CANVAS_BG_DARK = "#1C1917";
const bgForTheme = (t: "light" | "dark"): string =>
  t === "dark" ? CANVAS_BG_DARK : CANVAS_BG_LIGHT;

export function WorkspaceCanvasPane({
  canvasId,
  readOnly = false,
  header,
  workspaceId,
  onOpenItem,
}: {
  canvasId: string;
  /** Viewer-role access → board opens read-only. */
  readOnly?: boolean;
  /** Enables cross-item linking: a selected shape can be linked to a
   *  workspace item, and clicking that link opens the item inline. */
  workspaceId?: string;
  onOpenItem?: (node: WorkspaceItemNode) => void;
  /** When set, renders the unified ItemPaneHeader (title / ⚡ / sync
   *  status) above the canvas — the pane had zero chrome before. */
  header?: { workspaceId: string; node: WorkspaceItemNode };
}) {
  const { ydoc, provider, user, error, status } =
    useCanvasCollabProvider(canvasId);
  const presencePeers = usePresencePeers(provider);
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
        viewBackgroundColor: bgForTheme(expectedThemeRef.current),
        // Clean, mockup-matching defaults for anything drawn on a fresh
        // board: architect stroke (no sketchy roughness) + the app accent.
        currentItemRoughness: 0,
        currentItemStrokeColor: "#d97757",
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
    if (themeChanged) expectedThemeRef.current = appTheme;
    // Background follows the *effective* board theme (the override when the
    // user flipped Excalidraw's own toggle, else the app theme).
    const wantBg = bgForTheme(expectedThemeRef.current);
    const bgWrong =
      excalidrawAPI.getAppState().viewBackgroundColor !== wantBg;
    // Separate literals (not a Partial<AppState> var) so each satisfies
    // updateScene under exactOptionalPropertyTypes.
    if (themeChanged && bgWrong) {
      excalidrawAPI.updateScene({
        appState: { theme: appTheme, viewBackgroundColor: wantBg },
      });
    } else if (themeChanged) {
      excalidrawAPI.updateScene({ appState: { theme: appTheme } });
    } else if (bgWrong) {
      excalidrawAPI.updateScene({
        appState: { viewBackgroundColor: wantBg },
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
  // Item-link clicks open the shared preview modal when available (0148).
  const previewItem = useItemPreview();
  // Cross-item linking (Phase 8) — a single selected shape can be linked
  // to a workspace item. Only wired when the pane knows its workspace.
  const linkingEnabled = !readOnly && !!workspaceId && !!onOpenItem;
  const [linkSel, setLinkSel] = useState<LinkSelection | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The picker serves two flows: "link" attaches the selected shape to an
  // item (Phase 8); "insert" drops a fresh styled node bound to an item (A2).
  const [pickerMode, setPickerMode] = useState<"link" | "insert">("link");
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
        // Structured serialization (A3): labels + connection graph + linked
        // items, so workspace chats understand the board — not just a flat
        // bag of its text.
        const text = canvasSceneToText(elements).trim();
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
        // Keep the drawing surface matched to the freshly-flipped theme.
        const wantBg = bgForTheme(nextTheme);
        if (
          (appState as { viewBackgroundColor?: string }).viewBackgroundColor !==
          wantBg
        ) {
          excalidrawAPI?.updateScene({
            appState: { viewBackgroundColor: wantBg },
          });
        }
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

      // "Link to item" affordance for a single selected non-image shape.
      let linkNext: LinkSelection | null = null;
      if (linkingEnabled && picked.length === 1) {
        const el = elements.find((e) => e.id === picked[0]);
        if (el && el.type !== "image" && !el.isDeleted) {
          const p = sceneCoordsToViewportCoords(
            { sceneX: el.x + el.width, sceneY: el.y },
            appState
          );
          const rect = containerRef.current?.getBoundingClientRect();
          linkNext = {
            elementId: el.id,
            left: p.x - (rect?.left ?? 0),
            top: p.y - (rect?.top ?? 0),
            linked: !!parseWikiHref(el.link),
          };
        }
      }
      setLinkSel(linkNext);
    },
    [binding.onChange, schedulePush, readOnly, linkingEnabled]
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

  // Set (or clear) an element's link to a workspace item. Stores the same
  // relative wiki-href notes use, so Excalidraw renders its link badge and
  // ``onLinkOpen`` below can route the click back into the app.
  const setElementLink = useCallback(
    (elementId: string, href: string | null) => {
      const api = excalidrawAPI;
      if (!api || !workspaceId) return;
      const elements = api.getSceneElements().map((el) =>
        el.id === elementId ? { ...el, link: href } : el
      );
      api.updateScene({ elements });
      // Push the change through the collab binding so peers + persistence
      // see it (updateScene alone doesn't fire our onChange for this path).
      binding.onChange(
        api.getSceneElements(),
        api.getAppState(),
        api.getFiles()
      );
    },
    [excalidrawAPI, workspaceId, binding]
  );

  const handleLinkPicked = useCallback(
    (node: WorkspaceItemNode) => {
      if (!linkSel || !workspaceId) return;
      const href = buildWikiHref({
        id: node.id,
        kind: node.kind,
        refId: node.ref_id,
        title: node.title,
        workspaceId,
      });
      setElementLink(linkSel.elementId, href);
      setPickerOpen(false);
    },
    [linkSel, workspaceId, setElementLink]
  );

  // A2 — drop a first-class "item node": a clean terracotta node labelled
  // with the item's title and bound to it, created at the current viewport
  // centre. Clicking it opens the item (preview modal), so the node *is* the
  // workspace item, not just an annotation.
  const handleInsertItemNode = useCallback(
    (node: WorkspaceItemNode) => {
      const api = excalidrawAPI;
      if (!api || !workspaceId) return;
      const href = buildWikiHref({
        id: node.id,
        kind: node.kind,
        refId: node.ref_id,
        title: node.title,
        workspaceId,
      });
      const rect = containerRef.current?.getBoundingClientRect();
      const centre = viewportCoordsToSceneCoords(
        {
          clientX: (rect?.left ?? 0) + (rect?.width ?? 800) / 2,
          clientY: (rect?.top ?? 0) + (rect?.height ?? 500) / 2,
        },
        api.getAppState()
      );
      const width = 200;
      const height = 64;
      const created = convertToExcalidrawElements([
        {
          type: "rectangle",
          x: centre.x - width / 2,
          y: centre.y - height / 2,
          width,
          height,
          strokeColor: "#d97757",
          backgroundColor: "transparent",
          strokeWidth: 2,
          roughness: 0,
          roundness: { type: 3 },
          link: href,
          label: {
            text: node.title || "Untitled",
            fontSize: 16,
            strokeColor: "#d97757",
          },
        },
      ] as Parameters<typeof convertToExcalidrawElements>[0]);
      api.updateScene({
        elements: [...api.getSceneElements(), ...created],
      });
      // Push through the collab binding so peers + persistence see the node
      // (updateScene alone doesn't fire our onChange for this path).
      binding.onChange(
        api.getSceneElements(),
        api.getAppState(),
        api.getFiles()
      );
      setPickerOpen(false);
    },
    [excalidrawAPI, workspaceId, binding]
  );

  // Route a click on an element's link: workspace-item hrefs open in the
  // preview modal (falling back to inline open when no preview handler is in
  // context); anything else falls through to Excalidraw's default (new tab).
  const handleLinkOpen = useCallback(
    (
      element: { link?: string | null },
      event: { preventDefault: () => void }
    ) => {
      const parsed = parseWikiHref(element.link);
      const open = previewItem ?? onOpenItem;
      if (!parsed || !open) return;
      event.preventDefault();
      open({
        id: parsed.item,
        kind: parsed.kind as WorkspaceItemNode["kind"],
        ref_id: parsed.ref,
        title: "",
        icon: null,
        position: 0,
        indexing_status: null,
        children: [],
      });
    },
    [onOpenItem, previewItem]
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
    return <ErrorState>{error}</ErrorState>;
  }

  const canvasSurface = (
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
      {/* A2 — insert a workspace item as a first-class node. Top-right is the
          one corner Excalidraw's default UI leaves clear. */}
      {linkingEnabled && (
        <div className="absolute right-2 top-2 z-20">
          <button
            type="button"
            onClick={() => {
              setPickerMode("insert");
              setPickerOpen(true);
            }}
            title="Drop a workspace item onto the board as a linked node"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--text)] shadow-md transition hover:bg-[var(--surface-hover)]"
          >
            <Plus className="h-3.5 w-3.5" />
            Insert item
          </button>
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
      {linkSel && (
        <div
          className="absolute z-20 flex gap-1"
          style={{
            left: linkSel.left,
            top: linkSel.top,
            transform: "translate(6px, -6px)",
          }}
        >
          <button
            type="button"
            onClick={() => {
              setPickerMode("link");
              setPickerOpen(true);
            }}
            title={
              linkSel.linked
                ? "Change the linked workspace item"
                : "Link this shape to a workspace item"
            }
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-medium text-[var(--text)] shadow-md transition hover:bg-[var(--surface-hover)]"
          >
            <Link2 className="h-3.5 w-3.5" />
            {linkSel.linked ? "Linked" : "Link to item"}
          </button>
          {linkSel.linked && (
            <button
              type="button"
              onClick={() => setElementLink(linkSel.elementId, null)}
              title="Remove the link"
              aria-label="Remove link"
              className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] p-1 text-[var(--text-muted)] shadow-md transition hover:text-[var(--danger)]"
            >
              <Link2Off className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      <Excalidraw
        excalidrawAPI={setExcalidrawAPI}
        onChange={handleChange}
        onPointerUpdate={binding.onPointerUpdate}
        onLinkOpen={linkingEnabled ? handleLinkOpen : undefined}
        viewModeEnabled={readOnly}
        initialData={initialData}
      />
      {pickerOpen && workspaceId && (
        <WorkspaceItemPicker
          workspaceId={workspaceId}
          onPick={
            pickerMode === "insert" ? handleInsertItemNode : handleLinkPicked
          }
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );

  if (!header) return canvasSurface;
  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      <ItemPaneHeader
        workspaceId={header.workspaceId}
        itemId={header.node.id}
        kind="canvas"
        fallbackTitle={header.node.title}
        canEdit={!readOnly}
        status={
          <>
            <PresenceChips peers={presencePeers} />
            <CanvasSyncChip status={status} ready={binding.ready} />
          </>
        }
      />
      {canvasSurface}
    </div>
  );
}

/** Connected / Syncing / Offline chip for the canvas header — the board
 *  previously synced in total silence. */
function CanvasSyncChip({
  status,
  ready,
}: {
  status: "connecting" | "connected" | "disconnected";
  ready: boolean;
}) {
  if (status === "connected" && ready) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
        Synced live
      </span>
    );
  }
  if (status === "disconnected") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[11px] text-[var(--warning)]"
        title="Reconnecting — edits keep applying locally and sync when the connection returns"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />
        Offline
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
      <Loader2 className="h-3 w-3 animate-spin" />
      Connecting…
    </span>
  );
}
