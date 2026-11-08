/**
 * The microphone's AudioWorklet (audio thread): noise suppressor (GTCRN,
 * RNNoise or none) → input volume → automatic gain → the gate (voice
 * activity or push to talk) → out to the published track. It also meters
 * the level, says when you're talking (even while muted, for "You're
 * muted"), and times itself so the main thread can fall back to a lighter
 * suppressor when this device can't keep up.
 *
 * Loaded with ``audioWorklet.addModule`` from a Vite worker bundle
 * (``?worker&url``). The suppressor's .wasm bytes come in the node's
 * options: there's no fetch on the audio thread.
 */
import { AutoGain, softLimit } from "./gain";
import { FRAME_MS, VoiceGate } from "./gate";
import { FrameAdapter } from "./frames";
import { createGtcrn, createRnnoise, type Suppressor } from "./suppressors";
import { VOICE_WORKLET_NAME, type FromWorklet, type ToWorklet, type VoiceWorkletOptions, type WorkletEngine } from "./workletTypes";

// The AudioWorkletGlobalScope (not in TypeScript's DOM lib).
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

const now: () => number =
  typeof globalThis.performance?.now === "function" ? () => globalThis.performance.now() : () => Date.now();

const OPEN_RAMP_S = 0.003;
const CLOSE_RAMP_S = 0.015;
const METER_EVERY_FRAMES = 5; // 50 ms
const LOAD_EVERY_S = 1;

class VoiceMicProcessor extends AudioWorkletProcessor {
  private engine: WorkletEngine = "none";
  private suppressor: Suppressor | null = null;
  private adapters: FrameAdapter[] = [];
  private prob: number | null = null;
  private loading = 0;
  private readonly channels: number;
  private readonly gate: VoiceGate;
  private readonly agc = new AutoGain();
  private agcOn: boolean;
  private inputGain: number;
  private muted: boolean;
  private destroyed = false;
  // Analysis frame (10 ms) over the suppressed signal.
  private readonly frameLen = Math.round((sampleRate * FRAME_MS) / 1000);
  private sumSq = 0;
  private counted = 0;
  private frames = 0;
  // Smoothed gains.
  private gateGain = 0;
  private gateTarget = 0;
  private agcGain = 1;
  private agcTarget = 1;
  private readonly openStep = 1 / (OPEN_RAMP_S * sampleRate);
  private readonly closeStep = 1 / (CLOSE_RAMP_S * sampleRate);
  private lastOpen = false;
  private lastTalking = false;
  private lastQuiet = false;
  // Self-timing.
  private busyMs = 0;
  private audioSamples = 0;
  private readonly scratch: Float32Array[];

  constructor(options: { processorOptions: VoiceWorkletOptions }) {
    super(options);
    const o = options.processorOptions;
    this.channels = o.channels;
    this.gate = new VoiceGate(o.gate);
    this.agcOn = o.agc;
    this.inputGain = o.inputGain;
    this.muted = o.muted;
    this.scratch = Array.from({ length: this.channels }, () => new Float32Array(128));
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.onMessage(e.data);
    void this.setEngine(o.engine, o.wasm);
  }

  private post(msg: FromWorklet): void {
    this.port.postMessage(msg);
  }

  private onMessage(msg: ToWorklet): void {
    switch (msg.type) {
      case "config":
        if (msg.gate) this.gate.configure(msg.gate);
        if (msg.agc !== undefined) {
          this.agcOn = msg.agc;
          if (!msg.agc) this.agc.reset();
        }
        if (msg.inputGain !== undefined) this.inputGain = msg.inputGain;
        if (msg.muted !== undefined) this.muted = msg.muted;
        return;
      case "ptt":
        this.gate.setPtt(msg.down);
        return;
      case "engine":
        void this.setEngine(msg.engine, msg.wasm);
        return;
      case "destroy":
        this.destroyed = true;
        this.dropSuppressor();
        return;
    }
  }

  private dropSuppressor(): void {
    this.suppressor?.destroy();
    this.suppressor = null;
    this.adapters = [];
    this.prob = null;
  }

  private async setEngine(engine: WorkletEngine, wasm: ArrayBuffer | null): Promise<void> {
    const ticket = ++this.loading;
    if (engine === "none" || !wasm) {
      this.dropSuppressor();
      this.engine = "none";
      this.post({ type: "ready", engine: "none" });
      return;
    }
    try {
      const s = engine === "gtcrn" ? await createGtcrn(wasm) : await createRnnoise(wasm);
      if (ticket !== this.loading || this.destroyed) {
        s.destroy();
        return;
      }
      this.dropSuppressor();
      this.suppressor = s;
      this.adapters = Array.from({ length: this.channels }, () =>
        new FrameAdapter(s.frameSize, (frame) => {
          const p = s.process(frame);
          if (p !== null) this.prob = p;
        }),
      );
      this.engine = engine;
      this.busyMs = 0;
      this.audioSamples = 0;
      this.post({ type: "ready", engine });
    } catch (err) {
      if (ticket !== this.loading) return;
      this.post({ type: "failed", engine, message: String((err as Error)?.message ?? err) });
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.destroyed) return false;
    const t0 = now();
    const input = inputs[0];
    const output = outputs[0];
    const n = output?.[0]?.length ?? 128;
    if (!input || input.length === 0 || !input[0]) {
      for (const ch of output ?? []) ch.fill(0);
      return true;
    }

    // 1. Suppress (per channel), then input volume.
    for (let c = 0; c < this.channels; c++) {
      const src = input[Math.min(c, input.length - 1)];
      const dst = this.scratch[c];
      const adapter = this.adapters[c];
      if (adapter) adapter.process(src, dst);
      else dst.set(src);
      if (this.inputGain !== 1) for (let i = 0; i < n; i++) dst[i] *= this.inputGain;
    }

    // 2. Analyse channel 0 in 10 ms frames: gate, meter, gain.
    const a = this.scratch[0];
    let i = 0;
    while (i < n) {
      const take = Math.min(n - i, this.frameLen - this.counted);
      for (let k = i; k < i + take; k++) this.sumSq += a[k] * a[k];
      this.counted += take;
      i += take;
      if (this.counted === this.frameLen) this.endFrame();
    }

    // 3. Gain, gate, limiter, out.
    const outCh = output.length;
    for (let s = 0; s < n; s++) {
      if (this.gateGain < this.gateTarget) this.gateGain = Math.min(this.gateTarget, this.gateGain + this.openStep);
      else if (this.gateGain > this.gateTarget) this.gateGain = Math.max(this.gateTarget, this.gateGain - this.closeStep);
      this.agcGain += (this.agcTarget - this.agcGain) * 0.001;
      const g = this.gateGain * this.agcGain;
      for (let c = 0; c < outCh; c++) {
        const src = this.scratch[Math.min(c, this.channels - 1)];
        output[c][s] = g === 0 ? 0 : softLimit(src[s] * g);
      }
    }

    // 4. Self-timing.
    this.busyMs += now() - t0;
    this.audioSamples += n;
    if (this.audioSamples >= sampleRate * LOAD_EVERY_S) {
      const audioMs = (this.audioSamples / sampleRate) * 1000;
      this.post({ type: "load", engine: this.engine, ratio: this.busyMs / audioMs });
      this.busyMs = 0;
      this.audioSamples = 0;
    }
    return true;
  }

  private endFrame(): void {
    const db = this.counted ? 10 * Math.log10(this.sumSq / this.counted + 1e-12) : -120;
    this.sumSq = 0;
    this.counted = 0;
    const prob = this.engine === "rnnoise" ? this.prob : null;
    const f = this.gate.step(db, prob);
    const open = f.open && !this.muted;
    this.gateTarget = open ? 1 : 0;
    if (this.agcOn) this.agcTarget = this.agc.update(f.talking && !this.muted ? db : null, FRAME_MS);
    else this.agcTarget = 1;
    if (open !== this.lastOpen) {
      this.lastOpen = open;
      this.post({ type: "gate", open });
    }
    if (f.talking !== this.lastTalking) {
      this.lastTalking = f.talking;
      this.post({ type: "talking", on: f.talking });
    }
    if (f.quiet !== this.lastQuiet) {
      this.lastQuiet = f.quiet;
      this.post({ type: "quiet", on: f.quiet });
    }
    if (++this.frames % METER_EVERY_FRAMES === 0) {
      // The meter shows the level the gate judges (before the gain), so a
      // manual threshold line drawn over it means what it says.
      this.post({ type: "level", db, open, talking: f.talking, thresholdDb: f.thresholdDb, floorDb: f.floorDb, prob });
    }
  }
}

registerProcessor(VOICE_WORKLET_NAME, VoiceMicProcessor);
