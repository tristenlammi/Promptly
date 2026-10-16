import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { chatApi } from "@/api/chat";
import { authHeader } from "@/api/client";
import {
  researchApi,
  type ResearchRefinePayload,
  type ResearchStartPayload,
} from "@/api/research";
import { useResearchStore } from "@/store/researchStore";

/** Parse SSE lines of the form `data: {...}` */
async function* iterateSSE(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ")) {
          yield trimmed.slice(6);
        }
      }
    }
    // Flush remaining
    if (buf.trim().startsWith("data: ")) {
      yield buf.trim().slice(6);
    }
  } finally {
    reader.releaseLock();
  }
}

export function useResearch() {
  const store = useResearchStore();
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);
  // The server-side job being watched, so Cancel can actually stop it.
  const streamRef = useRef<string | null>(null);

  // Follow a research job's stream. Research runs on the server as a
  // background job: this only watches it, so a reload can come back to it
  // (``reattachResearch``) and Cancel stops it server-side.
  const follow = useCallback(
    async (conversationId: string, streamId: string, ac: AbortController) => {
      let resp: Response;
      try {
        resp = await fetch(chatApi.streamUrl(streamId), {
          headers: { Accept: "text/event-stream", ...authHeader() },
          signal: ac.signal,
        });
      } catch {
        if (!ac.signal.aborted) store.setError("Failed to connect to research service.");
        return;
      }
      if (!resp.ok || !resp.body) {
        store.setError(`Research service returned ${resp.status}.`);
        return;
      }

      try {
        for await (const raw of iterateSSE(resp.body)) {
          if (ac.signal.aborted) break;

          let data: Record<string, unknown>;
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            continue;
          }

          const ev = data.event as string | undefined;

          if (data.error) {
            store.setError(data.error as string);
            break;
          }
          if (data.done) break;

          if (ev === "research_decomposed") {
            store.setDecomposed(
              (data.subquestions as Array<{ question: string; search_query: string }>) ?? []
            );
          } else if (ev === "research_searching") {
            store.setSearching(data.index as number);
          } else if (ev === "research_searched") {
            store.setSearched(data.index as number, (data.sources_found as number) ?? 0);
          } else if (ev === "research_reading") {
            store.setReading(data.index as number);
          } else if (ev === "research_question_done") {
            store.setQuestionDone(data.index as number);
          } else if (ev === "research_synth_start") {
            store.setSynthesizing();
          } else if (typeof data.delta === "string") {
            store.appendReportDelta(data.delta);
          } else if (ev === "research_done") {
            store.finishResearch({
              costUsd: (data.cost_usd as number) ?? 0,
              promptTokens: (data.prompt_tokens as number) ?? 0,
              completionTokens: (data.completion_tokens as number) ?? 0,
              sourceCount: (data.source_count as number) ?? 0,
            });

            // Refetch the conversation to get the research messages in the
            // correct server order (parent_id chain). Manual appendMessage
            // calls race with this refetch and can produce wrong ordering.
            void queryClient.invalidateQueries({
              queryKey: ["conversation", conversationId],
              refetchType: "active",
            });
            void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          }
        }
      } catch {
        if (!ac.signal.aborted) {
          store.setError("Research stream was interrupted.");
        }
      } finally {
        if (streamRef.current === streamId) streamRef.current = null;
      }
    },
    [store, queryClient]
  );

  // Shared driver for a fresh investigation and a refinement — the stream
  // shape is identical, only the endpoint + header label differ.
  const run = useCallback(
    async (
      conversationId: string,
      label: string,
      start: () => Promise<{ stream_id: string }>
    ) => {
      // Cancel any in-flight research.
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      store.startResearch(conversationId, label);

      let streamId: string;
      try {
        streamId = (await start()).stream_id;
      } catch {
        store.setError("Failed to connect to research service.");
        return;
      }
      streamRef.current = streamId;
      await follow(conversationId, streamId, ac);
    },
    [store, follow]
  );

  const startResearch = useCallback(
    (conversationId: string, payload: ResearchStartPayload) =>
      run(conversationId, payload.query, () => researchApi.start(conversationId, payload)),
    [run]
  );

  const refineResearch = useCallback(
    (conversationId: string, payload: ResearchRefinePayload) =>
      run(conversationId, `Dig deeper: ${payload.refinement}`, () =>
        researchApi.refine(conversationId, payload)
      ),
    [run]
  );

  /** Come back to a research job still running after a reload or after
   *  navigating away. The server replays its progress from the start. */
  const reattachResearch = useCallback(
    async (conversationId: string, streamId: string, label: string) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      store.startResearch(conversationId, label);
      streamRef.current = streamId;
      await follow(conversationId, streamId, ac);
    },
    [store, follow]
  );

  const cancelResearch = useCallback(() => {
    // Stop the job itself — dropping the connection alone left it
    // searching and spending in the background.
    const streamId = streamRef.current;
    streamRef.current = null;
    abortRef.current?.abort();
    store.reset();
    if (streamId) {
      void chatApi.stopStream(streamId).catch(() => {
        /* already finished — nothing to stop */
      });
    }
  }, [store]);

  return { startResearch, refineResearch, reattachResearch, cancelResearch };
}
