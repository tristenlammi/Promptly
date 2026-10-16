import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import type { FrameLike } from "./deck";

/** One slide as a picture: the frame and what's in it, on white, clipped
 *  to the frame (Excalidraw's own frame export). */
export async function renderSlide(
  api: ExcalidrawImperativeAPI,
  frame: FrameLike,
  maxWidthOrHeight: number,
): Promise<HTMLCanvasElement> {
  const { exportToCanvas } = await import("@excalidraw/excalidraw");
  // Text drawn before its font has loaded comes out blank.
  await document.fonts?.ready;
  const elements = api.getSceneElements();
  const appState = api.getAppState();
  return exportToCanvas({
    elements: elements.filter((e) => e.id === frame.id || e.frameId === frame.id),
    appState: { ...appState, exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false, frameRendering: { ...appState.frameRendering, outline: false, name: false } },
    files: api.getFiles(),
    exportingFrame: frame as never,
    exportPadding: 0,
    maxWidthOrHeight,
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png", quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("couldn't render the slide"))), type, quality),
  );
}
