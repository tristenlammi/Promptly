import { AlertCircle, Copy, CloudOff, FilePlus2, Loader2, Pause, Play, RotateCcw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import type { NoteAttachment } from "../types";

/** 0:42, 12:05, 1:02:03. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const SPEEDS = [1, 1.5, 2];

/** ``levels`` stretched or shrunk to ``n`` bars. */
function bars(levels: number[] | null | undefined, n: number): number[] {
  if (n <= 0) return [];
  if (!levels?.length) return Array.from({ length: n }, (_, i) => 0.12 + 0.08 * Math.abs(Math.sin(i * 0.7)));
  return Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * levels.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / n));
    return Math.max(...levels.slice(a, b));
  });
}

/**
 * A recording in a note: play / pause, a waveform you can click or drag to
 * move through it (arrow keys too), the time, and 1× / 1.5× / 2×. Under it,
 * its words once the server has them — two lines, then "Show all", "Copy"
 * and "Add to note" — or where that's got to.
 */
export function AudioPlayer({
  att,
  editable,
  transcriptionOn,
  onRemove,
  onAddToNote,
  onRetryTranscript,
  onRetryUpload,
}: {
  att: NoteAttachment;
  editable: boolean;
  transcriptionOn: boolean;
  onRemove: () => void;
  onAddToNote: (text: string) => void;
  onRetryTranscript: () => void;
  onRetryUpload: () => void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0); // seconds
  const [mediaDur, setMediaDur] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [count, setCount] = useState(60);
  const [open, setOpen] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const src = att.urls?.play ?? att.urls?.original ?? att.local?.url ?? null;
  const known = (att.duration_ms ?? 0) / 1000;
  const duration = known || mediaDur;
  const label = att.filename ? att.filename.replace(/\.[^.]+$/, "") : "Voice note";

  useLayoutEffect(() => {
    const el = wave.current;
    if (!el) return;
    const fit = () => setCount(Math.max(16, Math.min(160, Math.floor(el.clientWidth / 4))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed]);

  // A new address for the same recording (the playback copy arrived): carry on from here.
  const lastSrc = useRef(src);
  useEffect(() => {
    const a = audio.current;
    if (!a || lastSrc.current === src) return;
    lastSrc.current = src;
    const at = a.currentTime;
    const wasPlaying = !a.paused;
    a.load();
    const go = () => {
      a.currentTime = at;
      a.playbackRate = speed;
      if (wasPlaying) void a.play().catch(() => undefined);
    };
    a.addEventListener("loadedmetadata", go, { once: true });
    setLoadError(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const toggle = () => {
    const a = audio.current;
    if (!a || !src) return;
    if (a.paused) void a.play().catch(() => setLoadError(true));
    else a.pause();
  };

  const seek = (sec: number) => {
    const a = audio.current;
    if (!a || !duration) return;
    const t = Math.max(0, Math.min(duration, sec));
    a.currentTime = t;
    setPos(t);
  };

  const seekAt = (clientX: number) => {
    const el = wave.current;
    if (!el || !duration) return;
    const r = el.getBoundingClientRect();
    seek(((clientX - r.left) / r.width) * duration);
  };

  const levels = bars(att.peaks, count);
  const done = duration ? pos / duration : 0;
  const up = att.local;
  const state = att.transcript_state;
  const words = (att.transcript ?? "").trim();

  return (
    <div className="rounded-xl bg-[color-mix(in_srgb,var(--note-text)_6%,transparent)] px-2 py-2" data-note-audio={att.id}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          disabled={!src}
          aria-label={playing ? `Pause ${label}` : `Play ${label}`}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent-strong)] text-white transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-50"
        >
          {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="ml-0.5 h-4 w-4 fill-current" />}
        </button>
        <div
          ref={wave}
          role="slider"
          tabIndex={0}
          aria-label={`Position in ${label}`}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(pos)}
          aria-valuetext={`${clock(pos * 1000)} of ${clock(duration * 1000)}`}
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            seekAt(e.clientX);
          }}
          onPointerMove={(e) => e.buttons === 1 && seekAt(e.clientX)}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 30 : 5;
            if (e.key === "ArrowRight" || e.key === "ArrowUp") seek(pos + step);
            else if (e.key === "ArrowLeft" || e.key === "ArrowDown") seek(pos - step);
            else if (e.key === "Home") seek(0);
            else if (e.key === "End") seek(duration);
            else if (e.key === " " || e.key === "Enter") toggle();
            else return;
            e.preventDefault();
          }}
          className="flex h-10 min-w-0 flex-1 cursor-pointer touch-none items-center gap-[2px] rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          {levels.map((v, i) => (
            <span
              key={i}
              aria-hidden
              className={cn("min-w-[1px] flex-1 rounded-full", (i + 0.5) / levels.length <= done ? "bg-[var(--accent-strong)]" : "bg-[color-mix(in_srgb,var(--note-text)_28%,transparent)]")}
              style={{ height: `${Math.max(8, Math.round(v * 100))}%` }}
            />
          ))}
        </div>
        <span className="shrink-0 text-xs tabular-nums note-muted">
          {pos > 0 || playing ? clock(pos * 1000) + " / " : ""}
          {duration ? clock(duration * 1000) : "–:––"}
        </span>
        <button
          type="button"
          onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
          aria-label={`Playback speed ${speed}×`}
          title="Playback speed"
          className="h-8 shrink-0 rounded-full px-2 text-xs font-semibold tabular-nums note-hover"
        >
          {speed}×
        </button>
        {editable && (
          <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} title="Remove recording" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full note-muted note-hover hover:text-[var(--note-text)]">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {src && (
        <audio
          ref={audio}
          src={src}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPos(0);
          }}
          onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d)) setMediaDur(d);
            e.currentTarget.playbackRate = speed;
          }}
          onError={() => setLoadError(true)}
        />
      )}

      <div className="px-1 pt-1.5 text-sm">
        {up ? (
          up.state === "failed" ? (
            <p className="flex flex-wrap items-center gap-2 text-[var(--danger)]" role="alert">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
              <span>Couldn't upload{up.error ? `: ${up.error}` : "."}</span>
              <button type="button" onClick={onRetryUpload} className="rounded-full px-2 py-0.5 font-medium text-[var(--note-text)] note-hover">
                Try again
              </button>
            </p>
          ) : up.state === "waiting" ? (
            <p className="flex items-center gap-2 note-muted">
              <CloudOff className="h-4 w-4 shrink-0" aria-hidden /> Waiting for a connection — the recording is kept on this device.
            </p>
          ) : (
            <p className="flex items-center gap-2 note-muted" role="status">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden /> Uploading… {Math.round(up.progress * 100)}%
            </p>
          )
        ) : loadError ? (
          <p className="note-muted">Couldn't play this recording here. Reopen the note to try again.</p>
        ) : state === "pending" || state === "working" ? (
          <p className="flex items-center gap-2 note-muted" role="status">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden /> Transcribing…
          </p>
        ) : state === "failed" ? (
          <p className="flex flex-wrap items-center gap-2 note-muted">
            Couldn't transcribe —
            {editable && transcriptionOn ? (
              <button type="button" onClick={onRetryTranscript} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-[var(--note-text)] note-hover">
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Try again
              </button>
            ) : (
              <span>try again later.</span>
            )}
          </p>
        ) : state === "off" ? (
          <p className="flex flex-wrap items-center gap-2 note-muted">
            {transcriptionOn ? (
              <>
                Not transcribed yet.
                {editable && (
                  <button type="button" onClick={onRetryTranscript} className="rounded-full px-2 py-0.5 font-medium text-[var(--note-text)] note-hover">
                    Transcribe
                  </button>
                )}
              </>
            ) : (
              "Transcription is off on this server."
            )}
          </p>
        ) : state === "done" && !words ? (
          <p className="note-muted">No words were heard in this recording.</p>
        ) : words ? (
          <div>
            <p className={cn("whitespace-pre-wrap break-words leading-relaxed", !open && "note-clamp")} style={open ? undefined : { WebkitLineClamp: 2 }}>
              {words}
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {words.length > 140 && (
                <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="rounded-full px-2 py-1 text-xs font-medium note-hover">
                  {open ? "Show less" : "Show all"}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(words).then(
                    () => toast.success("Transcript copied"),
                    () => toast.error("Couldn't copy. Select the text instead."),
                  );
                }}
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium note-hover"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden /> Copy
              </button>
              {editable && (
                <button type="button" onClick={() => onAddToNote(words)} className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium note-hover">
                  <FilePlus2 className="h-3.5 w-3.5" aria-hidden /> Add to note
                </button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
