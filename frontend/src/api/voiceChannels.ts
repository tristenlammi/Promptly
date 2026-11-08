import { apiClient } from "./client";

/**
 * Voice channels (Calls WP-V2): Rooms rooms of kind "voice". Joining hands
 * back what the client connects to LiveKit with; live state comes on the
 * Rooms stream as ``voice_*`` events. See ``backend/app/calls/voice*.py``.
 */

export type VoiceQuality = "standard" | "good" | "high" | "music";
export type StreamQuality = "720p30" | "1080p30" | "1080p60";

/** Someone in a voice channel, as everyone looking at the space sees them. */
export interface VoiceMember {
  user_id: string;
  muted: boolean;
  deafened: boolean;
  server_muted: boolean;
  server_deafened: boolean;
  video: boolean;
  live: boolean;
  /** Whose Go Live stream they're watching, or null. */
  watching: string | null;
  device: "web" | "android";
  joined_at: string | null;
}

/** A voice channel's settings (``room.voice`` in the bootstrap). */
export interface VoiceChannelSettings {
  user_limit: number;
  quality: VoiceQuality;
  /** Opus kbps the clients publish at. */
  bitrate: number;
  join_role: "member" | "admin";
  talk_role: "member" | "admin";
  video: boolean;
  alone_minutes: number | null;
}

/** ``POST /rooms/rooms/{id}/voice/join``: what a client connects with. */
export interface VoiceJoin {
  /** The signalling path through nginx (``/livekit``). */
  url: string;
  token: string;
  identity: string;
  room_id: string;
  space_id: string;
  lk_room: string;
  /** The signed voice session (the Android service's key). */
  session: string;
  /** This join's session id: reports and leave name it. */
  session_id: string;
  device: "web" | "android";
  quality: VoiceQuality;
  bitrate: number;
  can_talk: boolean;
  can_video: boolean;
  server_muted: boolean;
  server_deafened: boolean;
  max_stream: StreamQuality;
  members: VoiceMember[];
}

/** Where you are in voice (a reloaded page, bootstrap's ``voice_me``). */
export interface VoiceWhere {
  room_id: string | null;
  space_id?: string | null;
  device?: "web" | "android" | null;
  session_id?: string | null;
  joined_at?: string | null;
}

/** Why you left a channel without asking to (``voice_disconnected``). */
export type VoiceEndReason =
  | "left" // you left from another device or tab
  | "admin" // an admin disconnected you
  | "alone" // alone too long and "Still there?" went unanswered
  | "replaced" // you joined on another device (or another channel elsewhere)
  | "moved" // an admin moved you and this connection didn't follow
  | "access" // you can't be in this channel any more
  | "voice_off" // voice was turned off for the server or for you
  | "deleted" // the channel was deleted
  | "lost"; // the server lost track of this connection

export type VoiceServerEvent =
  | { type: "voice_state"; room_id: string; members: VoiceMember[] }
  | { type: "voice_speaking"; room_id: string; user_id: string; on: boolean }
  | { type: "voice_moved"; from_room_id: string; to_room_id: string; by: string; session: string; handled?: boolean }
  | { type: "voice_disconnected"; room_id: string; session: string | null; reason: VoiceEndReason; by?: string }
  | { type: "voice_still_there"; room_id: string; deadline: string; seconds: number };

export interface VoiceStateReport {
  session?: string;
  muted?: boolean;
  deafened?: boolean;
  video?: boolean;
  live?: boolean;
  /** The user id whose stream you're watching; "" when you stop. */
  watching?: string;
}

export const voiceApi = {
  async join(roomId: string, device: "web" | "android" = "web"): Promise<VoiceJoin> {
    const { data } = await apiClient.post<VoiceJoin>(`/rooms/rooms/${roomId}/voice/join`, { device });
    return data;
  },
  async leave(session?: string): Promise<boolean> {
    const { data } = await apiClient.post<{ ok: boolean; left: boolean }>("/rooms/voice/leave", { session: session ?? null });
    return data.left;
  },
  async me(): Promise<VoiceWhere> {
    const { data } = await apiClient.get<VoiceWhere>("/rooms/voice/me");
    return data;
  },
  async state(body: VoiceStateReport): Promise<VoiceMember> {
    const { data } = await apiClient.post<VoiceMember>("/rooms/voice/state", body);
    return data;
  },
  async speaking(on: boolean): Promise<void> {
    await apiClient.post("/rooms/voice/speaking", { on });
  },
  async stillHere(): Promise<void> {
    await apiClient.post("/rooms/voice/still-here");
  },
  async control(action: "mute" | "unmute" | "deafen" | "undeafen" | "leave"): Promise<{ delivered: boolean }> {
    const { data } = await apiClient.post<{ ok: boolean; delivered: boolean }>("/rooms/voice/control", { action });
    return data;
  },
};
