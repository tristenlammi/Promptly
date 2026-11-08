/**
 * Fixed-size frames over the audio thread's 128-sample blocks.
 *
 * Noise suppressors want their own frame size (RNNoise 480 samples, GTCRN
 * 768 at 48 kHz); the AudioWorklet hands over 128 at a time. A
 * ``FrameAdapter`` collects input until a whole frame is there, processes
 * it in place, and plays the results back out with the smallest constant
 * delay that never runs dry: ``frame - gcd(128, frame)`` samples
 * (448 = 9.3 ms for RNNoise, 640 = 13.3 ms for GTCRN at 48 kHz).
 */

export const BLOCK = 128;

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** The adapter's added delay, in samples. */
export function adapterDelay(frameSize: number): number {
  return frameSize - gcd(BLOCK, frameSize);
}

export class FrameAdapter {
  readonly frameSize: number;
  readonly delay: number;
  private readonly frame: Float32Array;
  private filled = 0;
  // Output FIFO as a ring.
  private readonly out: Float32Array;
  private readPos = 0;
  private writePos = 0;
  private stored = 0;

  constructor(
    frameSize: number,
    private readonly processFrame: (frame: Float32Array) => void,
  ) {
    this.frameSize = frameSize;
    this.delay = adapterDelay(frameSize);
    this.frame = new Float32Array(frameSize);
    this.out = new Float32Array(frameSize + this.delay + BLOCK * 2);
    // Prime with silence: the constant delay.
    this.writePos = this.delay;
    this.stored = this.delay;
  }

  /** One block in, one block out (same length; any length up to a frame). */
  process(input: Float32Array, output: Float32Array): void {
    let i = 0;
    while (i < input.length) {
      const n = Math.min(input.length - i, this.frameSize - this.filled);
      this.frame.set(input.subarray(i, i + n), this.filled);
      this.filled += n;
      i += n;
      if (this.filled === this.frameSize) {
        this.processFrame(this.frame);
        this.push(this.frame);
        this.filled = 0;
      }
    }
    this.pull(output);
  }

  private push(src: Float32Array): void {
    const cap = this.out.length;
    for (let k = 0; k < src.length; k++) {
      this.out[this.writePos] = src[k];
      this.writePos = (this.writePos + 1) % cap;
    }
    this.stored += src.length;
  }

  private pull(dst: Float32Array): void {
    const cap = this.out.length;
    const n = Math.min(dst.length, this.stored);
    for (let k = 0; k < n; k++) {
      dst[k] = this.out[this.readPos];
      this.readPos = (this.readPos + 1) % cap;
    }
    // Never happens with the priming above; silence rather than garbage.
    for (let k = n; k < dst.length; k++) dst[k] = 0;
    this.stored -= n;
  }
}
