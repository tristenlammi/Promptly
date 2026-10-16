import { apiClient } from "./client";

/** A single durable fact the assistant remembers across chats (Phase 6). */
export interface Memory {
  id: string;
  content: string;
  /** ``manual`` (user-added) or ``auto`` (lifted from a conversation). */
  source: "manual" | "auto";
  source_conversation_id: string | null;
  /** Category tag (Phase 2.1): identity | preferences | projects | context | null. */
  category: string | null;
  /** Pinned facts are always injected into the system prompt (Phase 2.1). */
  pinned: boolean;
  /** Usage signals (Phase 3.1): how many turns retrieved this fact. */
  times_used: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryImportResult {
  imported: number;
  /** Existing facts replaced by a richer imported version (R-329). */
  updated: number;
  skipped: number;
  errors: number;
}

export interface MemoryConsolidateResult {
  merged_groups: number;
  removed: number;
  changes: { kept_id: string; text: string; merged: string[] }[];
}

/** One proposed change from a plain-English edit instruction. ``before``
 *  is the row's current text (updates + deletes), ``after`` the proposed
 *  text (adds + updates). Sent back verbatim to apply — the server
 *  re-validates every id against the caller's own rows, so this is a
 *  suggestion, not an authority. */
export interface MemoryEditOp {
  op: "add" | "update" | "delete";
  id?: string | null;
  before?: string | null;
  after?: string | null;
  category?: string | null;
}

export interface MemoryApplyResult {
  added: number;
  updated: number;
  deleted: number;
}

export interface MemoryPatch {
  content?: string;
  category?: string | null;
  pinned?: boolean;
}

export const MEMORY_CATEGORIES: { value: string; label: string }[] = [
  { value: "identity", label: "Identity" },
  { value: "preferences", label: "Preferences" },
  { value: "projects", label: "Projects" },
  { value: "context", label: "Context" },
];

export const memoryApi = {
  async list(): Promise<Memory[]> {
    const { data } = await apiClient.get<Memory[]>("/memory");
    return data;
  },
  async create(content: string, options?: { category?: string | null; pinned?: boolean }): Promise<Memory> {
    const { data } = await apiClient.post<Memory>("/memory", {
      content,
      ...options,
    });
    return data;
  },
  async update(id: string, patch: MemoryPatch): Promise<Memory> {
    const { data } = await apiClient.patch<Memory>(`/memory/${id}`, patch);
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/memory/${id}`);
  },
  /** Bulk-delete a list of memory ids. Fires in parallel; ignores 404s. */
  async bulkRemove(ids: string[]): Promise<void> {
    await Promise.allSettled(ids.map((id) => apiClient.delete(`/memory/${id}`)));
  },
  async clear(): Promise<void> {
    await apiClient.delete("/memory");
  },
  /** Download all memories as a JSON file (Phase 3.5). Fetched through
   *  the API client: a plain link carries no sign-in token, so it saved a
   *  401 error as the "backup" (R-264). */
  async exportFile(): Promise<void> {
    const { data } = await apiClient.get<Blob>("/memory/export", { responseType: "blob" });
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = "promptly-memories.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  /** Import memories from a parsed JSON array (Phase 3.5). */
  async import(items: unknown[]): Promise<MemoryImportResult> {
    const { data } = await apiClient.post<MemoryImportResult>("/memory/import", items);
    return data;
  },
  /** Import plain-text facts, one per line — pasted, or read from a
   *  .txt / .md file. List markers are stripped server-side (R-329). */
  async importText(text: string): Promise<MemoryImportResult> {
    const { data } = await apiClient.post<MemoryImportResult>("/memory/import", { text });
    return data;
  },
  /** Ask what a plain-English instruction would change. Read-only —
   *  the caller previews the plan and applies it separately. */
  async instruct(instruction: string): Promise<MemoryEditOp[]> {
    const { data } = await apiClient.post<{ changes: MemoryEditOp[] }>(
      "/memory/instruct",
      { instruction }
    );
    return data.changes;
  },
  /** Apply a plan the user accepted. */
  async applyInstruction(ops: MemoryEditOp[]): Promise<MemoryApplyResult> {
    const { data } = await apiClient.post<MemoryApplyResult>(
      "/memory/instruct/apply",
      { ops }
    );
    return data;
  },
  /** One model pass that merges near-duplicate facts (merge-only). */
  async consolidate(): Promise<MemoryConsolidateResult> {
    const { data } = await apiClient.post<MemoryConsolidateResult>(
      "/memory/consolidate"
    );
    return data;
  },
};
