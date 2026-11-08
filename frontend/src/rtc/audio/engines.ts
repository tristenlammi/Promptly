/**
 * Which noise suppressor runs.
 *
 * The person picks Off / Standard / Enhanced (Voice & video settings).
 * Enhanced runs our own suppressor on the device; it tries the engines in
 * ``ENHANCED_CHAIN`` in order and falls back on weak or unsuited devices:
 *
 *   GTCRN  — the Enhanced default. Removes keyboards and barks too (WP-V0:
 *            53 dB of background left for keyboard vs RNNoise's 16), ~3% of
 *            a desktop core.
 *   RNNoise — the light fallback (~1%): great on steady noise, and its
 *            speech probability drives automatic sensitivity.
 *   browser — Standard: the browser's own noise suppression.
 *
 * Fallback rules (Calls plan, Noise suppression, with RNNoise as the light
 * step in between): no AudioWorklet or WebAssembly, or audio that can't run
 * at 48 kHz → Standard; 2 cores or fewer → skip GTCRN; an engine whose
 * build doesn't load here, or that used more than half of its time budget
 * for 5 s on this device (remembered) → the next one.
 *
 * Switching the default is one constant: ``ENHANCED_CHAIN``.
 */

export type NoisePref = "off" | "standard" | "enhanced";
/** What actually runs: our worklet with a suppressor, the browser's, or none. */
export type NoiseEngine = "gtcrn" | "rnnoise" | "browser" | "none";

export const DEFAULT_NOISE: NoisePref = "enhanced";
/** Enhanced, best first. Orchestrator decision 2026-11-09 (owner informed). */
export const ENHANCED_CHAIN: readonly ("gtcrn" | "rnnoise")[] = ["gtcrn", "rnnoise"];

export type FallbackReason =
  | "unsupported" // no AudioWorklet / WebAssembly / 48 kHz audio
  | "weak-cpu" // 2 cores or fewer
  | "overloaded" // it couldn't keep up on this device
  | "load-failed" // its build didn't load here
  | null;

export interface AudioCaps {
  audioWorklet: boolean;
  wasm: boolean;
  /** The audio context runs at 48 kHz (both suppressors need it). */
  rate48k: boolean;
  /** ``navigator.hardwareConcurrency``, null when unknown. */
  cores: number | null;
}

export interface EngineChoice {
  engine: NoiseEngine;
  /** Why Enhanced isn't running its first choice (null when it is, or
   *  when the person didn't pick Enhanced). */
  reason: FallbackReason;
}

export const WEAK_CORES = 2;

/**
 * The engine for a preference on this device. ``unusable`` maps an engine
 * to why it can't run here (failed to load, or was overloaded).
 */
export function chooseEngine(
  pref: NoisePref,
  caps: AudioCaps,
  unusable: Partial<Record<"gtcrn" | "rnnoise", "overloaded" | "load-failed">> = {},
): EngineChoice {
  if (pref === "off") return { engine: "none", reason: null };
  if (pref === "standard") return { engine: "browser", reason: null };
  if (!caps.audioWorklet || !caps.wasm || !caps.rate48k) return { engine: "browser", reason: "unsupported" };
  let reason: FallbackReason = null;
  for (const engine of ENHANCED_CHAIN) {
    let why: FallbackReason = unusable[engine] ?? null;
    if (!why && engine === "gtcrn" && caps.cores !== null && caps.cores <= WEAK_CORES) why = "weak-cpu";
    if (!why) return { engine, reason };
    reason ??= why;
  }
  return { engine: "browser", reason };
}

/** Whether this engine runs our worklet (and so wants the browser's own
 *  suppression and gain off). */
export function usesWorkletSuppressor(engine: NoiseEngine): engine is "gtcrn" | "rnnoise" {
  return engine === "gtcrn" || engine === "rnnoise";
}

/** The getUserMedia audio processing for an engine (WP-V0: with our
 *  suppressor, the browser's suppression and gain off, echo cancellation
 *  on; we apply our own gain after the suppressor). */
export function captureProcessing(
  engine: NoiseEngine,
  prefs: { echo: boolean; agc: boolean },
): { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } {
  if (usesWorkletSuppressor(engine)) return { echoCancellation: prefs.echo, noiseSuppression: false, autoGainControl: false };
  return { echoCancellation: prefs.echo, noiseSuppression: engine === "browser", autoGainControl: prefs.agc };
}

// ---------------------------------------------------------------- overload memory

const OVERLOAD_KEY = "promptly.voice.overloaded";
const OVERLOAD_TTL_MS = 30 * 24 * 3600 * 1000;

/** Engines that couldn't keep up on this device lately (localStorage:
 *  it's this device's CPU, not the person's). */
export function rememberedOverloads(now = Date.now()): Partial<Record<"gtcrn" | "rnnoise", "overloaded">> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(OVERLOAD_KEY) ?? "{}") as Record<string, number>;
    const out: Partial<Record<"gtcrn" | "rnnoise", "overloaded">> = {};
    for (const e of ENHANCED_CHAIN) if (raw[e] && now - raw[e] < OVERLOAD_TTL_MS) out[e] = "overloaded";
    return out;
  } catch {
    return {};
  }
}

export function rememberOverload(engine: "gtcrn" | "rnnoise", now = Date.now()): void {
  try {
    const raw = JSON.parse(window.localStorage.getItem(OVERLOAD_KEY) ?? "{}") as Record<string, number>;
    raw[engine] = now;
    window.localStorage.setItem(OVERLOAD_KEY, JSON.stringify(raw));
  } catch {
    /* private window: we'll notice again next time */
  }
}

/** Picking Enhanced again in settings gives the device another chance. */
export function forgetOverloads(): void {
  try {
    window.localStorage.removeItem(OVERLOAD_KEY);
  } catch {
    /* nothing remembered */
  }
}

/** Plain words for the settings line and the one-time notice. */
export function fallbackWords(reason: FallbackReason): string | null {
  switch (reason) {
    case "unsupported":
      return "This browser can't run Enhanced noise suppression, so it uses Standard.";
    case "weak-cpu":
      return "Enhanced uses a lighter noise filter on this device to keep your voice smooth.";
    case "overloaded":
      return "Enhanced isn't smooth on this device, so it switched to a lighter noise filter.";
    case "load-failed":
      return "Enhanced noise suppression didn't load here, so a lighter filter is used.";
    default:
      return null;
  }
}

// ---------------------------------------------------------------- overload watch

/** Share of the time budget that counts as too much (the plan: half). */
export const OVERLOAD_RATIO = 0.5;
/** For this many one-second reports in a row (the plan: 5 s). */
export const OVERLOAD_SECONDS = 5;

/** Watches the worklet's one-second load reports (time spent / audio time)
 *  and says when the suppressor can't keep up on this device. */
export class OverloadWatch {
  private run = 0;
  private fired = false;

  /** Returns true once, when the load has been over the limit long enough. */
  report(ratio: number): boolean {
    if (this.fired) return false;
    this.run = ratio > OVERLOAD_RATIO ? this.run + 1 : 0;
    if (this.run >= OVERLOAD_SECONDS) {
      this.fired = true;
      return true;
    }
    return false;
  }

  reset(): void {
    this.run = 0;
    this.fired = false;
  }
}
