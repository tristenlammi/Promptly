/**
 * The microphone pipeline on the main thread: a mic track in, a processed
 * track out (noise suppressor, gain and gate in our AudioWorklet), plus its
 * live readings. Used by voice channels (as a LiveKit track processor), the
 * mic test's loopback, and later Talking to Promptly.
 *
 *   const p = await MicPipeline.create(ctx, { engine: "gtcrn", ... });
 *   const out = p.connect(micTrack);       // publish ``out``
 *   p.on("level", (m) => ...); p.ptt(true); p.configure({ muted: true });
 */
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";

import gtcrnWasmUrl from "@sapphi-red/web-noise-suppressor/gtcrn.wasm?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

import { OverloadWatch, type AudioCaps, type NoiseEngine } from "./engines";
import { DEFAULT_GATE, type GateConfig } from "./gate";
import voiceWorkletUrl from "./voiceWorklet.ts?worker&url";
import { VOICE_WORKLET_NAME, type FromWorklet, type ToWorklet, type VoiceWorkletOptions, type WorkletEngine } from "./workletTypes";

// ---------------------------------------------------------------- capabilities

// A tiny module using a SIMD instruction (from wasm-feature-detect, MIT).
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

export function wasmSimd(): boolean {
  try {
    return typeof WebAssembly === "object" && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

export function audioCaps(ctx: BaseAudioContext | null): AudioCaps {
  const AC = typeof window !== "undefined" ? (window.AudioContext ?? null) : null;
  return {
    audioWorklet: !!AC && typeof AudioWorkletNode !== "undefined" && (!ctx || "audioWorklet" in ctx),
    wasm: typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function",
    rate48k: ctx ? ctx.sampleRate === 48000 : true,
    cores: typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : null,
  };
}

/** The voice audio context: 48 kHz (both suppressors need it), low latency. */
export function createVoiceContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  } catch {
    // Some browsers won't resample the mic to a fixed rate: Enhanced then
    // falls back to Standard (rate48k false).
    return new AudioContext({ latencyHint: "interactive" });
  }
}

// ---------------------------------------------------------------- loading

const bytesCache = new Map<string, Promise<ArrayBuffer>>();

function wasmUrl(engine: "gtcrn" | "rnnoise"): string {
  if (engine === "gtcrn") return gtcrnWasmUrl;
  return wasmSimd() ? rnnoiseSimdWasmUrl : rnnoiseWasmUrl;
}

/** A suppressor's .wasm, fetched once per page and checked it compiles here. */
export function engineBytes(engine: "gtcrn" | "rnnoise"): Promise<ArrayBuffer> {
  const url = wasmUrl(engine);
  let p = bytesCache.get(url);
  if (!p) {
    p = fetch(url, { credentials: "same-origin" })
      .then((r) => {
        if (!r.ok) throw new Error(`couldn't fetch ${engine} (${r.status})`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (!WebAssembly.validate(buf)) throw new Error(`${engine} doesn't run in this browser`);
        return buf;
      });
    p.catch(() => bytesCache.delete(url));
    bytesCache.set(url, p);
  }
  // Each node gets its own copy (the bytes are transferred to the worklet).
  return p.then((b) => b.slice(0));
}

const workletLoaded = new WeakMap<BaseAudioContext, Promise<void>>();

function ensureWorklet(ctx: BaseAudioContext): Promise<void> {
  let p = workletLoaded.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(voiceWorkletUrl);
    p.catch(() => workletLoaded.delete(ctx));
    workletLoaded.set(ctx, p);
  }
  return p;
}

// ---------------------------------------------------------------- the pipeline

export interface MicPipelineOptions {
  engine: NoiseEngine;
  stereo?: boolean;
  gate?: GateConfig;
  /** Our own gain after the suppressor (only with a worklet suppressor;
   *  otherwise the browser's ``autoGainControl`` does it). */
  agc?: boolean;
  /** Input volume, 0..2 (0–200%). */
  inputGain?: number;
  muted?: boolean;
}

export interface MicReading {
  /** dBFS of what the gate judges. */
  db: number;
  /** 0..1 for a meter. */
  level: number;
  open: boolean;
  talking: boolean;
  thresholdDb: number;
  floorDb: number;
  prob: number | null;
}

type Events = {
  ready: WorkletEngine;
  failed: { engine: WorkletEngine; message: string };
  overload: WorkletEngine;
  level: MicReading;
  gate: boolean;
  talking: boolean;
  quiet: boolean;
  load: { engine: WorkletEngine; ratio: number };
};

export class MicPipeline {
  readonly ctx: AudioContext;
  readonly node: AudioWorkletNode;
  private destination: MediaStreamAudioDestinationNode;
  private source: MediaStreamAudioSourceNode | null = null;
  private tap: MediaStreamTrack | null = null;
  private monitorOn = false;
  private engineNow: WorkletEngine;
  private readonly watch = new OverloadWatch();
  private readonly handlers = new Map<keyof Events, Set<(v: never) => void>>();
  private destroyed = false;
  /** The latest load report (share of a core spent per second of audio). */
  load: number | null = null;
  /** The latest meter reading. */
  reading: MicReading | null = null;

  /** Two channels (a "Music" channel), else one. */
  readonly stereo: boolean;

  private constructor(ctx: AudioContext, node: AudioWorkletNode, engine: WorkletEngine, stereo: boolean) {
    this.ctx = ctx;
    this.stereo = stereo;
    this.node = node;
    this.engineNow = engine;
    this.destination = ctx.createMediaStreamDestination();
    node.connect(this.destination);
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => this.onMessage(e.data);
  }

  /** Builds the worklet in ``ctx`` with a suppressor. Fails when the
   *  browser has no AudioWorklet (the caller then publishes the mic as is).
   *  A suppressor that won't load is reported as ``failed`` and the
   *  pipeline carries on without one. */
  static async create(ctx: AudioContext, opts: MicPipelineOptions): Promise<MicPipeline> {
    await ensureWorklet(ctx);
    const engine = workletEngine(opts.engine);
    let wasm: ArrayBuffer | null = null;
    let loadError: string | null = null;
    if (engine !== "none") {
      try {
        wasm = await engineBytes(engine);
      } catch (err) {
        loadError = String((err as Error)?.message ?? err);
      }
    }
    const channels = opts.stereo ? 2 : 1;
    const options: VoiceWorkletOptions = {
      engine: wasm ? engine : "none",
      wasm,
      channels,
      gate: opts.gate ?? DEFAULT_GATE,
      agc: !!opts.agc,
      inputGain: opts.inputGain ?? 1,
      muted: !!opts.muted,
    };
    const node = new AudioWorkletNode(ctx, VOICE_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      channelCount: channels,
      channelCountMode: "explicit",
      processorOptions: options,
    });
    const p = new MicPipeline(ctx, node, options.engine, channels === 2);
    if (loadError && engine !== "none") {
      queueMicrotask(() => p.emit("failed", { engine, message: loadError! }));
    }
    return p;
  }

  get engine(): WorkletEngine {
    return this.engineNow;
  }

  on<K extends keyof Events>(type: K, cb: (v: Events[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(cb as (v: never) => void);
    return () => set.delete(cb as (v: never) => void);
  }

  private emit<K extends keyof Events>(type: K, v: Events[K]): void {
    const set = this.handlers.get(type) as Set<(v: Events[K]) => void> | undefined;
    set?.forEach((cb) => {
      try {
        cb(v);
      } catch {
        /* a listener's bug mustn't break the audio */
      }
    });
  }

  private send(msg: ToWorklet, transfer: Transferable[] = []): void {
    if (!this.destroyed) this.node.port.postMessage(msg, transfer);
  }

  private onMessage(msg: FromWorklet): void {
    switch (msg.type) {
      case "ready":
        this.engineNow = msg.engine;
        this.watch.reset();
        this.emit("ready", msg.engine);
        return;
      case "failed":
        this.emit("failed", { engine: msg.engine, message: msg.message });
        return;
      case "level": {
        const reading: MicReading = {
          db: msg.db,
          level: Math.max(0, Math.min(1, (msg.db + 60) / 60)),
          open: msg.open,
          talking: msg.talking,
          thresholdDb: msg.thresholdDb,
          floorDb: msg.floorDb,
          prob: msg.prob,
        };
        this.reading = reading;
        this.emit("level", reading);
        return;
      }
      case "gate":
        this.emit("gate", msg.open);
        return;
      case "talking":
        this.emit("talking", msg.on);
        return;
      case "quiet":
        this.emit("quiet", msg.on);
        return;
      case "load":
        this.load = msg.ratio;
        this.emit("load", { engine: msg.engine, ratio: msg.ratio });
        if (msg.engine !== "none" && this.watch.report(msg.ratio)) this.emit("overload", msg.engine);
        return;
    }
  }

  /** Feed a microphone track through; returns the processed track (the
   *  same one across calls while it lives). The worklet listens to a clone,
   *  so muting the original (LiveKit's mute) doesn't blind the "you're
   *  talking while muted" check; our own ``muted`` keeps the output silent. */
  connect(track: MediaStreamTrack): MediaStreamTrack {
    this.disconnectSource();
    if (this.destination.stream.getAudioTracks()[0]?.readyState !== "live") {
      this.node.disconnect(this.destination);
      this.destination = this.ctx.createMediaStreamDestination();
      this.node.connect(this.destination);
    }
    this.tap = track.clone();
    this.source = this.ctx.createMediaStreamSource(new MediaStream([this.tap]));
    this.source.connect(this.node);
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
    return this.destination.stream.getAudioTracks()[0];
  }

  /** The processed track (after ``connect``). */
  get track(): MediaStreamTrack | null {
    return this.destination.stream.getAudioTracks()[0] ?? null;
  }

  disconnectSource(): void {
    try {
      this.source?.disconnect();
    } catch {
      /* already gone */
    }
    this.source = null;
    this.tap?.stop();
    this.tap = null;
  }

  /** Play the processed sound on this device's speakers (the mic test). */
  monitor(on: boolean): void {
    if (on === this.monitorOn) return;
    this.monitorOn = on;
    if (on) this.node.connect(this.ctx.destination);
    else {
      try {
        this.node.disconnect(this.ctx.destination);
      } catch {
        /* wasn't connected */
      }
    }
  }

  configure(patch: { gate?: Partial<GateConfig>; agc?: boolean; inputGain?: number; muted?: boolean }): void {
    this.send({ type: "config", ...patch });
  }

  ptt(down: boolean): void {
    this.send({ type: "ptt", down });
  }

  /** Swap the suppressor in place (the published track carries on). */
  async setEngine(engine: NoiseEngine): Promise<void> {
    const want = workletEngine(engine);
    if (want === "none") {
      this.send({ type: "engine", engine: "none", wasm: null });
      return;
    }
    let wasm: ArrayBuffer;
    try {
      wasm = await engineBytes(want);
    } catch (err) {
      this.emit("failed", { engine: want, message: String((err as Error)?.message ?? err) });
      return;
    }
    this.send({ type: "engine", engine: want, wasm }, [wasm]);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.send({ type: "destroy" });
    this.destroyed = true;
    this.disconnectSource();
    try {
      this.node.disconnect();
    } catch {
      /* fine */
    }
    this.node.port.onmessage = null;
    this.destination.stream.getTracks().forEach((t) => t.stop());
  }
}

function workletEngine(engine: NoiseEngine): WorkletEngine {
  return engine === "gtcrn" || engine === "rnnoise" ? engine : "none";
}

/** The pipeline as a LiveKit track processor. LiveKit hands it the captured
 *  mic track on publish and on every restart (device switch, re-acquire);
 *  the pipeline's lifetime stays with its owner. */
export function asLiveKitProcessor(pipeline: MicPipeline): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  const proc: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> = {
    name: "promptly-voice",
    processedTrack: undefined,
    async init(opts) {
      proc.processedTrack = pipeline.connect(opts.track);
    },
    async restart(opts) {
      proc.processedTrack = pipeline.connect(opts.track);
    },
    async destroy() {
      pipeline.disconnectSource();
    },
  };
  return proc;
}
