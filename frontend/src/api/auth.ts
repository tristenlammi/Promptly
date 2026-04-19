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
};
