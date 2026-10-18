import { apiClient } from "./client";

/** App passwords — how a device signs in to sync (WP-8.3). */

export type AppPasswordScope = "dav:read" | "dav:write" | "dav:delete" | "upload";

export interface AppPassword {
  id: string;
  name: string;
  /** "pmt_Ab3x…" — to recognise it by. */
  hint: string;
  scopes: AppPasswordScope[];
  created_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
}

export interface AppPasswordCreated extends AppPassword {
  /** Shown once. */
  password: string;
  username: string;
}

export const appPasswordsApi = {
  async list(): Promise<AppPassword[]> {
    const { data } = await apiClient.get<AppPassword[]>("/auth/app-passwords");
    return data;
  },
  async create(name: string, scopes: AppPasswordScope[]): Promise<AppPasswordCreated> {
    const { data } = await apiClient.post<AppPasswordCreated>("/auth/app-passwords", { name, scopes });
    return data;
  },
  /** Change what a device may do. */
  async update(id: string, scopes: AppPasswordScope[]): Promise<AppPassword> {
    const { data } = await apiClient.patch<AppPassword>(`/auth/app-passwords/${id}`, { scopes });
    return data;
  },
  async revoke(id: string): Promise<void> {
    await apiClient.delete(`/auth/app-passwords/${id}`);
  },
};
