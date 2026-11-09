import { apiClient } from "./client";

/** ``{app: count}`` for the sidebar's app rows (``GET /api/badges``).
 *  Keys are sidebar app ids; a row that isn't for you is left out. */
export type BadgeCounts = Record<string, number>;

/** The rows the server counts (app/badges/providers.py). */
export const BADGE_APPS = ["tasks", "mail", "rooms", "porch"] as const;

export const badgesApi = {
  async get(apps: readonly string[]): Promise<BadgeCounts> {
    const { data } = await apiClient.get<BadgeCounts>("/badges", { params: { apps: apps.join(",") } });
    return data;
  },
};
