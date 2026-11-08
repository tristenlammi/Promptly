/**
 * Small pieces the voice UI repeats: an avatar with the speaking ring,
 * the mute / deafen / camera / LIVE icons, the signal bars.
 */
import { HeadphoneOff, MicOff, Signal, SignalHigh, SignalLow, SignalMedium, Video } from "lucide-react";
import type { CSSProperties } from "react";

import type { RoomUser } from "@/api/rooms";
import type { VoiceMember } from "@/api/voiceChannels";
import { UserAvatar } from "@/rooms/components/ui";
import { cn } from "@/utils/cn";

import type { VoiceConnectionInfo } from "../voice/store";

/** Discord's speaking green: the ring everyone recognises. */
export const SPEAKING = "#23a55a";
export const ACCENT = "var(--item-accent, var(--accent))";

export function VoiceAvatar({
  user,
  size = 24,
  speaking,
  className,
  ringGap = 2,
}: {
  user: RoomUser | undefined;
  size?: number;
  speaking: boolean;
  className?: string;
  /** Space between the avatar and the ring (the background shows). */
  ringGap?: number;
}) {
  const style: CSSProperties = {
    boxShadow: speaking ? `0 0 0 ${ringGap}px var(--voice-ring-gap, var(--surface)), 0 0 0 ${ringGap + 2}px ${SPEAKING}` : "none",
    transition: "box-shadow 120ms ease-out",
  };
  return (
    <span className={cn("inline-flex shrink-0 rounded-full", className)} style={style} data-speaking={speaking ? "true" : "false"}>
      <UserAvatar user={user} size={size} />
    </span>
  );
}

/** Muted, deafened (red when an admin did it), camera, LIVE. */
export function MemberIcons({ m, className, size = 14 }: { m: VoiceMember; className?: string; size?: number }) {
  const s = { width: size, height: size };
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-[var(--text-muted)]", className)}>
      {m.video && (
        <span title="Camera on" aria-label="Camera on" role="img">
          <Video style={s} />
        </span>
      )}
      {m.live && (
        <span
          className="rounded-[4px] bg-[var(--danger)] px-1 text-[9px] font-bold uppercase leading-[14px] tracking-wide text-white"
          title="Live: streaming"
          aria-label="Live"
          role="img"
        >
          Live
        </span>
      )}
      {(m.server_muted || m.muted) && !m.server_deafened && !m.deafened && (
        <span
          title={m.server_muted ? "Muted by an admin" : "Muted"}
          aria-label={m.server_muted ? "Muted by an admin" : "Muted"}
          role="img"
          className={m.server_muted ? "text-[var(--danger)]" : undefined}
        >
          <MicOff style={s} />
        </span>
      )}
      {(m.server_deafened || m.deafened) && (
        <span
          title={m.server_deafened ? "Deafened by an admin" : "Deafened"}
          aria-label={m.server_deafened ? "Deafened by an admin" : "Deafened"}
          role="img"
          className={m.server_deafened ? "text-[var(--danger)]" : undefined}
        >
          <HeadphoneOff style={s} />
        </span>
      )}
    </span>
  );
}

export type SignalLevel = "good" | "fair" | "poor" | "unknown";

export function signalLevel(c: VoiceConnectionInfo): SignalLevel {
  if (c.quality === "lost" || c.quality === "poor" || (c.lossPct ?? 0) >= 5 || (c.rttMs ?? 0) >= 400) return "poor";
  if (c.quality === "good" || (c.lossPct ?? 0) >= 1 || (c.rttMs ?? 0) >= 150) return "fair";
  if (c.quality === "excellent" || c.rttMs !== null) return "good";
  return "unknown";
}

export const SIGNAL_COLOR: Record<SignalLevel, string> = {
  good: "var(--success)",
  fair: "var(--warning)",
  poor: "var(--danger)",
  unknown: "var(--text-muted)",
};

export function SignalIcon({ level, className }: { level: SignalLevel; className?: string }) {
  const Icon = level === "good" ? SignalHigh : level === "fair" ? SignalMedium : level === "poor" ? SignalLow : Signal;
  return <Icon className={cn("h-4 w-4", className)} style={{ color: SIGNAL_COLOR[level] }} aria-hidden />;
}

/** A row of tiny avatars for a channel (the mini panel, Today). */
export function AvatarStack({ users, max = 5, size = 20 }: { users: (RoomUser | undefined)[]; max?: number; size?: number }) {
  const shown = users.slice(0, max);
  const more = users.length - shown.length;
  return (
    <span className="flex items-center">
      {shown.map((u, i) => (
        <span key={u?.id ?? i} className={cn("rounded-full ring-2 ring-[var(--surface)]", i > 0 && "-ml-1.5")}>
          <UserAvatar user={u} size={size} />
        </span>
      ))}
      {more > 0 && <span className="ml-1 text-[11px] font-medium text-[var(--text-muted)]">+{more}</span>}
    </span>
  );
}
