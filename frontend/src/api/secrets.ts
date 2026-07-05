/**
 * Credentials vault (A1) — named encrypted values for automations.
 *
 * The plaintext value is write-only: it crosses the wire on create/
 * update and is never returned. The list/get shapes carry only the
 * name + timestamps.
 */
import { apiClient } from "./client";

export interface UserSecret {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export const secretsApi = {
  async list(): Promise<UserSecret[]> {
    const { data } = await apiClient.get<UserSecret[]>("/secrets");
    return data;
  },
  async create(name: string, value: string): Promise<UserSecret> {
    const { data } = await apiClient.post<UserSecret>("/secrets", {
      name,
      value,
    });
    return data;
  },
  async update(id: string, value: string): Promise<UserSecret> {
    const { data } = await apiClient.put<UserSecret>(`/secrets/${id}`, {
      value,
    });
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/secrets/${id}`);
  },
};
