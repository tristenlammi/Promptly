/**
 * Recording a voice message: the microphone, a level for the live meter, the
 * levels kept for the waveform, and the finished file. WebM/Opus where the
 * browser can (Chrome, Android, Firefox), MP4 on Safari; the server makes a
 * copy every browser plays.
 *
 * The microphone is only ever opened by ``start()``, which the composer
 * calls from a press on the mic button, and it's let go the moment the
 * recording is finished or cancelled.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface Recording {
  file: File;
  duration_ms: number;
  peaks: number[];
}

export type RecorderPhase = "idle" | "starting" | "recording";

const TYPES: [string, string][] = [
  ["audio/webm;codecs=opus", "webm"],
  ["audio/webm", "webm"],
  ["audio/mp4", "m4a"],
  ["audio/ogg;codecs=opus", "ogg"],
];
const PEAK_EVERY_MS = 100;

export function canRecord(): boolean {
  return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

function pickType(): [string, string] {
  for (const t of TYPES) if (MediaRecorder.isTypeSupported?.(t[0])) return t;
  return ["", "webm"];
}

/** Why the microphone didn't start, in plain words. */
export function micProblem(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found on this device.";
  if (name === "NotReadableError") return "The microphone is busy in another app. Close it there and try again.";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Promptly isn't allowed to use the microphone. Allow it for this site in your browser's settings, then try again.";
  return "The microphone couldn't be started. Try again.";
}

/** ≤ ``n`` levels 0–1 from the ones measured while recording. */
export function shrinkPeaks(levels: number[], n = 64): number[] {
  if (!levels.length) return [];
  let out = levels;
  if (levels.length > n) {
    const step = levels.length / n;
    out = Array.from({ length: n }, (_, i) => Math.max(...levels.slice(Math.floor(i * step), Math.max(Math.floor((i + 1) * step), Math.floor(i * step) + 1))));
  }
  const top = Math.max(...out) || 1;
  return out.map((v) => Math.round(Math.min(1, (v / top) ** 0.7) * 100) / 100);
}

export function useVoiceRecorder() {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const level = useRef(0);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const chunks = useRef<Blob[]>([]);
  const peaks = useRef<number[]>([]);
  const since = useRef(0);
  const type = useRef<[string, string]>(["", "webm"]);
  // Bumped by every start / stop / cancel: a start that finishes after a
  // cancel knows it's no longer wanted.
  const run = useRef(0);

  const release = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void ctx.current?.close().catch(() => undefined);
    ctx.current = null;
    level.current = 0;
  }, []);

  /** Open the microphone and start. Throws what ``getUserMedia`` threw. */
  const start = useCallback(async (): Promise<boolean> => {
    const mine = ++run.current;
    setPhase("starting");
    setElapsed(0);
    chunks.current = [];
    peaks.current = [];
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      if (mine === run.current) setPhase("idle");
      throw e;
    }
    if (mine !== run.current) {
      s.getTracks().forEach((t) => t.stop());
      return false;
    }
    stream.current = s;
    try {
      const ac = new AudioContext();
      ctx.current = ac;
      void ac.resume().catch(() => undefined);
      const an = ac.createAnalyser();
      an.fftSize = 1024;
      ac.createMediaStreamSource(s).connect(an);
      const buf = new Float32Array(an.fftSize);
      let windowMax = 0;
      let last = performance.now();
      const tick = () => {
        if (ctx.current !== ac) return;
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        level.current = Math.min(1, rms * 4);
        windowMax = Math.max(windowMax, rms);
        if (performance.now() - last >= PEAK_EVERY_MS) {
          peaks.current.push(windowMax);
          windowMax = 0;
          last = performance.now();
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch {
      /* no meter; the recording still works */
    }
    const t = pickType();
    type.current = t;
    const r = new MediaRecorder(s, t[0] ? { mimeType: t[0], audioBitsPerSecond: 32_000 } : undefined);
    r.ondataavailable = (ev) => ev.data.size && chunks.current.push(ev.data);
    r.start(500);
    rec.current = r;
    since.current = performance.now();
    setPhase("recording");
    return true;
  }, []);

  /** Finish: the file, its length and its waveform (null if nothing was recorded). */
  const stop = useCallback((): Promise<Recording | null> => {
    run.current++;
    const r = rec.current;
    rec.current = null;
    if (!r) {
      release();
      setPhase("idle");
      return Promise.resolve(null);
    }
    const duration = Math.round(performance.now() - since.current);
    return new Promise((resolve) => {
      const done = () => {
        const mime = (r.mimeType || type.current[0] || "audio/webm").split(";")[0];
        const blob = new Blob(chunks.current, { type: mime });
        chunks.current = [];
        release();
        setPhase("idle");
        if (!blob.size) return resolve(null);
        const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : type.current[1];
        resolve({ file: new File([blob], `Voice message.${ext}`, { type: mime, lastModified: Date.now() }), duration_ms: duration, peaks: shrinkPeaks(peaks.current) });
      };
      r.onstop = done;
      if (r.state !== "inactive") r.stop();
      else done();
    });
  }, [release]);

  /** Throw the recording away and let the microphone go. */
  const cancel = useCallback(() => {
    run.current++;
    const r = rec.current;
    rec.current = null;
    if (r && r.state !== "inactive") {
      r.ondataavailable = null;
      r.onstop = null;
      try {
        r.stop();
      } catch {
        /* already stopped */
      }
    }
    chunks.current = [];
    release();
    setPhase("idle");
  }, [release]);

  useEffect(() => {
    if (phase !== "recording") return;
    const t = window.setInterval(() => setElapsed(performance.now() - since.current), 200);
    return () => window.clearInterval(t);
  }, [phase]);

  // Leaving the page (or the room): never leave the microphone open.
  useEffect(() => cancel, [cancel]);

  return { phase, elapsed, level, start, stop, cancel };
}
