import {
  Suspense,
  forwardRef,
  lazy,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, Loader2 } from "lucide-react";

import { studyApi } from "@/api/study";
import type { ExcalidrawSnapshot } from "@/api/types";
import { cn } from "@/utils/cn";

// Excalidraw is ~1MB; lazy-load it so the Study project list stays snappy.
const Excalidraw = lazy(async () => {
  const mod = await import("@excalidraw/excalidraw");
  return { default: mod.Excalidraw };
});

interface NotesCanvasProps {
  sessionId: string;
  initialSnapshot: ExcalidrawSnapshot | null;
  /** Hidden panes should NOT render the Excalidraw component — it's heavy
   *  and resizing it while hidden triggers layout thrash. We use ``visible``
   *  as a hint but keep the mounted instance alive to preserve scene state. */
  visible: boolean;
}

export interface NotesCanvasHandle {
  /** Export the current scene as a base64-encoded PNG data URL, or null if
   *  the scene is empty / Excalidraw isn't ready. */
  exportPngBase64: () => Promise<string | null>;
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

/** Debounce delay for auto-saving the whiteboard. Per §7.4 / §13. */
const AUTO_SAVE_MS = 30_000;

/**
 * Thin wrapper around Excalidraw. Handles:
 *   - Debounced auto-save of the scene JSON to the study session.
 *   - Flush-on-unmount so we never lose work.
 *   - Imperative PNG export (used at submit time).
 */
export const NotesCanvas = forwardRef<NotesCanvasHandle, NotesCanvasProps>(
  function NotesCanvas({ sessionId, initialSnapshot, visible }, ref) {
    const [status, setStatus] = useState<SaveStatus>("idle");
    const saveTimerRef = useRef<number | null>(null);
    const latestSceneRef = useRef<ExcalidrawSnapshot | null>(null);
    const isDirtyRef = useRef(false);
    const apiRef = useRef<unknown>(null);

    // Excalidraw calls `.forEach` on `initialData.elements` on mount
    // and crashes hard if it's anything other than a real array
    // (``TypeError: I.forEach is not a function``). Older saved sessions
    // can have a snapshot with a missing/null/object-shaped ``elements``
    // field, and we've also seen the backend return ``{}`` when the
    // student never drew anything — so we normalise here instead of
    // passing the raw blob through.
    const initialData = useMemo(() => {
      if (!initialSnapshot || typeof initialSnapshot !== "object") {
        return undefined;
      }
      const raw = initialSnapshot as {
        elements?: unknown;
        appState?: unknown;
        files?: unknown;
      };
      const elements = Array.isArray(raw.elements) ? raw.elements : [];
      const appState =
        raw.appState && typeof raw.appState === "object" ? raw.appState : {};
      const files =
        raw.files && typeof raw.files === "object" ? raw.files : {};
      // Excalidraw treats an undefined initialData the same as empty,
      // so when the normalised scene is empty we return undefined to
      // skip one mount-time pass through its scene importer.
      if (elements.length === 0 && Object.keys(files).length === 0) {
        return undefined;
      }
      return { elements, appState, files } as ExcalidrawSnapshot;
    }, [initialSnapshot]);

    const persist = useCallback(
      async (snapshot: ExcalidrawSnapshot) => {
        setStatus("saving");
        try {
          await studyApi.updateWhiteboard(sessionId, snapshot);
          isDirtyRef.current = false;
          setStatus("saved");
          window.setTimeout(() => {
            setStatus((s) => (s === "saved" ? "idle" : s));
          }, 1500);
        } catch {
          setStatus("error");
        }
      },
      [sessionId]
    );

    const scheduleSave = useCallback(() => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        const snap = latestSceneRef.current;
        if (snap && isDirtyRef.current) {
          void persist(snap);
        }
      }, AUTO_SAVE_MS);
    }, [persist]);

    useEffect(() => {
      return () => {
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        if (isDirtyRef.current && latestSceneRef.current) {
          void studyApi.updateWhiteboard(sessionId, latestSceneRef.current);
        }
      };
    }, [sessionId]);

    const handleChange = useCallback(
      (elements: unknown, appState: unknown, files: unknown) => {
        latestSceneRef.current = { elements, appState, files } as ExcalidrawSnapshot;
        isDirtyRef.current = true;
        scheduleSave();
      },
      [scheduleSave]
    );

    useImperativeHandle(
      ref,
      () => ({
        async exportPngBase64() {
          const snap = latestSceneRef.current;
          const elements = Array.isArray(
            (snap as { elements?: unknown } | null)?.elements
          )
            ? ((snap as { elements: unknown[] }).elements as unknown[])
            : [];
          if (elements.length === 0) return null;
          try {
            const mod = await import("@excalidraw/excalidraw");
            const blob = await mod.exportToBlob({
              elements: elements as Parameters<typeof mod.exportToBlob>[0]["elements"],
              appState: (snap as { appState?: unknown })?.appState as Parameters<
                typeof mod.exportToBlob
              >[0]["appState"],
              files: (snap as { files?: unknown })?.files as Parameters<
                typeof mod.exportToBlob
              >[0]["files"],
              mimeType: "image/png",
            });
            if (!blob) return null;
            return await blobToBase64(blob);
          } catch (err) {
            // Swallow — submission still works without a snapshot attachment.
            console.warn("Failed to export whiteboard PNG", err);
            return null;
          }
        },
      }),
      []
    );

    return (
      <div
        className={cn(
          "relative flex h-full w-full flex-col",
          !visible && "invisible pointer-events-none"
        )}
        aria-hidden={!visible}
      >
        <div className="flex items-center justify-end border-b border-[var(--border)] px-4 py-1.5 text-xs text-[var(--text-muted)]">
          <StatusBadge status={status} />
        </div>
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full w-full items-center justify-center text-sm text-[var(--text-muted)]">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading whiteboard...
              </div>
            }
          >
            <div className="h-full w-full">
              <Excalidraw
                initialData={initialData}
                onChange={handleChange}
                excalidrawAPI={(api: unknown) => {
                  apiRef.current = api;
                }}
                UIOptions={{
                  canvasActions: {
                    loadScene: false,
                    export: false,
                    saveAsImage: true,
                  },
                }}
              />
            </div>
          </Suspense>
        </div>
      </div>
    );
  }
);

function StatusBadge({ status }: { status: SaveStatus }) {
  if (status === "idle") {
    return <span className="opacity-60">Auto-saves every 30s</span>;
  }
  if (status === "saving") {
    return (
      <span className="inline-flex items-center gap-1">
        <Loader2 className="h-3 w-3 animate-spin" /> Saving...
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--accent)]">
        <Check className="h-3 w-3" /> Saved
      </span>
    );
  }
  return (
    <span className="text-red-500 dark:text-red-400">
      Couldn't save whiteboard
    </span>
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Unexpected FileReader result"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}
