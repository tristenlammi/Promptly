import { apiClient } from "./client";
import { useAuthStore } from "@/store/authStore";

export interface ResearchStartPayload {
  query: string;
  provider_id: string;
  model_id: string;
}

export const researchApi = {
  /**
   * Start a deep research investigation. Returns a raw fetch Response
   * whose body is a text/event-stream SSE stream — use useResearch() to
   * consume it instead of calling this directly.
   *
   * Uses the same auth token as the Axios client (from authStore, not
   * localStorage) to avoid 401s on the raw fetch call.
   */
  startStream(conversationId: string, payload: ResearchStartPayload): Promise<Response> {
    const token = useAuthStore.getState().accessToken;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return fetch(`/api/conversations/${conversationId}/research`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  },

  /** Classify whether a query warrants a proactive deep-research suggestion. */
  async classify(query: string): Promise<boolean> {
    const { data } = await apiClient.post<{ suggest: boolean }>(
      "/research/classify",
      { query }
    );
    return data.suggest;
  },
};
