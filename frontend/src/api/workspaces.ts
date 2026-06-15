/**
 * Workspaces API client.
 *
 * Mirrors the Study API shape intentionally — the workspaces UI re-uses
 * the list/detail/archive patterns wholesale so the two features feel
 * like siblings in the sidebar.
 */

import { apiClient } from "./client";
import type { ConversationSummary } from "@/api/types";

export interface WorkspaceFilePin {
  file_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  pinned_at: string;
  /** RAG indexing lifecycle. ``queued`` also covers non-RAG files
   *  (images / binaries) — they stay queued and retrieval ignores them. */
  indexing_status: "queued" | "embedding" | "ready" | "failed";
  indexing_error: string | null;
}

export interface WorkspaceParticipant {
  user_id: string;
  username: string;
  email: string;
}

export interface WorkspaceSummary {
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
  /** Whether the caller owns this workspace or has an accepted share
   *  on it. Used to badge cards in the list and to hide destructive
   *  actions (delete, archive, manage shares) from collaborators. */
  role: "owner" | "collaborator";
  /** Non-null only when ``role === "collaborator"`` — tells the
   *  caller who they got access from so the card can render
   *  "shared by Jane" in place of the owner timestamp. */
  shared_by: WorkspaceParticipant | null;
}

export interface WorkspaceDetail extends WorkspaceSummary {
  system_prompt: string | null;
  files: WorkspaceFilePin[];
  /** The workspace's owner — present on the detail endpoint so the
   *  header can render "Owned by X" consistently across owner /
   *  collaborator viewpoints. */
  owner: WorkspaceParticipant | null;
  /** Every user with an accepted workspace share, sorted by username. */
  collaborators: WorkspaceParticipant[];
  /** Per-turn context budget (Phase P2). ``per_turn_tokens`` is what
   *  every chat in the workspace actually pays: instructions + full pinned
   *  text in full-dump mode, or instructions + a top-k retrieval slice
   *  once ``retrieval_active`` is true. ``indexing_count`` is how many
   *  pinned files are still being embedded. */
  instruction_tokens: number;
  pinned_file_tokens: number;
  per_turn_tokens: number;
  retrieval_active: boolean;
  indexing_count: number;
  /** Caller's fine-grained permission. ``viewer`` is read-only;
   *  ``editor``/``owner`` can edit. */
  access_role: "owner" | "editor" | "viewer";
  /** Opt-in rolling workspace memory. */
  auto_memory_enabled: boolean;
  /** True when the workspace has an embedding provider configured.
   *  False → files stay in full-dump mode regardless of size;
   *  the Files tab shows an onboarding nudge when this is false. */
  embeddings_configured: boolean;
}

export type WorkspaceShareRole = "editor" | "viewer";

/** One share row on the owner-facing management list. */
export interface WorkspaceShareRow {
  id: string;
  workspace_id: string;
  invitee: WorkspaceParticipant;
  status: "pending" | "accepted" | "declined";
  role: WorkspaceShareRole;
  created_at: string;
  accepted_at: string | null;
}

/** A pending workspace-share invite as seen by the invitee. */
export interface WorkspaceInviteRow {
  id: string;
  workspace_id: string;
  workspace_title: string;
  inviter: WorkspaceParticipant;
  created_at: string;
}

export interface WorkspaceUsageModel {
  model_id: string | null;
  messages: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
}

export interface WorkspaceUsage {
  conversation_count: number;
  message_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  by_model: WorkspaceUsageModel[];
}

export interface CreateWorkspacePayload {
  title: string;
  description?: string | null;
  system_prompt?: string | null;
  default_model_id?: string | null;
  default_provider_id?: string | null;
}

export interface UpdateWorkspacePayload {
  title?: string;
  description?: string | null;
  system_prompt?: string | null;
  default_model_id?: string | null;
  default_provider_id?: string | null;
  auto_memory_enabled?: boolean;
}

export const workspacesApi = {
  async list(opts: { archived?: boolean } = {}): Promise<WorkspaceSummary[]> {
    const { data } = await apiClient.get<WorkspaceSummary[]>(
      "/workspaces",
      { params: { archived: opts.archived ?? false } }
    );
    return data;
  },

  async get(id: string): Promise<WorkspaceDetail> {
    const { data } = await apiClient.get<WorkspaceDetail>(
      `/workspaces/${id}`
    );
    return data;
  },

  async create(
    payload: CreateWorkspacePayload
  ): Promise<WorkspaceSummary> {
    const { data } = await apiClient.post<WorkspaceSummary>(
      "/workspaces",
      payload
    );
    return data;
  },

  async update(
    id: string,
    payload: UpdateWorkspacePayload
  ): Promise<WorkspaceSummary> {
    const { data } = await apiClient.patch<WorkspaceSummary>(
      `/workspaces/${id}`,
      payload
    );
    return data;
  },

  async remove(id: string): Promise<void> {
    await apiClient.delete(`/workspaces/${id}`);
  },

  async archive(id: string): Promise<WorkspaceSummary> {
    const { data } = await apiClient.post<WorkspaceSummary>(
      `/workspaces/${id}/archive`
    );
    return data;
  },

  async unarchive(id: string): Promise<WorkspaceSummary> {
    const { data } = await apiClient.post<WorkspaceSummary>(
      `/workspaces/${id}/unarchive`
    );
    return data;
  },

  async listConversations(id: string): Promise<ConversationSummary[]> {
    const { data } = await apiClient.get<ConversationSummary[]>(
      `/workspaces/${id}/conversations`
    );
    return data;
  },

  async usage(id: string): Promise<WorkspaceUsage> {
    const { data } = await apiClient.get<WorkspaceUsage>(
      `/workspaces/${id}/usage`
    );
    return data;
  },

  async reindex(id: string): Promise<void> {
    await apiClient.post(`/workspaces/${id}/reindex`);
  },

  /** Bulk-detach every conversation from this workspace (workspace_id → null).
   *  Conversations are preserved; they move back to the top-level list.
   *  Returns the count of affected conversations. */
  async removeAllConversations(id: string): Promise<{ removed: number }> {
    const { data } = await apiClient.delete<{ removed: number }>(
      `/workspaces/${id}/conversations`
    );
    return data;
  },

  async pinFile(id: string, fileId: string): Promise<WorkspaceFilePin> {
    const { data } = await apiClient.post<WorkspaceFilePin>(
      `/workspaces/${id}/files`,
      { file_id: fileId }
    );
    return data;
  },

  async unpinFile(id: string, fileId: string): Promise<void> {
    await apiClient.delete(`/workspaces/${id}/files/${fileId}`);
  },

  async moveConversation(
    workspaceId: string,
    conversationId: string
  ): Promise<ConversationSummary> {
    const { data } = await apiClient.post<ConversationSummary>(
      `/workspaces/${workspaceId}/conversations/${conversationId}`
    );
    return data;
  },

  async removeConversationFromWorkspace(
    workspaceId: string,
    conversationId: string
  ): Promise<ConversationSummary> {
    const { data } = await apiClient.delete<ConversationSummary>(
      `/workspaces/${workspaceId}/conversations/${conversationId}`
    );
    return data;
  },

  // ------------------------------------------------------------------
  // Workspace sharing — owner perspective
  // ------------------------------------------------------------------
  async listShares(workspaceId: string): Promise<WorkspaceShareRow[]> {
    const { data } = await apiClient.get<WorkspaceShareRow[]>(
      `/workspaces/${workspaceId}/shares`
    );
    return data;
  },

  async createShare(
    workspaceId: string,
    payload: { username?: string; email?: string; role?: WorkspaceShareRole }
  ): Promise<WorkspaceShareRow> {
    const { data } = await apiClient.post<WorkspaceShareRow>(
      `/workspaces/${workspaceId}/shares`,
      payload
    );
    return data;
  },

  async deleteShare(workspaceId: string, shareId: string): Promise<void> {
    await apiClient.delete(
      `/workspaces/${workspaceId}/shares/${shareId}`
    );
  },

  // ------------------------------------------------------------------
  // Workspace sharing — invitee perspective
  // ------------------------------------------------------------------
  async listInvites(): Promise<WorkspaceInviteRow[]> {
    const { data } = await apiClient.get<WorkspaceInviteRow[]>(
      "/workspace-share-invites"
    );
    return data;
  },

  async acceptInvite(shareId: string): Promise<void> {
    await apiClient.post(`/workspace-share-invites/${shareId}/accept`);
  },

  async declineInvite(shareId: string): Promise<void> {
    await apiClient.post(`/workspace-share-invites/${shareId}/decline`);
  },
};
