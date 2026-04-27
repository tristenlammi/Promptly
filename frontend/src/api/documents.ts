import { apiClient } from "./client";
import type { FileItem, FileScope } from "./files";

/**
 * Client for the Drive Documents API (``/api/documents/*``).
 *
 * Drive Documents are ordinary Drive files whose blob happens to be
 * an HTML snapshot of a Y.js CRDT. All create / collab-auth /
 * inline-asset plumbing lives here so the rest of the frontend keeps
 * treating docs as plain ``FileItem`` rows.
 */

export interface DocumentCreatePayload {
  scope?: FileScope;
  folder_id?: string | null;
  /** Optional title; omitted => server picks "Untitled document". */
  name?: string | null;
}

export interface CollabTokenResponse {
  token: string;
  /** Unix seconds; the editor schedules a refresh a few seconds before. */
  expires_at: number;
  user: {
    id: string;
    name: string;
    color: string;
  };
}

export interface DocumentAsset {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  /** Authenticated ``/api/files/{id}/download`` path. Embed as ``src``. */
  url: string;
}

export const documentsApi = {
  async create(payload: DocumentCreatePayload = {}): Promise<FileItem> {
    const { data } = await apiClient.post<FileItem>("/documents", payload);
    return data;
  },

  async getCollabToken(documentId: string): Promise<CollabTokenResponse> {
    const { data } = await apiClient.get<CollabTokenResponse>(
      `/documents/${documentId}/collab-token`
    );
    return data;
  },

  async uploadAsset(documentId: string, file: File): Promise<DocumentAsset> {
    const form = new FormData();
    form.append("file", file);
    // ``apiClient`` sets ``Content-Type: application/json`` as a default
    // header on the instance. Axios honours that even when the body is
    // a FormData, so without explicitly overriding the header here the
    // backend sees ``application/json`` for a multipart payload and
    // returns 422 with "Field required: file". Setting it to
    // ``multipart/form-data`` (no boundary) tells axios to fill in the
    // boundary itself — same pattern already used by ``filesApi.upload``.
    const { data } = await apiClient.post<DocumentAsset>(
      `/documents/${documentId}/assets`,
      form,
      {
        headers: { "Content-Type": "multipart/form-data" },
        // Inline asset uploads can be larger images / audio clips —
        // bump the per-request timeout so a slow connection doesn't
        // abort a 10 MB paste before it lands.
        timeout: 120_000,
      }
    );
    return data;
  },
};
