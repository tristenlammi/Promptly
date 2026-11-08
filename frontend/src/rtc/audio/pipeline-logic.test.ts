// The voice pipeline's logic, without audio: engine choice and fallback,
// the gate (voice activity, push to talk, the too-quiet hint), frame
// adapting, the overload watch and the gain.
import { describe, expect, it } from "vitest";

import {
  captureProcessing,
  chooseEngine,
  DEFAULT_NOISE,
  ENHANCED_CHAIN,
  OverloadWatch,
  type AudioCaps,
} from "./engines";
import { adapterDelay, FrameAdapter } from "./frames";
import { AGC_TARGET_DB, AutoGain, softLimit } from "./gain";
import { FRAME_MS, VAD_HOLD_MS, VoiceGate } from "./gate";

const desktop: AudioCaps = { audioWorklet: true, wasm: true, rate48k: true, cores: 16 };

describe("engine choice", () => {
  it("defaults to Enhanced, which is GTCRN then RNNoise", () => {
    expect(DEFAULT_NOISE).toBe("enhanced");
    expect(ENHANCED_CHAIN).toEqual(["gtcrn", "rnnoise"]);
    expect(chooseEngine("enhanced", desktop)).toEqual({ engine: "gtcrn", reason: null });
  });

  it("Off and Standard don't run our suppressor", () => {
    expect(chooseEngine("off", desktop).engine).toBe("none");
    expect(chooseEngine("standard", desktop).engine).toBe("browser");
    expect(chooseEngine("standard", { ...desktop, audioWorklet: false }).reason).toBeNull();
  });

  it("falls back to Standard without AudioWorklet, WebAssembly or 48 kHz", () => {
    for (const caps of [{ ...desktop, audioWorklet: false }, { ...desktop, wasm: false }, { ...desktop, rate48k: false }]) {
      expect(chooseEngine("enhanced", caps)).toEqual({ engine: "browser", reason: "unsupported" });
    }
  });

  it("uses the light RNNoise on 2 cores or fewer", () => {
    expect(chooseEngine("enhanced", { ...desktop, cores: 2 })).toEqual({ engine: "rnnoise", reason: "weak-cpu" });
    expect(chooseEngine("enhanced", { ...desktop, cores: 4 }).engine).toBe("gtcrn");
    expect(chooseEngine("enhanced", { ...desktop, cores: null }).engine).toBe("gtcrn");
  });

  it("steps down when an engine was overloaded or failed to load", () => {
    expect(chooseEngine("enhanced", desktop, { gtcrn: "overloaded" })).toEqual({ engine: "rnnoise", reason: "overloaded" });
    expect(chooseEngine("enhanced", desktop, { gtcrn: "load-failed" })).toEqual({ engine: "rnnoise", reason: "load-failed" });
    expect(chooseEngine("enhanced", desktop, { gtcrn: "overloaded", rnnoise: "overloaded" })).toEqual({ engine: "browser", reason: "overloaded" });
    expect(chooseEngine("enhanced", { ...desktop, cores: 2 }, { rnnoise: "load-failed" })).toEqual({ engine: "browser", reason: "weak-cpu" });
  });

  it("asks the browser for echo cancellation only, under our suppressor", () => {
    expect(captureProcessing("gtcrn", { echo: true, agc: true })).toEqual({ echoCancellation: true, noiseSuppression: false, autoGainControl: false });
    expect(captureProcessing("browser", { echo: true, agc: true })).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    expect(captureProcessing("none", { echo: false, agc: false })).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  });
});

describe("overload watch", () => {
  it("fires once after 5 s over half the budget in a row", () => {
    const w = new OverloadWatch();
    for (let i = 0; i < 4; i++) expect(w.report(0.7)).toBe(false);
    expect(w.report(0.2)).toBe(false); // the run is broken
    for (let i = 0; i < 4; i++) expect(w.report(0.6)).toBe(false);
    expect(w.report(0.6)).toBe(true);
    expect(w.report(0.9)).toBe(false); // only once
    w.reset();
    for (let i = 0; i < 4; i++) w.report(0.9);
    expect(w.report(0.9)).toBe(true);
  });
});

/** Run a gate over levels (one per 10 ms frame); returns open per frame. */
function drive(g: VoiceGate, frames: { db: number; prob?: number | null }[]) {
  return frames.map((f) => g.step(f.db, f.prob ?? null));
}
const rep = (n: number, db: number, prob: number | null = null) => Array.from({ length: n }, () => ({ db, prob }));
/** Speech-like: 200 ms syllables at ``db`` with 100 ms gaps at ``gapDb``. */
const syllables = (n: number, db: number, gapDb: number) =>
  Array.from({ length: n }, (_, i) => ({ db: i % 30 < 20 ? db : gapDb, prob: null }));

describe("voice activity gate", () => {
  it("manual: opens at the threshold, holds through short pauses, then closes", () => {
    const g = new VoiceGate({ mode: "vad", auto: false, thresholdDb: -40, releaseMs: 0 });
    expect(drive(g, rep(10, -50)).some((f) => f.open)).toBe(false);
    const talk = drive(g, rep(5, -30));
    expect(talk.every((f) => f.open)).toBe(true);
    // A short pause (under the hold) stays open.
    const pause = drive(g, rep(VAD_HOLD_MS / FRAME_MS - 2, -60));
    expect(pause.every((f) => f.open)).toBe(true);
    // A long one closes.
    const after = drive(g, rep(10, -60));
    expect(after[after.length - 1].open).toBe(false);
  });

  it("manual: hysteresis keeps it open a little under the threshold", () => {
    const g = new VoiceGate({ mode: "vad", auto: false, thresholdDb: -40, releaseMs: 0 });
    drive(g, rep(3, -35));
    const near = drive(g, rep(60, -42));
    expect(near.every((f) => f.open)).toBe(true);
  });

  it("automatic: follows the background and opens on speech above it", () => {
    const g = new VoiceGate({ mode: "vad", auto: true, thresholdDb: -50, releaseMs: 0 });
    // A steady fan at -45 dB for 10 s: the floor learns it, the gate stays shut.
    const fan = drive(g, rep(1000, -45));
    expect(fan.slice(-500).some((f) => f.open)).toBe(false);
    expect(fan[fan.length - 1].floorDb).toBeGreaterThan(-47);
    // Speech well above the fan opens it, and stays open through a sentence.
    expect(drive(g, rep(5, -22)).every((f) => f.open)).toBe(true);
    const sentence = drive(g, syllables(400, -22, -45));
    expect(sentence.every((f) => f.open)).toBe(true);
    expect(sentence[sentence.length - 1].floorDb).toBeLessThan(-40);
  });

  it("automatic with a speech probability: keyboard-loud non-speech stays shut", () => {
    const g = new VoiceGate({ mode: "vad", auto: true, thresholdDb: -50, releaseMs: 0 });
    drive(g, rep(200, -70, 0.02));
    // Loud clacks the model says aren't speech.
    expect(drive(g, rep(30, -25, 0.05)).some((f) => f.open)).toBe(false);
    // Speech.
    expect(drive(g, rep(5, -30, 0.95)).every((f) => f.open)).toBe(true);
    // Sustains on weaker probability mid-word.
    expect(drive(g, rep(20, -32, 0.45)).every((f) => f.open)).toBe(true);
  });

  it("silence is never speech, whatever the model says", () => {
    const g = new VoiceGate({ mode: "vad", auto: true, thresholdDb: -50, releaseMs: 0 });
    expect(drive(g, rep(10, -85, 0.99)).some((f) => f.open || f.talking)).toBe(false);
  });
});

describe("push to talk", () => {
  it("sends only while the key is held, plus the release delay", () => {
    const g = new VoiceGate({ mode: "ptt", auto: true, thresholdDb: -50, releaseMs: 200 });
    expect(drive(g, rep(10, -20)).some((f) => f.open)).toBe(false); // talking, no key
    g.setPtt(true);
    expect(drive(g, rep(10, -90)).every((f) => f.open)).toBe(true); // key held, even quiet
    g.setPtt(false);
    const tail = drive(g, rep(30, -20));
    const openFor = tail.filter((f) => f.open).length * FRAME_MS;
    expect(openFor).toBe(200);
    expect(tail[tail.length - 1].open).toBe(false);
  });

  it("a release delay of 0 closes on the next frame", () => {
    const g = new VoiceGate({ mode: "ptt", auto: true, thresholdDb: -50, releaseMs: 0 });
    g.setPtt(true);
    drive(g, rep(3, -20));
    g.setPtt(false);
    expect(g.step(-20).open).toBe(false);
  });

  it("switching to push to talk shuts an open voice gate", () => {
    const g = new VoiceGate({ mode: "vad", auto: false, thresholdDb: -40, releaseMs: 100 });
    drive(g, rep(5, -20));
    g.configure({ mode: "ptt" });
    expect(g.step(-20).open).toBe(false);
  });
});

describe("too quiet hint", () => {
  it("shows after 10 s of talking that never crosses a manual threshold", () => {
    const g = new VoiceGate({ mode: "vad", auto: false, thresholdDb: -20, releaseMs: 0 });
    drive(g, rep(300, -70)); // the room
    // Talking at -40 dB, well over the room but under -20, for 11 s.
    const talk = drive(g, syllables(1100, -40, -70));
    expect(talk[200].quiet).toBe(false);
    expect(talk[talk.length - 1].quiet).toBe(true);
    // Crossing it clears the hint.
    expect(g.step(-10).quiet).toBe(false);
  });

  it("doesn't nag in automatic mode or push to talk", () => {
    for (const cfg of [
      { mode: "vad" as const, auto: true, thresholdDb: -20, releaseMs: 0 },
      { mode: "ptt" as const, auto: false, thresholdDb: -20, releaseMs: 0 },
    ]) {
      const g = new VoiceGate(cfg);
      drive(g, rep(300, -70));
      expect(drive(g, syllables(1200, -40, -70)).some((f) => f.quiet)).toBe(false);
    }
  });
});

describe("frame adapter", () => {
  for (const frame of [480, 768, 128]) {
    it(`frames of ${frame}: a constant delay of ${adapterDelay(frame)} samples, never dry`, () => {
      const seen: number[] = [];
      const a = new FrameAdapter(frame, (f) => seen.push(f.length));
      const total = 128 * 200;
      const input = Float32Array.from({ length: total }, (_, i) => i + 1);
      const output = new Float32Array(total);
      for (let i = 0; i < total; i += 128) a.process(input.subarray(i, i + 128), output.subarray(i, i + 128));
      const d = adapterDelay(frame);
      for (let i = 0; i < d; i++) expect(output[i]).toBe(0);
      for (let i = d; i < total - frame; i++) expect(output[i]).toBe(input[i - d]);
      expect(seen.every((n) => n === frame)).toBe(true);
    });
  }
  it("RNNoise adds 9.3 ms and GTCRN 13.3 ms at 48 kHz", () => {
    expect(adapterDelay(480)).toBe(448);
    expect(adapterDelay(768)).toBe(640);
  });
});

describe("automatic gain", () => {
  it("brings quiet speech up slowly, within its limits, and holds in pauses", () => {
    const agc = new AutoGain();
    for (let i = 0; i < 100; i++) agc.update(-40, FRAME_MS); // 1 s
    expect(agc.db).toBeCloseTo(3, 1); // 3 dB/s up
    for (let i = 0; i < 2000; i++) agc.update(-40, FRAME_MS);
    expect(agc.db).toBe(18); // capped
    const before = agc.db;
    agc.update(null, FRAME_MS);
    expect(agc.db).toBe(before);
    for (let i = 0; i < 300; i++) agc.update(-26, FRAME_MS);
    expect(agc.db).toBeCloseTo(AGC_TARGET_DB + 26, 0); // comes down to the target
    for (let i = 0; i < 1000; i++) agc.update(-5, FRAME_MS);
    expect(agc.db).toBe(-6); // never more than 6 dB down
  });

  it("limits peaks below full scale", () => {
    expect(softLimit(0.5)).toBe(0.5);
    expect(softLimit(3)).toBeLessThan(1);
    expect(softLimit(-3)).toBeGreaterThan(-1);
  });
});
