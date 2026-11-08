/**
 * Go Live: what a quality choice means for capture and encoding.
 *
 * 720p30 (default) / 1080p30 / 1080p60, capped by the server's
 * ``calls_max_stream``. "Smoother motion" (games, video) keeps the frame
 * rate when bandwidth drops; "Better for text" (code, documents) keeps the
 * resolution. Simulcast layers (1080p/720p/360p as the owner asked) let
 * each viewer get what their connection takes while the streamer uploads
 * once; the server's upload is the real limit.
 */
import type { StreamQuality } from "@/api/voiceChannels";

export type StreamHint = "motion" | "detail";

export const STREAM_QUALITIES: readonly StreamQuality[] = ["720p30", "1080p30", "1080p60"];
export const DEFAULT_STREAM_QUALITY: StreamQuality = "720p30";
export const DEFAULT_STREAM_HINT: StreamHint = "motion";

export interface LayerSpec {
  width: number;
  height: number;
  maxBitrate: number;
  maxFramerate: number;
}

export interface StreamPlan {
  quality: StreamQuality;
  /** Capture size and rate asked of ``getDisplayMedia``. */
  capture: { width: number; height: number; frameRate: number };
  /** The top layer's encoding. */
  encoding: { maxBitrate: number; maxFramerate: number };
  /** Lower simulcast layers, smallest first. */
  layers: LayerSpec[];
  contentHint: StreamHint;
  degradation: RTCDegradationPreference;
}

/** The highest quality allowed: the wanted one, or the server's cap. */
export function capQuality(want: StreamQuality, max: StreamQuality): StreamQuality {
  const w = STREAM_QUALITIES.indexOf(want);
  const m = STREAM_QUALITIES.indexOf(max);
  if (w < 0) return m < 0 ? DEFAULT_STREAM_QUALITY : max;
  if (m < 0) return want;
  return STREAM_QUALITIES[Math.min(w, m)];
}

/** Qualities offered under a cap, for the picker. */
export function allowedQualities(max: StreamQuality): StreamQuality[] {
  const m = STREAM_QUALITIES.indexOf(max);
  return STREAM_QUALITIES.slice(0, m < 0 ? 1 : m + 1);
}

const P360 = (fps: number): LayerSpec => ({ width: 640, height: 360, maxBitrate: 500_000, maxFramerate: fps });
const P720 = (fps: number, motion: boolean): LayerSpec => ({
  width: 1280,
  height: 720,
  maxBitrate: motion ? 2_000_000 : 1_500_000,
  maxFramerate: fps,
});

export function streamPlan(want: StreamQuality, max: StreamQuality, hint: StreamHint): StreamPlan {
  const quality = capQuality(want, max);
  const motion = hint === "motion";
  // Text keeps sharpness at a lower frame rate in the smaller layers.
  const lowFps = motion ? 30 : 15;
  let capture: StreamPlan["capture"];
  let encoding: StreamPlan["encoding"];
  let layers: LayerSpec[];
  switch (quality) {
    case "1080p60":
      capture = { width: 1920, height: 1080, frameRate: 60 };
      encoding = { maxBitrate: motion ? 6_000_000 : 4_500_000, maxFramerate: 60 };
      layers = [P360(lowFps), P720(lowFps, motion)];
      break;
    case "1080p30":
      capture = { width: 1920, height: 1080, frameRate: 30 };
      encoding = { maxBitrate: motion ? 4_000_000 : 3_000_000, maxFramerate: 30 };
      layers = [P360(15), P720(lowFps, motion)];
      break;
    default:
      capture = { width: 1280, height: 720, frameRate: 30 };
      encoding = { maxBitrate: motion ? 2_500_000 : 2_000_000, maxFramerate: 30 };
      layers = [P360(15)];
      break;
  }
  return {
    quality,
    capture,
    encoding,
    layers,
    contentHint: hint,
    degradation: motion ? "maintain-framerate" : "maintain-resolution",
  };
}

/** Plain words for a quality, for pickers. */
export function qualityWords(q: StreamQuality): string {
  return q === "1080p60" ? "1080p 60" : q === "1080p30" ? "1080p 30" : "720p 30";
}
