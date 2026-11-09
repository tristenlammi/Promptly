import { ChevronLeft, ChevronRight, Heart, ImageOff, Loader2, Play, UserRound, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { thumbHashToDataURL } from "thumbhash";

import type { PorchMedia } from "@/api/porch";
import { cn } from "@/utils/cn";

function blur(hash: string | null): string | undefined {
  if (!hash) return undefined;
  try {
    return thumbHashToDataURL(Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/** The frame takes the first photo's shape, kept between 4:5 and 1.91:1. */
export function frameRatio(media: PorchMedia[]): number {
  const first = media[0];
  if (!first?.width || !first?.height) return 1;
  return Math.min(1.91, Math.max(0.8, first.width / first.height));
}

/**
 * A post's photos and videos: swipe (or the arrows) between them, with dots
 * and "2/6". Each one fits inside the frame on the surface colour, over its
 * ThumbHash blur while it loads. Videos play muted when mostly on screen;
 * tap for sound.
 */
export function MediaCarousel({
  media,
  label,
  className,
  onDoubleTap,
}: {
  media: PorchMedia[];
  label: string;
  className?: string;
  /** Double-tap (or double-click) a photo: ❤️ it. */
  onDoubleTap?: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const [burst, setBurst] = useState(0);
  const [showTags, setShowTags] = useState(false);
  const lastTap = useRef(0);
  const tap = () => {
    if (!onDoubleTap) return;
    const now = Date.now();
    if (now - lastTap.current < 320) {
      lastTap.current = 0;
      setBurst((b) => b + 1);
      onDoubleTap();
    } else {
      lastTap.current = now;
    }
  };
  const tags = media[at]?.tags ?? [];
  const ratio = useMemo(() => frameRatio(media), [media]);
  const n = media.length;

  const onScroll = useCallback(() => {
    const el = track.current;
    if (!el || !el.clientWidth) return;
    setAt(Math.max(0, Math.min(n - 1, Math.round(el.scrollLeft / el.clientWidth))));
  }, [n]);

  const go = (i: number) => {
    const el = track.current;
    if (!el) return;
    const to = Math.max(0, Math.min(n - 1, i));
    el.scrollTo({ left: to * el.clientWidth, behavior: "smooth" });
  };

  if (n === 0) return null;
  return (
    <div
      role="group"
      aria-roledescription="carousel"
      aria-label={label}
      className={cn("group/carousel relative w-full overflow-hidden bg-[var(--surface-2)]", className)}
      style={{ aspectRatio: String(ratio) }}
      onKeyDown={(e) => {
        if (n < 2) return;
        if (e.key === "ArrowRight") {
          e.preventDefault();
          go(at + 1);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          go(at - 1);
        }
      }}
    >
      <div
        ref={track}
        onScroll={onScroll}
        tabIndex={n > 1 ? 0 : undefined}
        className="flex h-full w-full snap-x focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)] snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {media.map((m, i) => (
          <div
            key={m.id}
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${n}`}
            className="relative h-full w-full shrink-0 snap-center"
          >
            {m.kind === "video" ? (
              <VideoSlide m={m} active={i === at} />
            ) : (
              <div className="h-full w-full select-none" onClick={tap}>
                <PhotoSlide m={m} index={i} total={n} />
                {showTags && <TagLabels m={m} />}
              </div>
            )}
          </div>
        ))}
      </div>
      {burst > 0 && (
        <span key={burst} aria-hidden className="porch-heart-burst pointer-events-none absolute inset-0 m-auto flex h-24 w-24 items-center justify-center text-white drop-shadow-[0_2px_8px_rgba(0,0,0,.45)]">
          <Heart className="h-24 w-24 fill-white" />
        </span>
      )}
      {tags.length > 0 && media[at]?.kind !== "video" && (
        <button
          type="button"
          aria-pressed={showTags}
          aria-label={showTags ? "Hide who's in this photo" : `Show who's in this photo (${tags.length})`}
          onClick={() => setShowTags((v) => !v)}
          className="absolute bottom-3 left-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <UserRound className="h-4 w-4" aria-hidden />
        </button>
      )}
      {n > 1 && (
        <>
          <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium tabular-nums text-white" aria-hidden>
            {at + 1}/{n}
          </span>
          <button
            type="button"
            aria-label="Previous photo"
            onClick={() => go(at - 1)}
            disabled={at === 0}
            className="absolute left-2 top-1/2 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition focus-visible:opacity-100 disabled:hidden group-hover/carousel:opacity-100 md:flex"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            aria-label="Next photo"
            onClick={() => go(at + 1)}
            disabled={at === n - 1}
            className="absolute right-2 top-1/2 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition focus-visible:opacity-100 disabled:hidden group-hover/carousel:opacity-100 md:flex"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center gap-1.5" aria-hidden>
            {media.map((m, i) => (
              <span key={m.id} className={cn("h-1.5 w-1.5 rounded-full transition", i === at ? "bg-white" : "bg-white/50")} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Who's tagged on a photo, at their spots. The author also sees who
 *  hasn't said yes yet. */
function TagLabels({ m }: { m: PorchMedia }) {
  return (
    <ul aria-label="Tagged in this photo" className="pointer-events-none absolute inset-0">
      {m.tags.map((t) => (
        <li key={t.id} className="absolute" style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%` }}>
          <Link
            to={`/porch/u/${t.user.id}`}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "pointer-events-auto absolute left-0 top-0 -translate-x-1/2 translate-y-1 whitespace-nowrap rounded-lg px-2 py-1 text-xs font-semibold text-white shadow-[var(--shadow-md)]",
              t.status === "approved" ? "bg-black/75" : "border border-dashed border-white/80 bg-black/55",
            )}
          >
            {t.user.name}
            {t.status === "pending" && <span className="font-normal"> · waiting for their OK</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function PhotoSlide({ m, index, total }: { m: PorchMedia; index: number; total: number }) {
  const bg = useMemo(() => blur(m.thumbhash), [m.thumbhash]);
  const [failed, setFailed] = useState(false);
  const src = m.preview ?? m.thumb;
  const tagged = (m.tags ?? []).filter((t) => t.status === "approved").map((t) => t.user.name);
  const alt = (m.alt_text || (total > 1 ? `Photo ${index + 1} of ${total}` : "Photo")) + (tagged.length ? `. With ${tagged.join(", ")}.` : "");
  return (
    <div className="flex h-full w-full items-center justify-center bg-cover bg-center" style={bg ? { backgroundImage: `url(${bg})` } : undefined}>
      {src && !failed ? (
        <img
          src={src}
          alt={alt}
          loading={index === 0 ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="h-full w-full select-none object-contain"
        />
      ) : (
        <span role="img" aria-label={failed ? "This photo couldn't be shown" : "This photo is still being prepared"} className="flex flex-col items-center gap-2 rounded-xl bg-black/45 px-3 py-2 text-xs text-white">
          {failed ? <ImageOff className="h-5 w-5" /> : <Loader2 className="h-5 w-5 animate-spin" />}
          {failed ? "Couldn't show this photo" : "Getting the photo ready…"}
        </span>
      )}
    </div>
  );
}

function VideoSlide({ m, active }: { m: PorchMedia; active: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [muted, setMuted] = useState(true);
  const [started, setStarted] = useState(false);
  const bg = useMemo(() => blur(m.thumbhash), [m.thumbhash]);

  // Plays muted when two-thirds on screen (and the slide showing); pauses otherwise.
  useEffect(() => {
    const el = box.current;
    const v = ref.current;
    if (!el || !v || !m.video) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && e.intersectionRatio >= 0.66 && active && !reduce) {
          void v.play().then(() => setStarted(true), () => undefined);
        } else {
          v.pause();
        }
      },
      { threshold: [0, 0.66, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [m.video, active]);

  if (!m.video) {
    return (
      <div ref={box} className="flex h-full w-full items-center justify-center bg-cover bg-center" style={m.poster ? { backgroundImage: `url(${m.poster})` } : bg ? { backgroundImage: `url(${bg})` } : undefined}>
        <span role="img" aria-label="This video is still being prepared" className="flex items-center gap-2 rounded-xl bg-black/55 px-3 py-2 text-xs text-white">
          <Loader2 className="h-4 w-4 animate-spin" /> Getting the video ready…
        </span>
      </div>
    );
  }
  return (
    <div ref={box} className="relative h-full w-full bg-black">
      <video
        ref={ref}
        src={m.video}
        poster={m.poster ?? undefined}
        muted={muted}
        loop
        playsInline
        preload="metadata"
        aria-label={m.alt_text || "Video"}
        controls={started && !muted}
        className="h-full w-full object-contain"
        onPlay={() => setStarted(true)}
      />
      {muted && (
        <button
          type="button"
          onClick={() => {
            setMuted(false);
            const v = ref.current;
            if (v) {
              v.muted = false;
              void v.play().catch(() => undefined);
            }
          }}
          aria-label={started ? "Turn the sound on" : "Play video"}
          className="absolute inset-0 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
        >
          {!started && (
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/55 text-white">
              <Play className="h-7 w-7 translate-x-0.5" />
            </span>
          )}
          <span className="absolute bottom-3 right-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white">
            <VolumeX className="h-4 w-4" />
          </span>
        </button>
      )}
      {!muted && !started && (
        <span className="pointer-events-none absolute bottom-3 right-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white">
          <Volume2 className="h-4 w-4" />
        </span>
      )}
    </div>
  );
}
