import { ChevronLeft, ChevronRight, MoreHorizontal, Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";

import type { PorchStory, StoryOverlay } from "@/api/porch";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";

import { PorchAvatar, groupsLine } from "../ui";
import { STILL_MS, agoShort } from "./look";
import { StoryFrame } from "./StoryFrame";

/** Another dialog is open on top (a sheet, a confirm): keys are theirs. */
function covered(): boolean {
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).some((el) => !el.hasAttribute("data-story-player"));
}

const HOLD_MS = 180;
const SWIPE_CLOSE_PX = 90;

/**
 * Plays a list of stories full screen: progress bars on top, tap the right
 * of the picture for the next one and the left for the one before, hold to
 * pause, swipe down (or Esc) to close. Arrows, Space and Esc on a keyboard.
 * A video plays through (sound on tap); a photo or text story stays six
 * seconds. Used for someone's stories and for a highlight.
 */
export function StoryPlayer({
  stories,
  index,
  onIndex,
  onClose,
  onDone,
  onBeforeFirst,
  onShown,
  hold = false,
  title,
  subtitle,
  menu,
  footer,
  label,
}: {
  stories: PorchStory[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** Past the last story (the next person, or close). */
  onDone: () => void;
  /** Back from the first story (the person before), if there is one. */
  onBeforeFirst?: () => void;
  /** A story's been on screen with its picture loaded (mark it seen). */
  onShown?: (s: PorchStory) => void;
  /** Something's open over the player (a sheet): stand still. */
  hold?: boolean;
  title?: ReactNode;
  subtitle?: (s: PorchStory) => ReactNode;
  /** The "…" button, when there's anything to do. */
  menu?: (s: PorchStory) => (() => void) | null;
  footer?: (s: PorchStory, ctl: { pause: (on: boolean) => void }) => ReactNode;
  label: string;
}) {
  const navigate = useNavigate();
  const isPhone = useIsMobile(767);
  const story = stories[Math.min(index, stories.length - 1)];
  const [held, setHeld] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [ready, setReady] = useState(false);
  const [muted, setMuted] = useState(true);
  const [hidden, setHidden] = useState(document.visibilityState !== "visible");
  const [typing, setTyping] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const elapsed = useRef(0);
  const shown = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const paused = held || userPaused || hold || hidden || typing;

  const next = useCallback(() => {
    if (index < stories.length - 1) onIndex(index + 1);
    else onDone();
  }, [index, stories.length, onIndex, onDone]);
  const prev = useCallback(() => {
    if (index > 0) onIndex(index - 1);
    else if (onBeforeFirst) onBeforeFirst();
    else {
      elapsed.current = 0;
      if (video.current) video.current.currentTime = 0;
    }
  }, [index, onIndex, onBeforeFirst]);

  // A new story: start its clock again once its picture is in.
  useLayoutEffect(() => {
    elapsed.current = 0;
    setReady(story?.kind === "text");
    if (bar.current) bar.current.style.width = "0%";
  }, [story?.id, story?.kind]);

  // Seen once it's been on screen with its picture.
  useEffect(() => {
    if (!story || !ready || shown.current === story.id) return;
    shown.current = story.id;
    onShown?.(story);
  }, [story, ready, onShown]);

  useEffect(() => {
    const on = () => setHidden(document.visibilityState !== "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  // The clock: a photo or text story for six seconds, a video for its length.
  useEffect(() => {
    if (!story || !ready) return;
    const v = video.current;
    if (story.media?.kind === "video" && v) {
      if (paused) v.pause();
      else void v.play().catch(() => setMuted(true));
    }
    if (paused) return;
    let last = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const dt = t - last;
      last = t;
      let p: number;
      if (story.media?.kind === "video" && v && v.duration) {
        p = v.currentTime / Math.min(v.duration, 60);
        if (v.currentTime >= 60) {
          next();
          return;
        }
      } else {
        elapsed.current += dt;
        p = elapsed.current / STILL_MS;
      }
      if (bar.current) bar.current.style.width = `${Math.min(100, p * 100)}%`;
      if (p >= 1 && story.media?.kind !== "video") {
        next();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [story, ready, paused, next]);

  // Keys: arrows, Space, Esc (unless a sheet is open on top, or you're typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (covered()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "Escape") onClose();
      else if (e.key === " ") setUserPaused((p) => !p);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [next, prev, onClose]);

  // Focus moves into the player, and back where it was afterwards.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    root.current?.focus({ preventScroll: true });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      before?.focus?.();
    };
  }, []);

  // Tap, hold and swipe on the picture.
  const press = useRef<{ x: number; y: number; t: number; timer: number } | null>(null);
  const [drag, setDrag] = useState(0);
  const onDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-story-control]")) return;
    const timer = window.setTimeout(() => setHeld(true), HOLD_MS);
    press.current = { x: e.clientX, y: e.clientY, t: Date.now(), timer };
  };
  const onMove = (e: ReactPointerEvent) => {
    const p = press.current;
    if (!p) return;
    const dy = e.clientY - p.y;
    if (dy > 12 && Math.abs(e.clientX - p.x) < dy) {
      window.clearTimeout(p.timer);
      setHeld(true);
      setDrag(dy);
    }
  };
  const onUp = (e: ReactPointerEvent) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    window.clearTimeout(p.timer);
    const wasHeld = held;
    setHeld(false);
    if (drag > 0) {
      const d = drag;
      setDrag(0);
      if (d > SWIPE_CLOSE_PX) onClose();
      return;
    }
    if (wasHeld || Date.now() - p.t > HOLD_MS) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.clientX - rect.left < rect.width * 0.3) prev();
    else next();
  };

  if (!story) return null;
  const menuFn = menu?.(story) ?? null;
  const foot = footer ? footer(story, { pause: setUserPaused }) : null;
  const isVideo = story.media?.kind === "video";
  const btn = "flex h-10 w-10 items-center justify-center rounded-full text-white/95 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";
  const openOverlay = (o: StoryOverlay) => {
    if (o.type === "mention") navigate(`/porch/u/${o.user.id}`);
    else if (o.type === "place") navigate(`/maps?q=${encodeURIComponent(o.place.name)}`);
  };

  return createPortal(
    <div
      ref={root}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-story-player
      className="fixed inset-0 z-[45] flex items-center justify-center bg-black outline-none md:bg-black/95"
      style={drag ? { background: `rgba(0,0,0,${Math.max(0.3, 1 - drag / 400)})` } : undefined}
    >
      {!isPhone && (
        <button type="button" aria-label="Previous" onClick={prev} className={cn(btn, "mr-4 h-12 w-12 bg-white/10")} data-story-control>
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}
      <div
        className={cn("relative flex h-full w-full flex-col md:h-[min(100dvh-32px,960px)] md:w-auto md:aspect-[9/16] md:overflow-hidden md:rounded-2xl", isPhone && "pt-safe pb-safe")}
        style={drag ? { transform: `translateY(${drag}px) scale(${1 - Math.min(drag, 300) / 1500})`, transition: "none" } : { transition: "transform 160ms" }}
      >
        <div
          className="relative min-h-0 flex-1 touch-none select-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => {
            if (press.current) window.clearTimeout(press.current.timer);
            press.current = null;
            setHeld(false);
            setDrag(0);
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <StoryFrame
            story={story}
            videoRef={video}
            muted={muted}
            onLoaded={() => setReady(true)}
            onEnded={next}
            onOpenOverlay={openOverlay}
            className="absolute inset-0 h-full w-full md:aspect-auto"
          />
          {/* Top: progress, who and where, controls. */}
          <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/55 to-transparent px-2 pb-6 pt-2">
            <div className="flex gap-1" aria-hidden>
              {stories.map((s, i) => (
                <span key={s.id} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/35">
                  <span ref={i === index ? bar : undefined} className="block h-full bg-white" style={{ width: i < index ? "100%" : i === index ? undefined : "0%" }} />
                </span>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2" data-story-control>
              {title ?? (
                <Link to={story.author ? `/porch/u/${story.author.id}` : "#"} className="flex min-w-0 items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
                  <PorchAvatar user={story.author} size={32} />
                  <span className="min-w-0 text-sm leading-tight text-white">
                    <span className="block truncate font-semibold">{story.mine ? "Your story" : story.author?.name ?? "Someone"}</span>
                    <span className="block truncate text-xs text-white/80">
                      {subtitle ? subtitle(story) : [story.groups.length ? `in ${groupsLine(story.groups)}` : null, agoShort(story.created_at)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </Link>
              )}
              <span className="ml-auto flex items-center">
                <button type="button" className={btn} aria-label={paused && userPaused ? "Play" : "Pause"} onClick={() => setUserPaused((p) => !p)}>
                  {userPaused ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
                </button>
                {isVideo && (
                  <button type="button" className={btn} aria-label={muted ? "Turn the sound on" : "Turn the sound off"} onClick={() => setMuted((m) => !m)}>
                    {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                  </button>
                )}
                {menuFn && (
                  <button type="button" className={btn} aria-label="More for this story" aria-haspopup="dialog" onClick={menuFn}>
                    <MoreHorizontal className="h-5 w-5" />
                  </button>
                )}
                <button type="button" className={btn} aria-label="Close" onClick={onClose}>
                  <X className="h-6 w-6" />
                </button>
              </span>
            </div>
          </div>
          {userPaused && (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden>
              <span className="rounded-full bg-black/40 p-4 text-white">
                <Pause className="h-8 w-8" />
              </span>
            </span>
          )}
          <span className="sr-only" aria-live="polite">
            {`Story ${index + 1} of ${stories.length}${story.kind === "text" ? `: ${story.text}` : story.alt_text ? `: ${story.alt_text}` : ""}`}
          </span>
        </div>
        {foot && (
          <div
            className="shrink-0 bg-black px-3 py-2 md:absolute md:inset-x-0 md:bottom-0 md:bg-transparent md:bg-gradient-to-t md:from-black/70 md:to-transparent md:pt-8"
            data-story-control
            onFocusCapture={(e) => {
              const t = e.target as HTMLElement;
              if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") setTyping(true);
            }}
            onBlurCapture={() => setTyping(false)}
          >
            {foot}
          </div>
        )}
      </div>
      {!isPhone && (
        <button type="button" aria-label="Next" onClick={next} className={cn(btn, "ml-4 h-12 w-12 bg-white/10")} data-story-control>
          <ChevronRight className="h-6 w-6" />
        </button>
      )}
    </div>,
    document.body,
  );
}
