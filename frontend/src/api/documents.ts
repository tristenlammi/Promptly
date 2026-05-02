import { apiClient } from "./client";
import type { FileItem, FileScope } from "./files";

/** Output formats supported by ``GET /api/documents/:id/download``. */
export type DocumentDownloadFormat = "html" | "md" | "pdf";

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

  /** Persist the editor's current HTML straight to the file blob.
   *
   *  Bypasses the Hocuspocus collab snapshot pipeline so the user
   *  can hit "Save now" explicitly *and* recover from a misbehaving
   *  WebSocket path (Cloudflare tunnel, stopped collab container,
   *  proxy buffering — typical symptom is the file silently staying
   *  at 0 bytes). The backend re-runs the same HTML sanitiser as
   *  the snapshot endpoint, so a hostile client can't smuggle extra
   *  HTML through this side door. Returns the freshly-saved
   *  ``FileItem`` so the caller can refresh its size + updated_at.
   */
  async manualSave(documentId: string, html: string): Promise<FileItem> {
    const { data } = await apiClient.post<FileItem>(
      `/documents/${documentId}/save`,
      { html }
    );
    return data;
  },

  /** Download the document in the requested format.
   *
   *  Returns a ``Blob`` so the caller can trigger a browser save
   *  via an object URL. ``html`` is the canonical export (just the
   *  on-disk blob), ``md`` runs through markdownify on the server,
   *  ``pdf`` renders via xhtml2pdf. The backend always sets
   *  ``Content-Disposition: attachment``.
   */
  async download(
    documentId: string,
    format: DocumentDownloadFormat
  ): Promise<{ blob: Blob; filename: string }> {
    const { data, headers } = await apiClient.get<Blob>(
      `/documents/${documentId}/download`,
      {
        params: { format },
        responseType: "blob",
      }
    );
    // RFC 6266 ``filename="..."`` plus optional ``filename*=UTF-8''…``
    // for non-ASCII. We reach for the ``*`` variant when present so
    // emoji + non-Latin characters round-trip cleanly.
    const dispo = String(headers["content-disposition"] ?? "");
    let filename = `document.${format === "md" ? "md" : format}`;
    const utf8Match = dispo.match(/filename\*=UTF-8''([^;]+)/i);
    const plainMatch = dispo.match(/filename="([^"]+)"/i);
    if (utf8Match) {
      try {
        filename = decodeURIComponent(utf8Match[1]);
      } catch {
        if (plainMatch) filename = plainMatch[1];
      }
    } else if (plainMatch) {
      filename = plainMatch[1];
    }
    return { blob: data, filename };
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
