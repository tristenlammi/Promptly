import { apiClient } from "./client";

/** A reusable prompt template (Phase 3.1). Owned by the current user. */
export interface SavedPrompt {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface SavedPromptInput {
  title: string;
  body: string;
}

export const savedPromptsApi = {
  async list(): Promise<SavedPrompt[]> {
    const { data } = await apiClient.get<SavedPrompt[]>("/saved-prompts");
    return data;
  },
  async create(input: SavedPromptInput): Promise<SavedPrompt> {
    const { data } = await apiClient.post<SavedPrompt>("/saved-prompts", input);
    return data;
  },
  async update(
    id: string,
    input: Partial<SavedPromptInput>
  ): Promise<SavedPrompt> {
    const { data } = await apiClient.patch<SavedPrompt>(
      `/saved-prompts/${id}`,
      input
    );
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/saved-prompts/${id}`);
  },
};
