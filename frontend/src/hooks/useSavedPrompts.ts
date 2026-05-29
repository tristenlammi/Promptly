import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  savedPromptsApi,
  type SavedPrompt,
  type SavedPromptInput,
} from "@/api/savedPrompts";

const KEY = ["saved-prompts"] as const;

export function useSavedPrompts() {
  return useQuery<SavedPrompt[]>({
    queryKey: KEY,
    queryFn: () => savedPromptsApi.list(),
    staleTime: 60_000,
  });
}

export function useCreateSavedPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SavedPromptInput) => savedPromptsApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateSavedPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: Partial<SavedPromptInput>;
    }) => savedPromptsApi.update(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteSavedPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => savedPromptsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
