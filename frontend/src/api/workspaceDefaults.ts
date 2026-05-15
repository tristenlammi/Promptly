import { apiClient } from "./client";
import type { WorkspaceDefaults } from "./types";

/**
 * Non-admin read of the workspace-wide model defaults.
 *
 * Mirrors the admin ``app_settings`` payload but exposes only the
 * fields the chat picker on a *non-admin* page genuinely needs
 * (specifically the global default chat model). Used by the
 * ``modelStore`` so a fresh user without a personal default lands
 * on the admin's preferred starting model rather than whatever the
 * catalog returns first.
 */
export const workspaceDefaultsApi = {
  async get(): Promise<WorkspaceDefaults> {
    const { data } = await apiClient.get<WorkspaceDefaults>(
      "/workspace-defaults",
    );
    return data;
  },
};
