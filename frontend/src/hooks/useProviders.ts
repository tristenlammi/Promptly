import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  modelsApi,
  type CreateProviderPayload,
  type UpdateProviderPayload,
} from "@/api/models";
import { useModelStore } from "@/store/modelStore";

export const PROVIDERS_KEY = ["providers"] as const;
export const AVAILABLE_MODELS_KEY = ["available-models"] as const;

export function useProviders() {
  return useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => modelsApi.list(),
  });
}

export function useAvailableModels() {
  const setAvailable = useModelStore((s) => s.setAvailable);
  return useQuery({
    queryKey: AVAILABLE_MODELS_KEY,
    queryFn: async () => {
      const list = await modelsApi.available();
      setAvailable(list);
      return list;
    },
  });
}

export function useCreateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateProviderPayload) => modelsApi.create(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
      qc.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY });
    },
  });
}

export function useUpdateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateProviderPayload }) =>
      modelsApi.update(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
      qc.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY });
    },
  });
}

export function useDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => modelsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
      qc.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY });
    },
  });
}

export function useTestProvider() {
  return useMutation({
    mutationFn: (id: string) => modelsApi.test(id),
  });
}

export function useFetchModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => modelsApi.fetchModels(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
      qc.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY });
    },
  });
}
