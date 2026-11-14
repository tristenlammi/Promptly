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
/** The largest file a message takes (the server's limit, as the composer's). */
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

/**
 * The picture's bit rate for a video that may run ``maxSeconds`` and must
 * stay under ``maxBytes`` with its sound: as good as 2.5 Mbit/s, and never
 * so much that a full-length video would be refused. A tenth is kept back,
 * since recorders overshoot what they're asked for.
 */
export function videoBits(maxBytes: number = MAX_FILE_BYTES, maxSeconds: number = MAX_VIDEO_S): number {
  const room = Math.floor((maxBytes * 8 * 0.9) / maxSeconds) - AUDIO_BITS;
  return Math.max(250_000, Math.min(2_500_000, room));
}
export const audioBits = AUDIO_BITS;

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
