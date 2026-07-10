import { apiClient } from "./client";

export interface DataSource {
  id: string;
  name: string;
  driver: string;
  host: string;
  port: number;
  database: string;
  username: string;
  sslmode: string;
  enabled: boolean;
  password_set: boolean;
  created_at: string;
}

export interface DataSourcePayload {
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  /** Omit to keep the stored password on update; "" to clear. */
  password?: string;
  sslmode: string;
  enabled: boolean;
}

export const dataSourcesApi = {
  async list(): Promise<DataSource[]> {
    const { data } = await apiClient.get<DataSource[]>("/admin/data-sources");
    return data;
  },
  async create(payload: DataSourcePayload): Promise<DataSource> {
    const { data } = await apiClient.post<DataSource>(
      "/admin/data-sources",
      payload
    );
    return data;
  },
  async update(
    id: string,
    payload: Partial<DataSourcePayload>
  ): Promise<DataSource> {
    const { data } = await apiClient.patch<DataSource>(
      `/admin/data-sources/${id}`,
      payload
    );
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/admin/data-sources/${id}`);
  },
  async test(id: string): Promise<{ ok: boolean }> {
    const { data } = await apiClient.post<{ ok: boolean }>(
      `/admin/data-sources/${id}/test`
    );
    return data;
  },
};
