import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronUp, Loader2, Lock, Mic, RotateCw, SendHorizontal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { roomsApi } from "@/api/rooms";
import { VoiceWaveform } from "@/components/voice/VoiceWaveform";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { sendMessage } from "../actions";
import { clock } from "../voicePlayer";
import { micProblem, useVoiceRecorder, type Recording } from "../voiceRecorder";

/** Slide this far left to cancel, this far up to lock (hands-free). */
const CANCEL_PX = 90;
const LOCK_PX = 64;
/** A press shorter than this is a tap: it records hands-free until you send. */
const TAP_MS = 350;
/** If the microphone took this long to start (the browser was asking), the
 *  press that started it is long gone: don't record on its behalf. */
const SLOW_START_MS = 900;
const TOO_SHORT_MS = 600;

type Mode = "idle" | "hold" | "locked" | "sending" | "failed";

/**
 * The composer's mic button, where Send sits while the box is empty.
 *
 * - **Hold** to record; let go to send. Slide left to cancel, slide up to
 *   lock it so you can let go and keep talking.
 * - **Tap** (or press Enter on it) to record hands-free; Send or the bin
 *   finishes. Escape cancels.
 *
 * While it's recording, a bar covers the rest of the composer row with the
 * time and a live level. The recording uploads, then goes as a normal
 * message, so a bad connection retries it like any other.
 */
export function VoiceButton({
  roomId,
  replyToId,
  onSent,
  onActive,
  maxSeconds,
  className,
}: {
  roomId: string;
  replyToId: string | null;
  /** The message is on its way (clear the reply it answered). */
  onSent: () => void;
  /** Recording or sending: the composer keeps this button mounted. */
  onActive: (active: boolean) => void;
  maxSeconds: number;
  className: string;
}) {
  const qc = useQueryClient();
  const recorder = useVoiceRecorder();
  const [mode, setMode] = useState<Mode>("idle");
  const [slide, setSlide] = useState({ x: 0, y: 0 });
  const modeRef = useRef<Mode>("idle");
  const press = useRef<{ x: number; y: number; at: number; released: boolean } | null>(null);
  const tapToSend = useRef(false);
  const kept = useRef<{ rec: Recording; replyToId: string | null } | null>(null);
  const reply = useRef(replyToId);
  reply.current = replyToId;

  const go = useCallback(
    (m: Mode) => {
      modeRef.current = m;
      setMode(m);
      onActive(m !== "idle");
    },
    [onActive],
  );

  const upload = useCallback(
    async (rec: Recording, replyTo: string | null) => {
      go("sending");
      try {
        const att = await roomsApi.upload(roomId, rec.file);
        kept.current = null;
        go("idle");
        onSent();
        void sendMessage(qc, roomId, {
          body: `\u{1F3A4} ${clock(rec.duration_ms)}`,
          reply_to_id: replyTo,
          attachments: [att],
          voice: { attachment_id: att.id, duration_ms: rec.duration_ms, peaks: rec.peaks },
        });
      } catch (err) {
        kept.current = { rec, replyToId: replyTo };
        go("failed");
        toast.error(apiErrorMessage(err, "Your voice message didn't upload. Try again."));
      }
    },
    [go, onSent, qc, roomId],
  );

  const finish = useCallback(async () => {
    const m = modeRef.current;
    if (m !== "hold" && m !== "locked") return;
    go("sending");
    const rec = await recorder.stop();
    if (!rec || rec.duration_ms < TOO_SHORT_MS) {
      go("idle");
      toast.info("Hold the mic to record, or tap it to record hands-free.");
      return;
    }
    await upload(rec, reply.current);
  }, [go, recorder, upload]);

  const cancel = useCallback(() => {
    recorder.cancel();
    kept.current = null;
    press.current = null;
    setSlide({ x: 0, y: 0 });
    go("idle");
  }, [go, recorder]);

  const begin = useCallback(
    async (held: boolean) => {
      if (modeRef.current !== "idle") return;
      const startedAt = performance.now();
      go(held ? "hold" : "locked");
      setSlide({ x: 0, y: 0 });
      try {
        const ok = await recorder.start();
        if (!ok) return;
      } catch (e) {
        press.current = null;
        go("idle");
        toast.error(micProblem(e));
        return;
      }
      const p = press.current;
      if (held && p?.released) {
        // Let go before the microphone was ready.
        if (performance.now() - startedAt > SLOW_START_MS) {
          recorder.cancel();
          go("idle");
          toast.info("The microphone is ready. Hold the mic to record, or tap it.");
        } else {
          go("locked");
        }
      }
      navigator.vibrate?.(10);
    },
    [go, recorder],
  );

  // The length limit: it's sent as it stands.
  useEffect(() => {
    if (recorder.phase === "recording" && recorder.elapsed >= maxSeconds * 1000 && (mode === "hold" || mode === "locked")) {
      toast.info(`Voice messages stop at ${maxSeconds % 60 === 0 ? `${maxSeconds / 60} min` : `${maxSeconds} s`}, so that one has been sent.`);
      void finish();
    }
  }, [recorder.phase, recorder.elapsed, maxSeconds, mode, finish]);

  // Escape cancels a recording.
  useEffect(() => {
    if (mode !== "hold" && mode !== "locked") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mode, cancel]);

  // Another room: whatever was being recorded here is dropped.
  const lastRoom = useRef(roomId);
  useEffect(() => {
    if (lastRoom.current !== roomId) {
      lastRoom.current = roomId;
      if (modeRef.current !== "idle") cancel();
    }
  }, [roomId, cancel]);
  useEffect(() => () => onActive(false), [onActive]);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    if (mode === "locked") {
      tapToSend.current = true;
      return;
    }
    if (mode !== "idle") return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the gesture still works without it */
    }
    press.current = { x: e.clientX, y: e.clientY, at: performance.now(), released: false };
    void begin(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || p.released || modeRef.current !== "hold") return;
    const x = Math.min(0, e.clientX - p.x);
    const y = Math.min(0, e.clientY - p.y);
    if (x <= -CANCEL_PX) {
      navigator.vibrate?.(15);
      cancel();
    } else if (y <= -LOCK_PX) {
      navigator.vibrate?.(10);
      press.current = null;
      setSlide({ x: 0, y: 0 });
      go("locked");
    } else setSlide({ x, y });
  };
  const onPointerUp = () => {
    if (tapToSend.current) {
      tapToSend.current = false;
      if (modeRef.current === "locked") void finish();
      return;
    }
    const p = press.current;
    if (!p || p.released) return;
    p.released = true;
    setSlide({ x: 0, y: 0 });
    if (modeRef.current !== "hold") return;
    if (recorder.phase !== "recording") return; // ``begin`` decides when the mic is ready
    if (performance.now() - p.at < TAP_MS) go("locked");
    else void finish();
  };
  const onPointerCancel = () => {
    // The browser took the gesture (a scroll, a call): keep what's recorded.
    const p = press.current;
    if (p && !p.released) {
      p.released = true;
      setSlide({ x: 0, y: 0 });
      if (modeRef.current === "hold" && recorder.phase === "recording") go("locked");
    }
  };
  // The keyboard (and assistive tech): a click with no pointer behind it.
  const onClick = (e: React.MouseEvent) => {
    if (e.detail !== 0) return;
    if (mode === "idle") void begin(false);
    else if (mode === "locked") void finish();
  };

  const active = mode !== "idle";
  const recording = mode === "hold" || mode === "locked";
  const left = maxSeconds * 1000 - recorder.elapsed;
  const round = "flex h-9 w-9 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

  return (
    <>
      {active && (
        <div
          className="absolute inset-y-0 left-0 right-11 z-10 flex items-center gap-2 rounded-l-2xl bg-[var(--surface)] pl-2 pr-1 md:right-10"
          role="group"
          aria-label="Voice message"
        >
          {mode === "failed" ? (
            <>
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--danger)]" role="alert">
                Didn't upload.
              </span>
              <button
                type="button"
                onClick={() => kept.current && void upload(kept.current.rec, kept.current.replyToId)}
                className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-[var(--accent-text)] hover:bg-[var(--hover)]"
              >
                <RotateCw className="h-4 w-4" aria-hidden /> Try again
              </button>
              <button type="button" onClick={cancel} aria-label="Discard the voice message" className={cn(round, "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]")}>
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          ) : mode === "sending" ? (
            <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-[var(--text-muted)]" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Sending your voice message…
            </span>
          ) : (
            <>
              {mode === "locked" && (
                <button type="button" onClick={cancel} aria-label="Cancel the recording" title="Cancel" className={cn(round, "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]")}>
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              <span aria-hidden className={cn("ml-1 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--danger)]", recorder.phase === "recording" && "animate-pulse")} />
              <span className={cn("shrink-0 text-sm tabular-nums", left < 15_000 ? "font-semibold text-[var(--danger)]" : "text-[var(--text)]")} aria-live="off">
                {recorder.phase === "starting" ? "…" : clock(recorder.elapsed)}
              </span>
              <VoiceWaveform mode={recorder.phase === "recording" ? "live" : "idle"} levelRef={recorder.level} bars={18} className="h-6 min-w-0 flex-1" barClassName="w-[3px] rounded-full bg-[var(--danger)]" />
              {mode === "hold" ? (
                <span
                  className="flex shrink-0 items-center gap-1 pr-3 text-xs text-[var(--text-muted)]"
                  style={{ transform: `translateX(${slide.x * 0.6}px)`, opacity: Math.max(0.25, 1 + slide.x / CANCEL_PX) }}
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Slide to cancel
                </span>
              ) : (
                <span className="shrink-0 pr-2 text-xs text-[var(--text-muted)]">Recording</span>
              )}
              <span className="sr-only" role="status">
                {recorder.phase === "starting" ? "Starting the microphone" : mode === "locked" ? "Recording. Press Send when you're done, or Escape to cancel." : "Recording. Let go to send."}
              </span>
            </>
          )}
        </div>
      )}
      {mode === "hold" && (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-full right-1 z-10 mb-2 flex flex-col items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-[var(--text-muted)] shadow-[var(--shadow-md)]"
          style={{ transform: `translateY(${slide.y * 0.5}px)` }}
        >
          <Lock className="h-4 w-4" />
          <ChevronUp className="h-3.5 w-3.5" />
        </span>
      )}
      <button
        type="button"
        aria-label={mode === "locked" ? "Send voice message" : recording ? "Recording. Let go to send" : "Record a voice message"}
        title={mode === "idle" ? "Hold to record, or tap to record hands-free" : undefined}
        disabled={mode === "sending" || mode === "failed"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={onClick}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          className,
          "relative z-10 touch-none select-none [-webkit-touch-callout:none]",
          recording ? "!bg-[var(--accent-strong)] !text-white" : "!text-[var(--accent-text)]",
          mode === "hold" && "scale-110",
          (mode === "sending" || mode === "failed") && "opacity-40",
        )}
      >
        {mode === "locked" ? <SendHorizontal className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
      </button>
    </>
  );
}
