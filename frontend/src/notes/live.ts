/**
 * The Notes live stream (``GET /api/notes/events``): note ids and how far
 * they moved, never text. Each event refetches that note through the
 * normal, checked endpoint. ``fetch`` rather than ``EventSource`` because
 * auth is a bearer token in memory (the Rooms pattern, ``rooms/live.ts``).
 * Every reconnect also reloads the lists and retries the outbox, so a drop
 * never loses anything.
 */
import { useEffect } from "react";

import { API_BASE_URL, authHeader, refreshAccessToken } from "@/api/client";

import { kick, loadLists, onLiveEvent } from "./store";

const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;
const STALL_MS = 50000; // the server pings every 20 s

export function useNotesLive(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
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

    const open = () =>
      fetch(`${API_BASE_URL}/notes/events`, {
        method: "GET",
        headers: { ...authHeader(), Accept: "text/event-stream" },
        signal: controller?.signal,
      });

    const connect = async () => {
      if (cancelled) return;
      controller = new AbortController();
      lastByte = Date.now();
      try {
        let resp = await open();
        if (resp.status === 401 && (await refreshAccessToken())) resp = await open();
        if (!resp.ok || !resp.body) throw new Error(`Notes stream failed (${resp.status})`);
        attempt = 0;
        if (connectedBefore) {
          void loadLists();
          kick();
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
            try {
              onLiveEvent(JSON.parse(data));
            } catch {
              // A malformed frame shouldn't end the stream.
            }
          }
        }
      } catch {
        // Expected: navigation, sleep, no connection.
      }
      if (cancelled) return;
      attempt += 1;
      retryTimer = setTimeout(() => void connect(), Math.min(BASE_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS));
    };
    void connect();

    let lastFocus = 0;
    const onFocus = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastFocus < 5000) return;
      lastFocus = Date.now();
      void loadLists();
      kick();
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      controller?.abort();
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled]);
}
