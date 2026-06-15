import { useCallback, useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { Tldraw, type Editor } from "tldraw";
import "tldraw/tldraw.css";

import { canvasApi } from "@/api/canvas";
import { useCanvasCollabProvider } from "./useCanvasCollabProvider";
import { useYjsCanvasStore } from "./useYjsCanvasStore";

/**
 * Live, multiplayer tldraw board for a workspace canvas item.
 *
 * Mirrors the document collab path: a Hocuspocus provider feeds a shared
 * ``Y.Doc``; ``useYjsCanvasStore`` binds a tldraw ``TLStore`` to it (shapes
 * + presence). The board's flattened text is pushed back to the backend on
 * a 1.5s debounce so workspace RAG stays grounded in the canvas.
 *
 * The container is ``h-full`` + ``relative`` because tldraw fills its
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
  const storeWithStatus = useYjsCanvasStore({ ydoc, provider, user });

  const editorRef = useRef<Editor | null>(null);
  const debounceRef = useRef<number | null>(null);
  // Keep the last text we pushed so we skip no-op POSTs on cosmetic edits
  // (moving a shape doesn't change its text).
  const lastTextRef = useRef<string>("");

  // Flatten every text-bearing shape on the current page into one blob.
  // tldraw text / note / geo shapes carry their label under ``props.text``.
  const extractText = useCallback((editor: Editor): string => {
    const shapes = editor.getCurrentPageShapes();
    const parts: string[] = [];
    for (const shape of shapes) {
      const props = shape.props as { text?: unknown };
      if (typeof props.text === "string" && props.text.trim()) {
        parts.push(props.text.trim());
      }
    }
    return parts.join("\n");
  }, []);

  const schedulePush = useCallback(
    (editor: Editor) => {
      if (readOnly) return;
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        const text = extractText(editor);
        if (text === lastTextRef.current) return;
        lastTextRef.current = text;
        void canvasApi.updateText(canvasId, text).catch(() => {
          // Best-effort; a failed RAG sync shouldn't disrupt drawing.
        });
      }, TEXT_DEBOUNCE_MS);
    },
    [canvasId, extractText, readOnly]
  );

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;
      editor.updateInstanceState({ isReadonly: readOnly });

      // Push text whenever the document changes (debounced). We listen on
      // ``document`` scope so presence/cursor churn doesn't trip the push.
      const unlisten = editor.store.listen(
        () => schedulePush(editor),
        { scope: "document" }
      );
      // Seed an initial push so a freshly-opened board with prior content
      // re-grounds RAG even if nothing is edited this session.
      schedulePush(editor);

      return () => {
        unlisten();
      };
    },
    [readOnly, schedulePush]
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

  // Gate on the store being bound, not the live socket: once tldraw is up
  // we keep it mounted across transient disconnects (Yjs buffers + resyncs
  // on reconnect), so a blip doesn't blow away the user's view/selection.
  const ready = storeWithStatus.status === "synced-remote";

  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10 text-sm text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Connecting canvas…
        </span>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0 flex-1">
      <Tldraw store={storeWithStatus} onMount={handleMount} />
    </div>
  );
}
