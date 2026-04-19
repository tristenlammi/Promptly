import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { studyApi, type StudySendMessagePayload } from "@/api/study";
import { authHeader } from "@/api/client";
import { useStudyStore } from "@/store/studyStore";
import type {
  StudyMessage,
  WhiteboardExerciseDetail,
  WhiteboardExerciseSummary,
} from "@/api/types";

/** Re-used SSE parser. Mirrors the one in useStreamingChat. */
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

interface ExerciseReadyPayload {
  id: string;
  session_id: string;
  message_id: string | null;
  title: string | null;
  html: string;
  status: "active" | "submitted" | "reviewed";
  created_at: string;
}

interface SSEPayload {
  event?: string;
  delta?: string;
  done?: boolean;
  error?: string;
  message_id?: string;
  created_at?: string;
  stream_id?: string;
  exercise?: ExerciseReadyPayload;
  exercise_id?: string;
  kind?: string;
}

interface SendMessageOptions {
  /** If set, the store already contains an optimistic user message with this
   *  id. The POST's persisted user_message is swapped into the same slot
   *  instead of being appended, avoiding React key churn. */
  optimisticUserId?: string;
}

interface UseStudyStreamResult {
  sendMessage: (
    sessionId: string,
    payload: StudySendMessagePayload,
    options?: SendMessageOptions
  ) => Promise<void>;
  /** Attach to an existing `stream_id` (used by the submit-evaluation flow
   *  where the enqueue happened via a different HTTP call). */
  attachStream: (sessionId: string, streamId: string) => Promise<void>;
  cancel: () => void;
}

export function useStudyStream(): UseStudyStreamResult {
  const qc = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  // Shared consumer for the streaming response body. Once the SendMessage or
  // SubmitExercise call has set up the user message + redis ctx, both paths
  // end up running the same SSE reader here.
  const consumeStream = useCallback(
    async (sessionId: string, streamId: string, ac: AbortController) => {
      const store = useStudyStore.getState();
      const resp = await fetch(studyApi.streamUrl(sessionId, streamId), {
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

      let finalMessage: StudyMessage | null = null;

      for await (const raw of iterateSSE(resp.body, ac.signal)) {
        let data: SSEPayload;
        try {
          data = JSON.parse(raw) as SSEPayload;
        } catch {
          continue;
        }

        if (data.error && !data.event) {
          store.setStreamError(data.error);
          continue;
        }

        if (data.event === "exercise_ready" && data.exercise) {
          const ex = data.exercise;
          const detail: WhiteboardExerciseDetail = {
            id: ex.id,
            session_id: ex.session_id,
            message_id: ex.message_id,
            title: ex.title,
            status: ex.status,
            created_at: ex.created_at,
            submitted_at: null,
            html: ex.html,
            answer_payload: null,
            ai_feedback: null,
            excalidraw_snap: null,
          };
          const summary: WhiteboardExerciseSummary = {
            id: ex.id,
            session_id: ex.session_id,
            message_id: ex.message_id,
            title: ex.title,
            status: ex.status,
            created_at: ex.created_at,
            submitted_at: null,
          };
          store.setActiveExercise(detail);
          store.upsertExerciseSummary(summary);
          continue;
        }

        if (data.event === "exercise_reviewed" && data.exercise_id) {
          store.markExerciseReviewed(data.exercise_id);
          continue;
        }

        if (data.delta) {
          store.appendStreamingDelta(data.delta);
        }
        if (data.done) {
          const content = useStudyStore.getState().streamingContent;
          if (data.message_id && data.created_at) {
            finalMessage = {
              id: data.message_id,
              session_id: sessionId,
              role: "assistant",
              content,
              created_at: data.created_at,
            };
          }
          break;
        }
      }

      if (finalMessage) store.appendMessage(finalMessage);
    },
    []
  );

  const sendMessage = useCallback(
    async (
      sessionId: string,
      payload: StudySendMessagePayload,
      options?: SendMessageOptions
    ) => {
      const store = useStudyStore.getState();
      cancel();
      const ac = new AbortController();
      abortRef.current = ac;

      store.resetStream();
      store.setStreaming(true);

      try {
        const { stream_id, user_message } = await studyApi.sendMessage(
          sessionId,
          payload
        );
        if (options?.optimisticUserId) {
          store.replaceMessage(options.optimisticUserId, user_message);
        } else {
          store.appendMessage(user_message);
        }
        await consumeStream(sessionId, stream_id, ac);
      } catch (err) {
        if (ac.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        store.setStreamError(msg);
      } finally {
        abortRef.current = null;
        useStudyStore.getState().setStreaming(false);
        qc.invalidateQueries({ queryKey: ["study", "session", sessionId] });
        qc.invalidateQueries({ queryKey: ["study", "projects"] });
        qc.invalidateQueries({ queryKey: ["study", "exercises", sessionId] });
        useStudyStore.setState({ streamingContent: "" });
      }
    },
    [cancel, qc, consumeStream]
  );

  const attachStream = useCallback(
    async (sessionId: string, streamId: string) => {
      const store = useStudyStore.getState();
      cancel();
      const ac = new AbortController();
      abortRef.current = ac;

      store.resetStream();
      store.setStreaming(true);

      try {
        await consumeStream(sessionId, streamId, ac);
      } catch (err) {
        if (ac.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        store.setStreamError(msg);
      } finally {
        abortRef.current = null;
        useStudyStore.getState().setStreaming(false);
        qc.invalidateQueries({ queryKey: ["study", "session", sessionId] });
        qc.invalidateQueries({ queryKey: ["study", "projects"] });
        qc.invalidateQueries({ queryKey: ["study", "exercises", sessionId] });
        useStudyStore.setState({ streamingContent: "" });
      }
    },
    [cancel, qc, consumeStream]
  );

  return { sendMessage, attachStream, cancel };
}
