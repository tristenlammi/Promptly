import { apiClient } from "./client";

/** Version history of an office file (WP-6.2). */
export interface VersionAuthor {
  id: string;
  username: string;
}

export interface FileVersionRow {
  id: string;
  created_at: string;
  /** auto · manual · restore · import · pre_ai · shrink_guard · edit ·
   *  upload · generated · dav */
  source: string;
  label: string | null;
  keep_forever: boolean;
  size_bytes: number;
  authors: VersionAuthor[];
  /** An uploaded file's version: a signed link to its bytes (WP-8.1). */
  download_url?: string | null;
}

export interface VersionList {
  versions: FileVersionRow[];
  can_edit: boolean;
  kind: "document" | "sheet" | "whiteboard" | "pdf" | "blob";
}

/** What restoring a version would change ("before" = that version, "after" = now). */
export type VersionDiff =
  | {
      kind: "document";
      lines: { op: "same" | "add" | "del" | "skip"; text: string }[];
      added: number;
      removed: number;
      truncated: boolean;
    }
  | {
      /** An uploaded PDF saved from the viewer (WP-6.5): its text, and pages. */
      kind: "pdf";
      lines: { op: "same" | "add" | "del" | "skip"; text: string }[];
      added: number;
      removed: number;
      truncated: boolean;
      pages_before: number;
      pages_after: number;
      same_bytes: boolean;
    }
  | {
      kind: "sheet";
      cells: { tab: string; ref: string; before: string | null; after: string | null }[];
      changed: number;
      truncated: boolean;
      tabs_added: string[];
      tabs_removed: string[];
    }
  | {
      /** Any other uploaded file (WP-8.1): lines for text, else sizes. */
      kind: "blob";
      same_bytes: boolean;
      size_before: number;
      size_after: number;
      lines?: { op: "same" | "add" | "del" | "skip"; text: string }[];
      added?: number;
      removed?: number;
      truncated?: boolean;
    }
  | {
      kind: "whiteboard";
      added: string[];
      removed: string[];
      changed: string[];
      counts: { added: number; removed: number; changed: number };
    };

export const versionsApi = {
  async list(fileId: string): Promise<VersionList> {
    const { data } = await apiClient.get<VersionList>(`/files/${fileId}/versions`);
    return data;
  },
  async diff(fileId: string, versionId: string): Promise<VersionDiff> {
    const { data } = await apiClient.get<VersionDiff>(`/files/${fileId}/versions/${versionId}/diff`, {
      timeout: 60_000,
    });
    return data;
  },
  async update(fileId: string, versionId: string, body: { label?: string | null; keep_forever?: boolean }) {
    const { data } = await apiClient.patch<FileVersionRow>(`/files/${fileId}/versions/${versionId}`, body);
    return data;
  },
  async restore(fileId: string, versionId: string): Promise<{ ok: boolean; epoch: number }> {
    const { data } = await apiClient.post(`/files/${fileId}/versions/${versionId}/restore`, undefined, {
      timeout: 60_000,
    });
    return data;
  },
  async saveNow(fileId: string, label: string | null): Promise<void> {
    await apiClient.post(`/files/${fileId}/versions`, { source: "manual", label });
  },
};
