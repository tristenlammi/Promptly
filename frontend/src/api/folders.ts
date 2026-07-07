import { apiClient } from "./client";

/** A user-created folder that groups personal chats in the sidebar (0148).
 *  Carries a live default system prompt + a default model that new chats
 *  created inside it inherit. */
export interface ChatFolder {
  id: string;
  name: string;
  /** Live default system prompt applied to every chat in the folder. */
  system_prompt: string | null;
  /** Default model pre-selected for new chats created in the folder. */
  default_model_id: string | null;
  default_provider_id: string | null;
  /** Active (non-archived) chats currently in the folder. */
  chat_count: number;
  created_at: string;
  updated_at: string;
}

export interface ChatFolderInput {
  name: string;
  system_prompt?: string | null;
  default_model_id?: string | null;
  default_provider_id?: string | null;
}

export const chatFoldersApi = {
  async list(): Promise<ChatFolder[]> {
    const { data } = await apiClient.get<ChatFolder[]>("/chat/folders");
    return data;
  },
  async create(input: ChatFolderInput): Promise<ChatFolder> {
    const { data } = await apiClient.post<ChatFolder>("/chat/folders", input);
    return data;
  },
  async update(
    id: string,
    patch: Partial<ChatFolderInput>
  ): Promise<ChatFolder> {
    const { data } = await apiClient.patch<ChatFolder>(
      `/chat/folders/${id}`,
      patch
    );
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/chat/folders/${id}`);
  },
};
