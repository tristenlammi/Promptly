/**
 * On a phone, while you're in voice: a slim bar at the top of every Rooms
 * screen (and Promptly's phone headers) — "🔊 Lounge · 3 · tap to return"
 * — with Mute and Leave right there.
 */
import { MicOff, Mic, PhoneOff, Volume2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { cn } from "@/utils/cn";

import { voice } from "../voice/actions";
import { useVoice } from "../voice/hooks";
import { findChannel, useChannelMembers, useRoomsBootstrap } from "./directory";

export function VoicePill({ hideFor, className }: { hideFor?: string | null; className?: string }) {
  const navigate = useNavigate();
  const s = useVoice((v) => ({ status: v.status, roomId: v.roomId, muted: v.muted || v.deafened || v.serverMuted }));
  const inVoice = s.status !== "idle";
  const b = useRoomsBootstrap(inVoice);
  const members = useChannelMembers(s.roomId);
  if (!inVoice || !s.roomId || s.roomId === hideFor) return null;
  const ch = findChannel(b, s.roomId);
  const name = ch?.room.name ?? "Voice";
  const tone = s.status === "connected" ? "bg-[#15803d]" : s.status === "lost" ? "bg-[#c81e1e]" : "bg-[#b45309]";
  return (
    <div className={cn("flex h-11 shrink-0 items-center gap-1 px-2 text-white", tone, className)} data-testid="voice-pill">
      <button
        type="button"
        onClick={() => navigate(`/rooms/r/${s.roomId}`)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        aria-label={`${name}, ${members.length} in voice. Return to the channel`}
      >
        <Volume2 className="h-4 w-4 shrink-0" />
        <span className="truncate">
          {name} · {members.length}
        </span>
        <span className="truncate text-xs font-normal opacity-90">
          {s.status === "connected" ? "tap to return" : s.status === "lost" ? "connection lost" : "connecting…"}
        </span>
      </button>
      <button
        type="button"
        onClick={() => void voice.toggleMute()}
        aria-label={s.muted ? "Unmute" : "Mute"}
        aria-pressed={s.muted}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-black/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        {s.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={() => void voice.leave()}
        aria-label="Leave voice"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-black/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <PhoneOff className="h-4 w-4" />
      </button>
    </div>
  );
}
