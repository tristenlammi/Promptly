/**
 * What the main thread and the microphone worklet (``voiceWorklet.ts``)
 * say to each other. Kept apart from the worklet so the main thread can
 * import it without running the audio-thread code.
 */
import type { GateConfig } from "./gate";

export const VOICE_WORKLET_NAME = "promptly-voice-mic";

export type WorkletEngine = "gtcrn" | "rnnoise" | "none";

export interface VoiceWorkletOptions {
  engine: WorkletEngine;
  wasm: ArrayBuffer | null;
  channels: 1 | 2;
  gate: GateConfig;
  agc: boolean;
  inputGain: number;
  muted: boolean;
}

export type ToWorklet =
  | { type: "config"; gate?: Partial<GateConfig>; agc?: boolean; inputGain?: number; muted?: boolean }
  | { type: "ptt"; down: boolean }
  | { type: "engine"; engine: WorkletEngine; wasm: ArrayBuffer | null }
  | { type: "destroy" };

export type FromWorklet =
  | { type: "ready"; engine: WorkletEngine }
  | { type: "failed"; engine: WorkletEngine; message: string }
  | { type: "level"; db: number; open: boolean; talking: boolean; thresholdDb: number; floorDb: number; prob: number | null }
  | { type: "gate"; open: boolean }
  | { type: "talking"; on: boolean }
  | { type: "quiet"; on: boolean }
  | { type: "load"; engine: WorkletEngine; ratio: number };
