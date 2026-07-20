/**
 * Live subscription to one discussion item's change feed.
 *
 * The backend publishes every thread/message mutation onto a Redis channel
 * and fans it out over SSE at
 * ``GET /workspaces/{workspaceId}/discussions/{itemId}/events``.
 *
 * **Why `fetch` and not `EventSource`.** Auth in this app is a bearer token
 * held in memory (``authHeader()``) — there is no session cookie, and
 * `EventSource` can't set request headers. Every other stream here (chat,
 * research, the admin live console) reads SSE off a `fetch` body for the
 * same reason, so this follows that pattern. The cost is that `fetch`
 * doesn't auto-reconnect, so we do it ourselves with a capped backoff.
 */
import { useEffect, useRef } from "react";

import { API_BASE_URL, authHeader } from "@/api/client";

export interface DiscussionEvent {
  type:
    | "thread_created"
    | "thread_deleted"
    | "message_created"
    | "message_deleted";
  item_id: string;
  thread_id?: string;
  message_id?: string;
  actor_id?: string;
  /** Present on ``message_created`` — the full DiscussionMessage. */
  message?: unknown;
}

const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;

export function useDiscussionEvents(
  workspaceId: string,
  itemId: string,
  onEvent: (event: DiscussionEvent) => void
) {
  // Keep the callback in a ref so a new closure each render doesn't tear
  // the stream down and reconnect.
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = async () => {
      if (cancelled) return;
      controller = new AbortController();
      try {
        const resp = await fetch(
          `${API_BASE_URL}/workspaces/${workspaceId}/discussions/${itemId}/events`,
          {
            method: "GET",
            headers: { ...authHeader(), Accept: "text/event-stream" },
            signal: controller.signal,
          }
        );
        if (!resp.ok || !resp.body) {
          throw new Error(`Discussion stream failed (${resp.status})`);
        }
        attempt = 0; // a successful connect resets the backoff
        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            // Heartbeats are bare ``: ping`` comments — no data lines.
            if (!data) continue;
            try {
              handler.current(JSON.parse(data) as DiscussionEvent);
            } catch {
              // Ignore a malformed frame rather than killing the stream.
            }
          }
        }
      } catch {
        // Swallow — a drop is expected (navigation, proxy timeout, sleep).
      }
      if (cancelled) return;
      // Reconnect with capped exponential backoff. The pane also keeps a
      // slow refetch, so a long outage still converges.
      attempt += 1;
      const delay = Math.min(BASE_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
      retryTimer = setTimeout(() => void connect(), delay);
    };

    void connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
    };
  }, [workspaceId, itemId]);
}
