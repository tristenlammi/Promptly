/**
 * What the UI does with voice. Everything goes through the one engine of
 * this tab, which is loaded (with LiveKit and the audio pipeline) the first
 * time it's needed, so pages that only show channel lists don't pay for it.
 *
 *   voice.join(roomId)        join, or move from your current channel
 *   voice.leave()
 *   voice.toggleMute() / voice.toggleDeafen()
 *   voice.setPersonVolume(userId, 0..200) / voice.setLocalMute(userId, on)
 *   voice.startLive({ quality, hint }) / voice.stopLive() / voice.watch(userId | null)
 *   ...
 * State to draw comes from ``useVoice`` (``hooks.ts``).
 */
import type { StreamQuality } from "@/api/voiceChannels";

import type { VoiceEngine } from "./engine";
import type { StreamHint } from "./goLive";
import type { VoicePrefs } from "./prefs";
import { useVoiceStore } from "./store";

let enginePromise: Promise<VoiceEngine> | null = null;

/** The tab's voice engine (loaded on first call). */
export function voiceEngine(): Promise<VoiceEngine> {
  if (!enginePromise) {
    enginePromise = import("./engine")
      .then((m) => new m.VoiceEngine())
      .catch((err) => {
        enginePromise = null;
        throw err;
      });
  }
  return enginePromise;
}

const withEngine =
  <A extends unknown[], R>(fn: (e: VoiceEngine, ...a: A) => R) =>
  async (...a: A): Promise<Awaited<R>> =>
    await fn(await voiceEngine(), ...a);

export const voice = {
  /** Join a voice channel (moves you from another; you're only ever in one). */
  join: withEngine((e, roomId: string) => e.joinChannel(roomId)),
  /** "Rejoin" after the connection was lost. */
  rejoin: withEngine((e) => {
    const roomId = useVoiceStore.getState().roomId;
    return roomId ? e.joinChannel(roomId) : Promise.resolve(false);
  }),
  leave: withEngine((e) => e.leave()),
  /** Warm up (hovering a channel): library, suppressor, connection. */
  prepare: withEngine((e) => e.prepare()),

  setMuted: withEngine((e, muted: boolean) => e.setMuted(muted)),
  toggleMute: withEngine((e) => e.setMuted(!useVoiceStore.getState().muted)),
  setDeafened: withEngine((e, deafened: boolean) => e.setDeafened(deafened)),
  toggleDeafen: withEngine((e) => e.setDeafened(!useVoiceStore.getState().deafened)),
  /** Hold-to-talk button (phones); the keybind works on its own. */
  pushToTalk: withEngine((e, down: boolean) => e.pushToTalk(down)),

  setPersonVolume: withEngine((e, userId: string, percent: number) => e.setPersonVolume(userId, percent)),
  setLocalMute: withEngine((e, userId: string, muted: boolean) => e.setLocalMute(userId, muted)),
  setStreamVolume: withEngine((e, percent: number) => e.setStreamVolume(percent)),

  setCamera: withEngine((e, on: boolean) => e.setCamera(on)),
  startLive: withEngine((e, opts?: { quality?: StreamQuality; hint?: StreamHint; audio?: boolean; surface?: "monitor" | "window" | "browser" }) => e.startLive(opts)),
  stopLive: withEngine((e) => e.stopLive()),
  watch: withEngine((e, userId: string | null) => e.setWatching(userId)),

  answerStillHere: withEngine((e) => e.answerStillHere()),
  /** Ask for the microphone again (after it was refused or failed). */
  retryMic: withEngine((e) => e.retryMic()),
  /** Turn sound on when the browser held it back. */
  resumeAudio: withEngine((e) => e.resumeAudio()),
  dismissNotice: withEngine((e) => e.dismissNotice()),
  dismissProblem: withEngine((e) => e.dismissProblem()),

  setInputDevice: withEngine((e, deviceId: string) => e.setInputDevice(deviceId)),
  setOutputDevice: withEngine((e, deviceId: string) => e.setOutputDevice(deviceId)),
  setCameraDevice: withEngine((e, deviceId: string) => e.setCameraDevice(deviceId)),
  /** Voice & video settings (saved to your account, applied live). */
  updatePrefs: withEngine((e, patch: Partial<VoicePrefs>) => e.updatePrefs(patch)),
};
