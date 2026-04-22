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

export interface ChatProjectParticipant {
  user_id: string;
  username: string;
  email: string;
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
  /** Whether the caller owns this project or has an accepted share
   *  on it. Used to badge cards in the list and to hide destructive
   *  actions (delete, archive, manage shares) from collaborators. */
  role: "owner" | "collaborator";
  /** Non-null only when ``role === "collaborator"`` — tells the
   *  caller who they got access from so the card can render
   *  "shared by Jane" in place of the owner timestamp. */
  shared_by: ChatProjectParticipant | null;
}

export interface ChatProjectDetail extends ChatProjectSummary {
  system_prompt: string | null;
  files: ChatProjectFilePin[];
  /** The project's owner — present on the detail endpoint so the
   *  header can render "Owned by X" consistently across owner /
   *  collaborator viewpoints. */
  owner: ChatProjectParticipant | null;
  /** Every user with an accepted project share, sorted by username. */
  collaborators: ChatProjectParticipant[];
}

/** One share row on the owner-facing management list. */
export interface ProjectShareRow {
  id: string;
  project_id: string;
  invitee: ChatProjectParticipant;
  status: "pending" | "accepted" | "declined";
  created_at: string;
  accepted_at: string | null;
}

/** A pending project-share invite as seen by the invitee. */
export interface ProjectInviteRow {
  id: string;
  project_id: string;
  project_title: string;
  inviter: ChatProjectParticipant;
  created_at: string;
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

  // ------------------------------------------------------------------
  // Project sharing — owner perspective
  // ------------------------------------------------------------------
  async listShares(projectId: string): Promise<ProjectShareRow[]> {
    const { data } = await apiClient.get<ProjectShareRow[]>(
      `/chat/projects/${projectId}/shares`
    );
    return data;
  },

  async createShare(
    projectId: string,
    payload: { username?: string; email?: string }
  ): Promise<ProjectShareRow> {
    const { data } = await apiClient.post<ProjectShareRow>(
      `/chat/projects/${projectId}/shares`,
      payload
    );
    return data;
  },

  async deleteShare(projectId: string, shareId: string): Promise<void> {
    await apiClient.delete(
      `/chat/projects/${projectId}/shares/${shareId}`
    );
  },

  // ------------------------------------------------------------------
  // Project sharing — invitee perspective
  // ------------------------------------------------------------------
  async listInvites(): Promise<ProjectInviteRow[]> {
    const { data } = await apiClient.get<ProjectInviteRow[]>(
      "/chat/project-share-invites"
    );
    return data;
  },

  async acceptInvite(shareId: string): Promise<void> {
    await apiClient.post(`/chat/project-share-invites/${shareId}/accept`);
  },

  async declineInvite(shareId: string): Promise<void> {
    await apiClient.post(`/chat/project-share-invites/${shareId}/decline`);
  },
};
