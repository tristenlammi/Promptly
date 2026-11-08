/**
 * Gentle automatic gain after the noise suppressor (Enhanced turns the
 * browser's own gain control off: run before the suppressor it turns the
 * pauses up, WP-V0). Follows the speech level only while someone is
 * talking, slowly, within -6..+18 dB, and a soft limiter keeps peaks
 * under full scale.
 */

export const AGC_TARGET_DB = -20;
const MAX_GAIN_DB = 18;
const MIN_GAIN_DB = -6;
const RISE_DB_PER_S = 3;
const FALL_DB_PER_S = 12;

export class AutoGain {
  private gainDb = 0;

  get db(): number {
    return this.gainDb;
  }

  /** One frame of ``frameMs``: its level (dBFS, before this gain) when it's
   *  speech, else null (the gain holds). Returns the linear gain. */
  update(speechLevelDb: number | null, frameMs: number): number {
    if (speechLevelDb !== null && Number.isFinite(speechLevelDb)) {
      const error = AGC_TARGET_DB - (speechLevelDb + this.gainDb);
      const s = frameMs / 1000;
      const step = Math.max(-FALL_DB_PER_S * s, Math.min(RISE_DB_PER_S * s, error));
      this.gainDb = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, this.gainDb + step));
    }
    return dbToGain(this.gainDb);
  }

  reset(): void {
    this.gainDb = 0;
  }
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(g: number): number {
  return 20 * Math.log10(Math.max(g, 1e-9));
}

/** RMS of a block in dBFS (-120 for silence). */
export function levelDb(buf: Float32Array, n = buf.length): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += buf[i] * buf[i];
  return n ? gainToDb(Math.sqrt(sum / n)) : -120;
}

/** Soft limiter: transparent below 0.8, smoothly approaches 1.0 above. */
export function softLimit(x: number): number {
  const a = Math.abs(x);
  if (a <= 0.8) return x;
  const over = (a - 0.8) / 0.2;
  const y = 0.8 + 0.2 * Math.tanh(over);
  return x < 0 ? -y : y;
}

/** A meter reading 0..1 from dBFS (-60 dB is the bottom), like Test calls'. */
export function meterLevel(db: number): number {
  return Math.max(0, Math.min(1, (db + 60) / 60));
}
