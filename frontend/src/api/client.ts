import axios, { AxiosError, type AxiosRequestConfig } from "axios";

import { useAuthStore } from "@/store/authStore";

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true, // refresh cookie lives on /api/auth
  headers: { "Content-Type": "application/json" },
  timeout: 30_000,
});

// ---- Request: attach access token ----
apiClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ---- Response: refresh on 401 (single-flight) ----
let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const res = await axios.post<{ access_token: string; expires_in: number }>(
        `${API_BASE_URL}/auth/refresh`,
        null,
        { withCredentials: true }
      );
      const { access_token } = res.data;
      useAuthStore.getState().setAccessToken(access_token);
      return access_token;
    } catch {
      useAuthStore.getState().clear();
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as AxiosRequestConfig & { _retried?: boolean };
    if (
      error.response?.status === 401 &&
      original &&
      !original._retried &&
      // Don't try to refresh on the refresh endpoint itself.
      !original.url?.endsWith("/auth/refresh") &&
      !original.url?.endsWith("/auth/login")
    ) {
      original._retried = true;
      const newToken = await refreshAccessToken();
      if (newToken) {
        original.headers = {
          ...(original.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${newToken}`,
        };
        return apiClient.request(original);
      }
    }
    return Promise.reject(error);
  }
);

/** Used by the streaming hook — fetch() is needed for readable-body streaming. */
export function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().accessToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
