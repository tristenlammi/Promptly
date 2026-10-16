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

/** True when the request never got a real answer: no response at all,
 *  or the gateway/proxy reporting the backend down (502/503/504). */
export function isServerUnavailable(err: unknown): boolean {
  const e = err as AxiosError | undefined;
  if (!e || !axios.isAxiosError(e)) return false;
  if (!e.response) return true;
  return [502, 503, 504].includes(e.response.status);
}

/** The server definitively refused the refresh cookie. */
function refreshRefused(err: unknown): boolean {
  const e = err as AxiosError | undefined;
  if (!e || !axios.isAxiosError(e) || !e.response) return false;
  return e.response.status === 401 || e.response.status === 403;
}

// ---- Response: refresh on 401 (single-flight) ----
let refreshPromise: Promise<string | null> | null = null;

export async function refreshAccessToken(): Promise<string | null> {
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
    } catch (err) {
      // Only the server saying "no" (401/403) ends the session. A refresh
      // that failed because the backend was restarting (an update), was
      // rate-limited, or hit a server error used to log everyone out
      // mid-work and lose their place (R-246, R-142).
      if (refreshRefused(err)) {
        const wasSignedIn = useAuthStore.getState().user !== null;
        useAuthStore.getState().clear();
        // A session that just ended: start over on a fresh page, so the
        // next person here doesn't see this user's cached data (R-030).
        // Not on a cold load (nobody was signed in) — that would loop.
        if (wasSignedIn) void import("@/lib/session").then((m) => m.resetToLogin());
      }
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
