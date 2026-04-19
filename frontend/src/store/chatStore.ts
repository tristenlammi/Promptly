import { create } from "zustand";

import type {
  ChatMessage,
  ConversationSummary,
  MessageAttachmentSnapshot,
  Source,
  ToolInvocation,
} from "@/api/types";

interface ChatState {
  conversations: ConversationSummary[];
  activeId: string | null;
  messages: ChatMessage[];
  /** Assistant text currently being streamed (not yet persisted). */
  streamingContent: string;
  /** Sources received via SSE during the current stream. */
  streamingSources: Source[] | null;
  /** Vision-related warnings emitted by the backend at stream start (non-
   *  vision model + image attachment, oversized image, etc). One entry
   *  per warning, in the order they arrived. Cleared when the next
   *  stream begins. */
  visionWarnings: string[];
  /** Live-tracking of tool calls fired during the current stream. Entries
   *  are appended on ``tool_started`` and updated in place on
   *  ``tool_finished``. Cleared at the start of each new stream because
   *  the persisted assistant message holds the lasting record (text +
   *  attachments) — these entries only drive the in-flight UI. */
  toolInvocations: ToolInvocation[];
  /** Attachments produced by tools during the current (still in-flight)
   *  stream. Mirrored onto the assistant message when the stream ends
   *  via the ``done`` payload, but kept here so the streaming bubble can
   *  render chips before the message is committed. */
  streamingAttachments: MessageAttachmentSnapshot[] | null;
  /** True while an outbound send or an open SSE stream is in flight. */
  isStreaming: boolean;
  streamError: string | null;

  setConversations: (items: ConversationSummary[]) => void;
  upsertConversation: (c: ConversationSummary) => void;
  removeConversation: (id: string) => void;
  setActive: (id: string | null) => void;
  setMessages: (messages: ChatMessage[]) => void;
  appendMessage: (message: ChatMessage) => void;
  /** Swap a message (matched by id) for a new one. Used to reconcile an
   *  optimistic client-side user message with the server-persisted copy. */
  replaceMessage: (id: string, message: ChatMessage) => void;
  /** Drop every message strictly *after* the one with this id. Used by
   *  the edit-and-resend flow so the stale assistant reply disappears
   *  before the new stream re-renders one in its place. No-op when the
   *  id isn't found, so transient races (e.g. mid-stream edits) can't
   *  accidentally wipe the list. */
  truncateAfter: (id: string) => void;
  setStreaming: (streaming: boolean) => void;
  appendStreamingDelta: (delta: string) => void;
  setStreamingSources: (sources: Source[] | null) => void;
  /** Merge new sources into the in-flight list, deduping by URL.
   *  Called on every ``tool_finished`` event whose tool returned
   *  citations (web_search, fetch_url) so the bubble can render
   *  numbered references inline as the answer streams. */
  appendStreamingSources: (sources: Source[]) => void;
  addVisionWarning: (message: string) => void;
  dismissVisionWarning: (index: number) => void;
  clearVisionWarnings: () => void;
  /** Add a freshly-started tool call. No-op if an entry with the same
   *  id already exists (defensive against duplicate ``tool_started``
   *  events from a flaky proxy). */
  startToolInvocation: (id: string, name: string) => void;
  /** Move an invocation from ``pending`` to ``ok`` / ``error`` and
   *  attach its result. Silently dropped if the id isn't tracked
   *  (would only happen if a ``tool_finished`` arrived without a
   *  matching ``tool_started``, which is itself a backend bug). */
  finishToolInvocation: (
    id: string,
    update: {
      ok: boolean;
      error?: string | null;
      attachments?: MessageAttachmentSnapshot[] | null;
      meta?: Record<string, unknown> | null;
    }
  ) => void;
  appendStreamingAttachments: (
    attachments: MessageAttachmentSnapshot[]
  ) => void;
  resetStream: () => void;
  setStreamError: (err: string | null) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  conversations: [],
  activeId: null,
  messages: [],
  streamingContent: "",
  streamingSources: null,
  visionWarnings: [],
  toolInvocations: [],
  streamingAttachments: null,
  isStreaming: false,
  streamError: null,

  setConversations: (conversations) => set({ conversations }),
  upsertConversation: (c) =>
    set((state) => {
      const idx = state.conversations.findIndex((x) => x.id === c.id);
      const next = [...state.conversations];
      if (idx >= 0) next[idx] = c;
      else next.unshift(c);
      // Keep pinned first, then most-recent-updated.
      next.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updated_at.localeCompare(a.updated_at);
      });
      return { conversations: next };
    }),
  removeConversation: (id) =>
    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      activeId: state.activeId === id ? null : state.activeId,
      messages: state.activeId === id ? [] : state.messages,
    })),
  setActive: (activeId) => set({ activeId }),
  setMessages: (messages) => set({ messages }),
  appendMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),
  replaceMessage: (id, message) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? message : m)),
    })),
  truncateAfter: (id) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === id);
      if (idx < 0) return {};
      return { messages: state.messages.slice(0, idx + 1) };
    }),
  setStreaming: (isStreaming) => set({ isStreaming }),
  appendStreamingDelta: (delta) =>
    set((state) => ({ streamingContent: state.streamingContent + delta })),
  setStreamingSources: (streamingSources) => set({ streamingSources }),
  appendStreamingSources: (incoming) =>
    set((state) => {
      if (!incoming || incoming.length === 0) return {};
      // Dedupe by URL — the backend already canonicalises but two
      // tools (e.g. web_search + fetch_url) can legitimately return
      // the same hit, and we want one citation chip per unique URL.
      const seen = new Set<string>();
      const merged: Source[] = [];
      for (const s of [...(state.streamingSources ?? []), ...incoming]) {
        const key = (s.url || "").toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(s);
      }
      return { streamingSources: merged };
    }),
  addVisionWarning: (message) =>
    set((state) => ({ visionWarnings: [...state.visionWarnings, message] })),
  dismissVisionWarning: (index) =>
    set((state) => ({
      visionWarnings: state.visionWarnings.filter((_, i) => i !== index),
    })),
  clearVisionWarnings: () => set({ visionWarnings: [] }),
  startToolInvocation: (id, name) =>
    set((state) => {
      if (state.toolInvocations.some((t) => t.id === id)) return {};
      return {
        toolInvocations: [
          ...state.toolInvocations,
          { id, name, status: "pending" },
        ],
      };
    }),
  finishToolInvocation: (id, update) =>
    set((state) => ({
      toolInvocations: state.toolInvocations.map((t) =>
        t.id === id
          ? {
              ...t,
              status: update.ok ? "ok" : "error",
              error: update.error ?? null,
              attachments: update.attachments ?? null,
              meta: update.meta ?? null,
            }
          : t
      ),
    })),
  appendStreamingAttachments: (attachments) =>
    set((state) => ({
      streamingAttachments: [
        ...(state.streamingAttachments ?? []),
        ...attachments,
      ],
    })),
  resetStream: () =>
    set({
      streamingContent: "",
      streamingSources: null,
      visionWarnings: [],
      toolInvocations: [],
      streamingAttachments: null,
      isStreaming: false,
      streamError: null,
    }),
  setStreamError: (streamError) => set({ streamError }),
}));
