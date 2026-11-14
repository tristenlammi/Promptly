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
  /** Only in the panel: this reply failed with nothing changed; the message to send again. */
  retry?: string;
  /** The panel's id for the turn these two rows belong to. */
  cid?: string;
}

/** A turn the server is still working on (the panel reconnects to it). */
export interface AiRunning {
  message: string;
  started: string;
  client_id: string | null;
}

export type AiEvent =
  | { type: "text"; text: string }
  | { type: "action"; name: string; summary: string; ok: boolean }
  | { type: "status"; text: string }
  | { type: "done"; changed: boolean; revision: number; version_id: string | null; data?: Record<string, unknown> }
  | { type: "error"; message: string; retry?: boolean }
  /** Only from this client: the stream stopped (or went silent) before the turn ended. */
  | { type: "lost" }
  /** Only from this client: the server is still on the previous message. */
  | { type: "busy" };

/** No bytes for this long (the server sends a keep-alive every 10 s) means the connection is gone. */
const STREAM_SILENCE_MS = 35_000;

/** Server-sent events off a fetch response, ending with ``lost`` when the
 *  stream stops or goes silent before a ``done`` / ``error``. A phone that
 *  slept, a dropped connection and a proxy timeout all look like that; the
 *  turn itself carries on on the server. */
async function* readAiEvents(res: Response): AsyncGenerator<AiEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let ended = false;
  try {
    for (;;) {
      let timer = 0;
      const silent = new Promise<"silent">((resolve) => {
        timer = window.setTimeout(() => resolve("silent"), STREAM_SILENCE_MS);
      });
      const got = await Promise.race([reader.read(), silent]);
      window.clearTimeout(timer);
      if (got === "silent" || got.done) break;
      buf += decoder.decode(got.value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue; // a keep-alive comment
        try {
          const ev = JSON.parse(line.slice(6)) as AiEvent;
          if (ev.type === "done" || ev.type === "error") ended = true;
          yield ev;
        } catch {
          /* a partial frame */
        }
      }
      if (ended) return;
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    /* the connection dropped: lost, below */
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  if (!ended) yield { type: "lost" };
}

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
  async thread(fileId: string): Promise<{ turns: AiTurn[]; running: AiRunning | null }> {
    const { data } = await apiClient.get(`/items/${fileId}/ai`);
    return { turns: data.turns ?? [], running: data.running ?? null };
  },
  /** Stop the turn that's running (what it changed so far isn't saved). */
  async stopTurn(fileId: string): Promise<void> {
    await apiClient.post(`/items/${fileId}/ai/stop`);
  },
  /** The turn that's running on the server, from its first event. Yields
   *  nothing when none is. */
  async *followTurn(fileId: string, signal?: AbortSignal): AsyncGenerator<AiEvent> {
    await apiClient.get(`/items/${fileId}/revision`);
    const res = await fetch(`${API_BASE_URL}/items/${fileId}/ai/live`, { headers: authHeader(), credentials: "include", signal });
    if (res.status === 204 || !res.ok || !res.body) return;
    yield* readAiEvents(res);
  },
  async clearThread(fileId: string): Promise<void> {
    await apiClient.delete(`/items/${fileId}/ai`);
  },
  /** One AI-panel turn, streamed. Yields events until ``done`` / ``error``. */
  async *ask(
    fileId: string,
    body: { message: string; provider_id: string | null; model_id: string | null; attachment_ids?: string[]; client_id?: string },
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
    if (res.status === 409) {
      yield { type: "busy" };
      return;
    }
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
    yield* readAiEvents(res);
  },
};
