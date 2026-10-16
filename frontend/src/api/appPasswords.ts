import { apiClient } from "./client";

/** App passwords — how a device signs in to sync (WP-8.3). */

export type AppPasswordScope = "dav:read" | "dav:write" | "upload";

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
  async revoke(id: string): Promise<void> {
    await apiClient.delete(`/auth/app-passwords/${id}`);
  },
};
