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
 * any tool still runs server-side and its result is folded into the
 * streamed assistant text. Promote the subchat to a real chat to get the
 * full-fidelity rendering.
 */

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
      const { done, value } = await reader.read();
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

export interface UseSubchatStreamResult {
  messages: ChatMessage[];
  streaming: boolean;
  /** Live assistant text for the in-flight reply (empty when idle). */
  streamingContent: string;
  error: string | null;
  send: (text: string) => Promise<void>;
  cancel: () => void;
}

export function useSubchatStream(
  subchatId: string | null
): UseSubchatStreamResult {
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

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // Clear only the transient in-flight state when switching subchats (or
  // closing); the persisted transcript is intentionally left in the store so
  // returning to the chat restores it. Abort any in-flight stream on unmount.
  useEffect(() => {
    setStreamingContent("");
    setError(null);
    return () => cancel();
  }, [subchatId, cancel]);

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

      try {
        const { stream_id, user_message } = await chatApi.sendMessage(
          subchatId,
          { content: body }
        );
        // Swap the optimistic row for the persisted one (real id/metrics).
        setStoredMessages((prev) =>
          prev.map((m) => (m.id === optimistic.id ? user_message : m))
        );

        const resp = await fetch(chatApi.streamUrl(stream_id), {
          method: "GET",
          headers: { Accept: "text/event-stream", ...authHeader() },
          signal: ac.signal,
        });
        if (!resp.ok || !resp.body) {
          throw new Error(`Stream failed: ${resp.status} ${resp.statusText}`);
        }

        let acc = "";
        let final: ChatMessage | null = null;
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
            if (raf != null) {
              if (typeof cancelAnimationFrame === "function")
                cancelAnimationFrame(raf);
              else clearTimeout(raf);
              raf = null;
            }
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
        if (final)
          setStoredMessages((prev) => [...prev, final as ChatMessage]);
      } catch (err) {
        if (!ac.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (raf != null) {
          if (typeof cancelAnimationFrame === "function")
            cancelAnimationFrame(raf);
          else clearTimeout(raf);
        }
        abortRef.current = null;
        setStreaming(false);
        setStreamingContent("");
      }
    },
    [subchatId, streaming, cancel, setStoredMessages]
  );

  return { messages, streaming, streamingContent, error, send, cancel };
}
