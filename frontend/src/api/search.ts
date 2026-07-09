import { apiClient } from "./client";

export type SearchProviderType =
  | "searxng"
  | "brave"
  | "tavily"
  | "google_pse"
  | "openrouter";

export interface SearchProviderRow {
  id: string;
  name: string;
  type: SearchProviderType;
  /** Masked server-side: api keys come back as "••••1234" previews. */
  config: Record<string, unknown>;
  is_default: boolean;
  enabled: boolean;
  /** Failover order — lower is tried first. */
  position: number;
  /** Auto-backoff: if set and in the future, the provider is paused
   *  (skipped) until then after a quota/auth failure. */
  cooldown_until: string | null;
  /** Short description of the failure that triggered the current pause. */
  last_error: string | null;
  created_at: string;
}

export interface SearchProviderCreatePayload {
  name: string;
  type: SearchProviderType;
  config: Record<string, unknown>;
  is_default?: boolean;
  enabled?: boolean;
  /** "system" (admin-only) = visible to every account; powers the
   *  instance default + the failover chain for all users. */
  scope?: "user" | "system";
}

export interface SearchProviderUpdatePayload {
  name?: string;
  config?: Record<string, unknown>;
  is_default?: boolean;
  enabled?: boolean;
}

export interface SearchTestResult {
  query: string;
  provider: string;
  results: { title: string; url: string; snippet: string }[];
}

export const searchApi = {
  async list(): Promise<SearchProviderRow[]> {
    const { data } = await apiClient.get<SearchProviderRow[]>(
      "/search/providers"
    );
    return data;
  },
  async create(
    payload: SearchProviderCreatePayload
  ): Promise<SearchProviderRow> {
    const { data } = await apiClient.post<SearchProviderRow>(
      "/search/providers",
      payload
    );
    return data;
  },
  async update(
    id: string,
    payload: SearchProviderUpdatePayload
  ): Promise<SearchProviderRow> {
    const { data } = await apiClient.patch<SearchProviderRow>(
      `/search/providers/${id}`,
      payload
    );
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/search/providers/${id}`);
  },
  /** Set the full failover order (admin). ``order`` is provider ids,
   *  first = tried first. Returns the reordered list. */
  async reorder(order: string[]): Promise<SearchProviderRow[]> {
    const { data } = await apiClient.post<SearchProviderRow[]>(
      "/search/providers/reorder",
      { order }
    );
    return data;
  },
  /** Clear an auto-backoff pause after fixing the key/quota (admin). */
  async resume(id: string): Promise<SearchProviderRow> {
    const { data } = await apiClient.post<SearchProviderRow>(
      `/search/providers/${id}/resume`,
      {}
    );
    return data;
  },
  /** Diagnostic search against one provider — powers the "Test" button. */
  async test(providerId: string, query: string): Promise<SearchTestResult> {
    const { data } = await apiClient.post<SearchTestResult>("/search/run", {
      query,
      provider_id: providerId,
      count: 3,
    });
    return data;
  },
};
