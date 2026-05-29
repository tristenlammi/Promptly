import { apiClient } from "./client";

/** A single durable fact the assistant remembers across chats (Phase 6). */
export interface Memory {
  id: string;
  content: string;
  /** ``manual`` (user-added) or ``auto`` (lifted from a conversation). */
  source: "manual" | "auto";
  source_conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export const memoryApi = {
  async list(): Promise<Memory[]> {
    const { data } = await apiClient.get<Memory[]>("/memory");
    return data;
  },
  async create(content: string): Promise<Memory> {
    const { data } = await apiClient.post<Memory>("/memory", { content });
    return data;
  },
  async update(id: string, content: string): Promise<Memory> {
    const { data } = await apiClient.patch<Memory>(`/memory/${id}`, {
      content,
    });
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/memory/${id}`);
  },
  async clear(): Promise<void> {
    await apiClient.delete("/memory");
  },
};
