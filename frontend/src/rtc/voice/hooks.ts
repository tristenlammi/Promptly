/**
 * React hooks for voice (the API WP-V4's UI builds on).
 *
 *   useVoice((s) => s.status)          any part of the voice store
 *   useVoiceLevel("me" | userId)       a 0..1 meter, ~10 Hz
 *   useVoiceSettings()                 Voice & video settings + per-person volumes
 *   useVoiceLive()                     keep channel lists live (mount once, app level)
 *   useMicTest()                       "Let's check" with loopback
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useAuthStore } from "@/store/authStore";
import { subscribeRoomsStream } from "@/rooms/stream";

import type { EngineChoice } from "../audio/engines";
import type { MicReading } from "../audio/pipeline";
import { applyVoiceListEvent } from "./liveEvents";
import { startMicTest, type MicTest } from "./micTest";
import { readVoiceSettings, type VoiceSettingsAll } from "./prefs";
import { useVoiceLevels, useVoiceStore, type VoiceStoreState } from "./store";

/** Read voice state; the selector's result is compared shallowly, so
 *  returning a small object of fields is fine. */
export function useVoice<T>(selector: (s: VoiceStoreState) => T): T {
  return useVoiceStore(useShallow(selector));
}

/** A live 0..1 level: "me" for your mic (after noise suppression), or a
 *  user id for someone you hear. */
export function useVoiceLevel(who: string): number {
  return useVoiceLevels((s) => s.levels[who] ?? 0);
}

export function useVoiceSettings(): VoiceSettingsAll {
  const settings = useAuthStore((s) => s.user?.settings);
  const [out, setOut] = useState(() => readVoiceSettings(settings));
  useEffect(() => setOut(readVoiceSettings(settings)), [settings]);
  return out;
}

/** Keeps who's-in-which-channel and the speaking rings live everywhere
 *  (one shared Rooms stream). Mount once where channel lists show. */
export function useVoiceLive(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    return subscribeRoomsStream({ onEvent: applyVoiceListEvent });
  }, [enabled]);
}

export interface MicTestState {
  running: boolean;
  starting: boolean;
  error: string | null;
  /** "mic-denied" | "mic-missing" | "mic-failed" when it couldn't start. */
  errorKind: "mic-denied" | "mic-missing" | "mic-failed" | null;
  reading: MicReading | null;
  choice: EngineChoice | null;
  loopback: boolean;
}

export function useMicTest() {
  const test = useRef<MicTest | null>(null);
  const [state, setState] = useState<MicTestState>({
    running: false,
    starting: false,
    error: null,
    errorKind: null,
    reading: null,
    choice: null,
    loopback: false,
  });
  const settings = useVoiceSettings();
  const prefsRef = useRef(settings.prefs);
  prefsRef.current = settings.prefs;

  const stop = useCallback(() => {
    test.current?.stop();
    test.current = null;
    setState((s) => ({ ...s, running: false, starting: false, reading: null }));
  }, []);

  const start = useCallback(
    async (opts: { loopback?: boolean; micId?: string; speakerId?: string } = {}) => {
      stop();
      setState((s) => ({ ...s, starting: true, error: null, errorKind: null }));
      try {
        const t = await startMicTest(prefsRef.current, { loopback: !!opts.loopback, micId: opts.micId, speakerId: opts.speakerId });
        test.current = t;
        t.pipeline?.on("level", (reading) => setState((s) => ({ ...s, reading })));
        setState((s) => ({ ...s, running: true, starting: false, choice: t.choice, loopback: !!opts.loopback }));
      } catch (err) {
        const name = (err as { name?: string })?.name;
        const errorKind = name === "NotAllowedError" || name === "SecurityError" ? "mic-denied" : name === "NotFoundError" ? "mic-missing" : "mic-failed";
        setState((s) => ({ ...s, starting: false, running: false, error: String((err as Error)?.message ?? err), errorKind }));
      }
    },
    [stop],
  );

  const setLoopback = useCallback((on: boolean) => {
    test.current?.setLoopback(on);
    setState((s) => ({ ...s, loopback: on }));
  }, []);

  useEffect(() => stop, [stop]);
  return { ...state, start, stop, setLoopback };
}
