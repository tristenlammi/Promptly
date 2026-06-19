import { apiClient } from "./client";
import type { CollabTokenResponse } from "./documents";

/**
 * Client for the multiplayer Canvas API (``/api/canvas/*``).
 *
 * A canvas is an Excalidraw board whose state lives in a Yjs CRDT, synced over
 * the same Hocuspocus stack as Drive Documents. The board's flattened text
 * is pushed back to the backend on a debounce so workspace RAG stays
 * grounded in what the canvas says.
 *
 * The collab token shape is identical to the document one, so we reuse
 * ``CollabTokenResponse`` rather than re-declaring it.
 */

export interface CanvasMetadata {
  id: string;
  workspace_id: string;
  title: string;
}

export const canvasApi = {
  /** Short-lived JWT + presence identity (name + colour) for the
   *  Hocuspocus ``canvas:<id>`` room. Same contract as documents. */
  async getCollabToken(canvasId: string): Promise<CollabTokenResponse> {
    const { data } = await apiClient.get<CollabTokenResponse>(
      `/canvas/${canvasId}/collab-token`
    );
    return data;
  },

  /** Push the board's flattened text so the workspace RAG index stays
   *  in sync with the canvas. Debounced by the caller; returns 204. */
  async updateText(canvasId: string, text: string): Promise<void> {
    await apiClient.post(`/canvas/${canvasId}/text`, { text });
  },

  /** Lightweight metadata (id / workspace / title). */
  async get(canvasId: string): Promise<CanvasMetadata> {
    const { data } = await apiClient.get<CanvasMetadata>(
      `/canvas/${canvasId}`
    );
    return data;
  },

  /** Run server-side background removal on an image, returning the
   *  transparent PNG cut-out. The image bytes never leave the user's own
   *  backend (rembg runs there). */
  async removeBackground(image: Blob): Promise<Blob> {
    const form = new FormData();
    form.append("file", image, "image.png");
    const { data } = await apiClient.post<Blob>(
      `/canvas/remove-background`,
      form,
      {
        // apiClient defaults to application/json — override so the backend
        // parses the multipart upload (same pattern as the other uploads).
        headers: { "Content-Type": "multipart/form-data" },
        responseType: "blob",
      }
    );
    return data;
  },
};
