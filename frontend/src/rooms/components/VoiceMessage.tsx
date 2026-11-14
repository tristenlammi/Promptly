import { Loader2, Pause, Play } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Attachment, VoiceMeta } from "@/api/rooms";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { clock, isPlayed, markPlayed, useVoicePlayer, voicePlayer } from "../voicePlayer";

/** ``levels`` stretched or shrunk to ``n`` bars (a gentle ripple when there are none). */
function bars(levels: number[], n: number): number[] {
  if (n <= 0) return [];
  if (!levels.length) return Array.from({ length: n }, (_, i) => 0.18 + 0.12 * Math.abs(Math.sin(i * 0.7)));
  return Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * levels.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / n));
    return Math.max(...levels.slice(a, b));
  });
}

/** A transcript older than this that never arrived isn't coming. */
const WORDS_WAIT_MS = 10 * 60_000;

/**
 * A voice message: play / pause, a waveform to tap or drag through (arrow
 * keys too), its length, and 1× / 1.5× / 2×. A dot marks one you haven't
 * played. Its words sit underneath once the server has them.
 */
export function VoiceMessage({
  messageId,
  voice,
  attachment,
  own,
  meId,
  sentAt,
}: {
  messageId: string;
  voice: VoiceMeta;
  attachment: Attachment | undefined;
  own: boolean;
  meId: string;
  sentAt: string;
}) {
  const player = useVoicePlayer();
  const wave = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(40);
  const [open, setOpen] = useState(false);
  const mine = player.id === messageId;
  const playing = mine && player.playing;
  const src = attachment ? (voice.play ? `${attachment.url}&play=1` : attachment.url) : null;
  const known = voice.duration_ms / 1000;
  const duration = known || (mine ? player.duration : 0);
  const pos = mine ? Math.min(player.pos, duration || player.pos) : 0;
  const unplayed = !own && !isPlayed(meId, messageId);
  const failed = mine && player.failed;

  useLayoutEffect(() => {
    const el = wave.current;
    if (!el) return;
    const fit = () => setCount(Math.max(14, Math.min(64, Math.floor(el.clientWidth / 5))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The playback copy arrived while this was loaded but couldn't play
  // (Safari and a Chrome recording): try again with it.
  const lastSrc = useRef(src);
  useEffect(() => {
    if (lastSrc.current === src) return;
    lastSrc.current = src;
    if (src && mine && player.failed) voicePlayer.play(messageId, src, player.pos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const levels = useMemo(() => bars(voice.peaks, count), [voice.peaks, count]);
  const done = duration ? pos / duration : 0;

  const toggle = () => {
    if (!src) return;
    if (!playing) markPlayed(meId, messageId);
    voicePlayer.toggle(messageId, src);
  };
  const seek = (sec: number) => {
    if (!src || !duration) return;
    const t = Math.max(0, Math.min(duration - 0.05, sec));
    if (mine) voicePlayer.seek(t);
    else {
      markPlayed(meId, messageId);
      voicePlayer.play(messageId, src, t);
    }
  };
  const seekAt = (clientX: number) => {
    const el = wave.current;
    if (!el || !duration) return;
    const r = el.getBoundingClientRect();
    seek(((clientX - r.left) / r.width) * duration);
  };

  const words = (voice.transcript ?? "").trim();
  const waiting = voice.state === "pending" && Date.now() - new Date(sentAt).getTime() < WORDS_WAIT_MS;
  const fill = unplayed || mine ? "bg-[var(--accent-strong)]" : "bg-[color-mix(in_srgb,var(--text)_55%,transparent)]";
  const rest = unplayed ? "bg-[color-mix(in_srgb,var(--accent)_45%,transparent)]" : "bg-[color-mix(in_srgb,var(--text)_24%,transparent)]";

  return (
    <div
      className={cn(
        "w-[min(320px,calc(100vw-7.5rem))] max-w-full rounded-2xl px-2.5 py-2",
        own ? "rounded-br-md bg-[color-mix(in_srgb,var(--accent)_22%,var(--surface))]" : "rounded-bl-md bg-[var(--surface-2)]",
      )}
      data-voice-message={messageId}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          disabled={!src}
          aria-label={playing ? "Pause voice message" : unplayed ? "Play voice message (not played yet)" : "Play voice message"}
          className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--accent-strong)] text-white transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-50 md:h-10 md:w-10"
        >
          {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="ml-0.5 h-4 w-4 fill-current" />}
          {unplayed && <span aria-hidden className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-[var(--surface-2)] bg-[var(--accent-strong)]" />}
        </button>
        <div
          ref={wave}
          role="slider"
          tabIndex={0}
          aria-label="Position in the voice message"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(pos)}
          aria-valuetext={`${clock(pos * 1000)} of ${clock(duration * 1000)}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekAt(e.clientX);
          }}
          onPointerMove={(e) => e.buttons === 1 && seekAt(e.clientX)}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 15 : 5;
            if (e.key === "ArrowRight" || e.key === "ArrowUp") seek(pos + step);
            else if (e.key === "ArrowLeft" || e.key === "ArrowDown") seek(pos - step);
            else if (e.key === "Home") seek(0);
            else if (e.key === " " || e.key === "Enter") toggle();
            else return;
            e.preventDefault();
          }}
          className="flex h-9 min-w-0 flex-1 cursor-pointer touch-none items-center gap-[2px] rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          {levels.map((v, i) => (
            <span
              key={i}
              aria-hidden
              className={cn("min-w-[2px] flex-1 rounded-full", (i + 0.5) / levels.length <= done ? fill : rest)}
              style={{ height: `${Math.max(12, Math.round(v * 100))}%` }}
            />
          ))}
        </div>
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-[var(--text-muted)]">{clock((mine && (pos > 0 || playing) ? pos : duration) * 1000)}</span>
        <button
          type="button"
          onClick={() => voicePlayer.nextSpeed()}
          aria-label={`Playback speed ${player.speed}×. Change speed`}
          title="Playback speed"
          className="flex h-9 min-w-[2.5rem] shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          {player.speed}×
        </button>
      </div>

      {failed ? (
        <p className="px-1 pt-1.5 text-xs text-[var(--text-muted)]" role="status">
          {voice.play ? "This couldn't be played here. Try again in a moment." : "Getting this ready to play on this device…"}
        </p>
      ) : words ? (
        <div className="px-1 pt-1.5">
          <p className={cn("select-text whitespace-pre-wrap break-words text-sm leading-snug text-[var(--text)]", !open && "line-clamp-3")}>{words}</p>
          <div className="mt-0.5 flex gap-3">
            {words.length > 160 && (
              <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="text-xs font-semibold text-[var(--accent-text)] hover:underline">
                {open ? "Show less" : "Show all"}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(words).then(
                  () => toast.success("Copied"),
                  () => toast.error("Couldn't copy. Select the text instead."),
                );
              }}
              className="text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text)] hover:underline"
            >
              Copy words
            </button>
          </div>
        </div>
      ) : waiting ? (
        <p className="flex items-center gap-1.5 px-1 pt-1.5 text-xs text-[var(--text-muted)]" role="status">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Writing out the words…
        </p>
      ) : voice.state === "done" ? (
        <p className="px-1 pt-1.5 text-xs text-[var(--text-muted)]">No words were heard.</p>
      ) : null}
    </div>
  );
}

/** A voice message that's still being sent. */
export function VoicePending({ duration_ms }: { duration_ms: number }) {
  return (
    <div className="flex items-center gap-2 rounded-2xl rounded-br-md bg-[color-mix(in_srgb,var(--accent)_22%,var(--surface))] px-3 py-2 text-sm text-[var(--text)]">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-strong)] text-white">
        <Play className="ml-0.5 h-3.5 w-3.5 fill-current" aria-hidden />
      </span>
      Voice message · <span className="tabular-nums">{clock(duration_ms)}</span>
    </div>
  );
}
