import { apiClient } from "./client";

export interface GroupMember {
  id: string;
  username: string;
}

export interface UserGroup {
  id: string;
  name: string;
  members: GroupMember[];
  /** Model ids granted to every member (provider ids + custom:<uuid>). */
  allowed_models: string[];
  created_at: string;
}

export const groupsApi = {
  async list(): Promise<UserGroup[]> {
    const { data } = await apiClient.get<UserGroup[]>("/admin/groups");
    return data;
  },
  async create(name: string): Promise<UserGroup> {
    const { data } = await apiClient.post<UserGroup>("/admin/groups", { name });
    return data;
  },
  async update(
    id: string,
    payload: { name?: string; allowed_models?: string[] }
  ): Promise<UserGroup> {
    const { data } = await apiClient.patch<UserGroup>(
      `/admin/groups/${id}`,
      payload
    );
    return data;
  },
  async rename(id: string, name: string): Promise<UserGroup> {
    const { data } = await apiClient.patch<UserGroup>(`/admin/groups/${id}`, {
      name,
    });
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/admin/groups/${id}`);
  },
  async setMembers(id: string, userIds: string[]): Promise<UserGroup> {
    const { data } = await apiClient.put<UserGroup>(
      `/admin/groups/${id}/members`,
      { user_ids: userIds }
    );
    return data;
  },
};
