import { apiClient } from "./client";
import type {
  AvailableModel,
  ModelInfo,
  Provider,
  ProviderType,
  TestConnectionResult,
} from "./types";

export interface CreateProviderPayload {
  name: string;
  type: ProviderType;
  base_url?: string | null;
  api_key: string;
  enabled?: boolean;
  models?: ModelInfo[];
}

export interface UpdateProviderPayload {
  name?: string;
  base_url?: string | null;
  api_key?: string;
  enabled?: boolean;
  models?: ModelInfo[];
  /**
   * Pass a list of model IDs to curate which models show in the chat picker.
   * Pass `null` to reset to "all models enabled". Omit to leave unchanged.
   */
  enabled_models?: string[] | null;
}

export const modelsApi = {
  async list(): Promise<Provider[]> {
    const { data } = await apiClient.get<Provider[]>("/models");
    return data;
  },
  async create(payload: CreateProviderPayload): Promise<Provider> {
    const { data } = await apiClient.post<Provider>("/models/providers", payload);
    return data;
  },
  async update(id: string, payload: UpdateProviderPayload): Promise<Provider> {
    const { data } = await apiClient.patch<Provider>(
      `/models/providers/${id}`,
      payload
    );
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/models/providers/${id}`);
  },
  async test(id: string): Promise<TestConnectionResult> {
    const { data } = await apiClient.post<TestConnectionResult>(
      `/models/providers/${id}/test`
    );
    return data;
  },
  async fetchModels(id: string): Promise<Provider> {
    const { data } = await apiClient.post<Provider>(
      `/models/providers/${id}/fetch-models`
    );
    return data;
  },
  async available(): Promise<AvailableModel[]> {
    const { data } = await apiClient.get<AvailableModel[]>("/models/available");
    return data;
  },
};
