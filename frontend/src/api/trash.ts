import { apiClient } from "./client";

/** What a trash row stands for — how restore / delete forever find it. */
export type TrashType =
  | "file"
  | "folder"
  | "workspace"
  | "workspace_item"
  | "entry"
  // An app's Undo only knows what it deleted: these take the thing's own id.
  | "calendar_event"
  | "album"
  | "task"
  | "contact"
  // A note in Notes (trashed in place, by its id).
  | "note";

export type TrashApp = "drive" | "photos" | "apps" | "workspaces" | "calendar" | "tasks" | "contacts" | "notes" | string;

export interface TrashItem {
  type: TrashType;
  id: string;
  app: TrashApp;
  kind: string;
  title: string;
  deleted_at: string;
  expires_at: string;
  location: string;
  workspace_id?: string | null;
  /** Nested items that ride along (a workspace folder's contents). */
  count?: number;
  mime_type?: string | null;
  size_bytes?: number | null;
}

export interface TrashRef {
  type: TrashType;
  id: string;
  workspace_id?: string | null;
}

export interface TrashActionResult {
  done: number;
  results: { id: string; ok: boolean; location?: string | null; error?: string | null }[];
}

export const toRef = (it: TrashItem): TrashRef => ({
  type: it.type,
  id: it.id,
  workspace_id: it.workspace_id ?? undefined,
});

export const trashApi = {
  async list(): Promise<{ items: TrashItem[]; retention_days: number }> {
    return (await apiClient.get("/trash")).data;
  },
  async restore(items: TrashRef[]): Promise<TrashActionResult> {
    return (await apiClient.post("/trash/restore", { items })).data;
  },
  async purge(items: TrashRef[]): Promise<TrashActionResult> {
    return (await apiClient.post("/trash/purge", { items })).data;
  },
  async empty(): Promise<{ deleted: number }> {
    return (await apiClient.delete("/trash")).data;
  },
};
