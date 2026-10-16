import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "@/styles/excalidraw.css";

/** A shared whiteboard, view-only (WP-3.4) — the scene from the share
 *  link, no collab connection. Lazy-loaded by ``SharedOfficeView``. */
export function SharedWhiteboardCanvas({
  scene,
}: {
  scene: { elements?: unknown[]; files?: Record<string, unknown> };
}) {
  return (
    <div className="absolute inset-0">
      <Excalidraw
        viewModeEnabled
        initialData={{
          // The server sends live elements straight from the board.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          elements: (scene.elements ?? []) as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          files: (scene.files ?? {}) as any,
          appState: { viewBackgroundColor: "#ffffff", theme: "light" },
          scrollToContent: true,
        }}
        UIOptions={{ canvasActions: { export: false, loadScene: false, saveToActiveFile: false } }}
      />
    </div>
  );
}
