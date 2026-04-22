import { apiClient } from "./client";

/**
 * Admin API for Custom Models.
 *
 * Mirrors ``backend/app/custom_models/router.py``. Only admins can
 * reach these endpoints — the backend returns 403 otherwise.
 */

// --------------------------------------------------------------------
// Types
// --------------------------------------------------------------------

export interface KnowledgeFile {
  user_file_id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  /** queued | embedding | ready | failed */
  indexing_status: string;
  indexing_error: string | null;
  indexed_at: string | null;
  added_at: string;
  chunk_count: number;
}

export interface CustomModelSummary {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  base_provider_id: string;
  base_model_id: string;
  base_display_name: string | null;
  file_count: number;
  ready_file_count: number;
  top_k: number;
  created_at: string;
  updated_at: string;
}

export interface CustomModelDetail extends CustomModelSummary {
  personality: string | null;
  files: KnowledgeFile[];
}

export interface CustomModelCreate {
  name: string;
  display_name: string;
  description?: string | null;
  personality?: string | null;
  base_provider_id: string;
  base_model_id: string;
  top_k?: number;
  file_ids?: string[];
}

export interface CustomModelUpdate {
  display_name?: string;
  description?: string | null;
  personality?: string | null;
  base_provider_id?: string;
  base_model_id?: string;
  top_k?: number;
}

export interface EmbeddingConfig {
  embedding_provider_id: string | null;
  embedding_model_id: string | null;
  embedding_dim: number | null;
  embedding_provider_name: string | null;
}

export interface EmbeddingConfigUpdate {
  embedding_provider_id: string | null;
  embedding_model_id?: string | null;
  embedding_dim?: number | null;
}

export interface EmbeddingConfigTestResult {
  ok: boolean;
  embedding_provider_id: string | null;
  embedding_model_id: string | null;
  embedding_provider_name: string | null;
  dimension: number | null;
  latency_ms: number | null;
  sample: number[] | null;
  error: string | null;
}

// --------------------------------------------------------------------
// API client
// --------------------------------------------------------------------

const BASE = "/admin/custom-models";

export const customModelsApi = {
  async list(): Promise<CustomModelSummary[]> {
    const { data } = await apiClient.get<CustomModelSummary[]>(BASE);
    return data;
  },
  async get(id: string): Promise<CustomModelDetail> {
    const { data } = await apiClient.get<CustomModelDetail>(`${BASE}/${id}`);
    return data;
  },
  async create(payload: CustomModelCreate): Promise<CustomModelDetail> {
    const { data } = await apiClient.post<CustomModelDetail>(BASE, payload);
    return data;
  },
  async update(
    id: string,
    payload: CustomModelUpdate
  ): Promise<CustomModelDetail> {
    const { data } = await apiClient.patch<CustomModelDetail>(
      `${BASE}/${id}`,
      payload
    );
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`${BASE}/${id}`);
  },
  async attachFiles(
    id: string,
    fileIds: string[]
  ): Promise<CustomModelDetail> {
    const { data } = await apiClient.post<CustomModelDetail>(
      `${BASE}/${id}/files`,
      { file_ids: fileIds }
    );
    return data;
  },
  async detachFile(id: string, fileId: string): Promise<void> {
    await apiClient.delete(`${BASE}/${id}/files/${fileId}`);
  },
  async reindexFile(id: string, fileId: string): Promise<KnowledgeFile> {
    const { data } = await apiClient.post<KnowledgeFile>(
      `${BASE}/${id}/files/${fileId}/reindex`
    );
    return data;
  },

  // ---- Workspace embedding-provider config ----
  async getEmbeddingConfig(): Promise<EmbeddingConfig> {
    const { data } = await apiClient.get<EmbeddingConfig>(
      `${BASE}/embedding-config`
    );
    return data;
  },
  async setEmbeddingConfig(
    payload: EmbeddingConfigUpdate
  ): Promise<EmbeddingConfig> {
    const { data } = await apiClient.put<EmbeddingConfig>(
      `${BASE}/embedding-config`,
      payload
    );
    return data;
  },
  async bootstrapLocalEmbedding(): Promise<EmbeddingConfig> {
    const { data } = await apiClient.post<EmbeddingConfig>(
      `${BASE}/bootstrap-local-embedding`
    );
    return data;
  },
  async testEmbeddingConfig(): Promise<EmbeddingConfigTestResult> {
    const { data } = await apiClient.post<EmbeddingConfigTestResult>(
      `${BASE}/embedding-config/test`
    );
    return data;
  },
  async knownEmbeddingModels(): Promise<Record<string, number>> {
    const { data } = await apiClient.get<Record<string, number>>(
      `${BASE}/embedding-models/known`
    );
    return data;
  },
};
