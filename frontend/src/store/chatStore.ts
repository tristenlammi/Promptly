import { create } from "zustand";

import type {
  ChatMessage,
  ConversationSummary,
  MessageAttachmentSnapshot,
  Source,
  ToolInvocation,
  VisionRelayInvocation,
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
  /** Facts captured into cross-chat memory during the current stream
   *  (Phase 6 + 2.2). Drives the transient "saved to memory" affordance
   *  with Undo support. Each entry carries the DB id so the chip can
   *  delete individual facts. Cleared at the start of each new stream. */
  memorySaved: Array<{ id: string; content: string }>;
  /** Facts that were retrieved and injected into this turn's system prompt
   *  (Phase 3.2). Drives the in-chat "🧠 N memories in context" chip.
   *  Cleared at the start of each new stream. */
  memoriesUsed: Array<{ id: string; content: string }>;
  /** Live-tracking of tool calls fired during the current stream. Entries
   *  are appended on ``tool_started`` and updated in place on
   *  ``tool_finished``. Cleared at the start of each new stream because
   *  the persisted assistant message holds the lasting record (text +
   *  attachments) — these entries only drive the in-flight UI. */
  toolInvocations: ToolInvocation[];
  /** Live-tracking of vision-relay captioning calls fired during the
   *  current stream (one per image attached to a chat whose model
   *  can't read images natively). Same lifecycle as ``toolInvocations``
   *  — appended on ``vision_relay_started``, updated in place on
   *  ``vision_relay_finished``, cleared at the start of the next
   *  stream. The chat model already received the caption text, so
   *  once the assistant reply commits the lasting record is the
   *  reply itself. */
  visionRelayInvocations: VisionRelayInvocation[];
  /** Attachments produced by tools during the current (still in-flight)
   *  stream. Mirrored onto the assistant message when the stream ends
   *  via the ``done`` payload, but kept here so the streaming bubble can
   *  render chips before the message is committed. */
  streamingAttachments: MessageAttachmentSnapshot[] | null;
  /** True while an outbound send or an open SSE stream is in flight. */
  isStreaming: boolean;
  streamError: string | null;
  /** Structured metadata about a classified upstream error. Populated
   *  alongside ``streamError`` when the backend recognises the failure
   *  mode (e.g. OpenRouter privacy filter); used by the chat error
   *  card to render a richer actionable message instead of the raw
   *  red banner. ``null`` means "just a plain error — no extra UX". */
  streamErrorMeta: StreamErrorMeta | null;

  setConversations: (items: ConversationSummary[]) => void;
  upsertConversation: (c: ConversationSummary) => void;
  removeConversation: (id: string) => void;
  setActive: (id: string | null) => void;
  setMessages: (messages: ChatMessage[]) => void;
  appendMessage: (message: ChatMessage) => void;
  /** Swap a message (matched by id) for a new one. Used to reconcile an
   *  optimistic client-side user message with the server-persisted copy. */
  replaceMessage: (id: string, message: ChatMessage) => void;
  /** Remove a single message by id. Used by the delete-message action;
   *  no-op when the id isn't present. */
  removeMessage: (id: string) => void;
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
  /** Record facts the backend just saved to memory this turn. */
  setMemorySaved: (facts: Array<{ id: string; content: string }>) => void;
  dismissMemorySaved: () => void;
  /** Record which facts were injected into this turn's system prompt (Phase 3.2). */
  setMemoriesUsed: (facts: Array<{ id: string; content: string }>) => void;
  dismissMemoriesUsed: () => void;
  /** Add a freshly-started tool call. No-op if an entry with the same
   *  id already exists (defensive against duplicate ``tool_started``
   *  events from a flaky proxy). */
  startToolInvocation: (id: string, name: string) => void;
  /** Update a running invocation's progress note (``tool_progress``).
   *  No-op if the id isn't tracked. */
  updateToolProgress: (id: string, message: string) => void;
  /** Move an invocation from ``pending`` to ``ok`` / ``error`` and
   *  attach its result. Silently dropped if the id isn't tracked
   *  (would only happen if a ``tool_finished`` arrived without a
   *  matching ``tool_started``, which is itself a backend bug). */
  finishToolInvocation: (
    id: string,
    update: {
      ok: boolean;
      error?: string | null;
      errorKind?: string | null;
      elapsedMs?: number | null;
      attachments?: MessageAttachmentSnapshot[] | null;
      meta?: Record<string, unknown> | null;
    }
  ) => void;
  /** Append a freshly-started vision-relay caption call. No-op when an
   *  entry with the same id already exists, so a duplicate
   *  ``vision_relay_started`` from a flaky proxy can't desync the UI. */
  startVisionRelay: (
    invocation: Omit<VisionRelayInvocation, "status" | "caption" | "error">
  ) => void;
  /** Move a relay invocation from ``pending`` to ``ok``/``error`` and
   *  attach its caption (success) or error (failure). Silently dropped
   *  when the id isn't tracked — same defensive pattern as
   *  ``finishToolInvocation``. */
  finishVisionRelay: (
    id: string,
    update: {
      ok: boolean;
      caption?: string | null;
      error?: string | null;
    }
  ) => void;
  appendStreamingAttachments: (
    attachments: MessageAttachmentSnapshot[]
  ) => void;
  resetStream: () => void;
  setStreamError: (err: string | null, meta?: StreamErrorMeta | null) => void;
}

/** Classified upstream error metadata — backend sets these fields on
 *  the SSE ``error`` payload for known failure modes, and the chat
 *  error card uses them to render a richer card (help link, title,
 *  tone) instead of the default red banner. Extending this type is
 *  the hook for adding new classified error cards in the future. */
export interface StreamErrorMeta {
  /** Stable code matching the backend's classification (e.g.
   *  ``"openrouter_privacy_blocked"``). */
  code: string;
  /** Short, human-readable summary shown as the card title. */
  title?: string | null;
  /** Optional external URL the user can click through to resolve
   *  the issue (e.g. the OpenRouter privacy settings page). */
  helpUrl?: string | null;
  /** Seconds to wait before retrying (rate-limit errors only) — drives
   *  the error card's retry countdown. */
  retryAfter?: number | null;
}

export const useChatStore = create<ChatState>((set) => ({
  conversations: [],
  activeId: null,
  messages: [],
  streamingContent: "",
  streamingSources: null,
  visionWarnings: [],
  memorySaved: [],
  memoriesUsed: [],
  toolInvocations: [],
  visionRelayInvocations: [],
  streamingAttachments: null,
  isStreaming: false,
  streamError: null,
  streamErrorMeta: null,

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
  removeMessage: (id) =>
    set((state) => ({
      messages: state.messages.filter((m) => m.id !== id),
    })),
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
  setMemorySaved: (facts) => set({ memorySaved: facts }),
  dismissMemorySaved: () => set({ memorySaved: [] }),
  setMemoriesUsed: (facts) => set({ memoriesUsed: facts }),
  dismissMemoriesUsed: () => set({ memoriesUsed: [] }),
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
  updateToolProgress: (id, message) =>
    set((state) => ({
      toolInvocations: state.toolInvocations.map((t) =>
        t.id === id ? { ...t, progressMessage: message } : t
      ),
    })),
  finishToolInvocation: (id, update) =>
    set((state) => ({
      toolInvocations: state.toolInvocations.map((t) =>
        t.id === id
          ? {
              ...t,
              status: update.ok ? "ok" : "error",
              progressMessage: null,
              error: update.error ?? null,
              errorKind: update.errorKind ?? null,
              elapsedMs: update.elapsedMs ?? null,
              attachments: update.attachments ?? null,
              meta: update.meta ?? null,
            }
          : t
      ),
    })),
  startVisionRelay: (invocation) =>
    set((state) => {
      if (state.visionRelayInvocations.some((v) => v.id === invocation.id))
        return {};
      return {
        visionRelayInvocations: [
          ...state.visionRelayInvocations,
          { ...invocation, status: "pending" },
        ],
      };
    }),
  finishVisionRelay: (id, update) =>
    set((state) => ({
      visionRelayInvocations: state.visionRelayInvocations.map((v) =>
        v.id === id
          ? {
              ...v,
              status: update.ok ? "ok" : "error",
              caption: update.caption ?? null,
              error: update.error ?? null,
            }
          : v
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
      memorySaved: [],
      memoriesUsed: [],
      toolInvocations: [],
      visionRelayInvocations: [],
      streamingAttachments: null,
      isStreaming: false,
      streamError: null,
      streamErrorMeta: null,
    }),
  setStreamError: (streamError, streamErrorMeta = null) =>
    set({ streamError, streamErrorMeta }),
}));
