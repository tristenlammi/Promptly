import { API_BASE_URL, apiClient, authHeader } from "@/api/client";

import type { PatchOp } from "./jsonpatch";

/** The Item Store and item files (backend: app/items). */

export interface StoreItem {
  kind: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  icon: string;
  color: string;
  suffix: string;
  replaces: string;
  highlights: string[];
  installed: boolean;
  disabled: boolean;
  files: number;
}

export interface ItemSpecInfo extends Omit<StoreItem, "installed" | "disabled" | "files"> {
  ai_suggestions: string[];
  ai_web: boolean;
  actions: { name: string; description: string; writes: boolean }[];
}

export interface ItemDoc<T = Record<string, unknown>> {
  file_id: string;
  kind: string;
  title: string;
  filename: string;
  folder_id: string | null;
  revision: number;
  schema_version: number;
  data: T;
  access: "read" | "comment" | "edit";
  is_owner: boolean;
  updated_at: string | null;
  starred: boolean;
  /** How full the file is (the kind's limit), and whether it can archive. */
  size_bytes?: number;
  max_bytes?: number;
  can_archive?: boolean;
  /** Opened from this device's copy, with no connection. */
  offline?: boolean;
  spec: ItemSpecInfo | null;
}

export interface ItemListEntry {
  file_id: string;
  kind: string;
  title: string;
  folder_id: string | null;
  updated_at: string | null;
}

export interface ActionResult<T = Record<string, unknown>> {
  summary: string;
  result: unknown;
  revision: number;
  data: T;
}

export interface AiTurn {
  role: "user" | "assistant";
  content: string;
  actions?: { name: string; summary: string; ok: boolean }[];
  version_id?: string | null;
  undone?: boolean;
  at?: string;
}

export type AiEvent =
  | { type: "text"; text: string }
  | { type: "action"; name: string; summary: string; ok: boolean }
  | { type: "status"; text: string }
  | { type: "done"; changed: boolean; revision: number; version_id: string | null; data?: Record<string, unknown> }
  | { type: "error"; message: string };

/** The file, from the server — or, with no connection, the copy this
 *  device kept (``offline: true``). Successful reads refresh that copy. */
export async function loadItemDoc<T>(fileId: string): Promise<ItemDoc<T> & { offline?: boolean }> {
  const { offlineStore, isOffline } = await import("./offlineStore");
  const { useAuthStore } = await import("@/store/authStore");
  const userId = useAuthStore.getState().user?.id ?? "anon";
  try {
    const doc = await itemsApi.get<T>(fileId);
    void offlineStore.putDoc(userId, doc as ItemDoc<unknown>);
    return doc;
  } catch (e) {
    if (isOffline(e)) {
      const cached = await offlineStore.getDoc<T>(userId, fileId);
      if (cached) return { ...cached, offline: true };
    }
    throw e;
  }
}

export interface LauncherApp extends Omit<StoreItem, "installed" | "disabled"> {
  latest: string | null;
}

export const itemsApi = {
  /** The Apps page: added apps in the person's order. */
  async launcher(): Promise<LauncherApp[]> {
    const { data } = await apiClient.get("/items/launcher");
    return data.apps;
  },
  async saveLauncher(order: string[]): Promise<void> {
    await apiClient.put("/items/launcher", { order });
  },
  /** Launch an app: its most recent file (made if there's none). */
  async openApp(kind: string): Promise<{ file_id: string; created: boolean }> {
    const { data } = await apiClient.post(`/items/open/${kind}`);
    return data;
  },
  async store(): Promise<{ items: StoreItem[]; is_admin: boolean }> {
    const { data } = await apiClient.get("/items/store");
    return data;
  },
  async add(kind: string): Promise<void> {
    await apiClient.post(`/items/store/${kind}`);
  },
  async remove(kind: string): Promise<void> {
    await apiClient.delete(`/items/store/${kind}`);
  },
  async setDisabled(disabled: string[]): Promise<{ disabled: string[] }> {
    const { data } = await apiClient.put("/items/store/admin", { disabled });
    return data;
  },
  async list(kind?: string): Promise<ItemListEntry[]> {
    const { data } = await apiClient.get("/items", { params: kind ? { kind } : undefined });
    return data.items;
  },
  async create(body: { kind: string; title?: string; folder_id?: string | null; data?: unknown }): Promise<ItemDoc> {
    const { data } = await apiClient.post("/items", body);
    return data;
  },
  async get<T>(fileId: string): Promise<ItemDoc<T>> {
    const { data } = await apiClient.get(`/items/${fileId}`);
    return data;
  },
  async revision(fileId: string): Promise<number> {
    const { data } = await apiClient.get(`/items/${fileId}/revision`);
    return data.revision;
  },
  /** Throws an axios error; a 409 carries ``{revision, data}`` (the newer state). */
  async save<T>(fileId: string, data: T, baseRevision: number): Promise<{ revision: number; data: T }> {
    const res = await apiClient.put(`/items/${fileId}`, { data, base_revision: baseRevision });
    return res.data;
  },
  /** Save as a patch against ``baseRevision``; the answer's ``fix`` is what
   *  the server's validation changed (apply it to what you sent). */
  async savePatch(fileId: string, patch: PatchOp[], baseRevision: number): Promise<{ revision: number; fix: PatchOp[] }> {
    const res = await apiClient.put(`/items/${fileId}`, { patch, base_revision: baseRevision });
    return res.data;
  },
  async action<T>(fileId: string, name: string, args: Record<string, unknown> = {}): Promise<ActionResult<T>> {
    const { data } = await apiClient.post(`/items/${fileId}/actions/${name}`, { args }, { timeout: 60_000 });
    return data;
  },
  /** Move data older than ``before`` (YYYY-MM-DD) into a new archive file. */
  async archive<T>(fileId: string, before: string): Promise<{ archive_id: string; revision: number; data: T; size_bytes: number }> {
    const { data } = await apiClient.post(`/items/${fileId}/archive`, { before }, { timeout: 120_000 });
    return data;
  },
  async restore<T>(fileId: string, versionId: string): Promise<{ revision: number; data: T }> {
    const { data } = await apiClient.post(`/items/${fileId}/restore/${versionId}`);
    return data;
  },
  async thread(fileId: string): Promise<AiTurn[]> {
    const { data } = await apiClient.get(`/items/${fileId}/ai`);
    return data.turns;
  },
  async clearThread(fileId: string): Promise<void> {
    await apiClient.delete(`/items/${fileId}/ai`);
  },
  /** One AI-panel turn, streamed. Yields events until ``done`` / ``error``. */
  async *ask(
    fileId: string,
    body: { message: string; provider_id: string | null; model_id: string | null; attachment_ids?: string[] },
    signal?: AbortSignal,
  ): AsyncGenerator<AiEvent> {
    // A cheap authed call first, so an expired access token is refreshed
    // by the axios interceptor before fetch() (which has no refresh) runs.
    await apiClient.get(`/items/${fileId}/revision`);
    const res = await fetch(`${API_BASE_URL}/items/${fileId}/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      credentials: "include",
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      let detail = `The assistant isn't available (${res.status}).`;
      try {
        const j = await res.json();
        if (typeof j?.detail === "string") detail = j.detail;
      } catch {
        /* not JSON */
      }
      yield { type: "error", message: detail };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          yield JSON.parse(line.slice(6)) as AiEvent;
        } catch {
          /* a partial frame */
        }
      }
    }
  },
};
