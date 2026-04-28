import { apiClient } from "./client";
import type {
  AdminModelOption,
  AdminUser,
  AdminUserUsage,
  AnalyticsModelRow,
  AnalyticsSummary,
  AnalyticsTimeseriesPoint,
  AnalyticsUserRow,
  AppSettings,
  AuthEvent,
  ErrorEventDetail,
  ErrorEventRow,
  ErrorGroupRow,
  UserRole,
} from "./types";

export interface CreateUserPayload {
  email: string;
  username: string;
  password: string;
  role: UserRole;
  /** null = full access to the admin-curated pool. */
  allowed_models: string[] | null;
  /**
   * Per-user quota overrides. Pass `null` (or omit) to leave the
   * user on the org-wide default; pass a number — including 0 — to
   * set a hard cap at create time.
   */
  storage_cap_bytes?: number | null;
  daily_token_budget?: number | null;
  monthly_token_budget?: number | null;
}

export interface UpdateUserPayload {
  email?: string;
  username?: string;
  /** Optional password reset. */
  password?: string;
  role?: UserRole;
  /**
   * Pass a list to restrict, `null` to reset to full access, or omit
   * to leave unchanged.
   */
  allowed_models?: string[] | null;
  /**
   * Quota overrides: same tri-state as `allowed_models`. Omit to
   * leave unchanged, send `null` to revert to the org default, send
   * a number for an explicit per-user cap.
   */
  storage_cap_bytes?: number | null;
  daily_token_budget?: number | null;
  monthly_token_budget?: number | null;
}

export interface ResetPasswordPayload {
  password: string;
}

export interface AuthEventsQuery {
  user_id?: string;
  event_type?: string;
  limit?: number;
  offset?: number;
}

/**
 * Partial update for ``app_settings``. Every field is optional;
 * unset fields are left unchanged on the server.
 *
 * ``smtp_password`` semantics:
 *   - undefined → unchanged
 *   - ""        → clear the stored password
 *   - non-empty → encrypt + store
 */
export interface AppSettingsPatch {
  mfa_required?: boolean;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_username?: string | null;
  smtp_password?: string;
  smtp_use_tls?: boolean;
  smtp_from_address?: string | null;
  smtp_from_name?: string | null;
  /**
   * Org-wide quota defaults. Omit = unchanged; `null` = revert to
   * "no default" (uncapped); number = new default for users without
   * a per-user override.
   */
  default_storage_cap_bytes?: number | null;
  default_daily_token_budget?: number | null;
  default_monthly_token_budget?: number | null;
  /**
   * CORS allow-list of fully-qualified origins (scheme://host[:port])
   * the API will accept cross-origin requests from. Set from the
   * first-run wizard's "Public URL" step and editable later under
   * Admin → Settings. Localhost is always allowed regardless.
   */
  public_origins?: string[];
}

export interface OriginPreview {
  canonical: string;
  warnings: string[];
}

export const adminApi = {
  // ---------------- Users ----------------
  async listUsers(): Promise<AdminUser[]> {
    const { data } = await apiClient.get<AdminUser[]>("/admin/users");
    return data;
  },
  async listLockedUsers(): Promise<AdminUser[]> {
    const { data } = await apiClient.get<AdminUser[]>("/admin/users/locked");
    return data;
  },
  async createUser(payload: CreateUserPayload): Promise<AdminUser> {
    const { data } = await apiClient.post<AdminUser>("/admin/users", payload);
    return data;
  },
  async updateUser(id: string, payload: UpdateUserPayload): Promise<AdminUser> {
    const { data } = await apiClient.patch<AdminUser>(`/admin/users/${id}`, payload);
    return data;
  },
  async deleteUser(id: string): Promise<void> {
    await apiClient.delete(`/admin/users/${id}`);
  },

  // ---------------- Per-user security actions ----------------
  async unlockUser(id: string): Promise<AdminUser> {
    const { data } = await apiClient.post<AdminUser>(`/admin/users/${id}/unlock`);
    return data;
  },
  async disableUser(id: string): Promise<AdminUser> {
    const { data } = await apiClient.post<AdminUser>(`/admin/users/${id}/disable`);
    return data;
  },
  async enableUser(id: string): Promise<AdminUser> {
    const { data } = await apiClient.post<AdminUser>(`/admin/users/${id}/enable`);
    return data;
  },
  async logoutEverywhere(id: string): Promise<AdminUser> {
    const { data } = await apiClient.post<AdminUser>(
      `/admin/users/${id}/logout-everywhere`
    );
    return data;
  },
  async resetPassword(
    id: string,
    payload: ResetPasswordPayload
  ): Promise<AdminUser> {
    const { data } = await apiClient.post<AdminUser>(
      `/admin/users/${id}/reset-password`,
      payload
    );
    return data;
  },

  // ---------------- Model pool ----------------
  async modelPool(): Promise<AdminModelOption[]> {
    const { data } = await apiClient.get<AdminModelOption[]>("/admin/model-pool");
    return data;
  },

  // ---------------- Per-user usage (Phase 3) ----------------
  async userUsage(id: string, days = 30): Promise<AdminUserUsage> {
    const { data } = await apiClient.get<AdminUserUsage>(
      `/admin/users/${id}/usage`,
      { params: { days } }
    );
    return data;
  },

  // ---------------- Audit log ----------------
  async listAuthEvents(query: AuthEventsQuery = {}): Promise<AuthEvent[]> {
    const params: Record<string, string | number> = {};
    if (query.user_id) params.user_id = query.user_id;
    if (query.event_type) params.event_type = query.event_type;
    if (query.limit !== undefined) params.limit = query.limit;
    if (query.offset !== undefined) params.offset = query.offset;
    const { data } = await apiClient.get<AuthEvent[]>("/admin/auth-events", {
      params,
    });
    return data;
  },

  // ---------------- App settings ----------------
  async getAppSettings(): Promise<AppSettings> {
    const { data } = await apiClient.get<AppSettings>("/admin/app-settings");
    return data;
  },
  async updateAppSettings(patch: AppSettingsPatch): Promise<AppSettings> {
    const { data } = await apiClient.patch<AppSettings>(
      "/admin/app-settings",
      patch
    );
    return data;
  },
  /**
   * Wizard helper: validate a candidate public-origin string and get
   * back the canonicalised form plus any non-fatal warnings (e.g.
   * "your URL is plain HTTP — set up TLS first"). Read-only — saving
   * still happens via ``updateAppSettings({ public_origins: [...] })``.
   */
  async previewOrigin(public_origin: string): Promise<OriginPreview> {
    const { data } = await apiClient.post<OriginPreview>(
      "/admin/app-settings/preview-origin",
      { public_origin }
    );
    return data;
  },

  // ---------------- Analytics (Phase 3) ----------------
  async analyticsSummary(days = 30): Promise<AnalyticsSummary> {
    const { data } = await apiClient.get<AnalyticsSummary>(
      "/admin/analytics/summary",
      { params: { days } }
    );
    return data;
  },
  async analyticsTimeseries(days = 30): Promise<AnalyticsTimeseriesPoint[]> {
    const { data } = await apiClient.get<AnalyticsTimeseriesPoint[]>(
      "/admin/analytics/timeseries",
      { params: { days } }
    );
    return data;
  },
  async analyticsUsers(days = 30): Promise<AnalyticsUserRow[]> {
    const { data } = await apiClient.get<AnalyticsUserRow[]>(
      "/admin/analytics/users",
      { params: { days } }
    );
    return data;
  },
  async analyticsByModel(days = 30): Promise<AnalyticsModelRow[]> {
    const { data } = await apiClient.get<AnalyticsModelRow[]>(
      "/admin/analytics/by-model",
      { params: { days } }
    );
    return data;
  },
  async analyticsUserTimeseries(
    userId: string,
    days = 30
  ): Promise<AnalyticsTimeseriesPoint[]> {
    const { data } = await apiClient.get<AnalyticsTimeseriesPoint[]>(
      `/admin/analytics/users/${userId}/timeseries`,
      { params: { days } }
    );
    return data;
  },

  // ---------------- Errors (Phase 3 — Console) ----------------
  async errorGroups(params: {
    status?: "open" | "resolved" | "all";
    q?: string;
    user_id?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<ErrorGroupRow[]> {
    const { data } = await apiClient.get<ErrorGroupRow[]>(
      "/admin/errors/groups",
      { params }
    );
    return data;
  },
  async errorGroupEvents(
    fingerprint: string,
    limit = 50
  ): Promise<ErrorEventRow[]> {
    const { data } = await apiClient.get<ErrorEventRow[]>(
      `/admin/errors/groups/${encodeURIComponent(fingerprint)}/events`,
      { params: { limit } }
    );
    return data;
  },
  async errorEvent(id: string): Promise<ErrorEventDetail> {
    const { data } = await apiClient.get<ErrorEventDetail>(
      `/admin/errors/${id}`
    );
    return data;
  },
  async resolveErrorGroup(fingerprint: string): Promise<number> {
    const { data } = await apiClient.post<number>(
      `/admin/errors/groups/${encodeURIComponent(fingerprint)}/resolve`
    );
    return data;
  },
  async reopenErrorGroup(fingerprint: string): Promise<number> {
    const { data } = await apiClient.post<number>(
      `/admin/errors/groups/${encodeURIComponent(fingerprint)}/reopen`
    );
    return data;
  },
};
