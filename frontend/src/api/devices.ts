import { apiClient } from "./client";

/** PromptlySync pairing: a one-time QR code that links a phone. */

export interface PairStart {
  code: string;
  /** What the QR holds: `<server>/sync?code=…`. */
  url: string;
  /** The QR as a data: URI. */
  qr: string;
  /** Unix seconds. */
  expires_at: number;
  apk_url: string;
}

export type PairStatus = { state: "waiting" } | { state: "expired" } | { state: "paired"; device: string };

export const devicesApi = {
  async pair(): Promise<PairStart> {
    const { data } = await apiClient.post<PairStart>("/devices/pair", { origin: window.location.origin });
    return data;
  },
  async status(code: string): Promise<PairStatus> {
    const { data } = await apiClient.get<PairStatus>(`/devices/pair/${encodeURIComponent(code)}`);
    return data;
  },
};
