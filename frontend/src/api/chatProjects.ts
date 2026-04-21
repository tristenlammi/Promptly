/**
 * Chat Projects API client.
 *
 * Mirrors the Study API shape intentionally — the projects UI re-uses
 * the list/detail/archive patterns wholesale so the two features feel
 * like siblings in the sidebar.
 */

import { apiClient } from "./client";
import type { ConversationSummary } from "@/api/types";

export interface ChatProjectFilePin {
  file_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  pinned_at: string;
}

export interface ChatProjectSummary {
  id: string;
  title: string;
  description: string | null;
  default_model_id: string | null;
  default_provider_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  conversation_count: number;
  file_count: number;
}

export interface ChatProjectDetail extends ChatProjectSummary {
  system_prompt: string | null;
  files: ChatProjectFilePin[];
}

export interface CreateChatProjectPayload {
  title: string;
  description?: string | null;
  system_prompt?: string | null;
  default_model_id?: string | null;
  default_provider_id?: string | null;
}

export interface UpdateChatProjectPayload {
  title?: string;
  description?: string | null;
  system_prompt?: string | null;
  default_model_id?: string | null;
  default_provider_id?: string | null;
}

export const chatProjectsApi = {
  async list(opts: { archived?: boolean } = {}): Promise<ChatProjectSummary[]> {
    const { data } = await apiClient.get<ChatProjectSummary[]>(
      "/chat/projects",
      { params: { archived: opts.archived ?? false } }
    );
    return data;
  },

  async get(id: string): Promise<ChatProjectDetail> {
    const { data } = await apiClient.get<ChatProjectDetail>(
      `/chat/projects/${id}`
    );
    return data;
  },

  async create(
    payload: CreateChatProjectPayload
  ): Promise<ChatProjectSummary> {
    const { data } = await apiClient.post<ChatProjectSummary>(
      "/chat/projects",
      payload
    );
    return data;
  },

  async update(
    id: string,
    payload: UpdateChatProjectPayload
  ): Promise<ChatProjectSummary> {
    const { data } = await apiClient.patch<ChatProjectSummary>(
      `/chat/projects/${id}`,
      payload
    );
    return data;
  },

  async remove(id: string): Promise<void> {
    await apiClient.delete(`/chat/projects/${id}`);
  },

  async archive(id: string): Promise<ChatProjectSummary> {
    const { data } = await apiClient.post<ChatProjectSummary>(
      `/chat/projects/${id}/archive`
    );
    return data;
  },

  async unarchive(id: string): Promise<ChatProjectSummary> {
    const { data } = await apiClient.post<ChatProjectSummary>(
      `/chat/projects/${id}/unarchive`
    );
    return data;
  },

  async listConversations(id: string): Promise<ConversationSummary[]> {
    const { data } = await apiClient.get<ConversationSummary[]>(
      `/chat/projects/${id}/conversations`
    );
    return data;
  },

  async pinFile(id: string, fileId: string): Promise<ChatProjectFilePin> {
    const { data } = await apiClient.post<ChatProjectFilePin>(
      `/chat/projects/${id}/files`,
      { file_id: fileId }
    );
    return data;
  },

  async unpinFile(id: string, fileId: string): Promise<void> {
    await apiClient.delete(`/chat/projects/${id}/files/${fileId}`);
  },

  async moveConversation(
    projectId: string,
    conversationId: string
  ): Promise<ConversationSummary> {
    const { data } = await apiClient.post<ConversationSummary>(
      `/chat/projects/${projectId}/conversations/${conversationId}`
    );
    return data;
  },

  async removeConversationFromProject(
    projectId: string,
    conversationId: string
  ): Promise<ConversationSummary> {
    const { data } = await apiClient.delete<ConversationSummary>(
      `/chat/projects/${projectId}/conversations/${conversationId}`
    );
    return data;
  },
};
