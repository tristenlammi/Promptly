import { apiClient } from "./client";

/**
 * Admin API for the Local Models tab (Phase 2).
 *
 * Wraps the bundled Ollama runtime exposed by the backend at
 * ``/api/admin/local-models``. Split into plain request/response
 * helpers here; React Query + SSE wiring lives in
 * ``hooks/useLocalModels.ts``.
 */

export interface InstalledModel {
  name: string;
  size_bytes: number | null;
  modified_at: string | null;
  digest: string | null;
  family: string | null;
  parameter_size: string | null;
  quantization: string | null;
}

export type LibrarySizeClass = "tiny" | "small" | "medium" | "large";
export type LibraryModality = "text" | "vision" | "code";

export interface LibraryEntry {
  name: string;
  display_name: string;
  family: string;
  description: string;
  size_class: LibrarySizeClass;
  parameter_size: string;
  context_window: number;
  modality: LibraryModality;
  disk_bytes: number;
  recommended_vram_bytes: number;
  recommended_ram_bytes: number | null;
  supports_vision: boolean;
  license: string | null;
}

export interface HardwareGPU {
  name: string;
  vram_total_bytes: number;
  vram_free_bytes: number;
}

export interface HardwareProbe {
  cpu_count: number;
  total_ram_bytes: number;
  has_nvidia: boolean;
  gpus: HardwareGPU[];
}

/** One progress event emitted by an Ollama ``POST /api/pull`` stream,
 *  forwarded verbatim with a final ``{done: true}`` terminator from
 *  the backend. */
export interface PullEvent {
  status?: string;
  completed?: number;
  total?: number;
  digest?: string;
  error?: boolean;
  detail?: string;
  done?: boolean;
}

const BASE = "/admin/local-models";

export const localModelsApi = {
  async listInstalled(): Promise<InstalledModel[]> {
    const { data } = await apiClient.get<InstalledModel[]>(`${BASE}/installed`);
    return data;
  },
  async library(): Promise<LibraryEntry[]> {
    const { data } = await apiClient.get<LibraryEntry[]>(`${BASE}/library`);
    return data;
  },
  async hardware(): Promise<HardwareProbe> {
    const { data } = await apiClient.get<HardwareProbe>(`${BASE}/hardware`);
    return data;
  },
  async deleteInstalled(name: string): Promise<void> {
    // ``name`` may contain ``:`` (e.g. ``llama3.1:8b``); the backend
    // route uses the ``path`` converter so we don't need to encode it
    // here — but encodeURI would drop the colon anyway, so we leave
    // it as-is.
    await apiClient.delete(
      `${BASE}/installed/${encodeURI(name).replace(/%2F/gi, "/")}`
    );
  },
  async refreshProvider(): Promise<{ created: number; models: number }> {
    const { data } = await apiClient.post<{ created: number; models: number }>(
      `${BASE}/refresh-provider`
    );
    return data;
  },

  /**
   * Stream an Ollama ``pull`` as Server-Sent Events.
   *
   * Uses ``fetch`` rather than the axios ``apiClient`` because SSE
   * requires a streaming body which axios can't surface reliably.
   * Auth piggybacks on the same access-token cookie the rest of the
   * app uses.
   *
   * ``signal`` is an ``AbortSignal`` so the UI can cancel mid-stream
   * (e.g. user clicks "Cancel download"); aborting closes the SSE
   * connection and Ollama stops the pull on the next chunk.
   */
  async *streamPull(
    name: string,
    opts: { signal?: AbortSignal; accessToken?: string | null } = {}
  ): AsyncGenerator<PullEvent, void, void> {
    const r = await fetch(`/api${BASE}/pull`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(opts.accessToken
          ? { Authorization: `Bearer ${opts.accessToken}` }
          : {}),
      },
      body: JSON.stringify({ name }),
      signal: opts.signal,
      credentials: "include",
    });
    if (!r.ok || !r.body) {
      let detail = `HTTP ${r.status}`;
      try {
        const body = await r.text();
        detail = body.slice(0, 300) || detail;
      } catch {
        // ignore
      }
      yield { error: true, detail };
      yield { done: true };
      return;
    }

    const reader = r.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;

      // SSE events are separated by blank lines; each ``data:`` line
      // carries one JSON object.
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const chunk of parts) {
        const line = chunk
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice("data:".length).trim();
        if (!payload) continue;
        try {
          yield JSON.parse(payload) as PullEvent;
        } catch {
          // Malformed frame — skip rather than crashing the stream.
        }
      }
    }
  },
};
