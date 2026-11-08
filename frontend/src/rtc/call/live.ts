/**
 * DM calls, app-wide (mounted once, signed in): keeps ``useCallStore``'s
 * "everywhere" part current, wherever in Promptly you are, so a call rings
 * in every open tab.
 *
 * Three sources, all landing in the same handlers:
 *  - ``GET /api/calls/live`` when the page opens, the Rooms stream comes
 *    back, or the window gets focus again (catch-up);
 *  - the Rooms stream (``call_*`` events), kept open in every tab while
 *    calls are on for you;
 *  - the service worker, which passes each ``call`` push (ring, stop,
 *    missed) to every open tab (``sw.ts``), for when the stream is behind.
 */
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { dmCallsApi, type CallLive, type CallRing, type DmCall } from "@/api/dmCalls";
import { roomsApi, type Bootstrap, type RoomEvent, type RoomUser } from "@/api/rooms";
import { BOOTSTRAP_KEY } from "@/rooms/cache";
import { subscribeRoomsStream } from "@/rooms/stream";
import { useAuthStore } from "@/store/authStore";

import { useVoiceStore } from "../voice/store";
import { loadedEngine } from "./actions";
import { inCallHere, rememberUsers, useCallStore, type CallStoreState } from "./store";

/** A ring is shown a little past its end, in case the stop is late. */
const RING_GRACE_MS = 3000;
/** Calls stopped here recently: a late push or event mustn't ring again. */
const stopped = new Map<string, number>();
const STOPPED_MEMORY_MS = 5 * 60_000;

/** The page's query client (for the Rooms bootstrap), while mounted. */
let queryClient: QueryClient | null = null;
let refetchTimer: ReturnType<typeof setTimeout> | null = null;
const askedRooms = new Set<string>();

/** A call in a conversation this page doesn't know yet (a group someone
 *  just made, a conversation that was closed): fetch Rooms' list again so
 *  the conversation, its name and its "Join" bar show. */
function knowRoom(roomId: string | null | undefined): void {
  const qc = queryClient;
  if (!qc || !roomId || refetchTimer) return;
  const b = qc.getQueryData<Bootstrap>(BOOTSTRAP_KEY);
  if (!b || b.dms.some((r) => r.id === roomId) || askedRooms.has(roomId)) return;
  askedRooms.add(roomId);
  refetchTimer = setTimeout(() => {
    refetchTimer = null;
    void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
  }, 250);
}

const set = (patch: Partial<CallStoreState> | ((s: CallStoreState) => Partial<CallStoreState>)) =>
  useCallStore.setState(patch as Partial<CallStoreState>);
const get = () => useCallStore.getState();

function statusOf(err: unknown): number | null {
  return (err as { response?: { status?: number } })?.response?.status ?? null;
}

function rememberStopped(callId: string): void {
  const now = Date.now();
  stopped.set(callId, now);
  for (const [id, at] of stopped) if (now - at > STOPPED_MEMORY_MS) stopped.delete(id);
}

function dropIncoming(callId: string): void {
  set((s) => {
    if (!s.incoming[callId]) return {};
    const incoming = { ...s.incoming };
    delete incoming[callId];
    return { incoming };
  });
}

/** A call is ringing you (the stream's event or the push's fields). */
export function ringArrived(ring: CallRing): void {
  if (!ring?.call_id || stopped.has(ring.call_id)) return;
  if (ring.ring_until && Date.parse(ring.ring_until) + RING_GRACE_MS < Date.now()) return;
  // Already in that call here (it rang again while you were joining).
  if (get().callId === ring.call_id && inCallHere(get())) return;
  rememberUsers([ring.caller]);
  knowRoom(ring.room_id);
  set((s) => ({ incoming: { ...s.incoming, [ring.call_id]: { ...ring, at: s.incoming[ring.call_id]?.at ?? Date.now() } } }));
}

/** Stop ringing here: answered or declined elsewhere, missed, or over. */
export function ringStopped(callId: string): void {
  rememberStopped(callId);
  dropIncoming(callId);
}

function callChanged(call: DmCall, ended: boolean): void {
  const self = useAuthStore.getState().user?.id;
  if (!ended && call.live) knowRoom(call.room_id);
  set((s) => {
    const live = { ...s.live };
    if (ended || !call.live) delete live[call.id];
    else live[call.id] = call;
    let inCallAnywhere = s.inCallAnywhere;
    if (self && call.live && call.in_call.includes(self)) inCallAnywhere = call.id;
    else if (inCallAnywhere === call.id) inCallAnywhere = null;
    return { live, inCallAnywhere };
  });
  if (ended || !call.live || (self && !call.ringing.includes(self))) {
    if (get().incoming[call.id]) ringStopped(call.id);
  }
  const engine = loadedEngine();
  if (engine) void engine.then((e) => e.onCallState(call, ended || !call.live));
}

function onEvent(ev: RoomEvent): void {
  if (!("type" in ev) || !ev.type.startsWith("call_")) return;
  switch (ev.type) {
    case "call_ring": {
      const { type: _t, ...ring } = ev;
      ringArrived(ring);
      return;
    }
    case "call_ring_stop":
      ringStopped(ev.call_id);
      return;
    case "call_state":
      callChanged(ev.call, false);
      return;
    case "call_ended":
      callChanged(ev.call, true);
      return;
    case "call_disconnected": {
      const engine = loadedEngine();
      if (engine) void engine.then((e) => e.onDisconnectedEvent(ev.call_id, ev.session, ev.reason));
      return;
    }
  }
}

/** What the service worker passes on from a ``call`` push. */
export function onCallPush(data: Record<string, unknown>): void {
  const kind = data.kind;
  const callId = typeof data.call_id === "string" ? data.call_id : null;
  if (!callId) return;
  if (kind === "call_ring") {
    ringArrived({
      call_id: callId,
      room_id: String(data.room_id ?? ""),
      media: data.media === "video" ? "video" : "audio",
      group: data.group === true,
      conversation: typeof data.conversation === "string" ? data.conversation : "",
      caller: (data.caller as RoomUser) ?? { id: "", username: "Someone", avatar_url: null, color: null },
      ring_until: typeof data.ring_until === "string" ? data.ring_until : null,
      busy: data.busy === true,
    });
  } else if (kind === "call_stop" || kind === "call_missed") {
    ringStopped(callId);
  }
}

/** Fill in rings from ``GET /api/calls/live`` (a page opened mid-ring). */
async function applyLive(qc: QueryClient, live: CallLive): Promise<void> {
  const self = useAuthStore.getState().user?.id;
  set({ available: true, live: Object.fromEntries(live.calls.map((c) => [c.id, c])), inCallAnywhere: live.in_call });
  const ringingMe = live.calls.filter((c) => self && c.ringing.includes(self) && !stopped.has(c.id));
  // Gone: rings this tab still shows that aren't ringing any more.
  for (const id of Object.keys(get().incoming)) {
    if (!ringingMe.some((c) => c.id === id)) dropIncoming(id);
  }
  if (!ringingMe.length) return;
  let b: Bootstrap | undefined;
  try {
    b = await qc.ensureQueryData({ queryKey: BOOTSTRAP_KEY, queryFn: roomsApi.bootstrap });
  } catch {
    b = undefined;
  }
  if (b) rememberUsers(b.users);
  for (const c of ringingMe) {
    if (get().incoming[c.id]) continue;
    const room = b ? [...b.dms, ...b.spaces.flatMap((s) => s.rooms)].find((r) => r.id === c.room_id) : undefined;
    const caller = (c.started_by && (get().users[c.started_by] ?? b?.users[c.started_by])) || { id: c.started_by ?? "", username: "Someone", avatar_url: null, color: null };
    const group = !!c.group;
    let conversation = "";
    if (group && room) {
      conversation = room.name || (room.members ?? []).filter((id) => id !== self).map((id) => b?.users[id]?.username ?? "").filter(Boolean).join(", ");
    }
    ringArrived({
      call_id: c.id,
      room_id: c.room_id ?? "",
      media: c.media,
      group,
      conversation,
      caller,
      ring_until: c.ring_until,
      busy: !!live.in_call && live.in_call !== c.id,
    });
  }
}

/** Keep calls live in this tab. Mount once (``CallRoot``). */
export function useCallsLive(): void {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const qc = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    queryClient = qc;
    let cancelled = false;
    let unsubStream: (() => void) | null = null;
    let lastSync = 0;
    const resync = async () => {
      lastSync = Date.now();
      try {
        const live = await dmCallsApi.live();
        if (cancelled) return;
        await applyLive(qc, live);
        if (!unsubStream && !cancelled) unsubStream = subscribeRoomsStream({ onEvent, onReconnect: () => void resync() });
      } catch (err) {
        if (cancelled) return;
        if (statusOf(err) === 404) {
          // Calls are off for you (or the server).
          set({ available: false, live: {}, incoming: {}, inCallAnywhere: null });
          unsubStream?.();
          unsubStream = null;
        }
      }
    };
    void resync();

    const onFocus = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastSync < 5000) return;
      void resync();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    // The service worker's copy of each call push.
    const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    const onSw = (e: MessageEvent) => {
      const d = e.data as { type?: string; payload?: Record<string, unknown> } | null;
      if (d?.type === "promptly-call" && d.payload) onCallPush(d.payload);
    };
    sw?.addEventListener("message", onSw);

    // Rings past their time disappear even if the stop never came.
    const sweep = window.setInterval(() => {
      const now = Date.now();
      for (const r of Object.values(get().incoming)) {
        const until = r.ring_until ? Date.parse(r.ring_until) : r.at + 45_000;
        if (until + RING_GRACE_MS < now) ringStopped(r.call_id);
      }
    }, 1000);

    // Joining a voice channel hangs up a call in this tab (one at a time).
    const offVoice = useVoiceStore.subscribe((s, prev) => {
      if (s.status === "joining" && prev.status !== "joining" && inCallHere(get())) {
        const engine = loadedEngine();
        if (engine) void engine.then((e) => e.leaveQuietly());
      }
    });

    return () => {
      cancelled = true;
      if (queryClient === qc) queryClient = null;
      unsubStream?.();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      sw?.removeEventListener("message", onSw);
      window.clearInterval(sweep);
      offVoice();
    };
  }, [userId, qc]);
}
