import { apiClient } from "./client";

/** Schemas mirror ``app/chat/compare_schemas.py``. */

export interface CompareColumnSpec {
  provider_id: string;
  model_id: string;
}

export interface CompareColumnSummary {
  conversation_id: string;
  provider_id: string | null;
  model_id: string | null;
  model_display_name: string | null;
  provider_name: string | null;
  is_crowned: boolean;
}

export interface CompareGroupSummary {
  id: string;
  title: string | null;
  seed_prompt: string | null;
  crowned_conversation_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  column_count: number;
}

export interface CompareGroupDetail extends CompareGroupSummary {
  columns: CompareColumnSummary[];
}

export interface CompareSendColumn {
  conversation_id: string;
  stream_id: string;
  user_message_id: string;
}

export interface CompareSendResponse {
  columns: CompareSendColumn[];
}

export interface CreateCompareGroupPayload {
  columns: CompareColumnSpec[];
  title?: string | null;
  seed_prompt?: string | null;
}

export type CompareArchiveFilter = "active" | "archived" | "all";

export const compareApi = {
  async create(
    payload: CreateCompareGroupPayload
  ): Promise<CompareGroupDetail> {
    const { data } = await apiClient.post<CompareGroupDetail>(
      "/chat/compare/groups",
      payload
    );
    return data;
  },

  async list(
    filter: CompareArchiveFilter = "all",
    limit = 50,
    offset = 0
  ): Promise<CompareGroupSummary[]> {
    const { data } = await apiClient.get<CompareGroupSummary[]>(
      "/chat/compare/groups",
      { params: { filter, limit, offset } }
    );
    return data;
  },

  async get(groupId: string): Promise<CompareGroupDetail> {
    const { data } = await apiClient.get<CompareGroupDetail>(
      `/chat/compare/groups/${groupId}`
    );
    return data;
  },

  async send(
    groupId: string,
    content: string
  ): Promise<CompareSendResponse> {
    const { data } = await apiClient.post<CompareSendResponse>(
      `/chat/compare/groups/${groupId}/send`,
      { content }
    );
    return data;
  },

  async crown(
    groupId: string,
    conversationId: string
  ): Promise<CompareGroupDetail> {
    const { data } = await apiClient.post<CompareGroupDetail>(
      `/chat/compare/groups/${groupId}/crown`,
      { conversation_id: conversationId }
    );
    return data;
  },

  async archiveToggle(groupId: string): Promise<CompareGroupSummary> {
    const { data } = await apiClient.post<CompareGroupSummary>(
      `/chat/compare/groups/${groupId}/archive`
    );
    return data;
  },

  async delete(groupId: string): Promise<void> {
    await apiClient.delete(`/chat/compare/groups/${groupId}`);
  },
};
