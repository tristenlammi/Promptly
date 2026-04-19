import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  adminApi,
  type AppSettingsPatch,
  type AuthEventsQuery,
  type CreateUserPayload,
  type ResetPasswordPayload,
  type UpdateUserPayload,
} from "@/api/admin";
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
} from "@/api/types";

const USERS_KEY = ["admin", "users"] as const;
const LOCKED_USERS_KEY = ["admin", "users", "locked"] as const;
const POOL_KEY = ["admin", "model-pool"] as const;
const AUTH_EVENTS_KEY = ["admin", "auth-events"] as const;
const APP_SETTINGS_KEY = ["admin", "app-settings"] as const;

/** Invalidate every cache that could change after a user-row mutation. */
function invalidateUserViews(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: USERS_KEY });
  qc.invalidateQueries({ queryKey: LOCKED_USERS_KEY });
  qc.invalidateQueries({ queryKey: AUTH_EVENTS_KEY });
}

// ---------------- Users ----------------
export function useAdminUsers() {
  return useQuery<AdminUser[]>({
    queryKey: USERS_KEY,
    queryFn: adminApi.listUsers,
    staleTime: 30_000,
  });
}

export function useLockedUsers() {
  return useQuery<AdminUser[]>({
    queryKey: LOCKED_USERS_KEY,
    queryFn: adminApi.listLockedUsers,
    staleTime: 15_000,
  });
}

export function useAdminModelPool(enabled = true) {
  return useQuery<AdminModelOption[]>({
    queryKey: POOL_KEY,
    queryFn: adminApi.modelPool,
    enabled,
    staleTime: 60_000,
  });
}

export function useCreateAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateUserPayload) => adminApi.createUser(payload),
    onSuccess: () => invalidateUserViews(qc),
  });
}

export function useUpdateAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateUserPayload }) =>
      adminApi.updateUser(id, payload),
    onSuccess: () => invalidateUserViews(qc),
  });
}

export function useDeleteAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.deleteUser(id),
    onSuccess: () => invalidateUserViews(qc),
  });
}

// ---------------- Per-user security actions ----------------
export function useUnlockUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.unlockUser(id),
    onSuccess: () => invalidateUserViews(qc),
  });
}

export function useDisableUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.disableUser(id),
    onSuccess: () => invalidateUserViews(qc),
  });
}

export function useEnableUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.enableUser(id),
    onSuccess: () => invalidateUserViews(qc),
  });
}

export function useLogoutEverywhere() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.logoutEverywhere(id),
    onSuccess: () => invalidateUserViews(qc),
  });
}

export function useResetUserPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: ResetPasswordPayload;
    }) => adminApi.resetPassword(id, payload),
    onSuccess: () => invalidateUserViews(qc),
  });
}

// ---------------- Audit log ----------------
export function useAuthEvents(query: AuthEventsQuery = {}) {
  return useQuery<AuthEvent[]>({
    // Query key includes filters so React Query treats each filter
    // combination as a separate cache entry — flipping filters in the
    // UI is instant once you've seen them.
    queryKey: [...AUTH_EVENTS_KEY, query] as const,
    queryFn: () => adminApi.listAuthEvents(query),
    staleTime: 10_000,
  });
}

// ---------------- Per-user usage (Phase 3) ----------------
export function useAdminUserUsage(userId: string | null, days = 30) {
  return useQuery<AdminUserUsage>({
    queryKey: ["admin", "users", userId, "usage", days] as const,
    queryFn: () => adminApi.userUsage(userId as string, days),
    // Only fire when the modal actually has a user selected — avoids
    // a wasted request on the closed/idle state.
    enabled: userId !== null,
    staleTime: 30_000,
  });
}

// ---------------- App settings ----------------
export function useAppSettings() {
  return useQuery<AppSettings>({
    queryKey: APP_SETTINGS_KEY,
    queryFn: adminApi.getAppSettings,
    staleTime: 30_000,
  });
}

export function useUpdateAppSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: AppSettingsPatch) => adminApi.updateAppSettings(patch),
    onSuccess: (data) => {
      // Snapshot the response straight into the cache so the UI flips
      // without a refetch round-trip.
      qc.setQueryData(APP_SETTINGS_KEY, data);
      qc.invalidateQueries({ queryKey: AUTH_EVENTS_KEY });
    },
  });
}

// ---------------- Analytics (Phase 3) ----------------
export function useAnalyticsSummary(days = 30) {
  return useQuery<AnalyticsSummary>({
    queryKey: ["admin", "analytics", "summary", days] as const,
    queryFn: () => adminApi.analyticsSummary(days),
    staleTime: 60_000,
  });
}

export function useAnalyticsTimeseries(days = 30) {
  return useQuery<AnalyticsTimeseriesPoint[]>({
    queryKey: ["admin", "analytics", "timeseries", days] as const,
    queryFn: () => adminApi.analyticsTimeseries(days),
    staleTime: 60_000,
  });
}

export function useAnalyticsUsers(days = 30) {
  return useQuery<AnalyticsUserRow[]>({
    queryKey: ["admin", "analytics", "users", days] as const,
    queryFn: () => adminApi.analyticsUsers(days),
    staleTime: 60_000,
  });
}

export function useAnalyticsByModel(days = 30) {
  return useQuery<AnalyticsModelRow[]>({
    queryKey: ["admin", "analytics", "by-model", days] as const,
    queryFn: () => adminApi.analyticsByModel(days),
    staleTime: 60_000,
  });
}

export function useAnalyticsUserTimeseries(
  userId: string | null,
  days = 30
) {
  return useQuery<AnalyticsTimeseriesPoint[]>({
    queryKey: ["admin", "analytics", "user-timeseries", userId, days] as const,
    queryFn: () => adminApi.analyticsUserTimeseries(userId as string, days),
    enabled: userId !== null,
    staleTime: 60_000,
  });
}

// ---------------- Console — error groups + events ----------------
const ERROR_GROUPS_KEY = ["admin", "errors", "groups"] as const;

export function useErrorGroups(params: {
  status?: "open" | "resolved" | "all";
  q?: string;
  user_id?: string;
  limit?: number;
  offset?: number;
} = {}) {
  return useQuery<ErrorGroupRow[]>({
    queryKey: [...ERROR_GROUPS_KEY, params] as const,
    queryFn: () => adminApi.errorGroups(params),
    staleTime: 15_000,
  });
}

export function useErrorGroupEvents(fingerprint: string | null) {
  return useQuery<ErrorEventRow[]>({
    queryKey: ["admin", "errors", "groups", fingerprint, "events"] as const,
    queryFn: () => adminApi.errorGroupEvents(fingerprint as string),
    enabled: fingerprint !== null,
    staleTime: 15_000,
  });
}

export function useErrorEvent(id: string | null) {
  return useQuery<ErrorEventDetail>({
    queryKey: ["admin", "errors", id] as const,
    queryFn: () => adminApi.errorEvent(id as string),
    enabled: id !== null,
  });
}

export function useResolveErrorGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fingerprint: string) =>
      adminApi.resolveErrorGroup(fingerprint),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ERROR_GROUPS_KEY });
    },
  });
}

export function useReopenErrorGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fingerprint: string) =>
      adminApi.reopenErrorGroup(fingerprint),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ERROR_GROUPS_KEY });
    },
  });
}
