import { loadWorklets } from "./mic";

/**
 * Talk's speaker (WP-T4): Web Audio only, never an ``<audio>`` element
 * (the WP-T0 echo result). Speech arrives as 20 ms frames of PCM16 at
 * 24 kHz, about 300 ms ahead of when it should play; ``flush`` drops the
 * rest at once (``stop_audio``, Stop, a barge-in). A gain stage ducks it to
 * 30% the moment the local level meter hears you talking over it, before
 * the server has decided it's a real interruption.
 */

export const SPEECH_SAMPLE_RATE = 24_000;
const DUCKED = 0.3;

interface PosMessage {
  type: "pos";
  read: number;
  written: number;
  playing: boolean;
}

export class TalkPlayer {
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private written = 0;
  private read = 0;
  /** Where the current reply's speech starts, in pushed samples. */
  private replyMark: number | null = null;
  playing = false;
  /** Called when sound starts coming out, and when it runs dry. */
  onPlaying: ((playing: boolean) => void) | null = null;

  constructor(private ctx: AudioContext) {}

  async init(): Promise<void> {
    await loadWorklets(this.ctx);
    this.node = new AudioWorkletNode(this.ctx, "talk-playback", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.gain = this.ctx.createGain();
    this.node.connect(this.gain);
    this.gain.connect(this.ctx.destination);
    this.node.port.onmessage = (e: MessageEvent<PosMessage>) => {
      const m = e.data;
      if (m.type !== "pos") return;
      this.read = m.read;
      if (m.playing !== this.playing) {
        this.playing = m.playing;
        this.onPlaying?.(m.playing);
      }
    };
  }

  /** One frame of speech (PCM16 mono, 24 kHz). */
  push(pcm: Int16Array): void {
    if (!this.node) return;
    if (this.replyMark === null) this.replyMark = this.written;
    this.written += pcm.length;
    const copy = pcm.slice();
    this.node.port.postMessage({ type: "push", pcm: copy.buffer }, [copy.buffer]);
  }

  /** Drop everything not yet played. */
  flush(): void {
    this.read = this.written;
    this.replyMark = null;
    this.node?.port.postMessage({ type: "flush" });
    this.unduck();
  }

  /** The next frame pushed starts a new reply (for {@link playedMs}). */
  newReply(): void {
    this.replyMark = null;
  }

  /** How much of the current reply has actually played, in ms. */
  playedMs(): number | null {
    if (this.replyMark === null) return null;
    return Math.max(0, Math.round(((this.read - this.replyMark) / SPEECH_SAMPLE_RATE) * 1000));
  }

  /** How much is queued and not yet played, in ms. */
  bufferedMs(): number {
    return Math.max(0, ((this.written - this.read) / SPEECH_SAMPLE_RATE) * 1000);
  }

  duck(): void {
    const g = this.gain;
    if (!g) return;
    g.gain.cancelScheduledValues(this.ctx.currentTime);
    g.gain.setTargetAtTime(DUCKED, this.ctx.currentTime, 0.015);
  }

  unduck(): void {
    const g = this.gain;
    if (!g) return;
    g.gain.cancelScheduledValues(this.ctx.currentTime);
    g.gain.setTargetAtTime(1, this.ctx.currentTime, 0.08);
  }

  /** A short soft tone (Talk ending). */
  tone(kind: "end" | "start" = "end"): void {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    const [a, b] = kind === "end" ? [660, 440] : [440, 660];
    osc.frequency.setValueAtTime(a, t);
    osc.frequency.exponentialRampToValueAtTime(b, t + 0.22);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  }

  /** Play a whole clip (a voice sample in the picker) through Web Audio.
   *  Resolves when it has finished; ``stop`` on the result cuts it off. */
  async clip(data: ArrayBuffer): Promise<{ done: Promise<void>; stop: () => void }> {
    const buffer = await this.ctx.decodeAudioData(data);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    const done = new Promise<void>((resolve) => {
      src.onended = () => resolve();
    });
    src.start();
    return {
      done,
      stop: () => {
        try {
          src.stop();
        } catch {
          /* ended */
        }
      },
    };
  }

  close(): void {
    try {
      this.node?.disconnect();
      this.gain?.disconnect();
    } catch {
      /* already gone */
    }
    if (this.node) this.node.port.onmessage = null;
    this.node = null;
    this.gain = null;
  }
}
