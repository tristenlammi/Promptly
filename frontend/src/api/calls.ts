import { apiClient } from "./client";

/** Calls (voice channels): Test calls and Admin → Calls. */

export type StreamQuality = "720p30" | "1080p30" | "1080p60";

export interface CallsMe {
  /** Voice is on for me. */
  available: boolean;
  /** I may run Test calls (anyone with voice, and admins before it's on). */
  can_test: boolean;
  /** The server has a calls key pair at all. */
  configured: boolean;
  max_stream: StreamQuality;
}

export interface TestJoin {
  url: string;
  room: string;
  identity: string;
  token: string;
  echo_identity: string;
  echo_token: string;
}

export interface TestReport {
  ok: boolean;
  protocol?: "udp" | "tcp" | null;
  candidate_type?: "host" | "srflx" | "prflx" | "relay" | null;
  rtt_ms?: number | null;
  packet_loss_pct?: number | null;
  connect_ms?: number | null;
  server_address?: string | null;
  download_mbps?: number | null;
  error?: string | null;
}

export interface CallsAdminSettings {
  enabled: boolean;
  /** null = everyone. */
  group_ids: string[] | null;
  max_participants: number;
  max_stream: StreamQuality;
  configured: boolean;
}

export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

export interface CallsCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix: string | null;
}

export interface CallsChecklist {
  checks: CallsCheck[];
  ports: { udp: number; tcp: number };
}

export interface CallsUsage {
  running: boolean;
  people_in_voice: number | null;
  channels_in_use: number | null;
  tests_running: number | null;
  upload_bps: number | null;
  metrics_available: boolean;
  minutes_30d: number;
}

export const callsApi = {
  async me(): Promise<CallsMe> {
    return (await apiClient.get<CallsMe>("/calls/me")).data;
  },
  async startTest(): Promise<TestJoin> {
    return (await apiClient.post<TestJoin>("/calls/test")).data;
  },
  async reportTest(report: TestReport): Promise<{ outside: boolean }> {
    return (await apiClient.post<{ outside: boolean }>("/calls/test/report", report)).data;
  },
  /** Downloads ``mb`` megabytes of random bytes and returns Mbps. */
  async speedtest(mb = 8, signal?: AbortSignal): Promise<number> {
    const t0 = performance.now();
    const res = await apiClient.get<ArrayBuffer>("/calls/speedtest", {
      params: { mb, t: Date.now() },
      responseType: "arraybuffer",
      timeout: 60_000,
      signal,
    });
    const seconds = Math.max(0.05, (performance.now() - t0) / 1000);
    return (res.data.byteLength * 8) / seconds / 1_000_000;
  },
  async adminSettings(): Promise<CallsAdminSettings> {
    return (await apiClient.get<CallsAdminSettings>("/calls/admin/settings")).data;
  },
  async patchAdminSettings(
    body: Partial<Omit<CallsAdminSettings, "configured">> & { everyone?: boolean }
  ): Promise<CallsAdminSettings> {
    return (await apiClient.patch<CallsAdminSettings>("/calls/admin/settings", body)).data;
  },
  async check(): Promise<CallsChecklist> {
    return (await apiClient.get<CallsChecklist>("/calls/check", { timeout: 20_000 })).data;
  },
  async usage(): Promise<CallsUsage> {
    return (await apiClient.get<CallsUsage>("/calls/usage")).data;
  },
};
