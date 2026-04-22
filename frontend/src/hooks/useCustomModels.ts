import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  customModelsApi,
  type CustomModelCreate,
  type CustomModelUpdate,
  type EmbeddingConfigUpdate,
} from "@/api/customModels";
import { AVAILABLE_MODELS_KEY } from "@/hooks/useProviders";

export const CUSTOM_MODELS_KEY = ["custom-models"] as const;
export const CUSTOM_MODEL_KEY = (id: string) =>
  ["custom-models", id] as const;
export const EMBEDDING_CONFIG_KEY = ["custom-models", "embedding-config"] as const;
export const KNOWN_EMBEDDING_MODELS_KEY = [
  "custom-models",
  "embedding-models",
  "known",
] as const;

export function useCustomModels() {
  return useQuery({
    queryKey: CUSTOM_MODELS_KEY,
    queryFn: () => customModelsApi.list(),
  });
}

export function useCustomModel(id: string | null | undefined) {
  return useQuery({
    queryKey: CUSTOM_MODEL_KEY(id ?? ""),
    queryFn: () => customModelsApi.get(id as string),
    enabled: !!id,
    // Poll while files are still indexing so the drawer status chips
    // update without requiring a manual refresh.
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return false;
      const stillIndexing = data.files.some(
        (f) => f.indexing_status === "queued" || f.indexing_status === "embedding"
      );
      return stillIndexing ? 3000 : false;
    },
  });
}

export function useCreateCustomModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CustomModelCreate) => customModelsApi.create(payload),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: CUSTOM_MODELS_KEY });
      qc.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY });
      // Seed the detail cache with the full ``CustomModelDetail`` the
      // POST just returned so the drawer can flip straight into "edit"
      // mode without an extra fetch-round-trip flicker. The standard
      // ``useCustomModel`` query will still refetch on its own cadence
      // (polling while files index), but the first paint is instant.
      qc.setQueryData(CUSTOM_MODEL_KEY(data.id), data);
    },
  });
}

export function useUpdateCustomModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: CustomModelUpdate }) =>
      customModelsApi.update(id, payload),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: CUSTOM_MODELS_KEY });
      qc.invalidateQueries({ queryKey: CUSTOM_MODEL_KEY(data.id) });
      qc.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY });
    },
  });
}

export function useDeleteCustomModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => customModelsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CUSTOM_MODELS_KEY });
      qc.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY });
    },
  });
}

export function useAttachFiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, fileIds }: { id: string; fileIds: string[] }) =>
      customModelsApi.attachFiles(id, fileIds),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: CUSTOM_MODELS_KEY });
      qc.invalidateQueries({ queryKey: CUSTOM_MODEL_KEY(data.id) });
    },
  });
}

export function useDetachFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, fileId }: { id: string; fileId: string }) =>
      customModelsApi.detachFile(id, fileId),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: CUSTOM_MODELS_KEY });
      qc.invalidateQueries({ queryKey: CUSTOM_MODEL_KEY(vars.id) });
    },
  });
}

export function useReindexFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, fileId }: { id: string; fileId: string }) =>
      customModelsApi.reindexFile(id, fileId),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: CUSTOM_MODEL_KEY(vars.id) });
    },
  });
}

export function useEmbeddingConfig() {
  return useQuery({
    queryKey: EMBEDDING_CONFIG_KEY,
    queryFn: () => customModelsApi.getEmbeddingConfig(),
  });
}

export function useSetEmbeddingConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: EmbeddingConfigUpdate) =>
      customModelsApi.setEmbeddingConfig(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: EMBEDDING_CONFIG_KEY });
      qc.invalidateQueries({ queryKey: CUSTOM_MODELS_KEY });
    },
  });
}

export function useBootstrapLocalEmbedding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => customModelsApi.bootstrapLocalEmbedding(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: EMBEDDING_CONFIG_KEY });
      qc.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY });
    },
  });
}

export function useKnownEmbeddingModels() {
  return useQuery({
    queryKey: KNOWN_EMBEDDING_MODELS_KEY,
    queryFn: () => customModelsApi.knownEmbeddingModels(),
    staleTime: Infinity,
  });
}

export function useTestEmbeddingConfig() {
  return useMutation({
    mutationFn: () => customModelsApi.testEmbeddingConfig(),
  });
}
