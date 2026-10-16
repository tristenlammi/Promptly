import { apiClient } from "./client";
import type { CollabTokenResponse } from "./documents";
import type { FileItem } from "./files";
import type { SheetVersion, SpreadsheetData } from "./workspaces";

/**
 * Office files opened from Files (WP-3.4): Documents, Spreadsheets and
 * Whiteboards that belong to a person rather than a workspace, plus the
 * file-scoped spreadsheet API the sheet editor uses when it isn't inside
 * a workspace.
 */
export type OfficeKind = "document" | "sheet" | "whiteboard";

export interface OfficeEditorInfo {
  kind: OfficeKind;
  access: "read" | "comment" | "edit";
  workspace_id: string | null;
  workspace_title: string | null;
  item_id: string | null;
  /** The sheet / canvas id behind the file (null for a document). */
  content_id: string | null;
  is_owner: boolean;
  /** Folder trail from My files down (owner only). */
  path: { id: string; name: string }[];
  file: FileItem;
}

export interface OfficeTemplate {
  id: string;
  kind: OfficeKind;
  title: string;
  modified_at: string | null;
}

/** ``/files/doc/<id>``, ``/files/sheet/<id>``, ``/files/whiteboard/<id>``. */
export function officeEditorPath(file: Pick<FileItem, "id" | "source_kind">): string | null {
  const seg =
    file.source_kind === "document"
      ? "doc"
      : file.source_kind === "sheet"
        ? "sheet"
        : file.source_kind === "whiteboard"
          ? "whiteboard"
          : null;
  return seg ? `/files/${seg}/${file.id}` : null;
}

/** A spreadsheet converted for a sheet, plus what didn't come across. */
export interface SheetImportResult {
  data: unknown[];
  notes: string[];
}

export const officeApi = {
  async create(payload: {
    kind?: OfficeKind;
    title?: string;
    folder_id?: string | null;
    template_id?: string;
  }): Promise<FileItem> {
    const { data } = await apiClient.post<FileItem>("/files/office", payload);
    return data;
  },
  /** A presentation (Stage 12): a whiteboard in slide mode — opened with
   *  ``?slides=new``, the editor turns slide mode on with a first slide. */
  async createPresentation(folderId?: string | null): Promise<{ file: FileItem; path: string }> {
    const { data } = await apiClient.post<FileItem>("/files/office", { kind: "whiteboard", title: "Untitled presentation", folder_id: folderId ?? null });
    return { file: data, path: `/files/whiteboard/${data.id}?slides=new` };
  },

  async info(fileId: string): Promise<OfficeEditorInfo> {
    const { data } = await apiClient.get<OfficeEditorInfo>(`/files/${fileId}/office`);
    return data;
  },

  async templates(): Promise<{ folder_id: string; templates: OfficeTemplate[] }> {
    const { data } = await apiClient.get<{ folder_id: string; templates: OfficeTemplate[] }>(
      "/files/templates"
    );
    return data;
  },

  async saveAsTemplate(fileId: string): Promise<FileItem> {
    const { data } = await apiClient.post<FileItem>(`/files/${fileId}/save-as-template`);
    return data;
  },

  async collabToken(fileId: string): Promise<CollabTokenResponse> {
    const { data } = await apiClient.post<CollabTokenResponse>(`/files/${fileId}/collab-token`);
    return data;
  },

  /** A whiteboard's grid thumbnail (PNG, re-encoded server-side). */
  async pushThumbnail(fileId: string, png: Blob): Promise<void> {
    const form = new FormData();
    form.append("file", png, "thumbnail.png");
    await apiClient.put(`/files/${fileId}/thumbnail`, form, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 15_000,
    });
  },

  // ---- file-scoped spreadsheet routes -----------------------------
  async getSheet(fileId: string): Promise<SpreadsheetData> {
    const { data } = await apiClient.get<SpreadsheetData>(`/files/${fileId}/sheet`);
    return data;
  },
  async saveSheet(
    fileId: string,
    payload: { data: unknown; content_text?: string; title?: string; data_version?: number }
  ): Promise<SpreadsheetData> {
    const { data } = await apiClient.put<SpreadsheetData>(`/files/${fileId}/sheet`, payload);
    return data;
  },
  async importSheet(fileId: string, file: File): Promise<SheetImportResult> {
    const form = new FormData();
    form.append("file", file);
    const { data } = await apiClient.post<SheetImportResult>(`/files/${fileId}/sheet/import`, form, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 120_000,
    });
    return { data: data.data, notes: data.notes ?? [] };
  },
  /** "Open in Promptly Sheets": a new sheet made from an uploaded .xlsx /
   *  .ods / .csv, next to it (WP-4.4). */
  async openAsSheet(sourceFileId: string): Promise<{ file: FileItem; path: string; notes: string[] }> {
    const { data } = await apiClient.post<{ file: FileItem; path: string; notes: string[] }>(
      "/files/office/import-sheet",
      { source_file_id: sourceFileId },
      { timeout: 120_000 }
    );
    return data;
  },
  async exportSheet(
    fileId: string,
    format: "xlsx" | "csv",
    tab = 0
  ): Promise<{ blob: Blob; filename: string }> {
    const res = await apiClient.get(`/files/${fileId}/sheet/export`, {
      params: { format, tab },
      responseType: "blob",
    });
    const cd = String(res.headers["content-disposition"] ?? "");
    const m = /filename="([^"]+)"/.exec(cd);
    return { blob: res.data as Blob, filename: m?.[1] ?? `sheet.${format}` };
  },
  async sheetVersions(fileId: string): Promise<SheetVersion[]> {
    const { data } = await apiClient.get<SheetVersion[]>(`/files/${fileId}/sheet/versions`);
    return data;
  },
  async sheetVersion(fileId: string, versionId: string): Promise<unknown[]> {
    const { data } = await apiClient.get<{ data: unknown[] }>(
      `/files/${fileId}/sheet/versions/${versionId}`
    );
    return data.data;
  },
  async checkpointSheet(fileId: string, reason: "restore" | "clear"): Promise<void> {
    await apiClient.post(`/files/${fileId}/sheet/versions/checkpoint`, null, { params: { reason } });
  },
};
