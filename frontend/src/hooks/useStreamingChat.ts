import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  chatApi,
  type EditMessagePayload,
  type RegenerateMessagePayload,
  type SendMessagePayload,
} from "@/api/chat";
import { authHeader } from "@/api/client";
import { useChatStore } from "@/store/chatStore";
import type {
  ChatMessage,
  ConversationSummary,
  MessageAttachmentSnapshot,
  Source,
} from "@/api/types";

/**
 * Parse a ReadableStream<Uint8Array> of SSE data. Yields a decoded string for
 * each complete `data: ...` event. Multi-line events are handled by joining on
 * newlines.
 */
async function* iterateSSE(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line.
      let sepIndex: number;
      while ((sepIndex = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, sepIndex);
        buf = buf.slice(sepIndex + 2);

        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }
        if (dataLines.length > 0) {
          yield dataLines.join("\n");
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface SSEPayload {
  event?: string;
  delta?: string;
  done?: boolean;
  error?: string;
  /** Structured classification for known upstream failure modes
   *  (e.g. ``"openrouter_privacy_blocked"``). Set alongside ``error``
   *  by the backend when the raw message matches a recognised
   *  pattern; the UI uses it to pick a richer error card. */
  error_code?: string;
  /** Short human-readable title for the classified error — used as
   *  the card heading when ``error_code`` is set. */
  error_title?: string;
  /** Optional external URL a user can click through to resolve the
   *  underlying account/config issue. Rendered as a button in the
   *  classified error card. */
  error_help_url?: string;
  message_id?: string;
  created_at?: string;
  stream_id?: string;
  // Search citations (attached to the ``tool_finished`` payload of
  // search-category tools and to the final ``done`` payload as the
  // deduped union of every search hit produced this turn).
  sources?: Source[] | null;
  // title_updated event
  title?: string;
  // vision_warning event (non-vision model + image attachment, etc.)
  message?: string;
  // memory_saved event (Phase 6 + 2.2) — durable facts captured this turn.
  // ``ids`` (Phase 2.2) maps 1:1 with ``facts`` so the UI can undo by id.
  facts?: string[];
  ids?: string[];
  count?: number;
  // tool_started / tool_finished events (Phase A1)
  id?: string;
  name?: string;
  ok?: boolean;
  attachments?: MessageAttachmentSnapshot[] | null;
  meta?: Record<string, unknown> | null;
  // vision_relay_started / vision_relay_finished events. Driven by the
  // chat router when a non-vision chat model receives an image
  // attachment and the admin has configured a vision-capable relay
  // model under Admin → Settings → Vision relay. Each image attached
  // to the triggering turn produces one started/finished pair.
  index?: number;
  filename?: string;
  relay_provider_name?: string;
  relay_model_id?: string;
  caption?: string | null;
  // Assistant performance metrics (attached to the `done` payload).
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  ttft_ms?: number | null;
  total_ms?: number | null;
  cost_usd?: number | null;
  // ``true`` when the upstream stopped because it hit the output-token
  // ceiling (finish_reason "length") rather than finishing naturally —
  // the reply is cut off mid-thought. Attached to the `done` payload.
  truncated?: boolean;
}

interface SendMessageOptions {
  /** If set, the store already contains an optimistic user message with this
   *  id (added by the caller for instant UI feedback). When the POST returns,
   *  we'll swap the optimistic message for the real persisted one in-place
   *  so React keeps the same DOM node and nothing flickers. */
  optimisticUserId?: string;
}

interface UseStreamingChatResult {
  sendMessage: (
    conversationId: string,
    payload: SendMessagePayload,
    options?: SendMessageOptions
  ) => Promise<void>;
  /** Edit a previously-sent user message and stream a fresh assistant reply.
   *  Caller is expected to have already truncated any stale assistant rows
   *  from the store before invoking this; the returned user_message will be
   *  swapped in via replaceMessage so React keeps the same DOM node. */
  editAndResend: (
    conversationId: string,
    messageId: string,
    payload: EditMessagePayload
  ) => Promise<void>;
  /** Re-stream an assistant reply (optionally with a different model /
   *  provider). The hook truncates any messages after ``messageId``
   *  server-side and delivers a fresh stream for the replaced turn. */
  regenerate: (
    conversationId: string,
    messageId: string,
    payload?: RegenerateMessagePayload
  ) => Promise<void>;
  /** Resume a truncated assistant reply, appending the continuation onto
   *  the same message so it reads as one answer. */
  continueGenerate: (
    conversationId: string,
    messageId: string,
    payload?: RegenerateMessagePayload
  ) => Promise<void>;
  /** Re-attach to a generation that's still running on the backend (the
   *  user navigated away mid-reply and came back). Replays the buffered
   *  transcript from the start, then tails the live token stream. The
   *  user-message is assumed to already be in the conversation history
   *  (the caller's GET /conversations/<id> populated it). */
  reattach: (conversationId: string, streamId: string) => Promise<void>;
  cancel: () => void;
}

/**
 * Hook that drives the chat send + SSE stream lifecycle. All state flows
 * through the chatStore so the UI can subscribe granularly.
 */
export function useStreamingChat(): UseStreamingChatResult {
  const qc = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => {
    return () => cancel();
  }, [cancel]);

  // Shared SSE drain loop. Called after either the send-message POST or
  // the edit-and-resend POST has returned a stream_id. The store has
  // already been mutated to reflect the user-facing message at this
  // point; this just streams the assistant reply on top.
  const drainStream = useCallback(
    async (
      conversationId: string,
      streamId: string,
      ac: AbortController
    ): Promise<void> => {
      const store = useChatStore.getState();

      const resp = await fetch(chatApi.streamUrl(streamId), {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          ...authHeader(),
        },
        signal: ac.signal,
      });
      if (!resp.ok || !resp.body) {
        const body = resp.body ? await resp.text() : "";
        throw new Error(
          `Stream failed: ${resp.status} ${resp.statusText}${body ? ` — ${body}` : ""}`
        );
      }

      let finalMessage: ChatMessage | null = null;
      let finalSources: Source[] | null = null;
      let finalAttachments: MessageAttachmentSnapshot[] | null = null;

      // ---- Delta batching ----
      // Writing to the store on *every* token (often many per second)
      // forces a re-render + full markdown re-parse of the growing
      // bubble each time, which locks up the main thread on long
      // replies. Instead we buffer incoming tokens and flush at most
      // once per animation frame (~60fps), so render frequency is
      // decoupled from token frequency. ``flushDelta`` is also called
      // synchronously before we read ``streamingContent`` on ``done``
      // and in the ``finally`` so nothing is left unflushed.
      let pendingDelta = "";
      let rafHandle: number | null = null;
      const flushDelta = () => {
        rafHandle = null;
        if (pendingDelta) {
          useChatStore.getState().appendStreamingDelta(pendingDelta);
          pendingDelta = "";
        }
      };
      const scheduleFlush = () => {
        if (rafHandle == null) {
          rafHandle =
            typeof requestAnimationFrame === "function"
              ? requestAnimationFrame(flushDelta)
              : (setTimeout(flushDelta, 16) as unknown as number);
        }
      };
      const cancelScheduledFlush = () => {
        if (rafHandle != null) {
          if (typeof cancelAnimationFrame === "function") {
            cancelAnimationFrame(rafHandle);
          } else {
            clearTimeout(rafHandle);
          }
          rafHandle = null;
        }
      };

      try {
        for await (const raw of iterateSSE(resp.body, ac.signal)) {
        let data: SSEPayload;
        try {
          data = JSON.parse(raw) as SSEPayload;
        } catch {
          continue;
        }

        if (data.error && !data.event) {
          // When the backend classified the error we pass structured
          // metadata so the chat error card can render buttons/links
          // instead of the raw provider dump. Unknown errors fall
          // through with ``meta=null`` and render as a plain banner.
          const meta = data.error_code
            ? {
                code: data.error_code,
                title: data.error_title ?? null,
                helpUrl: data.error_help_url ?? null,
              }
            : null;
          store.setStreamError(data.error, meta);
          continue;
        }

        if (data.event === "vision_warning" && data.message) {
          store.addVisionWarning(data.message);
          continue;
        }
        if (
          data.event === "memory_saved" &&
          data.facts &&
          data.facts.length > 0
        ) {
          // Pair facts with their ids (Phase 2.2 — Undo support).
          // Falls back to empty-string ids for older backends.
          const items = data.facts.map(
            (content: string, i: number) => ({
              id: data.ids?.[i] ?? "",
              content,
            })
          );
          store.setMemorySaved(items);
          continue;
        }
        if (data.event === "vision_relay_started" && data.id) {
          store.startVisionRelay({
            id: data.id,
            index: data.index ?? 1,
            filename: data.filename ?? "image",
            relayProviderName: data.relay_provider_name ?? "Vision relay",
            relayModelId: data.relay_model_id ?? "",
          });
          continue;
        }
        if (data.event === "vision_relay_finished" && data.id) {
          store.finishVisionRelay(data.id, {
            ok: !!data.ok,
            caption: data.caption ?? null,
            error: data.error ?? null,
          });
          continue;
        }
        if (data.event === "tool_started" && data.id && data.name) {
          store.startToolInvocation(data.id, data.name);
          continue;
        }
        if (data.event === "tool_finished" && data.id) {
          store.finishToolInvocation(data.id, {
            ok: !!data.ok,
            error: data.error ?? null,
            attachments: data.attachments ?? null,
            meta: data.meta ?? null,
          });
          // Mirror the tool's attachments onto the in-flight bubble so
          // the chip renders next to the streaming text immediately,
          // not just after `done` lands.
          if (data.ok && data.attachments && data.attachments.length > 0) {
            store.appendStreamingAttachments(data.attachments);
          }
          // Phase D2: search tools (``web_search``, ``fetch_url``)
          // return citations on ``data.sources``. Merge them into the
          // in-flight source list so the SourcesFooter + inline ``[n]``
          // citation chips can render against the streaming text, not
          // just once the assistant message lands.
          if (data.ok && data.sources && data.sources.length > 0) {
            store.appendStreamingSources(data.sources);
            finalSources = useChatStore.getState().streamingSources;
          }
          continue;
        }
        if (data.event === "tool_error" && data.error) {
          // The MAX_TOOL_HOPS guard. Surface as a stream error so the
          // existing red banner picks it up — no need for a bespoke UI.
          store.setStreamError(data.error);
          continue;
        }
        if (data.event === "title_updated" && data.title) {
          // Backend auto-generated the chat title after the first turn —
          // reflect it everywhere the UI reads titles from.
          const nextTitle = data.title;
          const current = useChatStore
            .getState()
            .conversations.find((c) => c.id === conversationId);
          if (current) {
            useChatStore.getState().upsertConversation({
              ...current,
              title: nextTitle,
            });
          }
          qc.setQueryData<ConversationSummary>(
            ["conversation", conversationId],
            (old) => (old ? { ...old, title: nextTitle } : old)
          );
          continue;
        }

        if (data.delta) {
          pendingDelta += data.delta;
          scheduleFlush();
        }
        if (data.done) {
          // Flush any buffered tokens before we snapshot the content
          // for the persisted message, otherwise the final bubble can
          // drop the last frame's worth of text.
          cancelScheduledFlush();
          flushDelta();
          const currentContent = useChatStore.getState().streamingContent;
          if (data.sources) finalSources = data.sources;
          if (data.attachments) finalAttachments = data.attachments;
          if (data.message_id && data.created_at) {
            finalMessage = {
              id: data.message_id,
              conversation_id: conversationId,
              role: "assistant",
              content: currentContent,
              sources: finalSources,
              attachments: finalAttachments,
              created_at: data.created_at,
              prompt_tokens: data.prompt_tokens ?? null,
              completion_tokens: data.completion_tokens ?? null,
              ttft_ms: data.ttft_ms ?? null,
              total_ms: data.total_ms ?? null,
              cost_usd: data.cost_usd ?? null,
              truncated: data.truncated ?? false,
            };
          }
          break;
        }
        }
      } finally {
        // Whether we finished cleanly, broke on ``done``, or threw /
        // aborted mid-stream, make sure no animation-frame callback is
        // left pending (it would otherwise fire after the store was
        // reset and re-append stale text) and that any buffered tokens
        // land so a cancelled-but-partial reply keeps its last frame.
        cancelScheduledFlush();
        flushDelta();
      }

      if (finalMessage) {
        store.appendMessage(finalMessage);
      }
    },
    [qc]
  );

  const sendMessage = useCallback(
    async (
      conversationId: string,
      payload: SendMessagePayload,
      options?: SendMessageOptions
    ) => {
      const store = useChatStore.getState();
      cancel();
      const ac = new AbortController();
      abortRef.current = ac;

      // `resetStream` zeroes streamingContent/sources/tool state and flips
      // isStreaming to false. The caller may have already set
      // isStreaming=true (to show the thinking indicator before this hook
      // runs) — re-assert it here.
      store.resetStream();
      store.setStreaming(true);

      try {
        const { stream_id, user_message } = await chatApi.sendMessage(
          conversationId,
          payload
        );
        if (options?.optimisticUserId) {
          store.replaceMessage(options.optimisticUserId, user_message);
        } else {
          store.appendMessage(user_message);
        }

        await drainStream(conversationId, stream_id, ac);
      } catch (err) {
        if (ac.signal.aborted) {
          // Caller cancelled — partial content is already in streamingContent.
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        store.setStreamError(msg);
      } finally {
        abortRef.current = null;
        useChatStore.getState().setStreaming(false);
        qc.invalidateQueries({ queryKey: ["conversations"] });
        qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
        useChatStore.setState({
          streamingContent: "",
          streamingSources: null,
          streamingAttachments: null,
          toolInvocations: [],
          visionRelayInvocations: [],
        });
      }
    },
    [cancel, drainStream, qc]
  );

  const editAndResend = useCallback(
    async (
      conversationId: string,
      messageId: string,
      payload: EditMessagePayload
    ) => {
      const store = useChatStore.getState();
      cancel();
      const ac = new AbortController();
      abortRef.current = ac;

      store.resetStream();
      store.setStreaming(true);

      try {
        // POST the edit. Phase 2.6 — the backend now inserts the edited
        // turn as a *sibling* (new id) rather than rewriting in place,
        // and returns that new ``user_message`` + a fresh stream_id.
        const { stream_id, user_message } = await chatApi.editMessage(
          conversationId,
          messageId,
          payload
        );

        // Reflect the edit locally: swap the old turn out for the new
        // sibling and drop everything after it (truncate by the *new*
        // id, since the old one is no longer in the list). The drain
        // below appends the fresh reply; the finally-block conversation
        // refetch then backfills the ‹ 2/3 › version metadata.
        store.replaceMessage(messageId, user_message);
        store.truncateAfter(user_message.id);

        await drainStream(conversationId, stream_id, ac);
      } catch (err) {
        if (ac.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        store.setStreamError(msg);
      } finally {
        abortRef.current = null;
        useChatStore.getState().setStreaming(false);
        qc.invalidateQueries({ queryKey: ["conversations"] });
        qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
        useChatStore.setState({
          streamingContent: "",
          streamingSources: null,
          streamingAttachments: null,
          toolInvocations: [],
          visionRelayInvocations: [],
        });
      }
    },
    [cancel, drainStream, qc]
  );

  const reattach = useCallback(
    async (conversationId: string, streamId: string) => {
      const store = useChatStore.getState();
      cancel();
      const ac = new AbortController();
      abortRef.current = ac;

      // Drop any stale streaming state from a previous turn — the
      // backend will replay this stream's events from index 0 so we
      // start from a known-clean slate.
      store.resetStream();
      store.setStreaming(true);

      try {
        await drainStream(conversationId, streamId, ac);
      } catch (err) {
        if (ac.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        store.setStreamError(msg);
      } finally {
        abortRef.current = null;
        useChatStore.getState().setStreaming(false);
        qc.invalidateQueries({ queryKey: ["conversations"] });
        qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
        useChatStore.setState({
          streamingContent: "",
          streamingSources: null,
          streamingAttachments: null,
          toolInvocations: [],
          visionRelayInvocations: [],
        });
      }
    },
    [cancel, drainStream, qc]
  );

  const regenerate = useCallback(
    async (
      conversationId: string,
      assistantMessageId: string,
      payload: RegenerateMessagePayload = {}
    ) => {
      const store = useChatStore.getState();
      cancel();
      const ac = new AbortController();
      abortRef.current = ac;

      store.resetStream();
      store.setStreaming(true);

      try {
        // Kicks off the fresh stream on the server. The returned
        // ``user_message`` is the unchanged prompt that triggered the
        // reply — we don't need to splice it in, but we do need to
        // drop the stale assistant turn(s) locally so the UI matches
        // the server's "clean tail" state before streaming resumes.
        const { stream_id, user_message } = await chatApi.regenerateMessage(
          conversationId,
          assistantMessageId,
          payload
        );

        // Everything from the prompt's id forward stays, but the
        // assistant reply (and any trailing tool-sidecar rows) must
        // go — drainStream will replace them with the new content
        // as it arrives.
        store.truncateAfter(user_message.id);

        await drainStream(conversationId, stream_id, ac);
      } catch (err) {
        if (ac.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        store.setStreamError(msg);
      } finally {
        abortRef.current = null;
        useChatStore.getState().setStreaming(false);
        qc.invalidateQueries({ queryKey: ["conversations"] });
        qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
        useChatStore.setState({
          streamingContent: "",
          streamingSources: null,
          streamingAttachments: null,
          toolInvocations: [],
          visionRelayInvocations: [],
        });
      }
    },
    [cancel, drainStream, qc]
  );

  const continueGenerate = useCallback(
    async (
      conversationId: string,
      assistantMessageId: string,
      payload: RegenerateMessagePayload = {}
    ) => {
      const store = useChatStore.getState();
      cancel();
      const ac = new AbortController();
      abortRef.current = ac;

      // Snapshot the truncated reply BEFORE we touch the store so we can
      // seed the streaming buffer with it — the continuation streams onto
      // the end and the server appends to the same row, so the final
      // bubble reads as one continuous answer.
      const target = store.messages.find((m) => m.id === assistantMessageId);
      const partial = target?.content ?? "";
      const partialSources = target?.sources ?? null;
      const partialAttachments = target?.attachments ?? null;

      store.resetStream();
      store.setStreaming(true);

      try {
        const { stream_id, user_message } = await chatApi.continueMessage(
          conversationId,
          assistantMessageId,
          payload
        );

        // Drop the partial assistant row from the list; the streaming
        // bubble (seeded below) renders in its place and `done` re-adds
        // the merged message under the same id.
        store.truncateAfter(user_message.id);
        useChatStore.setState({
          streamingContent: partial,
          streamingSources: partialSources,
          streamingAttachments: partialAttachments,
        });

        await drainStream(conversationId, stream_id, ac);
      } catch (err) {
        if (ac.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        store.setStreamError(msg);
      } finally {
        abortRef.current = null;
        useChatStore.getState().setStreaming(false);
        qc.invalidateQueries({ queryKey: ["conversations"] });
        qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
        useChatStore.setState({
          streamingContent: "",
          streamingSources: null,
          streamingAttachments: null,
          toolInvocations: [],
          visionRelayInvocations: [],
        });
      }
    },
    [cancel, drainStream, qc]
  );

  return {
    sendMessage,
    editAndResend,
    regenerate,
    continueGenerate,
    reattach,
    cancel,
  };
}
