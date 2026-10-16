import { apiClient } from "./client";

export interface ResearchStartPayload {
  query: string;
  provider_id: string;
  model_id: string;
}

export interface ResearchRefinePayload {
  refinement: string;
  provider_id: string;
  model_id: string;
  base_message_id: string;
}

export const researchApi = {
  /** Start a deep research investigation. It runs on the server as a
   *  background job (it survives a reload and can be stopped); follow it
   *  with useResearch(), which attaches to the returned stream. */
  async start(
    conversationId: string,
    payload: ResearchStartPayload
  ): Promise<{ stream_id: string }> {
    const { data } = await apiClient.post<{ stream_id: string }>(
      `/conversations/${conversationId}/research`,
      payload
    );
    return data;
  },

  /** Refine an existing report ("dig deeper"). Same job shape as start. */
  async refine(
    conversationId: string,
    payload: ResearchRefinePayload
  ): Promise<{ stream_id: string }> {
    const { data } = await apiClient.post<{ stream_id: string }>(
      `/conversations/${conversationId}/research/refine`,
      payload
    );
    return data;
  },

  /** Classify whether a query warrants a proactive deep-research suggestion. */
  async classify(query: string): Promise<boolean> {
    const { data } = await apiClient.post<{ suggest: boolean }>(
      "/research/classify",
      { query }
    );
    return data.suggest;
  },

  /** Effective research model (admin-configured), for the pre-run preview.
   *  ``model_display`` is null when research falls back to the user's
   *  current chat model. */
  async config(): Promise<{
    configured: boolean;
    model_display: string | null;
  }> {
    const { data } = await apiClient.get<{
      configured: boolean;
      model_display: string | null;
    }>("/research/config");
    return data;
  },
};
