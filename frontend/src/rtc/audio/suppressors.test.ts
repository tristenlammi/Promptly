// The suppressors' WebAssembly builds load with our own small loaders and
// clean noise, under Node (the same V8 as Chrome's audio thread). Also a
// rough CPU figure, printed, for the plan's notes.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createGtcrn, createRnnoise, type Suppressor } from "./suppressors";

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(path.dirname(require.resolve("@sapphi-red/web-noise-suppressor/gtcrn.wasm")));
const wasm = (name: string) => readFileSync(path.join(pkgDir, "dist", name));

/** Deterministic white noise. */
function noise(n: number, amp: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((s / 0x7fffffff) * 2 - 1) * amp;
  }
  return out;
}

function rms(a: Float32Array, from = 0): number {
  let sum = 0;
  for (let i = from; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / (a.length - from));
}

function run(s: Suppressor, input: Float32Array): { out: Float32Array; probs: (number | null)[]; ms: number } {
  const out = new Float32Array(input.length);
  const probs: (number | null)[] = [];
  const frame = new Float32Array(s.frameSize);
  const t0 = performance.now();
  for (let i = 0; i + s.frameSize <= input.length; i += s.frameSize) {
    frame.set(input.subarray(i, i + s.frameSize));
    probs.push(s.process(frame));
    out.set(frame, i);
  }
  return { out, probs, ms: performance.now() - t0 };
}

describe("noise suppressors", () => {
  const seconds = 10;
  const input = noise(48000 * seconds, 0.1);

  it("RNNoise loads, removes steady noise and reports a speech probability", async () => {
    for (const file of ["rnnoise_simd.wasm", "rnnoise.wasm"]) {
      const s = await createRnnoise(wasm(file));
      expect(s.frameSize).toBe(480);
      const { out, probs, ms } = run(s, input);
      s.destroy();
      for (const p of probs) {
        expect(p).not.toBeNull();
        expect(p!).toBeGreaterThanOrEqual(0);
        expect(p!).toBeLessThanOrEqual(1);
      }
      expect(out.every((x) => Number.isFinite(x))).toBe(true);
      // White noise: after a second to adapt, turned down (RNNoise is gentler
      // on it than GTCRN).
      expect(rms(out, 48000)).toBeLessThan(rms(input) * 0.8);
      console.log(`${file}: ${((ms / (seconds * 1000)) * 100).toFixed(2)}% of a core (Node)`);
    }
  });

  it("GTCRN loads and removes steady noise", async () => {
    const s = await createGtcrn(wasm("gtcrn.wasm"));
    expect(s.frameSize).toBe(768);
    const { out, probs, ms } = run(s, input);
    s.destroy();
    expect(probs.every((p) => p === null)).toBe(true);
    expect(out.every((x) => Number.isFinite(x))).toBe(true);
    expect(rms(out, 48000)).toBeLessThan(rms(input) * 0.5);
    console.log(`gtcrn.wasm: ${((ms / (seconds * 1000)) * 100).toFixed(2)}% of a core (Node)`);
  });

  it("refuses a build whose exports don't match", async () => {
    await expect(createGtcrn(wasm("rnnoise.wasm"))).rejects.toThrow();
  });
});
