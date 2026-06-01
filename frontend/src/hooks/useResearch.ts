import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { researchApi, type ResearchStartPayload } from "@/api/research";
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

  const startResearch = useCallback(
    async (conversationId: string, payload: ResearchStartPayload) => {
      // Cancel any in-flight research.
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      store.startResearch(conversationId, payload.query);

      let resp: Response;
      try {
        resp = await researchApi.startStream(conversationId, payload);
      } catch (err) {
        store.setError("Failed to connect to research service.");
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
          } else if (ev === "research_gap_start") {
            // gap check in progress — no UI update needed
          } else if (ev === "research_gap_done") {
            // nothing to update
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
      } catch (err) {
        if (!ac.signal.aborted) {
          store.setError("Research stream was interrupted.");
        }
      }
    },
    [store, queryClient]
  );

  const cancelResearch = useCallback(() => {
    abortRef.current?.abort();
    store.reset();
  }, [store]);

  return { startResearch, cancelResearch };
}
