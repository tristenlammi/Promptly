import type { CollabTokenResponse } from "@/api/documents";
import { officeApi } from "@/api/office";
import { workspacesApi, type SheetVersion, type SpreadsheetData } from "@/api/workspaces";

/**
 * Where the sheet editor loads and saves (WP-3.4). Inside a workspace it
 * talks to ``/api/workspaces/{ws}/spreadsheets/{id}``; opened from Files
 * it talks to ``/api/files/{fileId}/sheet`` — same contract, answered by
 * the file's access instead of a workspace role.
 */
export interface SheetBackend {
  /** Stable identity — effects re-run when it changes. */
  key: string;
  /** The sheet id (the collab room is ``sheet:<id>``). */
  sheetId: string;
  get(): Promise<SpreadsheetData>;
  save(payload: {
    data: unknown;
    content_text?: string;
    title?: string;
    data_version?: number;
  }): Promise<SpreadsheetData>;
  checkpoint(reason: "restore" | "clear"): Promise<void>;
  importFile(file: File): Promise<{ data: unknown[]; notes: string[] }>;
  exportFile(format: "xlsx" | "csv", tab?: number): Promise<{ blob: Blob; filename: string }>;
  versions(): Promise<SheetVersion[]>;
  version(versionId: string): Promise<unknown[]>;
  collabToken(): Promise<CollabTokenResponse>;
}

export function workspaceSheetBackend(workspaceId: string, sheetId: string): SheetBackend {
  return {
    key: `ws:${workspaceId}:${sheetId}`,
    sheetId,
    get: () => workspacesApi.getSpreadsheet(workspaceId, sheetId),
    save: (payload) => workspacesApi.saveSpreadsheet(workspaceId, sheetId, payload),
    checkpoint: (reason) => workspacesApi.checkpointSpreadsheet(workspaceId, sheetId, reason),
    importFile: (file) => workspacesApi.importIntoSpreadsheet(workspaceId, sheetId, file),
    exportFile: (format, tab) => workspacesApi.exportSpreadsheet(workspaceId, sheetId, format, tab),
    versions: () => workspacesApi.spreadsheetVersions(workspaceId, sheetId),
    version: (versionId) => workspacesApi.spreadsheetVersion(workspaceId, sheetId, versionId),
    collabToken: () => workspacesApi.getSheetCollabToken(workspaceId, sheetId),
  };
}

export function fileSheetBackend(fileId: string, sheetId: string): SheetBackend {
  return {
    key: `file:${fileId}`,
    sheetId,
    get: () => officeApi.getSheet(fileId),
    save: (payload) => officeApi.saveSheet(fileId, payload),
    checkpoint: (reason) => officeApi.checkpointSheet(fileId, reason),
    importFile: (file) => officeApi.importSheet(fileId, file),
    exportFile: (format, tab) => officeApi.exportSheet(fileId, format, tab),
    versions: () => officeApi.sheetVersions(fileId),
    version: (versionId) => officeApi.sheetVersion(fileId, versionId),
    collabToken: () => officeApi.collabToken(fileId),
  };
}
