import { ImageOff, Loader2 } from "lucide-react";
import { useMemo, useState, type ReactNode, type Ref } from "react";
import { thumbHashToDataURL } from "thumbhash";

import type { PorchStory, StoryOverlay } from "@/api/porch";
import { cn } from "@/utils/cn";

import { BACKGROUND_LOOK } from "./look";
import { OverlayView } from "./OverlayLayer";

function blur(hash: string | null | undefined): string | undefined {
  if (!hash) return undefined;
  try {
    return thumbHashToDataURL(Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/** A text story's words on its colour (sized to fit, like a big caption). */
export function TextFace({ text, background, className }: { text: string; background: PorchStory["background"]; className?: string }) {
  const look = BACKGROUND_LOOK[background ?? "sunset"];
  const n = text.length;
  // Fewer words, bigger letters.
  const size = n < 40 ? 9 : n < 90 ? 7.2 : n < 180 ? 5.8 : 4.8;
  return (
    <div
      className={cn("absolute inset-0 flex items-center justify-center px-[8cqw]", className)}
      style={{ background: look.css, containerType: "inline-size" }}
    >
      <p
        className={cn("whitespace-pre-wrap break-words text-center font-bold leading-tight", look.dark ? "text-[#2A2118]" : "text-white")}
        style={{ fontSize: `${size}cqw`, textShadow: look.dark ? undefined : "0 1px 2px rgba(0,0,0,.25)" }}
      >
        {text}
      </p>
    </div>
  );
}

/**
 * One story drawn in its 9:16 frame: the photo (its crop already applied),
 * the video, or a text story's words on its colour — and the stickers on
 * top. Used by the viewer, the archive and highlights.
 */
export function StoryFrame({
  story,
  overlays,
  videoRef,
  muted = true,
  onLoaded,
  onEnded,
  onOpenOverlay,
  small = false,
  className,
  children,
}: {
  story: PorchStory;
  /** Stickers to draw (default: the story's). */
  overlays?: StoryOverlay[];
  videoRef?: Ref<HTMLVideoElement>;
  muted?: boolean;
  /** The picture or video is ready (the viewer starts its clock). */
  onLoaded?: () => void;
  onEnded?: () => void;
  onOpenOverlay?: (o: StoryOverlay) => void;
  /** A tile (archive, highlights): the small picture, no video. */
  small?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const m = story.media;
  const [failed, setFailed] = useState(false);
  const bg = useMemo(() => blur(m?.thumbhash), [m?.thumbhash]);
  const src = m ? (small ? m.thumb ?? m.poster : m.preview ?? m.poster) : null;
  const label = story.kind === "text" ? story.text : story.alt_text || (story.kind === "video" ? "A video" : "A photo");

  let face: ReactNode;
  if (story.kind === "text") {
    face = <TextFace text={story.text} background={story.background} />;
  } else if (!m || failed) {
    face = (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-neutral-800 text-sm text-white/80">
        <ImageOff className="h-6 w-6" aria-hidden />
        {m ? "Couldn't load this" : "Photo removed"}
      </div>
    );
  } else if (m.kind === "video" && !small) {
    face = m.video ? (
      <video
        ref={videoRef}
        key={story.id}
        src={m.video}
        poster={m.poster ?? undefined}
        playsInline
        muted={muted}
        preload="auto"
        onCanPlay={onLoaded}
        onEnded={onEnded}
        onError={() => setFailed(true)}
        className="absolute inset-0 h-full w-full object-contain"
        aria-label={label}
      />
    ) : (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white/80">
        <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        Getting the video ready…
      </div>
    );
  } else {
    face = src ? (
      <img
        key={src}
        src={src}
        alt={label}
        draggable={false}
        onLoad={onLoaded}
        onError={() => setFailed(true)}
        className="absolute inset-0 h-full w-full select-none object-contain"
      />
    ) : (
      <div className="absolute inset-0 flex items-center justify-center text-white/80">
        <Loader2 className="h-6 w-6 animate-spin" aria-label="Getting the photo ready" />
      </div>
    );
  }

  return (
    <div
      className={cn("relative aspect-[9/16] overflow-hidden bg-neutral-900 bg-cover bg-center", className)}
      style={bg && story.kind !== "text" ? { backgroundImage: `url(${bg})` } : undefined}
      role={story.kind === "text" ? "img" : undefined}
      aria-label={story.kind === "text" ? label : undefined}
    >
      {face}
      <OverlayView overlays={overlays ?? story.overlays} onOpen={onOpenOverlay} />
      {children}
    </div>
  );
}
