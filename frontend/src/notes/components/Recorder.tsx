import { FileAudio, Loader2, Mic, Pause, Play, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { confirm } from "@/components/shared/ConfirmDialog";
import { VoiceWaveform } from "@/components/voice/VoiceWaveform";
import { cn } from "@/utils/cn";

import { Sheet } from "./Sheet";
import { clock } from "./AudioPlayer";

/** Recordings stop at three hours, with a warning ten minutes before. */
export const MAX_MS = 3 * 3600 * 1000;
const WARN_MS = MAX_MS - 10 * 60 * 1000;
const PEAK_EVERY_MS = 100;

export interface Recording {
  file: File;
  duration_ms: number;
  peaks: number[];
}

const TYPES: [string, string][] = [
  ["audio/webm;codecs=opus", "webm"],
  ["audio/webm", "webm"],
  ["audio/mp4", "m4a"],
  ["audio/ogg;codecs=opus", "ogg"],
];

function pickType(): [string, string] | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of TYPES) if (MediaRecorder.isTypeSupported?.(t[0])) return t;
  return ["", "webm"];
}

function fileName(ext: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `Voice note ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${ext}`;
}

/** ≤200 levels from the ones measured while recording. */
function shrink(levels: number[], n = 200): number[] {
  if (!levels.length) return [];
  let out = levels;
  if (levels.length > n) {
    const step = levels.length / n;
    out = Array.from({ length: n }, (_, i) => Math.max(...levels.slice(Math.floor(i * step), Math.max(Math.floor((i + 1) * step), Math.floor(i * step) + 1))));
  }
  const top = Math.max(...out) || 1;
  return out.map((v) => Math.round(Math.min(1, (v / top) ** 0.7) * 1000) / 1000);
}

type Phase = "starting" | "recording" | "paused" | "saving" | "error";

/**
 * The record sheet: a red dot, the time, a live level, and Pause / Stop /
 * Discard. Stop puts the clip in the note straight away (it uploads in the
 * background and is kept on this device until it's in). WebM/Opus where the
 * browser can, MP4 on Safari.
 */
export function Recorder({ onSave, onFiles, onClose }: { onSave: (r: Recording) => void; onFiles: (files: File[]) => void; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const level = useRef(0);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const chunks = useRef<Blob[]>([]);
  const peaks = useRef<number[]>([]);
  const ran = useRef(0); // ms recorded before the current stretch
  const since = useRef<number | null>(null); // when the current stretch began
  const type = useRef<[string, string]>(["", "webm"]);
  const finished = useRef(false);
  const pick = useRef<HTMLInputElement>(null);

  const now = () => ran.current + (since.current !== null ? performance.now() - since.current : 0);

  const cleanup = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void ctx.current?.close().catch(() => undefined);
    ctx.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const t = pickType();
      if (!t) {
        setError("This browser can't record audio. Choose an audio file instead.");
        setPhase("error");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Recording needs a secure (https) connection to Promptly. Choose an audio file instead.");
        setPhase("error");
        return;
      }
      type.current = t;
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (e) {
        const name = (e as { name?: string })?.name;
        setError(
          name === "NotFoundError" || name === "OverconstrainedError"
            ? "No microphone was found. Plug one in and try again."
            : name === "NotReadableError"
              ? "The microphone is busy in another app. Close it there and try again."
              : "Promptly can't use your microphone. Allow it in the browser's site settings.",
        );
        setPhase("error");
        return;
      }
      if (cancelled) {
        s.getTracks().forEach((x) => x.stop());
        return;
      }
      stream.current = s;
      // The level: what the mic hears, for the ring and the waveform.
      try {
        const ac = new AudioContext();
        ctx.current = ac;
        const an = ac.createAnalyser();
        an.fftSize = 1024;
        ac.createMediaStreamSource(s).connect(an);
        const buf = new Float32Array(an.fftSize);
        let windowMax = 0;
        let last = performance.now();
        const tick = () => {
          if (!ctx.current) return;
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          const live = rec.current?.state === "recording";
          level.current = live ? Math.min(1, rms * 4) : 0;
          if (live) {
            windowMax = Math.max(windowMax, rms);
            if (performance.now() - last >= PEAK_EVERY_MS) {
              peaks.current.push(windowMax);
              windowMax = 0;
              last = performance.now();
            }
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      } catch {
        /* no level shown; recording still works */
      }
      const r = new MediaRecorder(s, t[0] ? { mimeType: t[0], audioBitsPerSecond: 48_000 } : undefined);
      rec.current = r;
      r.ondataavailable = (ev) => ev.data.size && chunks.current.push(ev.data);
      r.start(1000);
      since.current = performance.now();
      setPhase("recording");
    })();
    return () => {
      cancelled = true;
      if (rec.current && rec.current.state !== "inactive") {
        rec.current.ondataavailable = null;
        rec.current.onstop = null;
        rec.current.stop();
      }
      cleanup();
    };
  }, [cleanup]);

  const stop = useCallback(() => {
    const r = rec.current;
    if (!r || finished.current) return;
    finished.current = true;
    const duration = Math.round(now());
    since.current = null;
    ran.current = duration;
    setPhase("saving");
    r.onstop = () => {
      const mime = r.mimeType || type.current[0] || "audio/webm";
      const blob = new Blob(chunks.current, { type: mime.split(";")[0] });
      cleanup();
      if (!blob.size) {
        setError("Nothing was recorded. Check the microphone and try again.");
        setPhase("error");
        return;
      }
      const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : type.current[1];
      onSave({ file: new File([blob], fileName(ext), { type: blob.type, lastModified: Date.now() }), duration_ms: duration, peaks: shrink(peaks.current) });
    };
    if (r.state !== "inactive") r.stop();
    else r.onstop?.(new Event("stop"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanup, onSave]);

  // The clock (and the three-hour stop).
  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;
    const t = setInterval(() => {
      const ms = now();
      setElapsed(ms);
      if (ms >= MAX_MS) stop();
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, stop]);

  const pause = () => {
    const r = rec.current;
    if (!r) return;
    if (r.state === "recording") {
      r.pause();
      ran.current = now();
      since.current = null;
      setPhase("paused");
    } else if (r.state === "paused") {
      r.resume();
      since.current = performance.now();
      setPhase("recording");
    }
  };

  const discard = async () => {
    if (now() > 5000 && phase !== "error") {
      const ok = await confirm({ title: "Discard this recording?", message: "It hasn't been saved. This can't be undone.", confirmLabel: "Discard", danger: true });
      if (!ok) return;
    }
    finished.current = true;
    onClose();
  };

  const warn = elapsed >= WARN_MS;
  const big = "flex h-14 w-14 items-center justify-center rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]";

  return (
    <Sheet title="Record a voice note" onClose={() => void discard()}>
      <div className="flex flex-col items-center gap-5 py-2">
        {phase === "error" ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <Mic className="h-10 w-10 text-[var(--text-muted)] opacity-60" aria-hidden />
            <p role="alert" className="max-w-xs text-sm text-[var(--text)]">
              {error}
            </p>
          </div>
        ) : (
          <>
            <div className="relative flex h-28 w-28 items-center justify-center" aria-hidden>
              <span
                className={cn("absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--danger)_18%,transparent)] transition-transform", phase === "recording" && "animate-pulse")}
              />
              <span className={cn("relative h-14 w-14 rounded-full", phase === "paused" ? "bg-[var(--text-muted)]" : "bg-[var(--danger)]")} />
            </div>
            <p className="font-mono text-3xl tabular-nums text-[var(--text)]" aria-live="off">
              {clock(elapsed)}
            </p>
            <p className="sr-only" role="status">
              {phase === "starting" ? "Starting the microphone" : phase === "paused" ? "Paused" : phase === "saving" ? "Saving" : "Recording"}
            </p>
            <VoiceWaveform mode={phase === "recording" ? "live" : "idle"} levelRef={level} bars={28} className="h-10 w-56" barClassName="w-1 rounded-full bg-[var(--danger)]" />
            {warn && phase !== "saving" && (
              <p role="status" className="text-sm font-medium text-[var(--danger)]">
                {Math.max(0, Math.ceil((MAX_MS - elapsed) / 60000))} minutes left — recordings stop at 3 hours.
              </p>
            )}
            {phase === "starting" && <p className="text-sm text-[var(--text-muted)]">Starting the microphone…</p>}
          </>
        )}

        <div className="flex items-center gap-4">
          <button type="button" onClick={() => void discard()} aria-label="Discard" title="Discard" className={cn(big, "h-12 w-12 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]")}>
            <Trash2 className="h-5 w-5" />
          </button>
          {phase !== "error" && (
            <>
              <button
                type="button"
                data-autofocus
                onClick={stop}
                disabled={phase === "starting" || phase === "saving"}
                aria-label="Stop and save"
                title="Stop and save"
                className={cn(big, "h-16 w-16 bg-[var(--accent)] text-white shadow-[var(--shadow-md)] hover:brightness-110 disabled:opacity-50")}
              >
                {phase === "saving" ? <Loader2 className="h-6 w-6 animate-spin" /> : <Square className="h-6 w-6 fill-current" />}
              </button>
              <button
                type="button"
                onClick={pause}
                disabled={phase !== "recording" && phase !== "paused"}
                aria-label={phase === "paused" ? "Resume" : "Pause"}
                title={phase === "paused" ? "Resume" : "Pause"}
                className={cn(big, "h-12 w-12 text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40")}
              >
                {phase === "paused" ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
              </button>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => pick.current?.click()}
          disabled={phase === "saving"}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-[var(--accent-text)] hover:bg-[var(--hover)]"
        >
          <FileAudio className="h-4 w-4" aria-hidden /> Choose an audio file instead
        </button>
        <input
          ref={pick}
          type="file"
          accept="audio/*,.m4a,.mp3,.wav,.ogg,.opus,.aac,.flac,.webm"
          multiple
          hidden
          aria-label="Choose an audio file"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (!files.length) return;
            finished.current = true;
            onFiles(files);
          }}
        />
      </div>
    </Sheet>
  );
}
