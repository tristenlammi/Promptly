/**
 * The Rooms live feed: one fetch-based SSE stream per open Rooms app
 * (``GET /api/rooms/events``), applied to the bootstrap cache + the
 * message windows. ``fetch`` not ``EventSource`` because auth is a bearer
 * token in memory (see ``useDiscussionEvents``); we reconnect ourselves
 * with a capped backoff, and every (re)connect after the first refetches
 * the bootstrap and the open room's tail so a drop never loses messages.
 */
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { API_BASE_URL, authHeader, refreshAccessToken } from "@/api/client";
import { ROOMS_EVENTS_PATH, type Bootstrap, type RoomEvent } from "@/api/rooms";

import { BOOTSTRAP_KEY, findRoom, patchRoom, refreshTail, removeRoom, updateBootstrap, upsertRoom } from "./cache";
import { useRoomsStore } from "./store";

const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;
// The server pings every 20 s. Silence for longer means a dead connection
// a proxy is still holding open (a backend restart, a laptop waking up):
// drop it and reconnect, which also catches up on what was missed.
const STALL_MS = 50000;

/** Which room the person is reading right now (visible + focused + at the
 *  bottom) — those messages don't count as unread. Set by the message list. */
export const readingNow = { roomId: null as string | null };

export function useRoomsEvents(openRoomId: string | null) {
  const qc = useQueryClient();
  const openRef = useRef(openRoomId);
  openRef.current = openRoomId;

  useEffect(() => {
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

    const resync = () => {
      void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
      const open = openRef.current;
      if (open) void refreshTail(open).catch(() => undefined);
    };

    const connect = async () => {
      if (cancelled) return;
      controller = new AbortController();
      lastByte = Date.now();
      try {
        let resp = await fetch(`${API_BASE_URL}${ROOMS_EVENTS_PATH}`, {
          method: "GET",
          headers: { ...authHeader(), Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (resp.status === 401) {
          // The access token expired while we were away: refresh and retry once.
          if (await refreshAccessToken()) {
            resp = await fetch(`${API_BASE_URL}${ROOMS_EVENTS_PATH}`, {
              method: "GET",
              headers: { ...authHeader(), Accept: "text/event-stream" },
              signal: controller.signal,
            });
          }
        }
        if (!resp.ok || !resp.body) throw new Error(`Rooms stream failed (${resp.status})`);
        attempt = 0;
        if (connectedBefore) resync();
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
              applyRoomEvent(qc, JSON.parse(data) as RoomEvent);
            } catch {
              // A malformed frame shouldn't kill the stream.
            }
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

    // Coming back to the window: catch up even if the stream looked alive.
    let lastFocus = 0;
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastFocus < 5000) return;
      lastFocus = now;
      resync();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      cancelled = true;
      clearInterval(watchdog);
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [qc]);
}

let bootstrapRefetchTimer: ReturnType<typeof setTimeout> | null = null;
function refetchBootstrapSoon(qc: QueryClient) {
  if (bootstrapRefetchTimer) return;
  bootstrapRefetchTimer = setTimeout(() => {
    bootstrapRefetchTimer = null;
    void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
  }, 300);
}

export function applyRoomEvent(qc: QueryClient, ev: RoomEvent) {
  const store = useRoomsStore.getState();
  const b = qc.getQueryData<Bootstrap>(BOOTSTRAP_KEY);
  switch (ev.type) {
    case "message": {
      const m = ev.message;
      store.upsertMessage(m);
      if (m.author_id) store.clearTyping(m.room_id, m.author_id);
      if (m.kind === "promptly") store.setThinking(m.room_id, false);
      const found = findRoom(b, m.room_id);
      if (!found) {
        refetchBootstrapSoon(qc);
        return;
      }
      if (m.author_id && b && !b.users[m.author_id]) refetchBootstrapSoon(qc);
      const mine = !!b && m.author_id === b.me.id && m.kind === "user";
      const reading = readingNow.roomId === m.room_id;
      patchRoom(qc, m.room_id, (r) => {
        const fresh = m.seq > r.last_seq;
        const next = {
          ...r,
          last_seq: Math.max(r.last_seq, m.seq),
          last_message_at: fresh ? m.created_at : r.last_message_at,
          preview: fresh ? { author_id: m.author_id, body: m.body, kind: m.kind } : r.preview,
        };
        if (!fresh || m.kind === "system") return next;
        if (mine || reading) return { ...next, last_read_seq: Math.max(r.last_read_seq, mine ? m.seq : r.last_read_seq) };
        const mentioned = !!b && m.mentions.includes(b.me.id);
        return { ...next, unread: r.unread + 1, mentions: r.mentions + (mentioned ? 1 : 0) };
      });
      // A DM someone wrote in shows again even if you'd closed it.
      if (!found.space) {
        updateBootstrap(qc, (cur) => {
          const at = cur.dms.findIndex((r) => r.id === m.room_id);
          if (at <= 0) return cur;
          const dms = cur.dms.slice();
          const [r] = dms.splice(at, 1);
          return { ...cur, dms: [r, ...dms] };
        });
      }
      return;
    }
    case "message_edit":
      store.upsertMessage(ev.message);
      return;
    case "message_delete":
      store.patchMessage(ev.room_id, ev.id, (m) => ({ ...m, deleted: true, body: "", attachments: [], reactions: [] }));
      return;
    case "reaction":
      store.patchMessage(ev.room_id, ev.message_id, (m) => ({ ...m, reactions: ev.reactions }));
      return;
    case "read":
      patchRoom(qc, ev.room_id, (r) =>
        ev.seq >= r.last_seq
          ? { ...r, last_read_seq: ev.seq, unread: 0, mentions: 0 }
          : { ...r, last_read_seq: Math.max(r.last_read_seq, ev.seq), unread: Math.max(0, r.last_seq - ev.seq) },
      );
      return;
    case "typing":
      if (b && ev.user_id === b.me.id) return;
      store.setTyping(ev.room_id, ev.user_id);
      return;
    case "promptly_thinking":
      store.setThinking(ev.room_id, ev.on);
      return;
    case "room":
      if (!upsertRoom(qc, ev.room)) refetchBootstrapSoon(qc);
      return;
    case "room_delete":
      removeRoom(qc, ev.room_id);
      return;
    case "space":
      refetchBootstrapSoon(qc);
      return;
    case "space_delete":
      updateBootstrap(qc, (cur) => ({ ...cur, spaces: cur.spaces.filter((s) => s.id !== ev.space_id) }));
      return;
  }
}

/** Clear a room's stacked push notification from the tray (it's been read). */
export function clearRoomNotifications(roomId: string): void {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready
    .then((reg) => reg.getNotifications({ tag: `room:${roomId}` }))
    .then((list) => list.forEach((n) => n.close()))
    .catch(() => undefined);
}
