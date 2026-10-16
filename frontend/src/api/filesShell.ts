import { apiClient } from "./client";
import type { FileItem } from "./files";

/** Reads behind the Files shell (WP-3.5, Part C §2.2). */

export interface WorkspaceDriveEntry {
  file: FileItem;
  /** "note" / "sheet" / "canvas" — a workspace item; "pinned" — a pinned file. */
  item_kind: "note" | "sheet" | "canvas" | "pinned";
  item_id: string | null;
}

export interface WorkspaceDriveListing {
  workspace_id: string;
  title: string;
  role: string;
  entries: WorkspaceDriveEntry[];
}

export interface FileDetails {
  id: string;
  owner_id: string | null;
  owner_name: string | null;
  is_owner: boolean;
  location: string;
  folder_id: string | null;
  workspace_id: string | null;
  workspace_title: string | null;
  created_at: string;
  modified_at: string | null;
  size_bytes: number;
  versions: number;
}

export interface StorageBreakdown {
  cap_bytes: number | null;
  used_bytes: number;
  files_bytes: number;
  trash_bytes: number;
  office_pending_bytes: number;
  versions_bytes: number;
  /** Versions count toward storage from ``versions_counted_from`` (WP-6.2). */
  versions_counted?: boolean;
  versions_counted_from?: string | null;
  last_backup_at: string | null;
  last_offsite_at: string | null;
}

export interface FileTextResponse {
  text: string | null;
  pending: boolean;
  /** A faithful PDF of it (the ``convert`` profile, Stage 12): asking
   *  starts one; null when the server doesn't make them. */
  preview?: "ready" | "pending" | "failed" | null;
}

/** Ask your Drive — opt-in, exclusions and progress (WP-5.1). */
/** How chats use your files (WP-5.2): ``auto`` — when a question is about
 *  them; ``always`` — every reply looks first; ``off`` — chats don't. */
export type DriveChatMode = "auto" | "always" | "off";

export interface DriveAiStatus {
  enabled: boolean;
  excluded_folder_ids: string[];
  chat_mode: DriveChatMode;
  excluded_folders: { id: string; name: string }[];
  /** "Provider · model", or null when no embedder is set up. */
  embedder: string | null;
  eligible: number;
  indexed: number;
  skipped: number;
  failed: number;
  pending: number;
}

/** An uploaded spreadsheet's top-left corner, as Fortune tabs (WP-4.4). */
export interface SheetPreviewResponse {
  tabs: unknown[];
  truncated: boolean;
  notes: string[];
}

export const filesShellApi = {
  async driveAi(): Promise<DriveAiStatus> {
    const { data } = await apiClient.get<DriveAiStatus>("/files/ai-index");
    return data;
  },
  async setDriveAi(body: {
    enabled: boolean;
    excluded_folder_ids: string[];
    chat_mode?: DriveChatMode;
  }): Promise<DriveAiStatus> {
    const { data } = await apiClient.put<DriveAiStatus>("/files/ai-index", body);
    return data;
  },
  async sheetPreview(fileId: string): Promise<SheetPreviewResponse> {
    const { data } = await apiClient.get<SheetPreviewResponse>(`/files/${fileId}/sheet-preview`, { timeout: 60_000 });
    return data;
  },
  /** The PDF the converter made of an Office file (Stage 12). */
  async officePdf(fileId: string): Promise<ArrayBuffer> {
    const { data } = await apiClient.get<ArrayBuffer>(`/files/${fileId}/office-preview`, { responseType: "arraybuffer", timeout: 60_000 });
    return data;
  },
  /** An uploaded file's extracted text (Office outline preview). */
  async text(fileId: string): Promise<FileTextResponse> {
    const { data } = await apiClient.get<FileTextResponse>(`/files/${fileId}/text`);
    return data;
  },
  async workspaceDrive(workspaceId: string): Promise<WorkspaceDriveListing> {
    const { data } = await apiClient.get<WorkspaceDriveListing>(`/files/workspaces/${workspaceId}`);
    return data;
  },
  async details(fileId: string): Promise<FileDetails> {
    const { data } = await apiClient.get<FileDetails>(`/files/${fileId}/details`);
    return data;
  },
  async storage(): Promise<StorageBreakdown> {
    const { data } = await apiClient.get<StorageBreakdown>("/files/storage");
    return data;
  },
};
