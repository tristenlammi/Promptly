import { apiClient } from "./client";
import { filesApi } from "./files";

/** The PDF viewer's load and save (WP-6.5). */
export interface PdfInfo {
  can_edit: boolean;
  revision: string;
}

export interface PdfSaved {
  revision: string;
  size_bytes: number;
  version_id: string;
  modified_at: string;
}

export const pdfApi = {
  /** The bytes, and which revision they are (sent back on save). */
  async load(fileId: string): Promise<{ data: ArrayBuffer; revision: string | null }> {
    const res = await apiClient.get<ArrayBuffer>(filesApi.downloadUrl(fileId).replace(/^\/api/, ""), {
      responseType: "arraybuffer",
      timeout: 120_000,
    });
    return { data: res.data, revision: (res.headers["x-file-revision"] as string | undefined) ?? null };
  },

  async info(fileId: string): Promise<PdfInfo> {
    const { data } = await apiClient.get<PdfInfo>(`/files/${fileId}/pdf`);
    return data;
  },

  /** Save as the PDF's new content; what it replaces becomes a version. A
   *  409 means someone saved since ``revision`` was loaded. */
  async save(fileId: string, bytes: Uint8Array, revision: string): Promise<PdfSaved> {
    const form = new FormData();
    form.append("file", new Blob([bytes as BlobPart], { type: "application/pdf" }), "document.pdf");
    form.append("revision", revision);
    const { data } = await apiClient.put<PdfSaved>(`/files/${fileId}/pdf`, form, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 180_000,
    });
    return data;
  },
};
