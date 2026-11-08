import { apiClient } from "./client";
import type { RoomUser } from "./rooms";
import type { StreamQuality } from "./voiceChannels";

/**
 * DM calls (Calls phase 2): voice and video calls in Rooms conversations,
 * 1:1 and group. The server (``backend/app/calls/dm.py``) owns who's
 * ringing and who's in; LiveKit carries the media. Live changes arrive on
 * the Rooms stream as ``call_*`` events and, for rings, as Web Pushes the
 * service worker passes to every open tab.
 */

export type CallMedia = "audio" | "video";
export type RingState = "ringing" | "answered" | "declined" | "missed" | "busy" | null;
export type CallEndedReason = "completed" | "missed" | "cancelled" | "declined" | "ended" | null;

export interface CallParticipant {
  user_id: string;
  ring: RingState;
  /** Connected now. */
  in_call: boolean;
  device: "web" | "android" | null;
  joined_at: string | null;
}

/** A DM call as every member of its conversation sees it. */
export interface DmCall {
  id: string;
  kind: "dm";
  room_id: string | null;
  /** A group conversation (else 1:1). */
  group: boolean | null;
  media: CallMedia;
  started_by: string | null;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  ended_reason: CallEndedReason;
  live: boolean;
  /** Who's connected, in the order they came. */
  in_call: string[];
  ringing: string[];
  ring_until: string | null;
  duration: number;
  participants: CallParticipant[];
}

/** ``POST /api/calls`` and ``/join``: what a client connects with. */
export interface CallJoin {
  call: DmCall;
  /** The signalling path through nginx (``/livekit``). */
  url: string;
  token: string;
  identity: string;
  lk_room: string;
  room_id: string;
  /** The signed call session (the Android service's key). */
  session: string;
  /** This join's session id: leave names it. */
  session_id: string;
  device: "web" | "android";
  max_stream: StreamQuality;
}

/** ``call_ring``: a call ringing you (Rooms stream, and the push's fields). */
export interface CallRing {
  call_id: string;
  room_id: string;
  media: CallMedia;
  group: boolean;
  /** A group's name as you see it ("" for 1:1). */
  conversation: string;
  caller: RoomUser;
  ring_until: string | null;
  /** You're already talking (another call or a voice channel). */
  busy: boolean;
}

export type CallStopReason = "answered" | "declined" | "missed";
export type CallDisconnectReason = "replaced" | "elsewhere" | "access" | "lost" | "left";

export type CallServerEvent =
  | ({ type: "call_ring" } & CallRing)
  | { type: "call_state"; call: DmCall }
  | { type: "call_ended"; call: DmCall }
  /** Stop ringing on this device: you answered or declined elsewhere, or missed it. */
  | { type: "call_ring_stop"; call_id: string; reason: CallStopReason }
  /** Your connection to a call ended without you hanging up here. */
  | { type: "call_disconnected"; call_id: string; session: string | null; reason: CallDisconnectReason };

/** ``meta.call`` on a call's line in the conversation. */
export interface CallLineMeta {
  id: string;
  media: CallMedia;
  outcome: CallEndedReason;
  seconds: number;
  started_by: string | null;
  joined: string[];
  missed: string[];
  declined: string[];
}

export interface CallLive {
  calls: DmCall[];
  /** The call you're connected to (anywhere), if any. */
  in_call: string | null;
}

export const dmCallsApi = {
  /** Call a conversation (rings the others; joins its live call if one is on). */
  async start(roomId: string, media: CallMedia): Promise<CallJoin> {
    const { data } = await apiClient.post<CallJoin>("/calls", { room_id: roomId, media, device: "web" });
    return data;
  },
  /** Call people (opens the conversation with them first). */
  async startDm(userIds: string[], media: CallMedia): Promise<CallJoin> {
    const { data } = await apiClient.post<CallJoin>("/calls/dm", { user_ids: userIds, media, device: "web" });
    return data;
  },
  async live(): Promise<CallLive> {
    const { data } = await apiClient.get<CallLive>("/calls/live");
    return data;
  },
  async get(callId: string): Promise<DmCall> {
    const { data } = await apiClient.get<DmCall>(`/calls/${callId}`);
    return data;
  },
  /** Answer, join a live group call, or move your call to this tab. */
  async join(callId: string): Promise<CallJoin> {
    const { data } = await apiClient.post<CallJoin>(`/calls/${callId}/join`, { device: "web" });
    return data;
  },
  async decline(callId: string): Promise<DmCall> {
    const { data } = await apiClient.post<DmCall>(`/calls/${callId}/decline`);
    return data;
  },
  async leave(callId: string, session?: string | null): Promise<boolean> {
    const { data } = await apiClient.post<{ ok: boolean; left: boolean }>(`/calls/${callId}/leave`, { session: session ?? null });
    return data.left;
  },
  async end(callId: string): Promise<DmCall> {
    const { data } = await apiClient.post<DmCall>(`/calls/${callId}/end`);
    return data;
  },
  /** Ring people who aren't in the call (everyone missing, by default). */
  async ring(callId: string, userIds?: string[]): Promise<DmCall & { rang: string[] }> {
    const { data } = await apiClient.post<DmCall & { rang: string[] }>(`/calls/${callId}/ring`, { user_ids: userIds ?? null });
    return data;
  },
};
