/**
 * The sidebar's count badges (``GET /api/badges``) for the apps pinned to it.
 *
 * Kept fresh three ways, cheapest first:
 *  - after your own actions: any successful change you make in Mail, Rooms,
 *    Porch, Calls or an Item Store app (Tasks) marks the counts stale, so
 *    reading a message or ticking a task off clears its badge straight away;
 *  - live, for Rooms: while Rooms is in the sidebar the shared Rooms stream
 *    (the one calls already keep open) says when a message arrives, a room
 *    is read on another device or a call is missed;
 *  - otherwise: on window focus and every 60 s while the page is visible
 *    (new mail, Porch activity, a task falling due at midnight).
 */
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { BADGE_APPS, badgesApi, type BadgeCounts } from "@/api/badges";
import { apiClient } from "@/api/client";
import type { RoomEvent } from "@/api/rooms";
import { subscribeRoomsStream } from "@/rooms/stream";
import { useAuthStore } from "@/store/authStore";

export const BADGES_KEY = ["nav-badges"] as const;

const POLL_MS = 60_000;
const SETTLE_MS = 800;

/** Writes to these APIs can change a badge. */
const WRITES = /^\/?(?:api\/)?(mail|rooms|porch|calls|items)(?:\/|$)/;
const CHANGING = new Set(["post", "put", "patch", "delete"]);
/** Rooms stream events that can change the Rooms number. */
const ROOM_EVENTS = new Set(["message", "message_delete", "read", "room", "room_delete", "space", "space_delete", "calls_missed"]);

let client: QueryClient | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Something a badge counts may have changed: refetch soon (several
 *  changes in a row make one request). Safe to call from anywhere. */
export function badgesStale(): void {
  if (!client || timer) return;
  timer = setTimeout(() => {
    timer = null;
    void client?.invalidateQueries({ queryKey: BADGES_KEY });
  }, SETTLE_MS);
}

let watching = false;
function watchWrites(): void {
  if (watching) return;
  watching = true;
  apiClient.interceptors.response.use((res) => {
    const method = (res.config?.method ?? "get").toLowerCase();
    if (CHANGING.has(method) && WRITES.test(res.config?.url ?? "")) badgesStale();
    return res;
  });
}

/** ``{app: count}`` for these sidebar app ids (only the ones with badges are asked). */
export function useNavBadges(appIds: readonly string[]): BadgeCounts {
  const qc = useQueryClient();
  const signedIn = useAuthStore((s) => Boolean(s.user));
  const wanted = useMemo(() => BADGE_APPS.filter((a) => appIds.includes(a)), [appIds]);
  const roomsShown = wanted.includes("rooms");

  useEffect(() => {
    client = qc;
    watchWrites();
  }, [qc]);

  useEffect(() => {
    if (!signedIn || !roomsShown) return;
    return subscribeRoomsStream({
      onEvent: (ev: RoomEvent) => {
        if ("type" in ev && ROOM_EVENTS.has(ev.type)) badgesStale();
      },
      onReconnect: badgesStale,
    });
  }, [signedIn, roomsShown]);

  const { data } = useQuery({
    queryKey: [...BADGES_KEY, wanted.join(",")],
    queryFn: () => badgesApi.get(wanted),
    enabled: signedIn && wanted.length > 0,
    staleTime: 15_000,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    // A failed count just shows no badge; don't hammer the server.
    retry: false,
  });
  return data ?? {};
}
