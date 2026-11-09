/**
 * Small pieces the call screens share: people's names and pictures, the
 * call's title, a timer, a video that can pop out (picture-in-picture),
 * and the round call buttons.
 */
import { useQuery } from "@tanstack/react-query";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { roomsApi, type Bootstrap, type RoomUser } from "@/api/rooms";
import { BOOTSTRAP_KEY, dmTitle } from "@/rooms/cache";
import { UserAvatar } from "@/rooms/components/ui";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

import { SPEAKING } from "../../ui/bits";
import { useCallStore } from "../store";

/** Answer / Join green, dark enough for white text (5:1). */
export const CALL_GREEN = "#15803d";
export const CALL_RED = "#c81e1e";
/** Promptly's terracotta inside call UI (also under Rooms' own accent). */
export const CALL_ACCENT_STYLE = { "--item-accent": "var(--accent-strong, var(--accent))" } as CSSProperties;

/** Names and pictures for the call UI: Rooms' bootstrap (fetched when a
 *  call shows outside Rooms) and whoever the call itself told us about. */
export function useCallPeople(enabled: boolean): { users: Record<string, RoomUser>; b: Bootstrap | undefined } {
  const { data: b } = useQuery({ queryKey: BOOTSTRAP_KEY, queryFn: roomsApi.bootstrap, staleTime: 30_000, enabled });
  const seen = useCallStore((s) => s.users);
  const users = b ? { ...seen, ...b.users } : seen;
  return { users, b };
}

export function personOf(users: Record<string, RoomUser>, id: string | null | undefined, fallbackName = ""): RoomUser {
  return (id && users[id]) || { id: id ?? "", username: fallbackName || "Someone", avatar_url: null, color: null };
}

/** "Bob", or a group's name ("Lads", or "Bob, Cara"). */
export function callTitle(b: Bootstrap | undefined, users: Record<string, RoomUser>, roomId: string | null, peerIds: string[]): string {
  const room = b && roomId ? b.dms.find((r) => r.id === roomId) : undefined;
  if (room) return dmTitle(b, room);
  const me = useAuthStore.getState().user?.id;
  const ids = [...new Set(peerIds)].filter((id) => id !== me);
  const names = ids.map((id) => users[id]?.username).filter(Boolean) as string[];
  return names.length ? names.join(", ") : "Call";
}

/** Seconds since ``fromMs``, ticking. */
export function useElapsed(fromMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (fromMs === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [fromMs]);
  return fromMs === null ? 0 : Math.max(0, Math.round((now - fromMs) / 1000));
}

interface AttachableVideo {
  attach(el: HTMLMediaElement): HTMLMediaElement;
  detach(el: HTMLMediaElement): HTMLMediaElement;
}

export interface CallVideoHandle {
  el: HTMLVideoElement | null;
}

/** A LiveKit video track in a <video>; the handle gives the element (for
 *  picture-in-picture). */
export const CallVideo = forwardRef<CallVideoHandle, { track: AttachableVideo | null; className?: string; fit?: "contain" | "cover"; mirror?: boolean; label: string; testId?: string }>(
  function CallVideo({ track, className, fit = "cover", mirror = false, label, testId }, ref) {
    const el = useRef<HTMLVideoElement>(null);
    useImperativeHandle(ref, () => ({ get el() { return el.current; } }), []);
    useEffect(() => {
      const v = el.current;
      if (!v || !track) return;
      track.attach(v);
      return () => {
        track.detach(v);
      };
    }, [track]);
    return (
      <video
        ref={el}
        aria-label={label}
        data-testid={testId}
        className={className}
        autoPlay
        playsInline
        muted
        style={{ objectFit: fit, transform: mirror ? "scaleX(-1)" : undefined }}
      />
    );
  },
);

/** An avatar with the speaking ring. */
export function TalkingAvatar({ user, size, speaking, className }: { user: RoomUser; size: number; speaking: boolean; className?: string }) {
  return (
    <span
      className={cn("inline-flex shrink-0 rounded-full", className)}
      data-speaking={speaking ? "true" : "false"}
      style={{
        boxShadow: speaking ? `0 0 0 3px rgba(0,0,0,0.35), 0 0 0 6px ${SPEAKING}` : "0 0 0 0 transparent",
        transition: "box-shadow 140ms ease-out",
      }}
    >
      <UserAvatar user={user} size={size} />
    </span>
  );
}

/** A round call control. ``tone``: "plain" (see-through on the dark
 *  screen), "on" (white: a mic or camera that's off, like Messenger),
 *  "accent" (terracotta: sharing), "red" (hang up / decline), "green"
 *  (answer). */
export function RoundButton({
  label,
  tone = "plain",
  size = 56,
  pressed,
  onClick,
  children,
  testId,
  disabled,
  caption,
  className,
  focusFirst,
}: {
  label: string;
  tone?: "plain" | "on" | "accent" | "red" | "green";
  size?: number;
  pressed?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  testId?: string;
  disabled?: boolean;
  /** Focused when the call screen opens. */
  focusFirst?: boolean;
  /** A word under the button (the incoming sheet). */
  caption?: string;
  className?: string;
}) {
  const bg =
    tone === "red" ? CALL_RED : tone === "green" ? CALL_GREEN : tone === "accent" ? "var(--accent-strong)" : tone === "on" ? "#ffffff" : "rgba(255,255,255,0.14)";
  const fg = tone === "on" ? "#1c1917" : "#ffffff";
  const button = (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      data-call-focus={focusFirst ? "" : undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full transition-[transform,background-color] duration-150 hover:brightness-110 active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/70 disabled:opacity-40",
        tone === "plain" && "backdrop-blur-sm hover:bg-white/25",
        className,
      )}
      style={{ width: size, height: size, background: bg, color: fg }}
    >
      {children}
    </button>
  );
  if (!caption) return button;
  return (
    <span className="flex flex-col items-center gap-2">
      {button}
      <span className="text-[13px] font-medium text-white/90" aria-hidden>
        {caption}
      </span>
    </span>
  );
}
