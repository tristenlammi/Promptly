import { apiClient } from "@/api/client";

import type { BudgetData } from "./types";

/** The Up Bank connection (backend: app/items/kinds/budget/routes.py). The
 *  token goes up once and never comes back down. */

export interface UpStatus {
  connected: boolean;
  status: "off" | "ok" | "error" | "disconnected" | "full";
  /** From server state — a quiet sync doesn't touch the file. */
  last_sync_at: string | null;
  last_attempt_at?: string | null;
  /** The file can't take more transactions: archive older ones. */
  full?: boolean;
  /** Only the file's owner can connect, sync or disconnect. */
  is_owner?: boolean;
  last_error: string;
  webhook: boolean;
  can_webhook: boolean;
  added_last_sync: number;
  up_categories: { id: string; name: string; parent: string | null }[];
}

export interface UpSyncResult extends UpStatus {
  sync?: { ok: boolean; full?: boolean; changed?: boolean; error?: string; added?: number; settled?: number; updated?: number; removed?: number; subscriptions?: { new: number; found: number } };
  revision: number;
  data: BudgetData;
}

const base = (fileId: string) => `/items/k/budget/${fileId}/up`;

export const upApi = {
  async status(fileId: string): Promise<UpStatus> {
    const { data } = await apiClient.get(`${base(fileId)}/status`);
    return data;
  },
  async connect(fileId: string, token: string): Promise<UpSyncResult> {
    const { data } = await apiClient.post(`${base(fileId)}/connect`, { token }, { timeout: 180_000 });
    return data;
  },
  async sync(fileId: string): Promise<UpSyncResult> {
    const { data } = await apiClient.post(`${base(fileId)}/sync`, {}, { timeout: 180_000 });
    return data;
  },
  async disconnect(fileId: string): Promise<UpSyncResult> {
    const { data } = await apiClient.delete(base(fileId));
    return data;
  },
};

export function errorText(e: unknown, fallback = "Something went wrong."): string {
  const d = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof d === "string" ? d : fallback;
}
