import { apiClient } from "./client";
import type {
  AdminModelOption,
  AdminUser,
  AdminUserUsage,
  AnalyticsFeedbackRow,
  AnalyticsModelRow,
  AnalyticsSummary,
  AnalyticsTimeseriesPoint,
  AnalyticsUserRow,
  FeedbackNoteRow,
  AppSettings,
  AuthEvent,
  ErrorEventDetail,
  ErrorEventRow,
  ErrorGroupRow,
  RuntimeMetrics,
  UserRole,
} from "./types";

export interface UserImportResult {
  created_count: number;
  skipped_count: number;
  created: { email: string; temp_password: string }[];
  skipped: { row: number; email: string; reason: string }[];
  /** Set when the import stopped partway; ``created`` lists what was made. */
  failed?: string;
}

export interface CreateUserPayload {
  can_generate_images?: boolean;
  can_execute_code?: boolean;
  can_reach_private_network?: boolean;
  must_change_password?: boolean;
  email: string;
  username: string;
  password: string;
  role: UserRole;
  /** null = full access to the admin-curated pool. */
  allowed_models: string[] | null;
  /** Initial group memberships (role bundles). */
  group_ids?: string[];
  /**
   * Per-user quota overrides. Pass `null` (or omit) to leave the
   * user on the org-wide default; pass a number — including 0 — to
   * set a hard cap at create time.
   */
  storage_cap_bytes?: number | null;
  daily_token_budget?: number | null;
  monthly_token_budget?: number | null;
}

export interface BackupRun {
  id: string;
  kind: "nightly" | "pre_migrate" | "manual" | string;
  status: "running" | "ok" | "failed" | string;
  filename: string | null;
  size_bytes: number | null;
  revision: string | null;
  error: string | null;
  /** What a successful run did, in a sentence. */
  detail?: string | null;
  created_at: string;
  finished_at: string | null;
}

export type OffsiteTargetKind = "folder" | "s3" | "sftp" | "rest";

/** Off-site backup (WP-2.3). Carries no secrets — only which are set. */
export interface OffsiteOverview {
  enabled: boolean;
  target_kind: OffsiteTargetKind;
  location: string;
  credentials_set: string[];
  hour: number;
  keep_daily: number;
  keep_weekly: number;
  keep_monthly: number;
  restore_test_enabled: boolean;
  healthy: boolean;
  warning: string | null;
  last_copy: BackupRun | null;
  last_copy_ok: BackupRun | null;
  last_check: BackupRun | null;
  last_restore_test: BackupRun | null;
}

export interface OffsiteUpdatePayload {
  enabled?: boolean;
  target_kind?: OffsiteTargetKind;
  location?: string;
  credentials?: Record<string, string>;
  hour?: number;
  restore_test_enabled?: boolean;
}

export interface BackupsOverview {
  last_success: BackupRun | null;
  last_failure: BackupRun | null;
  runs: BackupRun[];
  keep_nightly: number;
  location: string;
  disk_free_bytes: number | null;
  pending_deletion_count: number;
  pending_deletion_bytes: number;
  offsite: OffsiteOverview;
}

/** What deleting a user would remove — fetched before the admin confirms. */
export interface UserDeletionPreview {
  username: string;
  is_admin: boolean;
  file_count: number;
  file_bytes: number;
  conversation_count: number;
  workspaces: {
    id: string;
    title: string;
    members: { id: string; username: string }[];
  }[];
}

export interface DeleteUserPayload {
  /** Must equal the username (type-to-confirm, enforced server-side). */
  confirm_username: string;
  /** workspace id -> new owner id, for each owned workspace to keep. */
  transfers: Record<string, string>;
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
  /** Toggle image-gen access. Omit to leave unchanged. */
  can_generate_images?: boolean;
  /** Toggle code-execution (Run button) access. Omit to leave unchanged. */
  can_execute_code?: boolean;
  /** Toggle local-network access for automations. Omit to leave unchanged. */
  can_reach_private_network?: boolean;
  /** Omit to leave membership unchanged; send a list to replace it. */
  group_ids?: string[];
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
  /** ISO dates; ``until`` is exclusive. */
  since?: string;
  until?: string;
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
/** Result of the wizard's ISPDB email-autoconfig lookup. Server settings
 *  only — never credentials. ``found: false`` = fall back to manual entry. */
export interface EmailAutoconfig {
  found: boolean;
  provider?: string | null;
  host?: string | null;
  port?: number | null;
  use_tls?: boolean | null;
  username?: string | null;
  note?: string | null;
}

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
   * SSO (OIDC). ``oidc_client_secret`` follows the ``smtp_password`` idiom:
   * omit = unchanged, "" = clear, non-empty = encrypt + store.
   */
  oidc_enabled?: boolean;
  oidc_issuer?: string | null;
  oidc_client_id?: string | null;
  oidc_client_secret?: string;
  oidc_button_label?: string | null;
  oidc_scopes?: string | null;
  oidc_trust_unverified_email?: boolean;
  oidc_satisfies_mfa?: boolean;
  /**
   * Org-wide quota defaults. Omit = unchanged; `null` = revert to
   * "no default" (uncapped); number = new default for users without
   * a per-user override.
   */
  default_storage_cap_bytes?: number | null;
  /** Largest single (resumable) upload, bytes; null = the 10 GB default (WP-8.2). */
  max_upload_bytes_large?: number | null;
  default_daily_token_budget?: number | null;
  default_monthly_token_budget?: number | null;
  /**
   * CORS allow-list of fully-qualified origins (scheme://host[:port])
   * the API will accept cross-origin requests from. Set from the
   * first-run wizard's "Public URL" step and editable later under
   * Admin → Settings. Localhost is always allowed regardless.
   */
  public_origins?: string[];
  /**
   * Per-turn cap on ``web_search`` tool invocations. Backend enforces
   * a 1..20 range; the form clamps before sending so a typo can't 422.
   */
  chat_max_web_searches_per_turn?: number;
  /**
   * Vision relay — must be sent as a pair: either both halves with
   * UUID + model id (enable), or both halves as ``null`` (disable).
   * The backend 400s on a single-half PATCH so the row can't end up
   * half-configured. Omit both to leave the current setting alone.
   */
  vision_relay_provider_id?: string | null;
  vision_relay_model_id?: string | null;
  /**
   * Global default chat model — same paired semantics as vision
   * relay: send both halves together to set or both as null to
   * clear. Omit both to leave unchanged.
   */
  default_chat_provider_id?: string | null;
  default_chat_model_id?: string | null;
  /**
   * Phase 11 — Deep Research model. Same paired semantics as above.
   * When set, every Deep Research run uses this model regardless of the
   * user's current chat model selection.
   */
  research_provider_id?: string | null;
  research_model_id?: string | null;
  /**
   * Memory extraction/consolidation model. Optional cheap model for the
   * post-turn capture pass and the tidy-up pass. Send both halves
   * together; null+null to clear.
   */
  memory_provider_id?: string | null;
  memory_model_id?: string | null;
  /**
   * Admin-selected default image-generation model. Paired: send both
   * together to set, null+null to clear, omit to leave unchanged.
   */
  image_gen_provider_id?: string | null;
  image_gen_model_id?: string | null;
  /**
   * Dedicated low-latency voice model. Paired: both together to set,
   * null+null to clear, omit to leave unchanged.
   */
  voice_provider_id?: string | null;
  voice_model_id?: string | null;
  /** Photos vision (PH-2): paired, as the others; plus the monthly limit. */
  photos_vision_provider_id?: string | null;
  photos_vision_model_id?: string | null;
  photos_vision_monthly_limit?: number;
}

export interface OriginPreview {
  canonical: string;
  warnings: string[];
}

/** Admin → Storage (WP-7.2). */
export interface StorageCheckRun {
  id: string;
  started_at: string | null;
  finished_at: string | null;
  status: "running" | "ok" | "problems" | "failed";
  trigger: string;
  checked: number;
  verified: number;
  bytes_verified: number;
  missing: number;
  damaged: number;
  recovered: number;
  quarantined: number;
  error: string | null;
}

export interface StorageProblem {
  id: string;
  filename: string;
  owner: string | null;
  state: "missing" | "damaged";
  size_bytes: number;
  verified_at: string | null;
  storage_path: string;
  trashed: boolean;
}

export interface UnderstandingStage {
  stage: string;
  label: string;
  done: number;
  total: number;
  failed: number;
  waiting?: string;
}

export interface StorageHealth {
  /** The media worker's work (WP-7.4): files per state, rendition bytes. */
  media: { counts: Partial<Record<"pending" | "processing" | "ready" | "failed" | "skipped", number>>; derived_bytes: number };
  /** Understanding photos (PH-2): every library, and the offline place names. */
  understanding?: {
    stages: UnderstandingStage[];
    gazetteer: { places: number; error: string | null; source: string; attribution: string };
  };
  disk: { total: number; used: number; free: number; min_free: number; percent_used: number; uploads_paused: boolean };
  checksums: boolean | null;
  files: { canonical: number; hashed: number; unhashed: number; verified_30d: number };
  problems: StorageProblem[];
  problem_count: number;
  quarantine: { count: number; bytes: number; oldest: string | null; items: { path: string; size: number }[] };
  runs: StorageCheckRun[];
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
  async storageHealth(): Promise<StorageHealth> {
    const { data } = await apiClient.get<StorageHealth>("/admin/storage/health");
    return data;
  },
  async runStorageCheck(): Promise<void> {
    await apiClient.post("/admin/storage/check");
  },
  async recheckFile(id: string): Promise<{ state: string }> {
    const { data } = await apiClient.post<{ state: string }>(`/admin/storage/files/${id}/recheck`);
    return data;
  },
  async retryMedia(): Promise<{ queued: number }> {
    const { data } = await apiClient.post<{ queued: number }>("/admin/storage/media/retry");
    return data;
  },
  async retryUnderstanding(): Promise<{ retried: number }> {
    const { data } = await apiClient.post<{ retried: number }>("/admin/storage/understanding/retry");
    return data;
  },
  async emptyQuarantine(): Promise<{ deleted: number }> {
    const { data } = await apiClient.post<{ deleted: number }>("/admin/storage/quarantine/empty");
    return data;
  },
  async backups(): Promise<BackupsOverview> {
    const { data } = await apiClient.get<BackupsOverview>("/admin/backups");
    return data;
  },
  async runBackup(): Promise<void> {
    await apiClient.post("/admin/backups/run");
  },
  async updateOffsite(patch: OffsiteUpdatePayload): Promise<OffsiteOverview> {
    const { data } = await apiClient.put<OffsiteOverview>("/admin/backups/offsite", patch);
    return data;
  },
  /** Reach the target with the saved settings (can take a while). */
  async testOffsite(): Promise<{ ok: boolean; created?: boolean; snapshots?: number; latest?: string | null; error?: string }> {
    const { data } = await apiClient.post("/admin/backups/offsite/test", null, { timeout: 180_000 });
    return data;
  },
  async offsiteAction(action: "run" | "check" | "restore-test"): Promise<void> {
    await apiClient.post(`/admin/backups/offsite/${action}`);
  },
  async deletionPreview(id: string): Promise<UserDeletionPreview> {
    const { data } = await apiClient.get<UserDeletionPreview>(
      `/admin/users/${id}/deletion-preview`
    );
    return data;
  },
  async deleteUser(id: string, payload: DeleteUserPayload): Promise<void> {
    await apiClient.delete(`/admin/users/${id}`, { data: payload });
  },

  /** Download all users as a CSV blob (no secrets). */
  async exportUsersCsv(): Promise<Blob> {
    const { data } = await apiClient.get("/admin/users/export", {
      responseType: "blob",
    });
    return data as Blob;
  },

  /** Bulk-create users from a CSV file. Returns per-row results incl. the
   *  one-time temp passwords for newly created accounts. */
  async importUsersCsv(
    file: File,
    onProgress?: (done: number, total: number) => void
  ): Promise<UserImportResult> {
    const form = new FormData();
    form.append("file", file);
    // Runs on the server; poll until it's done (R-137). The result, with
    // the temp passwords, stays retrievable for an hour.
    const { data: job } = await apiClient.post<{ job_id: string; total: number }>(
      "/admin/users/import",
      form,
      { headers: { "Content-Type": "multipart/form-data" } }
    );
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const { data } = await apiClient.get<
        UserImportResult & { status: string; done: number; total: number; error?: string }
      >(`/admin/users/import/${job.job_id}`);
      onProgress?.(data.done, data.total);
      if (data.status !== "running") {
        if (data.status === "failed" && data.error) {
          // Still hand back what was created — those passwords matter.
          return { ...data, failed: data.error } as UserImportResult;
        }
        return data;
      }
    }
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
  /** Turn off a user's two-step verification (lost phone + codes). */
  async resetMfa(id: string): Promise<AdminUser> {
    const { data } = await apiClient.post<AdminUser>(`/admin/users/${id}/reset-mfa`);
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
    if (query.since) params.since = query.since;
    if (query.until) params.until = query.until;
    if (query.limit !== undefined) params.limit = query.limit;
    if (query.offset !== undefined) params.offset = query.offset;
    const { data } = await apiClient.get<AuthEvent[]>("/admin/auth-events", {
      params,
    });
    return data;
  },

  /** The filtered audit log as a CSV download (R-145). */
  async exportAuthEvents(query: AuthEventsQuery = {}): Promise<Blob> {
    const params: Record<string, string> = {};
    if (query.event_type) params.event_type = query.event_type;
    if (query.since) params.since = query.since;
    if (query.until) params.until = query.until;
    const { data } = await apiClient.get<Blob>("/admin/auth-events.csv", {
      params,
      responseType: "blob",
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

  /**
   * Wizard helper: look an email address up in Mozilla's ISPDB (the same DB
   * Thunderbird uses) to prefill the SMTP host/port/security. Server settings
   * only — the user still enters their username + password. Best-effort;
   * ``found: false`` means "type it in manually".
   */
  async emailAutoconfig(email: string): Promise<EmailAutoconfig> {
    const { data } = await apiClient.get<EmailAutoconfig>(
      "/admin/app-settings/email-autoconfig",
      { params: { email } }
    );
    return data;
  },

  /** Send a test email to the admin's own address to validate SMTP. */
  async sendTestEmail(): Promise<void> {
    await apiClient.post("/admin/app-settings/test-email");
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
  async analyticsFeedback(days = 30): Promise<AnalyticsFeedbackRow[]> {
    const { data } = await apiClient.get<AnalyticsFeedbackRow[]>(
      "/admin/analytics/feedback",
      { params: { days } }
    );
    return data;
  },
  async analyticsFeedbackNotes(
    days = 30,
    limit = 50
  ): Promise<FeedbackNoteRow[]> {
    const { data } = await apiClient.get<FeedbackNoteRow[]>(
      "/admin/analytics/feedback/notes",
      { params: { days, limit } }
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
  async runtimeMetrics(): Promise<RuntimeMetrics> {
    const { data } = await apiClient.get<RuntimeMetrics>("/admin/metrics");
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
