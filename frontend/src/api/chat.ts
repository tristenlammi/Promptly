import { apiClient } from "./client";
import type {
  ConversationDetail,
  ConversationSearchHit,
  ConversationSummary,
  InviteRow,
  SendMessageResponse,
  ShareRow,
  WebSearchMode,
} from "./types";

export interface CreateConversationPayload {
  title?: string | null;
  model_id?: string | null;
  provider_id?: string | null;
  web_search_mode?: WebSearchMode;
}

export interface UpdateConversationPayload {
  title?: string | null;
  pinned?: boolean;
  starred?: boolean;
  web_search_mode?: WebSearchMode;
  model_id?: string | null;
  provider_id?: string | null;
}

export interface SendMessagePayload {
  content: string;
  provider_id?: string | null;
  model_id?: string | null;
  /** Three-mode web-search preference for *this* turn (Phase D1).
   *  Omit (``null`` / undefined) to use the conversation's stored mode;
   *  any explicit value overrides for this turn AND persists onto the
   *  conversation, so the next plain send keeps the same mode. */
  web_search_mode?: WebSearchMode | null;
  temperature?: number | null;
  max_tokens?: number | null;
  /** IDs of files picked via the paperclip modal. */
  attachment_ids?: string[];
  /** Per-turn opt-in to expose the artefact tool catalog (PDF / image
   *  generation). Search tools (``web_search`` / ``fetch_url``) ride
   *  on ``web_search_mode``, not this flag. The backend defaults to
   *  ``false`` so omitting this is a no-artefact-tool turn. */
  tools_enabled?: boolean;
}

/** Edit-and-resend payload. Attachments aren't sent — the backend
 *  preserves whatever was attached when the message was first posted. */
export interface EditMessagePayload {
  content: string;
  provider_id?: string | null;
  model_id?: string | null;
  web_search_mode?: WebSearchMode | null;
  temperature?: number | null;
  max_tokens?: number | null;
  tools_enabled?: boolean;
}

export const chatApi = {
  async list(limit = 50, offset = 0): Promise<ConversationSummary[]> {
    const { data } = await apiClient.get<ConversationSummary[]>(
      "/chat/conversations",
      { params: { limit, offset } }
    );
    return data;
  },
  async create(payload: CreateConversationPayload): Promise<ConversationSummary> {
    const { data } = await apiClient.post<ConversationSummary>(
      "/chat/conversations",
      payload
    );
    return data;
  },
  async get(id: string): Promise<ConversationDetail> {
    const { data } = await apiClient.get<ConversationDetail>(
      `/chat/conversations/${id}`
    );
    return data;
  },
  async update(
    id: string,
    payload: UpdateConversationPayload
  ): Promise<ConversationSummary> {
    const { data } = await apiClient.patch<ConversationSummary>(
      `/chat/conversations/${id}`,
      payload
    );
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/chat/conversations/${id}`);
  },
  async sendMessage(
    id: string,
    payload: SendMessagePayload
  ): Promise<SendMessageResponse> {
    const { data } = await apiClient.post<SendMessageResponse>(
      `/chat/conversations/${id}/messages`,
      payload
    );
    return data;
  },
  async editMessage(
    conversationId: string,
    messageId: string,
    payload: EditMessagePayload
  ): Promise<SendMessageResponse> {
    const { data } = await apiClient.post<SendMessageResponse>(
      `/chat/conversations/${conversationId}/messages/${messageId}/edit`,
      payload
    );
    return data;
  },
  streamUrl(streamId: string): string {
    // Used by useStreamingChat — must be absolute-ish since it flows through
    // nginx in prod and through vite proxy in dev.
    return `/api/chat/stream/${streamId}`;
  },
  async search(q: string, limit = 20): Promise<ConversationSearchHit[]> {
    const { data } = await apiClient.get<ConversationSearchHit[]>(
      "/chat/conversations/search",
      { params: { q, limit } }
    );
    return data;
  },

  // ---- Phase 4c — branching ----
  /** Fork an existing conversation from a chosen message. Returns
   *  the freshly-created branch's summary so the caller can navigate
   *  straight to it. The backend deep-copies messages up to and
   *  including ``messageId``; the new chat is owned by the caller. */
  async branch(
    conversationId: string,
    messageId: string
  ): Promise<ConversationSummary> {
    const { data } = await apiClient.post<ConversationSummary>(
      `/chat/conversations/${conversationId}/branch`,
      { message_id: messageId }
    );
    return data;
  },

  // ---- Phase 4b — sharing ----
  /** Owner: list every share row on a conversation. */
  async listShares(conversationId: string): Promise<ShareRow[]> {
    const { data } = await apiClient.get<ShareRow[]>(
      `/chat/conversations/${conversationId}/shares`
    );
    return data;
  },
  /** Owner: invite a user (by username or email) to a conversation. */
  async createShare(
    conversationId: string,
    payload: { username?: string; email?: string }
  ): Promise<ShareRow> {
    const { data } = await apiClient.post<ShareRow>(
      `/chat/conversations/${conversationId}/shares`,
      payload
    );
    return data;
  },
  /** Owner revokes a share, or invitee leaves a chat. */
  async deleteShare(conversationId: string, shareId: string): Promise<void> {
    await apiClient.delete(
      `/chat/conversations/${conversationId}/shares/${shareId}`
    );
  },
  /** Invitee: pending invites awaiting accept/decline. */
  async listInvites(): Promise<InviteRow[]> {
    const { data } = await apiClient.get<InviteRow[]>("/chat/share-invites");
    return data;
  },
  async acceptInvite(shareId: string): Promise<void> {
    await apiClient.post(`/chat/share-invites/${shareId}/accept`);
  },
  async declineInvite(shareId: string): Promise<void> {
    await apiClient.post(`/chat/share-invites/${shareId}/decline`);
  },
};
