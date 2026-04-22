import { apiClient } from "./client";
import type {
  AuthResponse,
  AuthResponseOk,
  TokenResponse,
  User,
  UserPreferencesUpdate,
} from "./types";

export interface SetupStatus {
  requires_setup: boolean;
}

/** Minimal user payload returned by ``GET /auth/users/directory``.
 *  Mirrors ``ShareUserBrief`` on the backend so share-create payloads
 *  can send ``username`` straight through after the picker resolves
 *  a selection. */
export interface DirectoryUser {
  user_id: string;
  username: string;
  email: string;
}

export const authApi = {
  async me(): Promise<User> {
    const { data } = await apiClient.get<User>("/auth/me");
    return data;
  },
  async setupStatus(): Promise<SetupStatus> {
    const { data } = await apiClient.get<SetupStatus>("/auth/setup-status");
    return data;
  },
  async setup(
    email: string,
    username: string,
    password: string
  ): Promise<AuthResponseOk> {
    const { data } = await apiClient.post<AuthResponseOk>("/auth/setup", {
      email,
      username,
      password,
    });
    return data;
  },
  async login(email: string, password: string): Promise<AuthResponse> {
    const { data } = await apiClient.post<AuthResponse>("/auth/login", {
      email,
      password,
    });
    return data;
  },
  async refresh(): Promise<TokenResponse> {
    const { data } = await apiClient.post<TokenResponse>("/auth/refresh");
    return data;
  },
  async logout(): Promise<void> {
    await apiClient.post("/auth/logout");
  },
  /** Merge a small whitelisted set of keys into ``user.settings``.
   *
   * Returns the freshly-loaded user so the caller can sync their
   * authStore state without a separate /me round-trip. Only keys the
   * backend recognises are accepted; anything else is rejected with
   * a 422.
   */
  async updatePreferences(payload: UserPreferencesUpdate): Promise<User> {
    const { data } = await apiClient.patch<User>(
      "/auth/me/preferences",
      payload
    );
    return data;
  },
  /** Search the user directory for ``q`` (matches username or email,
   *  case-insensitive). Used by the share pickers (conversation +
   *  project). Returns at most ``limit`` rows, excluding the caller
   *  so self-invites never appear as a dropdown option. */
  async directoryUsers(
    params: { q?: string; limit?: number } = {}
  ): Promise<DirectoryUser[]> {
    const { data } = await apiClient.get<DirectoryUser[]>(
      "/auth/users/directory",
      {
        params: {
          q: params.q ?? "",
          limit: params.limit ?? 12,
        },
      }
    );
    return data;
  },
};
