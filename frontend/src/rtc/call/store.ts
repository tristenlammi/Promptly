/**
 * The call store (DM calls, Calls phase 2): what the call UI draws, as
 * plain state (zustand), at app level so a call survives moving around
 * Promptly. Two parts:
 *
 *  - everywhere: calls ringing you (``incoming``), live calls in your
 *    conversations (``live``, for "Call in progress · Join"), and the
 *    names and pictures of people in them (``users``). Kept by ``live.ts``
 *    from ``GET /api/calls/live``, the Rooms stream and the service worker;
 *  - the call this tab is in: its connection, your mic, camera and screen,
 *    and everyone else's tracks. Written by the call engine (``engine.ts``).
 */
import type { LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import { create } from "zustand";

import type { CallMedia, CallRing, DmCall } from "@/api/dmCalls";
import type { RoomUser } from "@/api/rooms";

export type CallStatus =
  | "idle" // not in a call in this tab
  | "connecting" // asking the server and connecting
  | "calling" // you called; it's ringing the others
  | "connected"
  | "reconnecting" // the connection dropped; trying again on its own
  | "ended"; // just ended: the screen says how, then closes

export type CallEndKind =
  | "ended" // someone hung up (or you did)
  | "no-answer" // you called and nobody answered
  | "declined" // you called and they declined
  | "cancelled" // you hung up before anyone answered
  | "elsewhere" // you joined another call or a voice channel
  | "replaced" // you took the call on another device or tab
  | "access" // you can't be in it any more
  | "lost" // the connection was lost for good
  | "failed"; // couldn't connect at all

export type CallProblemKind =
  | "mic-denied"
  | "mic-missing"
  | "mic-failed"
  | "camera-denied"
  | "camera-failed"
  | "screen-failed"
  | "refused" // 403: a block, or calls off in this conversation
  | "unavailable" // 404/409: they can't take calls, the call ended, it's full
  | "connect-failed"; // couldn't reach the calls service

export interface CallProblem {
  kind: CallProblemKind;
  message: string;
}

export interface CallPeer {
  userId: string;
  /** LiveKit's display name (the username). */
  name: string;
  speaking: boolean;
  micMuted: boolean;
  camera: RemoteVideoTrack | null;
  screen: RemoteVideoTrack | null;
  connectionQuality: "excellent" | "good" | "poor" | "lost" | "unknown";
}

export interface IncomingCall extends CallRing {
  /** When this tab heard about it (ms). */
  at: number;
}

export interface CallStoreState {
  /** Calls are on for you (null until known). */
  available: boolean | null;
  /** Calls ringing you, by call id. */
  incoming: Record<string, IncomingCall>;
  /** Live calls in your conversations, by call id. */
  live: Record<string, DmCall>;
  /** The live call you're in on any device (the server's word). */
  inCallAnywhere: string | null;
  /** People seen in calls: names and pictures. */
  users: Record<string, RoomUser>;

  // ---- the call in this tab
  status: CallStatus;
  callId: string | null;
  roomId: string | null;
  /** This tab's session in the call (leave names it). */
  session: string | null;
  media: CallMedia;
  /** The server's latest view of it. */
  call: DmCall | null;
  /** You started it. */
  outgoing: boolean;
  /** When this tab connected (ms), for the timer when nobody has answered. */
  connectedAt: number | null;
  muted: boolean;
  camera: boolean;
  cameraTrack: LocalVideoTrack | null;
  facing: "user" | "environment";
  screen: boolean;
  screenTrack: LocalVideoTrack | null;
  /** Your screen share has sound. */
  screenAudio: boolean | null;
  speaking: boolean;
  peers: Record<string, CallPeer>;
  /** Full screen, or the small window you can keep while using Promptly. */
  view: "full" | "mini";
  /** Whose tile is shown big (group calls), or null for the grid. */
  pinned: string | null;
  audioBlocked: boolean;
  quality: "excellent" | "good" | "poor" | "lost" | "unknown";
  problem: CallProblem | null;
  /** Just ended: how, how long, and who it was with (the screen says so
   *  for a moment after the connection's state is gone). */
  ended: { kind: CallEndKind; seconds: number; at: number; roomId: string | null; peerIds: string[] } | null;
}

export const initialCallConnection = {
  status: "idle" as CallStatus,
  callId: null,
  roomId: null,
  session: null,
  media: "audio" as CallMedia,
  call: null,
  outgoing: false,
  connectedAt: null,
  muted: false,
  camera: false,
  cameraTrack: null,
  facing: "user" as const,
  screen: false,
  screenTrack: null,
  screenAudio: null,
  speaking: false,
  peers: {},
  view: "full" as const,
  pinned: null,
  audioBlocked: false,
  quality: "unknown" as const,
  problem: null,
} satisfies Partial<CallStoreState>;

export const useCallStore = create<CallStoreState>(() => ({
  available: null,
  incoming: {},
  live: {},
  inCallAnywhere: null,
  users: {},
  ended: null,
  ...initialCallConnection,
}));

/** In a call in this tab (any stage but idle and ended). */
export function inCallHere(s: Pick<CallStoreState, "status">): boolean {
  return s.status !== "idle" && s.status !== "ended";
}

export function rememberUsers(users: (RoomUser | null | undefined)[] | Record<string, RoomUser>): void {
  const list = Array.isArray(users) ? users : Object.values(users);
  const add = list.filter((u): u is RoomUser => !!u && !!u.id);
  if (!add.length) return;
  useCallStore.setState((s) => {
    let changed = false;
    const next = { ...s.users };
    for (const u of add) {
      const cur = next[u.id];
      if (!cur || cur.username !== u.username || cur.avatar_url !== u.avatar_url || cur.color !== u.color) {
        next[u.id] = u;
        changed = true;
      }
    }
    return changed ? { users: next } : {};
  });
}
