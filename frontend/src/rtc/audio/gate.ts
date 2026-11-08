/**
 * The microphone gate: decides, every 10 ms frame, whether what the mic
 * hears is sent (Voice activity, automatic or manual sensitivity) or only
 * while a key is held (Push to talk, with a release delay). Plus the "You
 * might be too quiet" hint.
 *
 * Plain logic with no audio APIs: the AudioWorklet (``voiceWorklet.ts``)
 * runs it on the audio thread, and the unit tests drive it frame by frame.
 * Levels are dBFS of the suppressed signal (what others would hear).
 */

export const FRAME_MS = 10;

export type InputMode = "vad" | "ptt";

export interface GateConfig {
  mode: InputMode;
  /** Voice activity: pick the threshold automatically. */
  auto: boolean;
  /** Voice activity, manual: open at this level (dBFS, -100..0). */
  thresholdDb: number;
  /** Push to talk: keep sending this long after the key is let go. */
  releaseMs: number;
}

export const DEFAULT_GATE: GateConfig = { mode: "vad", auto: true, thresholdDb: -50, releaseMs: 200 };

/** How long voice activity stays open after the last frame that opened it,
 *  so word endings and short pauses aren't chopped. */
export const VAD_HOLD_MS = 300;
/** Manual threshold hysteresis: once open, stay open down to this far below. */
const MANUAL_HYSTERESIS_DB = 4;
/** Automatic: open this far above the background (noise floor) ... */
const AUTO_OPEN_ABOVE_FLOOR_DB = 14;
/** ... and stay open down to this far above it. */
const AUTO_SUSTAIN_ABOVE_FLOOR_DB = 8;
/** Automatic never opens below this, however quiet the room. */
const AUTO_MIN_OPEN_DB = -58;
/** Speech probability (RNNoise) that opens / keeps open the automatic gate. */
const PROB_OPEN = 0.6;
const PROB_SUSTAIN = 0.35;
/** Anything quieter than this isn't speech, whatever the model says. */
const SILENCE_DB = -70;
/** Noise-floor tracker (minimum statistics): the quietest 100 ms over the
 *  last 3 s is the background; the floor follows it down at once and up at
 *  most this fast (dB per second). Speech has gaps between words, so the
 *  minimum stays near the background while someone talks. */
const FLOOR_BLOCK_FRAMES = 10;
const FLOOR_WINDOW_BLOCKS = 30;
const FLOOR_RISE = 6;
/** Until this much audio has been seen, the floor is just the minimum so
 *  far (a fan that was on before you joined is learned at once). */
const FLOOR_SETTLE_MS = 500;
const FLOOR_MIN = -100;
const FLOOR_MAX = -25;
/** "Too quiet": talking for at least this much ... */
const QUIET_TALK_MS = 2000;
/** ... within this long, without the manual threshold ever opening. */
const QUIET_WINDOW_MS = 10_000;

export interface GateFrame {
  /** Send this frame. */
  open: boolean;
  /** Sounds like someone talking, whatever the gate does (the "You're
   *  muted" whisper, the too-quiet hint). */
  talking: boolean;
  /** The background level the automatic threshold follows. */
  floorDb: number;
  /** The level the gate opens at right now (for the meter's line). */
  thresholdDb: number;
  /** Manual sensitivity looks too high for this voice. */
  quiet: boolean;
}

export class VoiceGate {
  private cfg: GateConfig;
  private t = 0;
  private pttDown = false;
  private pttReleasedAt = -Infinity;
  private open = false;
  private holdUntil = -Infinity;
  private floorDb = -70;
  private blockMin = Infinity;
  private blockFrames = 0;
  private readonly blockMins: number[] = [];
  private quietStart: number | null = null;
  private quietTalkMs = 0;
  private quiet = false;

  constructor(cfg: GateConfig = DEFAULT_GATE) {
    this.cfg = { ...cfg };
  }

  get config(): GateConfig {
    return this.cfg;
  }

  configure(patch: Partial<GateConfig>): void {
    const before = this.cfg;
    this.cfg = { ...this.cfg, ...patch };
    if (before.mode !== this.cfg.mode || before.auto !== this.cfg.auto || before.thresholdDb !== this.cfg.thresholdDb) {
      this.resetQuiet();
    }
    if (this.cfg.mode === "ptt" && before.mode !== "ptt") {
      this.open = this.pttDown;
    }
  }

  /** Push to talk key down / up. */
  setPtt(down: boolean): void {
    if (this.pttDown && !down) this.pttReleasedAt = this.t;
    this.pttDown = down;
  }

  /** The speech gate's own clock (ms of audio seen). */
  get now(): number {
    return this.t;
  }

  /**
   * One 10 ms frame: its level (dBFS) and, when the suppressor has one,
   * its speech probability (0..1).
   */
  step(levelDb: number, prob: number | null = null): GateFrame {
    this.t += FRAME_MS;
    const level = Number.isFinite(levelDb) ? levelDb : -120;
    const talking = this.isTalking(level, prob, false);
    let open: boolean;
    if (this.cfg.mode === "ptt") {
      open = this.pttDown || this.t - this.pttReleasedAt <= this.cfg.releaseMs;
    } else {
      const trigger = this.cfg.auto ? this.isTalking(level, prob, this.open) : this.manualTrigger(level);
      if (trigger) this.holdUntil = this.t + VAD_HOLD_MS;
      open = this.t <= this.holdUntil;
    }
    this.open = open;
    this.trackFloor(level);
    this.trackQuiet(open, talking);
    return { open, talking, floorDb: this.floorDb, thresholdDb: this.threshold(), quiet: this.quiet };
  }

  /** The level the gate opens at now (manual: the setting; automatic: the
   *  background plus a margin). */
  threshold(): number {
    if (this.cfg.mode === "vad" && !this.cfg.auto) return this.cfg.thresholdDb;
    return Math.max(this.floorDb + AUTO_OPEN_ABOVE_FLOOR_DB, AUTO_MIN_OPEN_DB);
  }

  private manualTrigger(level: number): boolean {
    const at = this.open ? this.cfg.thresholdDb - MANUAL_HYSTERESIS_DB : this.cfg.thresholdDb;
    return level >= at;
  }

  private isTalking(level: number, prob: number | null, sustaining: boolean): boolean {
    if (level < SILENCE_DB) return false;
    if (prob !== null) return prob >= (sustaining ? PROB_SUSTAIN : PROB_OPEN);
    if (sustaining) return level >= Math.max(this.floorDb + AUTO_SUSTAIN_ABOVE_FLOOR_DB, AUTO_MIN_OPEN_DB - 6);
    return level >= Math.max(this.floorDb + AUTO_OPEN_ABOVE_FLOOR_DB, AUTO_MIN_OPEN_DB);
  }

  private trackFloor(level: number): void {
    this.blockMin = Math.min(this.blockMin, level);
    if (++this.blockFrames >= FLOOR_BLOCK_FRAMES) {
      this.blockMins.push(this.blockMin);
      if (this.blockMins.length > FLOOR_WINDOW_BLOCKS) this.blockMins.shift();
      this.blockMin = Infinity;
      this.blockFrames = 0;
    }
    const windowMin = Math.min(this.blockMin, ...this.blockMins);
    if (this.t <= FLOOR_SETTLE_MS || windowMin < this.floorDb) {
      this.floorDb = windowMin;
    } else {
      this.floorDb += Math.min(windowMin - this.floorDb, (FLOOR_RISE * FRAME_MS) / 1000);
    }
    this.floorDb = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, this.floorDb));
  }

  private trackQuiet(open: boolean, talking: boolean): void {
    if (this.cfg.mode !== "vad" || this.cfg.auto || open) {
      this.resetQuiet();
      return;
    }
    if (this.quiet) return;
    if (talking) {
      if (this.quietStart === null) this.quietStart = this.t;
      this.quietTalkMs += FRAME_MS;
    }
    if (this.quietStart !== null && this.t - this.quietStart >= QUIET_WINDOW_MS) {
      if (this.quietTalkMs >= QUIET_TALK_MS) {
        this.quiet = true;
      } else {
        this.quietStart = null;
        this.quietTalkMs = 0;
      }
    }
  }

  private resetQuiet(): void {
    this.quiet = false;
    this.quietStart = null;
    this.quietTalkMs = 0;
  }
}
