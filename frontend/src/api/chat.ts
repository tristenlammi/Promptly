import { apiClient } from "./client";
import type {
  ChatMessage,
  ConversationDetail,
  ConversationSearchHit,
  ConversationSummary,
  ReasoningEffort,
  SendMessageResponse,
  TemporaryMode,
  WebSearchMode,
} from "./types";

/** One of a workspace's pinned files, with whether the current chat has
 *  excluded it from its context (per-chat opt-out). */
export interface ConversationWorkspaceFile {
  file_id: string;
  filename: string;
  mime_type: string;
  excluded: boolean;
}

/** Response from ``POST /chat/conversations/{id}/summarise-to-workspace``.
 *  Returned to the SummariseToWorkspaceButton modal so it can show the
 *  resulting filename + offer an "Open workspace" deep-link. */
export interface SummariseToWorkspaceResult {
  file_id: string;
  filename: string;
  workspace_id: string;
  workspace_title: string;
  chars: number;
}

/** Single-row payload for the ``@``-mention autocomplete in the
 *  composer. Mirrors ``backend/app/chat/schemas.py::MentionCandidate``. */
export interface MentionCandidate {
  id: string;
  title: string;
  workspace_id: string | null;
  workspace_title: string | null;
  updated_at: string;
}

/** A workspace file (note / canvas / upload) offered in the @ popover
 *  when composing inside a workspace. All are UserFiles, referenced via
 *  the existing ``file:`` mention mechanism. */
export interface MentionFileCandidate {
  id: string;
  filename: string;
  kind: string; // 'note' | 'canvas' | 'file'
}

/** An MCP connector the user can invoke via ``@[name](connector:id)``. */
export interface MentionConnectorCandidate {
  id: string;
  name: string;
  slug: string;
  kind: string; // 'mcp' | 'unifi' | …
  tool_count: number;
}

export interface CreateConversationPayload {
  title?: string | null;
  model_id?: string | null;
  provider_id?: string | null;
  web_search_mode?: WebSearchMode;
  /** DeepSeek-only knob. Omit / `null` for any non-DeepSeek chat. */
  reasoning_effort?: ReasoningEffort | null;
  /** Phase Z1 — request a temporary chat. ``null`` / undefined produces
   *  a normal permanent chat. The server computes ``expires_at`` from
   *  the chosen mode; the client only picks the policy. */
  temporary_mode?: TemporaryMode | null;
  /** Phase P1 — create under a workspace. Temporary chats can't
   *  belong to a workspace (enforced server-side). */
  workspace_id?: string | null;
}

export interface UpdateConversationPayload {
  title?: string | null;
  pinned?: boolean;
  starred?: boolean;
  web_search_mode?: WebSearchMode;
  reasoning_effort?: ReasoningEffort;
  model_id?: string | null;
  provider_id?: string | null;
  /** Phase P1 — move this chat into / out of a workspace. Pass a workspace
   *  id to move; pass ``null`` to detach. Omit to leave unchanged. */
  workspace_id?: string | null;
  /** Phase 1 — per-conversation custom instructions. Pass a string to
   *  set (empty string clears it); omit to leave unchanged. */
  system_prompt?: string;
  /** Phase 9 — pause / resume auto-memory capture for this conversation. */
  memory_capture_paused?: boolean;
  /** "Keep this chat" — pass ``null`` to promote a temporary chat to a
   *  permanent one. Only clearing is accepted by the server. */
  temporary_mode?: TemporaryMode | null;
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
  /** DeepSeek-only. Same override-then-persist semantics as
   *  `web_search_mode`. Omit to use the conversation's stored value. */
  reasoning_effort?: ReasoningEffort | null;
  temperature?: number | null;
  max_tokens?: number | null;
  /** IDs of files picked via the paperclip modal. */
  attachment_ids?: string[];
  /** Phase 9 — RAG-index the attachments into a conversation-scoped store
   *  instead of inlining them. Set by the composer's overflow warning. */
  index_attachments?: boolean;
  /** Per-turn opt-in to expose the artefact tool catalog (PDF / image
   *  generation). Search tools (``web_search`` / ``fetch_url``) ride
   *  on ``web_search_mode``, not this flag. The backend defaults to
   *  ``false`` so omitting this is a no-artefact-tool turn. */
  tools_enabled?: boolean;
  /** Voice mode (Phase 2): this turn was spoken in the hands-free voice
   *  overlay. The backend shortens the reply to a spoken, conversational
   *  length (no markdown/lists/code) and applies a token backstop. Omit
   *  / false for typed messages. */
  voice?: boolean;
}

/** Edit-and-resend payload. Attachments aren't sent — the backend
 *  preserves whatever was attached when the message was first posted. */
export interface EditMessagePayload {
  content: string;
  provider_id?: string | null;
  model_id?: string | null;
  web_search_mode?: WebSearchMode | null;
  reasoning_effort?: ReasoningEffort | null;
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
  reasoning_effort?: ReasoningEffort | null;
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
  async list(
    limit = 50,
    offset = 0,
    archived = false
  ): Promise<ConversationSummary[]> {
    const { data } = await apiClient.get<ConversationSummary[]>(
      "/chat/conversations",
      { params: { limit, offset, archived } }
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
  /** Soft-archive a chat — hides it from the sidebar + global search and
   *  moves it to the Archive page. Returns the updated summary. */
  async archive(id: string): Promise<ConversationSummary> {
    const { data } = await apiClient.post<ConversationSummary>(
      `/chat/conversations/${id}/archive`
    );
    return data;
  },
  /** Restore an archived chat back to the active sidebar list. */
  async unarchive(id: string): Promise<ConversationSummary> {
    const { data } = await apiClient.post<ConversationSummary>(
      `/chat/conversations/${id}/unarchive`
    );
    return data;
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
  /** Resume a truncated assistant reply — streams more text onto the end
   *  of the same message rather than producing a fresh sibling. */
  async continueMessage(
    conversationId: string,
    messageId: string,
    payload: RegenerateMessagePayload = {}
  ): Promise<SendMessageResponse> {
    const { data } = await apiClient.post<SendMessageResponse>(
      `/chat/conversations/${conversationId}/messages/${messageId}/continue`,
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
   *  once. Pass ``workspaceId`` to drop every imported chat into a
   *  workspace in one go. */
  async importConversations(
    file: File,
    workspaceId?: string | null
  ): Promise<ImportConversationsResponse> {
    const body = new FormData();
    body.append("file", file);
    if (workspaceId) body.append("workspace_id", workspaceId);
    const { data } = await apiClient.post<ImportConversationsResponse>(
      "/chat/conversations/import",
      body,
      {
        headers: { "Content-Type": "multipart/form-data" },
      }
    );
    return data;
  },
  /** Phase 3.2 — rewrite a rough composer draft into a sharper prompt.
   *  Stateless; returns the improved text for a preview/accept flow. */
  async enhancePrompt(
    text: string,
    providerId?: string | null,
    modelId?: string | null
  ): Promise<string> {
    const { data } = await apiClient.post<{ enhanced: string }>(
      `/chat/enhance-prompt`,
      { text, provider_id: providerId ?? null, model_id: modelId ?? null }
    );
    return data.enhanced;
  },
  /** Phase 5 — apply a natural-language change to a code artifact and
   *  return the full updated source for in-place patching. */
  async editArtifact(
    source: string,
    language: string,
    instruction: string,
    providerId?: string | null,
    modelId?: string | null
  ): Promise<string> {
    const { data } = await apiClient.post<{ updated: string }>(
      `/chat/edit-artifact`,
      {
        source,
        language,
        instruction,
        provider_id: providerId ?? null,
        model_id: modelId ?? null,
      }
    );
    return data.updated;
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
  async search(
    q: string,
    limit = 20,
    opts: { workspaceId?: string; start?: string; end?: string } = {}
  ): Promise<ConversationSearchHit[]> {
    const { workspaceId, start, end } = opts;
    const trimmed = q.trim();
    const { data } = await apiClient.get<ConversationSearchHit[]>(
      "/chat/conversations/search",
      {
        params: {
          // ``q`` is omitted entirely when empty so the backend switches
          // into date-only browse mode rather than rejecting the request.
          ...(trimmed ? { q: trimmed } : {}),
          limit,
          ...(workspaceId ? { workspace_id: workspaceId } : {}),
          ...(start ? { start } : {}),
          ...(end ? { end } : {}),
        },
      }
    );
    return data;
  },

  /** The workspace's pinned files with this chat's per-file excluded flag
   *  (empty when the chat isn't in a workspace). */
  async listConversationWorkspaceFiles(
    conversationId: string
  ): Promise<ConversationWorkspaceFile[]> {
    const { data } = await apiClient.get<ConversationWorkspaceFile[]>(
      `/chat/conversations/${conversationId}/workspace-files`
    );
    return data;
  },

  async toggleConversationWorkspaceFile(
    conversationId: string,
    fileId: string,
    excluded: boolean
  ): Promise<void> {
    await apiClient.put(
      `/chat/conversations/${conversationId}/workspace-files/${fileId}`,
      { excluded }
    );
  },

  /** Fetch candidates for the ``@``-mention autocomplete. When a
   *  ``workspace_id`` is provided, sibling chats in that workspace are
   *  surfaced separately (UI groups them above the generic
   *  recents). Excludes the caller's current conversation so
   *  self-references never appear. */
  async mentionCandidates(params: {
    q?: string;
    workspaceId?: string | null;
    excludeId?: string | null;
    limit?: number;
  }): Promise<{
    workspace_context_id: string | null;
    workspace_candidates: MentionCandidate[];
    recent_candidates: MentionCandidate[];
    workspace_file_candidates: MentionFileCandidate[];
    connector_candidates: MentionConnectorCandidate[];
  }> {
    const { data } = await apiClient.get<{
      workspace_context_id: string | null;
      workspace_candidates: MentionCandidate[];
      recent_candidates: MentionCandidate[];
      workspace_file_candidates: MentionFileCandidate[];
      connector_candidates: MentionConnectorCandidate[];
    }>("/chat/conversations/mention-candidates", {
      params: {
        q: params.q ?? "",
        workspace_id: params.workspaceId ?? undefined,
        exclude_id: params.excludeId ?? undefined,
        limit: params.limit ?? 12,
      },
    });
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

  /** Generate a standalone Markdown summary of the whole chat and
   *  pin it as a file to the conversation's parent workspace, so every
   *  other chat in that workspace picks it up on the next turn. Only
   *  valid for owner-role conversations that already live inside a
   *  workspace. */
  async summariseToWorkspace(
    conversationId: string
  ): Promise<SummariseToWorkspaceResult> {
    const { data } = await apiClient.post<SummariseToWorkspaceResult>(
      `/chat/conversations/${conversationId}/summarise-to-workspace`
    );
    return data;
  },

  /** In-place edit of an assistant reply — no re-stream, no
   *  truncation, no quota debit. Owner-only on the backend. The
   *  returned ``ChatMessage`` carries the new ``edited_at`` stamp
   *  so the caller can update the local store and surface the
   *  "edited" badge without a hard refresh. */
  async editAssistantMessage(
    conversationId: string,
    messageId: string,
    content: string
  ): Promise<ChatMessage> {
    const { data } = await apiClient.patch<ChatMessage>(
      `/chat/conversations/${conversationId}/messages/${messageId}`,
      { content }
    );
    return data;
  },

  /** Delete a single message. Owner-only on the backend; deletes
   *  exactly the targeted row (no cascade to later turns). */
  async deleteMessage(
    conversationId: string,
    messageId: string
  ): Promise<void> {
    await apiClient.delete(
      `/chat/conversations/${conversationId}/messages/${messageId}`
    );
  },

  /** Rate an assistant reply thumbs up / down (Phase 2.5). Pass
   *  ``rating: null`` to clear an existing rating. Returns the updated
   *  message so the caller can reconcile its store. */
  async setMessageFeedback(
    conversationId: string,
    messageId: string,
    rating: "up" | "down" | null,
    reason?: string
  ): Promise<ChatMessage> {
    const { data } = await apiClient.put<ChatMessage>(
      `/chat/conversations/${conversationId}/messages/${messageId}/feedback`,
      { rating, reason }
    );
    return data;
  },

  // ---- Phase 2.6 — in-thread regeneration versioning ----
  /** Switch the visible thread to a sibling version. ``messageId`` is
   *  the sibling picked from the ``‹ 2/3 ›`` pager. Returns the full
   *  conversation detail with the newly-resolved active path so the
   *  caller can replace its message list. */
  async activateMessageVersion(
    conversationId: string,
    messageId: string
  ): Promise<ConversationDetail> {
    const { data } = await apiClient.post<ConversationDetail>(
      `/chat/conversations/${conversationId}/messages/${messageId}/activate`
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
    messageId: string,
    opts?: { ephemeral?: boolean }
  ): Promise<ConversationSummary> {
    const { data } = await apiClient.post<ConversationSummary>(
      `/chat/conversations/${conversationId}/branch`,
      { message_id: messageId, ephemeral: opts?.ephemeral ?? false }
    );
    return data;
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

// ---------------------------------------------------------------------
// Workspace write-back proposals (Batch 4.1) — the AI files these from
// workspace chats; the user applies/dismisses from a preview card.
// ---------------------------------------------------------------------
export interface WorkspaceProposalCard {
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high";
  due_date?: string;
}

export interface WorkspaceProposal {
  id: string;
  conversation_id: string;
  workspace_id: string;
  kind: "create_note" | "add_cards";
  payload: {
    title?: string;
    markdown?: string;
    board_item_id?: string;
    board_title?: string;
    cards?: WorkspaceProposalCard[];
  };
  status: "pending" | "applied" | "dismissed";
  applied_item_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export const proposalsApi = {
  async list(conversationId: string): Promise<WorkspaceProposal[]> {
    const { data } = await apiClient.get<WorkspaceProposal[]>(
      `/chat/conversations/${conversationId}/proposals`
    );
    return data;
  },
  async apply(proposalId: string): Promise<WorkspaceProposal> {
    const { data } = await apiClient.post<WorkspaceProposal>(
      `/chat/proposals/${proposalId}/apply`
    );
    return data;
  },
  async dismiss(proposalId: string): Promise<WorkspaceProposal> {
    const { data } = await apiClient.post<WorkspaceProposal>(
      `/chat/proposals/${proposalId}/dismiss`
    );
    return data;
  },
};
