/**
 * The Rooms live stream (``GET /api/rooms/events``), shared: one fetch-based
 * SSE connection per tab however many parts of the app listen. The Rooms
 * app listens while it's open; the voice engine (``rtc/voice``) listens
 * while you're in a voice channel, on any page. The first listener opens the
 * stream and the last one to leave closes it.
 *
 * ``fetch`` not ``EventSource`` because auth is a bearer token in memory; we
 * reconnect ourselves with a capped backoff, and every reconnect after the
 * first tells listeners (``onReconnect``) so they can catch up on what a
 * drop missed.
 */
import { API_BASE_URL, authHeader, refreshAccessToken } from "@/api/client";
import { ROOMS_EVENTS_PATH, type RoomEvent } from "@/api/rooms";

const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;
// The server pings every 20 s. Silence for longer means a dead connection
// a proxy is still holding open (a backend restart, a laptop waking up):
// drop it and reconnect, which also catches up on what was missed.
const STALL_MS = 50000;

export interface RoomsStreamListener {
  onEvent: (ev: RoomEvent) => void;
  /** The stream came back after a drop (not called for the first connect). */
  onReconnect?: () => void;
}

const listeners = new Set<RoomsStreamListener>();
let stopStream: (() => void) | null = null;

export function subscribeRoomsStream(listener: RoomsStreamListener): () => void {
  listeners.add(listener);
  if (!stopStream) stopStream = openStream();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && stopStream) {
      stopStream();
      stopStream = null;
    }
  };
}

function emit(ev: RoomEvent): void {
  for (const l of [...listeners]) {
    try {
      l.onEvent(ev);
    } catch {
      // One listener's bug mustn't starve the others.
    }
  }
}

function openStream(): () => void {
  let cancelled = false;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let connectedBefore = false;
  let lastByte = Date.now();
  const watchdog = setInterval(() => {
    if (controller && Date.now() - lastByte > STALL_MS) {
      lastByte = Date.now();
      controller.abort();
    }
  }, 10000);

  const get = (signal: AbortSignal) =>
    fetch(`${API_BASE_URL}${ROOMS_EVENTS_PATH}`, {
      method: "GET",
      headers: { ...authHeader(), Accept: "text/event-stream" },
      signal,
    });

  const connect = async () => {
    if (cancelled) return;
    controller = new AbortController();
    lastByte = Date.now();
    try {
      let resp = await get(controller.signal);
      if (resp.status === 401) {
        // The access token expired while we were away: refresh and retry once.
        if (await refreshAccessToken()) resp = await get(controller.signal);
      }
      if (!resp.ok || !resp.body) throw new Error(`Rooms stream failed (${resp.status})`);
      attempt = 0;
      if (connectedBefore) {
        for (const l of [...listeners]) {
          try {
            l.onReconnect?.();
          } catch {
            /* as above */
          }
        }
      }
      connectedBefore = true;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      while (!cancelled) {
        const { value, done } = await reader.read();
        if (done) break;
        lastByte = Date.now();
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          let ev: RoomEvent;
          try {
            ev = JSON.parse(data) as RoomEvent;
          } catch {
            continue; // A malformed frame shouldn't kill the stream.
          }
          emit(ev);
        }
      }
    } catch {
      // Expected: navigation, proxy timeout, sleep.
    }
    if (cancelled) return;
    attempt += 1;
    const delay = Math.min(BASE_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
    retryTimer = setTimeout(() => void connect(), delay);
  };

  void connect();

  return () => {
    cancelled = true;
    clearInterval(watchdog);
    if (retryTimer) clearTimeout(retryTimer);
    controller?.abort();
  };
}
