/**
 * The in-app camera's rules, kept apart from the screen so they can be
 * tested: what a press on the shutter means, how long and how big a video
 * may be, and what to call what it makes.
 *
 * Tap the shutter for a photo; press and hold for a video, for as long as
 * you hold (``components/CameraView.tsx``).
 */

/** Held this long, a press is a video; let go sooner and it's a photo. */
export const HOLD_MS = 350;
/** The longest video, in seconds. */
export const MAX_VIDEO_S = 60;
/** The largest file a message takes where the server hasn't said (its
 *  one-request limit). The real limit comes from the server's upload policy,
 *  which is far more where big uploads are switched on. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** What a finished press on the shutter was. */
export function pressOutcome(downAt: number, upAt: number, holdMs: number = HOLD_MS): "photo" | "video" {
  return upAt - downAt >= holdMs ? "video" : "photo";
}

/** How far round the ring is (0 to 1) after ``elapsedMs`` of recording. */
export function ringFraction(elapsedMs: number, maxSeconds: number = MAX_VIDEO_S): number {
  if (!(elapsedMs > 0)) return 0;
  return Math.min(1, elapsedMs / (maxSeconds * 1000));
}

/** "0:07" on the recording timer. */
export function recordingClock(elapsedMs: number): string {
  const s = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const AUDIO_BITS = 96_000;

/** The most a video's picture is given: what a phone's own camera uses for
 *  1080p is around this, and past it a chat video only gets bigger. */
export const VIDEO_BITS_BEST = 10_000_000;

/**
 * What a picture of this size wants, in bits a second, at ``fps``: about
 * 10 Mbit/s for 1080p at 30, half that for 720p. Unknown size: the best.
 */
export function bitsForPicture(width: number, height: number, fps: number = 30): number {
  if (!(width > 0) || !(height > 0)) return VIDEO_BITS_BEST;
  const rate = fps > 0 ? Math.min(fps, 30) : 30;
  return Math.max(1_000_000, Math.min(VIDEO_BITS_BEST, Math.round(width * height * rate * 0.16)));
}

/**
 * The picture's bit rate for a video that may run ``maxSeconds`` and must
 * stay under ``maxBytes`` with its sound: as good as ``best`` (what the
 * picture's size wants), and never so much that a full-length video would
 * be refused. A tenth is kept back, since recorders overshoot what they're
 * asked for.
 */
export function videoBits(maxBytes: number = MAX_FILE_BYTES, maxSeconds: number = MAX_VIDEO_S, best: number = VIDEO_BITS_BEST): number {
  const room = Math.floor((maxBytes * 8 * 0.9) / maxSeconds) - AUDIO_BITS;
  return Math.max(250_000, Math.min(best, room));
}
export const audioBits = AUDIO_BITS;

// ---- what the camera is asked for ------------------------------------------

/** The live picture: full HD at 30 frames a second, from the camera asked for. */
export function cameraConstraints(facing: "environment" | "user"): MediaTrackConstraints {
  return { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
}

/** The parts of a camera track's capabilities this screen uses (Chrome on
 *  Android gives them; Safari and Firefox mostly don't). */
export interface CameraCaps {
  focusMode?: string[];
  exposureMode?: string[];
  whiteBalanceMode?: string[];
  zoom?: { min?: number; max?: number; step?: number };
  torch?: boolean;
}
export interface Point {
  x: number;
  y: number;
}

/**
 * Keep focusing, and keep the light and colour right, by itself: asked only
 * for what this camera says it can do. Null when it offers none of it.
 */
export function autoSettings(caps: CameraCaps): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (caps.focusMode?.includes("continuous")) out.focusMode = "continuous";
  if (caps.exposureMode?.includes("continuous")) out.exposureMode = "continuous";
  if (caps.whiteBalanceMode?.includes("continuous")) out.whiteBalanceMode = "continuous";
  return Object.keys(out).length ? out : null;
}

/**
 * Focus (and set the light) on one spot. Null when this camera can't focus
 * on request, so a tap then does nothing at all.
 */
export function focusSettings(caps: CameraCaps, at: Point): Record<string, unknown> | null {
  const focus = caps.focusMode ?? [];
  const mode = focus.includes("single-shot") ? "single-shot" : focus.includes("continuous") ? "continuous" : null;
  if (!mode) return null;
  const out: Record<string, unknown> = { pointsOfInterest: [{ x: at.x, y: at.y }], focusMode: mode };
  const light = caps.exposureMode ?? [];
  if (light.includes("single-shot")) out.exposureMode = "single-shot";
  else if (light.includes("continuous")) out.exposureMode = "continuous";
  return out;
}

/**
 * Where in the camera's picture (0 to 1 across and down) a tap landed. The
 * picture fills its box and is cropped to fit (object-cover), and a front
 * camera is shown mirrored. Null for a tap outside the picture or before it
 * has a size.
 */
export function pictureSpot(
  tap: Point,
  box: { left: number; top: number; width: number; height: number },
  picture: { width: number; height: number },
  mirrored: boolean = false,
): Point | null {
  if (!(box.width > 0) || !(box.height > 0) || !(picture.width > 0) || !(picture.height > 0)) return null;
  const scale = Math.max(box.width / picture.width, box.height / picture.height);
  const shownW = picture.width * scale;
  const shownH = picture.height * scale;
  let x = (tap.x - box.left + (shownW - box.width) / 2) / shownW;
  const y = (tap.y - box.top + (shownH - box.height) / 2) / shownH;
  if (mirrored) x = 1 - x;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/** How far this camera zooms, or null when it can't (or has only one setting). */
export function zoomRange(caps: CameraCaps): { min: number; max: number; step: number } | null {
  const z = caps.zoom;
  if (!z || typeof z.min !== "number" || typeof z.max !== "number" || !(z.max > z.min)) return null;
  return { min: z.min, max: z.max, step: z.step && z.step > 0 ? z.step : 0.1 };
}

/**
 * The zoom after a pinch: where it was when two fingers went down, times how
 * far they've spread, kept inside what the camera does and on its steps.
 */
export function pinchZoom(startZoom: number, startGap: number, gap: number, range: { min: number; max: number; step: number }): number {
  if (!(startGap > 0) || !(gap > 0)) return Math.min(range.max, Math.max(range.min, startZoom));
  const raw = startZoom * (gap / startGap);
  const stepped = range.min + Math.round((raw - range.min) / range.step) * range.step;
  return Math.min(range.max, Math.max(range.min, Number(stepped.toFixed(4))));
}

/** "1x", "2.5x": the zoom, as a phone's camera writes it. */
export function zoomLabel(zoom: number): string {
  const z = Math.round(zoom * 10) / 10;
  return `${Number.isInteger(z) ? z : z.toFixed(1)}x`;
}

/**
 * The kind of video file to record, best first. MP4 (H.264 + AAC) plays on
 * every phone and computer, iPhones included, so it's taken wherever the
 * browser can record it (Safari, and Chrome since 2024); WebM is what older
 * Chrome and Firefox make, and what iPhones before iOS 17.4 can't play.
 */
export const VIDEO_TYPES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

export function pickVideoType(supported: (type: string) => boolean): string | null {
  for (const t of VIDEO_TYPES) {
    try {
      if (supported(t)) return t;
    } catch {
      // A browser that throws on a type it doesn't know: not that one, then.
    }
  }
  return null;
}

/** "video/mp4;codecs=…" → "video/mp4". */
export function plainType(type: string): string {
  return (type.split(";")[0] || "").trim().toLowerCase();
}

export function extensionFor(type: string): string {
  const t = plainType(type);
  if (t === "image/jpeg") return "jpg";
  if (t === "image/png") return "png";
  if (t === "image/webp") return "webp";
  if (t === "video/mp4") return "mp4";
  if (t === "video/webm") return "webm";
  if (t === "video/quicktime") return "mov";
  return t.startsWith("video/") ? "mp4" : "jpg";
}

/** "Photo 2026-11-15 18.04.09.jpg": sorts by when it was taken, and has no
 *  character a file system minds. */
export function captureName(kind: "photo" | "video", when: Date, type: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}.${p(when.getMinutes())}.${p(when.getSeconds())}`;
  return `${kind === "photo" ? "Photo" : "Video"} ${stamp}.${extensionFor(type)}`;
}

/** Why the camera couldn't open, in plain words, from the browser's error. */
export function cameraProblem(err: unknown, secure: boolean = true): string {
  if (!secure) return "The camera only works on a secure (https) address.";
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Promptly isn't allowed to use the camera. You can allow it in your browser's site settings for this address.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "No camera was found on this device.";
  if (name === "NotReadableError" || name === "AbortError") return "The camera is busy in another app. Close that and try again.";
  return "The camera couldn't be opened.";
}
