/**
 * The voice store: everything the UI shows about voice, as plain state
 * (zustand). It lives at app level, so a voice connection survives
 * navigating between rooms and Promptly apps. The engine
 * (``engine.ts``, loaded on first use) writes it; components read it with
 * ``useVoice`` and act through ``actions.ts``.
 *
 * Two kinds of state:
 *  - your connection: status, channel, mute/deafen, peers and their tracks,
 *    your mic's readings, Go Live and watching, problems and notices;
 *  - every voice channel you can see (from the Rooms stream): who's in it
 *    and who's speaking, for channel lists (``channels``, ``speakingIn``).
 */
import type { RemoteVideoTrack, LocalVideoTrack } from "livekit-client";
import { create } from "zustand";

import type { StreamQuality, VoiceEndReason, VoiceMember, VoiceQuality } from "@/api/voiceChannels";

import type { FallbackReason, NoiseEngine, NoisePref } from "../audio/engines";

export type VoiceStatus =
  | "idle" // not in voice
  | "joining" // asking the server and connecting
  | "connected"
  | "reconnecting" // the connection dropped; trying again on its own
  | "lost"; // gave up after 30 s: offer "Rejoin"

export type VoiceProblemKind =
  | "mic-denied" // the browser refused the microphone
  | "mic-missing" // no microphone
  | "mic-failed" // the mic wouldn't start
  | "full" // the channel is full
  | "forbidden" // e.g. "Only admins can join Lounge"
  | "unavailable" // voice is off, or the channel's gone
  | "connect-failed" // couldn't reach the calls service
  | "camera-denied"
  | "camera-failed"
  | "screen-failed"; // Go Live couldn't start (not a cancel)

export interface VoiceProblem {
  kind: VoiceProblemKind;
  /** The server's or browser's words, for details. */
  message: string;
}

/** Why you're no longer in a channel: the server's reasons, plus
 *  "removed" (LiveKit dropped you without saying why) and "connection"
 *  (gave up reconnecting). */
export type VoiceEndKind = VoiceEndReason | "removed" | "connection";

export type VoiceNotice =
  | { kind: "moved"; fromRoomId: string; toRoomId: string; by: string; at: number }
  | { kind: "ended"; reason: VoiceEndKind; roomId: string; by?: string; at: number }
  | { kind: "noise-fallback"; reason: FallbackReason; at: number };

export interface VoicePeer {
  userId: string;
  /** LiveKit says they're talking (instant; the rings while connected). */
  speaking: boolean;
  /** They have a microphone published. */
  hasMic: boolean;
  /** Their mic track is muted (LiveKit's view). */
  micMuted: boolean;
  /** Camera video, when subscribed. */
  camera: RemoteVideoTrack | null;
  /** They're live (a screen track is published), whether or not you watch. */
  live: boolean;
  /** Their stream's video, while you watch it. */
  screen: RemoteVideoTrack | null;
  /** Their stream has sound. */
  streamAudio: boolean;
  connectionQuality: "excellent" | "good" | "poor" | "lost" | "unknown";
}

export interface VoiceConnectionInfo {
  quality: "excellent" | "good" | "poor" | "lost" | "unknown";
  rttMs: number | null;
  lossPct: number | null;
  protocol: "udp" | "tcp" | null;
  candidateType: "host" | "srflx" | "prflx" | "relay" | null;
}

export interface VoiceNoiseInfo {
  /** What the person picked. */
  pref: NoisePref;
  /** What runs. */
  engine: NoiseEngine;
  /** Why Enhanced isn't its first choice here, if it isn't. */
  reason: FallbackReason;
  /** Share of one core the suppressor uses (last second), when known. */
  load: number | null;
}

export interface VoiceStoreState {
  status: VoiceStatus;
  /** The channel you're in (or joining / reconnecting to). */
  roomId: string | null;
  spaceId: string | null;
  /** While joining another channel from this one. */
  joiningRoomId: string | null;
  /** This connection's session id (reports name it). */
  session: string | null;
  joinedAt: number | null;
  quality: VoiceQuality | null;
  bitrate: number | null;
  canTalk: boolean;
  canVideo: boolean;
  maxStream: StreamQuality;

  muted: boolean;
  deafened: boolean;
  serverMuted: boolean;
  serverDeafened: boolean;
  /** You're sending voice right now (the gate is open). */
  speaking: boolean;
  /** The mic hears you talking while you're muted ("You're muted"). */
  talkingWhileMuted: boolean;
  /** Manual sensitivity looks too high ("You might be too quiet"). */
  quiet: boolean;
  /** Push to talk key held. */
  pttActive: boolean;
  /** The browser is holding sound back until a click or key (a join
   *  without one, e.g. rejoining after a reload). */
  audioBlocked: boolean;

  camera: boolean;
  /** Your own camera, for a self view. */
  cameraTrack: LocalVideoTrack | null;
  live: boolean;
  /** Your stream has sound (null when not live). */
  liveAudio: boolean | null;
  liveQuality: StreamQuality | null;
  liveTrack: LocalVideoTrack | null;
  /** Whose stream you watch. */
  watching: string | null;
  /** The watched stream's own volume, 0..200. */
  streamVolume: number;

  /** Who's connected with you (LiveKit's view), by user id. */
  peers: Record<string, VoicePeer>;
  /** The server's view of your channel (mute icons, LIVE, who watches). */
  members: VoiceMember[];

  noise: VoiceNoiseInfo;
  connection: VoiceConnectionInfo;
  problem: VoiceProblem | null;
  notice: VoiceNotice | null;
  /** "Still there?" asked; answer with ``answerStillHere``. */
  stillThere: { roomId: string; deadline: string; seconds: number } | null;

  /** Every voice channel you can see: who's in it now. */
  channels: Record<string, VoiceMember[]>;
  /** Every voice channel you can see: who's speaking (from the server). */
  speakingIn: Record<string, Record<string, true>>;
}

export const EMPTY_CONNECTION: VoiceConnectionInfo = {
  quality: "unknown",
  rttMs: null,
  lossPct: null,
  protocol: null,
  candidateType: null,
};

export const initialVoiceState: VoiceStoreState = {
  status: "idle",
  roomId: null,
  spaceId: null,
  joiningRoomId: null,
  session: null,
  joinedAt: null,
  quality: null,
  bitrate: null,
  canTalk: true,
  canVideo: false,
  maxStream: "720p30",
  muted: false,
  deafened: false,
  serverMuted: false,
  serverDeafened: false,
  speaking: false,
  talkingWhileMuted: false,
  quiet: false,
  pttActive: false,
  audioBlocked: false,
  camera: false,
  cameraTrack: null,
  live: false,
  liveAudio: null,
  liveQuality: null,
  liveTrack: null,
  watching: null,
  streamVolume: 100,
  peers: {},
  members: [],
  noise: { pref: "enhanced", engine: "browser", reason: null, load: null },
  connection: EMPTY_CONNECTION,
  problem: null,
  notice: null,
  stillThere: null,
  channels: {},
  speakingIn: {},
};

export const useVoiceStore = create<VoiceStoreState>(() => ({ ...initialVoiceState }));

/** Mic level meters, 0..1, by user id ("me" for you): updated ~10 times a
 *  second while connected, kept apart so meters don't re-render the rest. */
export const useVoiceLevels = create<{ levels: Record<string, number> }>(() => ({ levels: {} }));

export const ME = "me";

/** The connection state of the store. Leaves alone the channel lists, your
 *  stream volume and noise settings, and mute / deafen: like Discord, you
 *  can be muted or deafened outside voice and stay so when you join. */
export function connectionReset(): Partial<VoiceStoreState> {
  const { channels: _c, speakingIn: _s, streamVolume: _v, noise: _n, muted: _m, deafened: _d, ...rest } = initialVoiceState;
  return rest;
}
