import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  BinaryFileData,
} from "@excalidraw/excalidraw/types";

import { canvasApi } from "@/api/canvas";

/**
 * Background removal for a canvas image, applied in place.
 *
 * The selected image's bytes (already in Excalidraw's file store) are
 * POSTed to the backend, which runs rembg server-side and returns a
 * transparent PNG. We repoint the element at the cut-out — keeping its
 * position and size — and bump its version so the change records in
 * Excalidraw's undo history and propagates through the Yjs collab binding.
 */

const blobToDataURL = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export async function removeImageBackground(
  api: ExcalidrawImperativeAPI,
  elementId: string,
  fileId: string
): Promise<void> {
  const file = api.getFiles()[fileId];
  if (!file?.dataURL) throw new Error("Image data unavailable.");

  // The image is held as a data: URL; turn it back into bytes to upload.
  const inputBlob = await (await fetch(file.dataURL)).blob();
  const cutout = await canvasApi.removeBackground(inputBlob);
  const dataURL = await blobToDataURL(cutout);

  const newFileId = `bgremoved_${Math.random().toString(36).slice(2)}`;
  api.addFiles([
    {
      id: newFileId,
      mimeType: "image/png",
      dataURL,
      created: Date.now(),
    } as BinaryFileData,
  ]);

  const next = api.getSceneElementsIncludingDeleted().map((el) =>
    el.id === elementId
      ? ({
          ...el,
          fileId: newFileId,
          version: el.version + 1,
          versionNonce: (el.versionNonce + 1) >>> 0,
        } as typeof el)
      : el
  );
  api.updateScene({
    elements: next,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}
