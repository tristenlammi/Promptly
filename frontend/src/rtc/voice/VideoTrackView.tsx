/**
 * Shows a LiveKit video track (a camera or a Go Live stream) in a <video>,
 * attaching on mount and detaching on unmount, so adaptive streaming knows
 * how big it's drawn.
 */
import { useEffect, useRef } from "react";

interface AttachableVideo {
  attach(el: HTMLMediaElement): HTMLMediaElement;
  detach(el: HTMLMediaElement): HTMLMediaElement;
}

export function VideoTrackView({
  track,
  className,
  fit = "contain",
  mirror = false,
  label,
}: {
  track: AttachableVideo | null;
  className?: string;
  fit?: "contain" | "cover";
  /** Your own camera reads more naturally mirrored. */
  mirror?: boolean;
  label: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return (
    <video
      ref={ref}
      aria-label={label}
      className={className}
      autoPlay
      playsInline
      muted
      style={{ objectFit: fit, transform: mirror ? "scaleX(-1)" : undefined }}
    />
  );
}
