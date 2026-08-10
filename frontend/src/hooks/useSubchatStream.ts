import { useCallback, useEffect, useRef, useState } from "react";

import { chatApi } from "@/api/chat";
import { authHeader } from "@/api/client";
import type { ChatMessage } from "@/api/types";
import { useSubchatStore } from "@/store/subchatStore";

/**
 * Streaming driver for the floating **Subchat** modal.
 *
 * Deliberately self-contained: unlike {@link useStreamingChat} it keeps
 * all state in local React state instead of the global ``useChatStore``.
 * That isolation is the whole point — a subchat runs its own SSE stream
 * concurrently with (and without clobbering) the main conversation that
 * spawned it. The subchat conversation already carries the parent's full
 * copied history server-side, so we only ever render the *new* turns the
 * user types here; the inherited context lives on the backend.
 *
 * Tool / vision chips are intentionally not surfaced (kept lightweight) —
 * a tool still runs server-side when the caller passes ``toolsEnabled``,
 * and its result is folded into the streamed assistant text. Promote the
 * subchat to a real chat to get the full-fidelity rendering.
 */

/** Abort the read loop when the server goes silent for this long. Same
 *  budget (and same reasoning) as the main chat hook: the backend emits an
 *  SSE ping comment every ~20s even while the model is quiet, so silence
 *  this long means the connection is actually dead. Without it a
 *  half-closed proxy left the panel on "Thinking…" with the composer
 *  unusable, and the only way out was discarding the subchat. */
const STREAM_STALL_TIMEOUT_MS = 75_000;

interface SSEPayload {
  event?: string;
  delta?: string;
  done?: boolean;
  error?: string;
  message_id?: string;
  created_at?: string;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cost_usd?: number | null;
  truncated?: boolean;
}

/** Minimal SSE line parser — yields the decoded ``data:`` payload of each
 *  complete event. Mirrors the parser in {@link useStreamingChat}; kept
 *  local so the battle-tested main hook stays untouched. */
async function* iterateSSE(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  try {
    while (!signal.aborted) {
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            stallTimer = setTimeout(
              () =>
                reject(
                  new Error(
                    "The connection went quiet — the reply is still being written and will appear when you reopen this subchat."
                  )
                ),
              STREAM_STALL_TIMEOUT_MS
            );
          }),
        ]);
      } finally {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
      }
      const { done, value } = result;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }
        if (dataLines.length > 0) yield dataLines.join("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Stable empty-array reference so the store selector doesn't return a fresh
 *  ``[]`` each render (which would loop React's snapshot check). */
const EMPTY_MESSAGES: ChatMessage[] = [];

function tempId(): string {
  // crypto.randomUUID is available in every browser we target; the
  // fallback keeps TS happy and covers ancient runtimes.
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `tmp-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

export interface UseSubchatStreamOptions {
  /** Forwarded to the send as ``tools_enabled``. Without it the backend
   *  defaults to ``false``, which silently stripped code execution, page
   *  fetching and image generation out of every subchat while the main
   *  composer one panel over had them. */
  toolsEnabled?: boolean;
  /** ``branched_at`` of the subchat conversation. Everything at or before
   *  it is the parent history the branch copied verbatim (the copies keep
   *  their original timestamps), so this is the cutoff that separates the
   *  inherited context from the turns actually taken in this panel. */
  branchedAt?: string | null;
}

export interface UseSubchatStreamResult {
  messages: ChatMessage[];
  streaming: boolean;
  /** Live assistant text for the in-flight reply (empty when idle). */
  streamingContent: string;
  error: string | null;
  send: (text: string) => Promise<void>;
  /** Drop the local reader only — the backend keeps generating. Used on
   *  unmount and when a new turn takes over. */
  cancel: () => void;
  /** Stop the reply for real and keep the text produced so far. */
  stop: () => Promise<void>;
}

export function useSubchatStream(
  subchatId: string | null,
  options: UseSubchatStreamOptions = {}
): UseSubchatStreamResult {
  const { toolsEnabled = false, branchedAt = null } = options;
  // Transcript lives in a module store keyed by subchat id so it survives the
  // modal unmounting on chat navigation (and re-renders on return). Streaming
  // in-flight state stays local — a stream is aborted on unmount anyway.
  const messages = useSubchatStore((s) =>
    subchatId ? s.transcripts[subchatId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  );
  const setStoredMessages = useCallback(
    (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
      if (subchatId) useSubchatStore.getState().set(subchatId, updater);
    },
    [subchatId]
  );
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The server-side stream this reader is attached to. Aborting the fetch
  // doesn't reach the backend — generation runs as a background task — so
  // stopping for real means naming the stream.
  const liveStreamRef = useRef<string | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  /** Stop button: halt generation server-side and keep what was written.
   *  ``cancel`` alone let the model run to completion — billed, saved in
   *  full — while the panel threw the visible partial away. */
  const stop = useCallback(async () => {
    const streamId = liveStreamRef.current;
    liveStreamRef.current = null;
    cancel();
    try {
      if (!streamId) return;
      const saved = await chatApi.stopStream(streamId);
      // Held until the server answers so the partial swaps straight into a
      // real bubble instead of blanking for a round trip.
      if (saved) setStoredMessages((prev) => [...prev, saved]);
    } catch (err) {
      console.warn("Stopping the subchat stream failed", err);
    } finally {
      // ``cancel`` nulled the abort handle, so the reading turn's own
      // cleanup can no longer recognise itself and skips its teardown.
      // Owning it here is what takes the panel out of the streaming state.
      setStreaming(false);
      setStreamingContent("");
    }
  }, [cancel, setStoredMessages]);

  /** Read one server-side stream to completion, painting deltas as they
   *  land and appending the finished reply. Shared by ``send`` and the
   *  reattach path so a resumed stream renders exactly like a fresh one. */
  const drain = useCallback(
    async (streamId: string, ac: AbortController): Promise<void> => {
      if (!subchatId) return;
      const resp = await fetch(chatApi.streamUrl(streamId), {
        method: "GET",
        headers: { Accept: "text/event-stream", ...authHeader() },
        signal: ac.signal,
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`Stream failed: ${resp.status} ${resp.statusText}`);
      }

      // rAF-batched delta flush so a fast token stream doesn't re-render
      // (and re-parse markdown) on every chunk.
      let pending = "";
      let raf: number | null = null;
      const flush = () => {
        raf = null;
        if (pending) {
          setStreamingContent((c) => c + pending);
          pending = "";
        }
      };
      const schedule = () => {
        if (raf == null) {
          raf =
            typeof requestAnimationFrame === "function"
              ? requestAnimationFrame(flush)
              : (setTimeout(flush, 16) as unknown as number);
        }
      };
      const cancelScheduled = () => {
        if (raf != null) {
          if (typeof cancelAnimationFrame === "function")
            cancelAnimationFrame(raf);
          else clearTimeout(raf);
          raf = null;
        }
      };

      let acc = "";
      let final: ChatMessage | null = null;
      try {
        for await (const raw of iterateSSE(resp.body, ac.signal)) {
          let data: SSEPayload;
          try {
            data = JSON.parse(raw) as SSEPayload;
          } catch {
            continue;
          }
          if (data.error && !data.event) {
            setError(data.error);
            continue;
          }
          if (data.delta) {
            acc += data.delta;
            pending += data.delta;
            schedule();
          }
          if (data.done) {
            cancelScheduled();
            if (data.message_id && data.created_at) {
              final = {
                id: data.message_id,
                conversation_id: subchatId,
                role: "assistant",
                content: acc,
                created_at: data.created_at,
                prompt_tokens: data.prompt_tokens ?? null,
                completion_tokens: data.completion_tokens ?? null,
                cost_usd: data.cost_usd ?? null,
                truncated: data.truncated ?? false,
              };
            }
            break;
          }
        }
      } finally {
        cancelScheduled();
      }
      if (final) setStoredMessages((prev) => [...prev, final as ChatMessage]);
    },
    [subchatId, setStoredMessages]
  );

  // Clear only the transient in-flight state when switching subchats (or
  // closing); the persisted transcript is intentionally left in the store so
  // returning to the chat restores it. Abort any in-flight stream on unmount.
  //
  // On the way back in, recover a reply we missed while unmounted. The modal
  // is torn down whenever you navigate to another chat, and dropping the
  // reader tells the backend nothing — it finishes the reply and saves it —
  // so without this you'd return to your question with no answer, forever,
  // while the answer sat in the database. Only runs when the last turn is a
  // user message: any other state means nothing is outstanding, and a
  // subchat conversation carries the whole copied parent history, so a
  // speculative fetch would be an expensive no-op.
  useEffect(() => {
    setStreamingContent("");
    setError(null);
    if (!subchatId) return () => cancel();

    const local = useSubchatStore.getState().get(subchatId);
    const awaitingReply =
      local.length > 0 && local[local.length - 1].role === "user";
    if (!awaitingReply) return () => cancel();

    let disposed = false;
    void (async () => {
      try {
        // Cheap id-only probe first: if the reply is still generating we
        // tail it live, and there's nothing persisted to fetch yet.
        const streamId = await chatApi.activeStream(subchatId);
        if (disposed || abortRef.current) return;

        if (streamId) {
          const ac = new AbortController();
          abortRef.current = ac;
          liveStreamRef.current = streamId;
          setStreaming(true);
          try {
            await drain(streamId, ac);
          } catch (err) {
            if (!ac.signal.aborted) {
              setError(err instanceof Error ? err.message : String(err));
            }
          } finally {
            // Only tear down if we still own the slot — a send that took
            // over while we were reading owns it now.
            if (abortRef.current === ac) {
              abortRef.current = null;
              liveStreamRef.current = null;
              setStreaming(false);
              setStreamingContent("");
            }
          }
          return;
        }

        // No live stream: the reply finished while we were away. Pull the
        // turns taken in this panel (everything after the branch point —
        // before it is the copied parent history, which this panel never
        // renders) and adopt them as the transcript.
        const detail = await chatApi.get(subchatId);
        if (disposed || abortRef.current) return;
        const cutoff = branchedAt ? Date.parse(branchedAt) : NaN;
        if (Number.isNaN(cutoff)) return;
        const own = detail.messages.filter(
          (m) => Date.parse(m.created_at) > cutoff
        );
        if (own.length > 0) {
          useSubchatStore.getState().set(subchatId, () => own);
        }
      } catch (err) {
        // Non-fatal — the panel just keeps showing what it already had.
        console.warn("Recovering the subchat reply failed", err);
      }
    })();

    return () => {
      disposed = true;
      cancel();
    };
  }, [subchatId, branchedAt, cancel, drain]);

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!subchatId || !body || streaming) return;

      cancel();
      const ac = new AbortController();
      abortRef.current = ac;
      setError(null);

      const optimistic: ChatMessage = {
        id: tempId(),
        conversation_id: subchatId,
        role: "user",
        content: body,
        created_at: new Date().toISOString(),
      };
      setStoredMessages((prev) => [...prev, optimistic]);
      setStreaming(true);
      setStreamingContent("");

      try {
        const { stream_id, user_message } = await chatApi.sendMessage(
          subchatId,
          { content: body, tools_enabled: toolsEnabled }
        );
        liveStreamRef.current = stream_id;
        // Swap the optimistic row for the persisted one (real id/metrics).
        setStoredMessages((prev) =>
          prev.map((m) => (m.id === optimistic.id ? user_message : m))
        );

        await drain(stream_id, ac);
      } catch (err) {
        if (!ac.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        // Only reset what's still ours. Now that the reattach path can also
        // own these refs, an unconditional reset here would clear a
        // successor's abort handle and stream id — leaving its Stop button
        // unable to name the stream it's meant to halt.
        if (abortRef.current === ac) {
          abortRef.current = null;
          liveStreamRef.current = null;
          setStreaming(false);
          setStreamingContent("");
        }
      }
    },
    [subchatId, streaming, cancel, drain, setStoredMessages, toolsEnabled]
  );

  return { messages, streaming, streamingContent, error, send, cancel, stop };
}
