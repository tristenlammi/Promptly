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
  created_at: string;
  updated_at: string;
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
};
