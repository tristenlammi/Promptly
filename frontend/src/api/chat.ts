import { apiClient } from "./client";
import type {
  ConversationDetail,
  ConversationSearchHit,
  ConversationSummary,
  InviteRow,
  SendMessageResponse,
  ShareRow,
  TemporaryMode,
  WebSearchMode,
} from "./types";

export interface CreateConversationPayload {
  title?: string | null;
  model_id?: string | null;
  provider_id?: string | null;
  web_search_mode?: WebSearchMode;
  /** Phase Z1 — request a temporary chat. ``null`` / undefined produces
   *  a normal permanent chat. The server computes ``expires_at`` from
   *  the chosen mode; the client only picks the policy. */
  temporary_mode?: TemporaryMode | null;
  /** Phase P1 — create under a chat project. Temporary chats can't
   *  belong to a project (enforced server-side). */
  project_id?: string | null;
}

export interface UpdateConversationPayload {
  title?: string | null;
  pinned?: boolean;
  starred?: boolean;
  web_search_mode?: WebSearchMode;
  model_id?: string | null;
  provider_id?: string | null;
  /** Phase P1 — move this chat into / out of a project. Pass a project
   *  id to move; pass ``null`` to detach. Omit to leave unchanged. */
  project_id?: string | null;
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

/** Regenerate-assistant-reply payload. All fields optional: omitting
 *  everything is a plain "try again"; passing ``provider_id`` +
 *  ``model_id`` powers the "try a different model" affordance. The
 *  preceding user message is left untouched on the server side. */
export interface RegenerateMessagePayload {
  provider_id?: string | null;
  model_id?: string | null;
  web_search_mode?: WebSearchMode | null;
  temperature?: number | null;
  max_tokens?: number | null;
  tools_enabled?: boolean;
}

export interface ImportConversationsResponse {
  imported: number;
  skipped: number;
  total_messages: number;
  conversations: Array<{
    id: string;
    title: string;
    message_count: number;
    source: string;
  }>;
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
  async regenerateMessage(
    conversationId: string,
    messageId: string,
    payload: RegenerateMessagePayload = {}
  ): Promise<SendMessageResponse> {
    const { data } = await apiClient.post<SendMessageResponse>(
      `/chat/conversations/${conversationId}/messages/${messageId}/regenerate`,
      payload
    );
    return data;
  },
  /** Download a conversation in the requested format. Returns the
   *  axios response so the caller has access to headers (we pull the
   *  filename out of ``Content-Disposition`` rather than re-deriving
   *  it client-side — keeps title handling identical to other
   *  authenticated downloads like file attachments). */
  async exportConversation(
    conversationId: string,
    format: "markdown" | "json" | "pdf"
  ): Promise<{ blob: Blob; filename: string }> {
    const res = await apiClient.get<Blob>(
      `/chat/conversations/${conversationId}/export`,
      {
        params: { fmt: format },
        responseType: "blob",
      }
    );
    const filename = extractFilename(res.headers?.["content-disposition"]) ??
      `conversation.${format === "markdown" ? "md" : format}`;
    return { blob: res.data, filename };
  },
  /** Upload one or more conversations parsed from a Promptly /
   *  ChatGPT / Claude / Markdown export. Bulk-capable: a ChatGPT
   *  ``conversations.json`` usually contains hundreds of chats at
   *  once. Pass ``projectId`` to drop every imported chat into a
   *  project in one go. */
  async importConversations(
    file: File,
    projectId?: string | null
  ): Promise<ImportConversationsResponse> {
    const body = new FormData();
    body.append("file", file);
    if (projectId) body.append("project_id", projectId);
    const { data } = await apiClient.post<ImportConversationsResponse>(
      "/chat/conversations/import",
      body,
      {
        headers: { "Content-Type": "multipart/form-data" },
      }
    );
    return data;
  },
  streamUrl(streamId: string): string {
    // Used by useStreamingChat — must be absolute-ish since it flows through
    // nginx in prod and through vite proxy in dev.
    return `/api/chat/stream/${streamId}`;
  },
  /** Ask the backend whether a generation is still running for this
   *  conversation. Returns the active stream id (or null). Used when
   *  the conversation page mounts after the user navigated away mid-
   *  reply — if a stream is found we re-attach to its live tail
   *  instead of leaving them watching a frozen "thinking" state. */
  async activeStream(conversationId: string): Promise<string | null> {
    const { data } = await apiClient.get<{ stream_id: string | null }>(
      `/chat/conversations/${conversationId}/active-stream`
    );
    return data.stream_id;
  },
  async search(q: string, limit = 20): Promise<ConversationSearchHit[]> {
    const { data } = await apiClient.get<ConversationSearchHit[]>(
      "/chat/conversations/search",
      { params: { q, limit } }
    );
    return data;
  },

  /** Compact the middle of a long conversation. Keeps the start and
   *  end verbatim and replaces the middle with a single system-role
   *  summary produced by the conversation's current model. */
  async compact(
    conversationId: string
  ): Promise<{ messages_removed: number; summary_message_id: string }> {
    const { data } = await apiClient.post<{
      messages_removed: number;
      summary_message_id: string;
    }>(`/chat/conversations/${conversationId}/compact`);
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

/** Pull the download filename out of a ``Content-Disposition`` header.
 *  Prefers the RFC 5987 ``filename*`` parameter (UTF-8 aware) and falls
 *  back to the plain ``filename``. Returns ``null`` if neither is
 *  present so the caller can pick a sensible default. */
function extractFilename(header: unknown): string | null {
  if (typeof header !== "string" || header.length === 0) return null;
  // filename*=UTF-8''<percent-encoded>
  const starMatch = /filename\*\s*=\s*([^']*)''([^;]+)/i.exec(header);
  if (starMatch) {
    try {
      return decodeURIComponent(starMatch[2].trim());
    } catch {
      // fall through to plain filename
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  if (plain) {
    return plain[1].trim();
  }
  return null;
}
