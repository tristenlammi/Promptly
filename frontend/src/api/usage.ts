import { apiClient } from "./client";
import type {
  AnalyticsModelRow,
  AnalyticsTimeseriesPoint,
  MyUsageSummary,
} from "./types";

/** Self-scoped usage & cost dashboard (Phase 8). Every endpoint is
 * keyed off the signed-in user server-side — there is no user_id
 * parameter — so these only ever return the caller's own numbers. */
export const usageApi = {
  async mySummary(days = 30): Promise<MyUsageSummary> {
    const { data } = await apiClient.get<MyUsageSummary>("/usage/me/summary", {
      params: { days },
    });
    return data;
  },
  async myTimeseries(days = 30): Promise<AnalyticsTimeseriesPoint[]> {
    const { data } = await apiClient.get<AnalyticsTimeseriesPoint[]>(
      "/usage/me/timeseries",
      { params: { days } }
    );
    return data;
  },
  async myByModel(days = 30): Promise<AnalyticsModelRow[]> {
    const { data } = await apiClient.get<AnalyticsModelRow[]>(
      "/usage/me/by-model",
      { params: { days } }
    );
    return data;
  },
};
