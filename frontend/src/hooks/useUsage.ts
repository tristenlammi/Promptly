import { useQuery } from "@tanstack/react-query";

import { usageApi } from "@/api/usage";
import type {
  AnalyticsModelRow,
  AnalyticsTimeseriesPoint,
  MyUsageSummary,
} from "@/api/types";

// Self-scoped usage dashboard (Phase 8). Mirrors the admin
// ``useAnalytics*`` hooks but keyed off the signed-in user, so the
// query cache never collides with the admin fleet views.

export function useMyUsageSummary(days = 30) {
  return useQuery<MyUsageSummary>({
    queryKey: ["usage", "me", "summary", days] as const,
    queryFn: () => usageApi.mySummary(days),
    staleTime: 60_000,
  });
}

export function useMyUsageTimeseries(days = 30) {
  return useQuery<AnalyticsTimeseriesPoint[]>({
    queryKey: ["usage", "me", "timeseries", days] as const,
    queryFn: () => usageApi.myTimeseries(days),
    staleTime: 60_000,
  });
}

export function useMyUsageByModel(days = 30) {
  return useQuery<AnalyticsModelRow[]>({
    queryKey: ["usage", "me", "by-model", days] as const,
    queryFn: () => usageApi.myByModel(days),
    staleTime: 60_000,
  });
}
