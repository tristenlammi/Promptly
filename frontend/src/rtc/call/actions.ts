/**
 * What the UI does with DM calls. Everything goes through the tab's one
 * call engine, loaded (with LiveKit and the audio pipeline) the first time
 * it's needed.
 *
 *   calls.start(roomId, "audio" | "video")    call a conversation
 *   calls.answer(callId, { video })           answer, join, or move it here
 *   calls.decline(callId) / calls.hangUp()
 *   calls.toggleMute() / calls.setCamera(on) / calls.startScreen() ...
 * State to draw comes from ``useCallStore`` (``store.ts``).
 */
import { dmCallsApi, type CallMedia } from "@/api/dmCalls";
import { toast } from "@/store/toastStore";

import type { CallEngine } from "./engine";
import { useCallStore } from "./store";

let enginePromise: Promise<CallEngine> | null = null;

export function callEngine(): Promise<CallEngine> {
  if (!enginePromise) {
    enginePromise = import("./engine")
      .then((m) => new m.CallEngine())
      .catch((err) => {
        enginePromise = null;
        throw err;
      });
  }
  return enginePromise;
}

/** The engine if it's loaded already (events for a call this tab isn't in
 *  don't need it). */
export function loadedEngine(): Promise<CallEngine> | null {
  return enginePromise;
}

const withEngine =
  <A extends unknown[], R>(fn: (e: CallEngine, ...a: A) => R) =>
  async (...a: A): Promise<Awaited<R>> =>
    await fn(await callEngine(), ...a);

function forget(callId: string): void {
  useCallStore.setState((s) => {
    if (!s.incoming[callId]) return {};
    const incoming = { ...s.incoming };
    delete incoming[callId];
    return { incoming };
  });
}

export const calls = {
  /** Call a conversation (1:1 or group). Joins its live call if one is on. */
  start: withEngine((e, roomId: string, media: CallMedia) => e.start(roomId, media)),
  /** Call people from outside Rooms (opens the conversation with them). */
  startWith: withEngine((e, userIds: string[], media: CallMedia) => e.startWith(userIds, media)),
  /** Answer a call ringing you (or join a live group call, or move your
   *  call to this tab). */
  answer: withEngine((e, callId: string, opts: { video: boolean; roomId?: string | null; media?: CallMedia } = { video: false }) => {
    forget(callId);
    return e.answer(callId, opts);
  }),
  async decline(callId: string): Promise<void> {
    forget(callId);
    try {
      await dmCallsApi.decline(callId);
    } catch {
      /* it stopped ringing already */
    }
  },
  /** Stop showing a call that's ringing you here (it rings on elsewhere). */
  dismiss(callId: string): void {
    forget(callId);
  },
  /** A call the Android app on this phone holds the sound of: show its
   *  video here, and drive the app's mute and speaker (Calls WP-D3). */
  watch: withEngine((e, callId: string) => e.watch(callId)),
  togglePhoneSpeaker: withEngine((e) => e.setPhoneSpeaker(!useCallStore.getState().phoneSpeaker)),
  hangUp: withEngine((e) => e.hangUp()),
  endForEveryone: withEngine((e) => e.endForEveryone()),
  setMuted: withEngine((e, muted: boolean) => e.setMuted(muted)),
  toggleMute: withEngine((e) => e.setMuted(!useCallStore.getState().muted)),
  setCamera: withEngine((e, on: boolean) => e.setCamera(on)),
  toggleCamera: withEngine((e) => e.setCamera(!useCallStore.getState().camera)),
  flipCamera: withEngine((e) => e.flipCamera()),
  startScreen: withEngine((e) => e.startScreen()),
  stopScreen: withEngine((e) => e.stopScreen()),
  setOutputDevice: withEngine((e, id: string) => e.setOutputDevice(id)),
  setInputDevice: withEngine((e, id: string) => e.setInputDevice(id)),
  setCameraDevice: withEngine((e, id: string) => e.setCameraDevice(id)),
  resumeAudio: withEngine((e) => e.resumeAudio()),
  retryMic: withEngine((e) => e.retryMic()),
  dismissProblem: withEngine((e) => e.dismissProblem()),
  dismissEnded: withEngine((e) => e.dismissEnded()),
  ringAgain: async (userIds?: string[]) => {
    try {
      const rang = await (await callEngine()).ringAgain(userIds);
      toast.info(rang.length ? (rang.length === 1 ? "Ringing 1 person" : `Ringing ${rang.length} people`) : "Everyone's been rung just now");
    } catch {
      toast.error("Couldn't ring them. Try again in a moment.");
    }
  },
  minimize: () => useCallStore.setState({ view: "mini" }),
  expand: () => useCallStore.setState({ view: "full" }),
  pin: (userId: string | null) => useCallStore.setState({ pinned: userId }),
};
