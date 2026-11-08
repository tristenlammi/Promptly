/**
 * The two noise suppressors, straight on their WebAssembly builds from
 * ``@sapphi-red/web-noise-suppressor`` 0.4.1 (MIT; GTCRN model MIT,
 * RNNoise BSD, built by shiguredo, Apache-2.0). We load the .wasm files
 * ourselves instead of the package's worklets so that one worklet of ours
 * can run the suppressor, the gate and the gain together, time itself, and
 * keep RNNoise's per-frame speech probability (the package's worklet
 * throws it away; automatic sensitivity needs it).
 *
 * Runs on the audio thread (no fetch there: the bytes come in through the
 * worklet's options) and in the unit tests under Node.
 *
 * The import/export names are the builds' own (GTCRN's are minified), so the
 * package is pinned to an exact version; a build that doesn't match fails to
 * load here and the engine falls back to the next suppressor.
 */

export interface Suppressor {
  /** Samples per frame at 48 kHz. */
  readonly frameSize: number;
  /** Denoise one frame in place (floats, -1..1). Returns the speech
   *  probability (0..1) when the suppressor has one, else null. */
  process(frame: Float32Array): number | null;
  destroy(): void;
}

type Exports = Record<string, unknown>;

function heapGrower(getMemory: () => WebAssembly.Memory) {
  return (requested: number): number => {
    const mem = getMemory();
    const have = mem.buffer.byteLength;
    if (requested <= have) return 1;
    try {
      mem.grow(Math.ceil((requested - have) / 65536));
      return 1;
    } catch {
      return 0;
    }
  };
}

function fn(ex: Exports, name: string): (...a: number[]) => number {
  const f = ex[name];
  if (typeof f !== "function") throw new Error(`suppressor build has no ${name}`);
  return f as (...a: number[]) => number;
}

/** RNNoise: 480-sample frames (10 ms), 16-bit-scaled floats, speech probability. */
export async function createRnnoise(bytes: BufferSource): Promise<Suppressor> {
  let memory: WebAssembly.Memory | null = null;
  const imports = {
    env: {
      emscripten_memcpy_big: (dest: number, src: number, num: number) => {
        const heap = new Uint8Array(memory!.buffer);
        heap.copyWithin(dest, src, src + num);
      },
      emscripten_resize_heap: heapGrower(() => memory!),
      __assert_fail: () => {
        throw new Error("rnnoise: assertion failed");
      },
    },
  };
  const { instance } = (await WebAssembly.instantiate(bytes, imports)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
  const ex = instance.exports as Exports;
  memory = ex.memory as WebAssembly.Memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("rnnoise build has no memory");
  if (typeof ex.emscripten_stack_init === "function") (ex.emscripten_stack_init as () => void)();
  fn(ex, "__wasm_call_ctors")();
  const frameSize = fn(ex, "rnnoise_get_frame_size")();
  const create = fn(ex, "rnnoise_create");
  const destroyState = fn(ex, "rnnoise_destroy");
  const processFrame = fn(ex, "rnnoise_process_frame");
  const malloc = fn(ex, "malloc");
  const free = fn(ex, "free");
  const state = create(0);
  const inPtr = malloc(frameSize * 4);
  const outPtr = malloc(frameSize * 4);
  if (!state || !inPtr || !outPtr) throw new Error("rnnoise: out of memory");
  let alive = true;
  return {
    frameSize,
    process(frame) {
      if (!alive) return null;
      const heap = new Float32Array(memory!.buffer);
      const i0 = inPtr >> 2;
      for (let k = 0; k < frameSize; k++) heap[i0 + k] = frame[k] * 32767;
      const prob = processFrame(state, outPtr, inPtr);
      const out = new Float32Array(memory!.buffer, outPtr, frameSize);
      for (let k = 0; k < frameSize; k++) frame[k] = out[k] / 32767;
      return prob;
    },
    destroy() {
      if (!alive) return;
      alive = false;
      destroyState(state);
      free(inPtr);
      free(outPtr);
    },
  };
}

/** GTCRN at 48 kHz: 768-sample frames (16 ms), floats, no speech probability. */
export async function createGtcrn(bytes: BufferSource): Promise<Suppressor> {
  let memory: WebAssembly.Memory | null = null;
  const imports = {
    a: {
      a: () => {
        throw new Error("gtcrn: assertion failed");
      },
      b: heapGrower(() => memory!),
    },
  };
  const { instance } = (await WebAssembly.instantiate(bytes, imports)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
  const ex = instance.exports as Exports;
  // The build's minified names (gtcrn-wasm via web-noise-suppressor 0.4.1):
  // c memory, d ctors, e create, f free, g destroy, j process_48k, k malloc.
  memory = ex.c as WebAssembly.Memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("gtcrn build has no memory");
  fn(ex, "d")();
  const create = fn(ex, "e");
  const free = fn(ex, "f");
  const destroyState = fn(ex, "g");
  const process48k = fn(ex, "j");
  const malloc = fn(ex, "k");
  const frameSize = 768;
  const state = create();
  const inPtr = malloc(frameSize * 4);
  const outPtr = malloc(frameSize * 4);
  if (!state || !inPtr || !outPtr) throw new Error("gtcrn: out of memory");
  let alive = true;
  return {
    frameSize,
    process(frame) {
      if (!alive) return null;
      new Float32Array(memory!.buffer, inPtr, frameSize).set(frame);
      process48k(state, inPtr, outPtr);
      frame.set(new Float32Array(memory!.buffer, outPtr, frameSize));
      return null;
    },
    destroy() {
      if (!alive) return;
      alive = false;
      free(inPtr);
      free(outPtr);
      destroyState(state);
    },
  };
}
