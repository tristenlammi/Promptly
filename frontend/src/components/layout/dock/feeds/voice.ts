import { Mic, MicOff, PhoneOff, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

import { findChannel, nameOf, useRoomsBootstrap } from "@/rtc/ui/directory";
import { voice } from "@/rtc/voice/actions";
import { useVoice } from "@/rtc/voice/hooks";
import { useAuthStore } from "@/store/authStore";

import type { DockAction, DockCardData, DockFeed } from "../types";

const quiet = (p: Promise<unknown>) => void p.catch(() => undefined);

function speakingLine(names: string[]): string {
  if (names.length === 1) return `${names[0]} is speaking`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are speaking`;
  return `${names.length} people are speaking`;
}

/** The voice channel you're in: who's speaking, how long, Mute and Leave.
 *  Rooms shows its own panel, so the card stays away there. */
function useCards(): DockCardData[] {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const meId = useAuthStore((s) => s.user?.id);
  const v = useVoice((s) => {
    const roomId = s.roomId ?? s.joiningRoomId;
    const here = s.status === "connected" && !s.remote;
    const talking = new Set<string>();
    if (roomId) {
      if (here) {
        for (const [id, p] of Object.entries(s.peers)) if (p.speaking) talking.add(id);
      } else {
        for (const id of Object.keys(s.speakingIn[roomId] ?? {})) talking.add(id);
      }
    }
    if (meId) talking.delete(meId);
    return {
      status: s.status,
      roomId,
      joinedAt: s.joinedAt,
      muted: s.muted,
      deafened: s.deafened,
      serverMuted: s.serverMuted,
      canTalk: s.canTalk,
      audioBlocked: s.audioBlocked,
      me: here && s.speaking && !s.muted && !s.deafened && !s.serverMuted,
      talking: [...talking].sort().join(","),
      people: roomId ? (s.channels[roomId]?.length ?? 0) : 0,
    };
  });
  const active = v.status !== "idle" && !!v.roomId;
  const bootstrap = useRoomsBootstrap(active);
  if (!active || !v.roomId || pathname.startsWith("/rooms")) return [];

  const roomId = v.roomId;
  const channel = findChannel(bootstrap, roomId);
  const names = v.talking ? v.talking.split(",").map((id) => nameOf(bootstrap, id)) : [];

  let detail: string;
  if (v.status === "joining") detail = "Connecting…";
  else if (v.status === "reconnecting") detail = "Reconnecting…";
  else if (v.status === "lost") detail = "Connection lost";
  else if (v.audioBlocked) detail = "Your browser paused the sound";
  else if (names.length) detail = speakingLine(names);
  else if (v.me) detail = "You're speaking";
  else if (v.serverMuted) detail = "Muted by an admin";
  else if (v.deafened) detail = "Sound off";
  else if (!v.canTalk) detail = "Listening only";
  else if (v.muted) detail = "You're muted";
  else detail = v.people > 1 ? `${v.people} people here` : "Just you so far";

  const leave: DockAction = { id: "leave", label: "Leave", icon: PhoneOff, danger: true, quick: true, onClick: () => quiet(voice.leave()) };
  const actions: DockAction[] =
    v.status === "lost"
      ? [{ id: "rejoin", label: "Rejoin", icon: RotateCcw, quick: true, onClick: () => quiet(voice.rejoin()) }, leave]
      : [
          {
            id: "mute",
            label: v.muted ? "Unmute" : "Mute",
            icon: v.muted ? MicOff : Mic,
            pressed: v.muted,
            quick: true,
            onClick: () => quiet(voice.toggleMute()),
          },
          leave,
        ];
  if (v.status === "connected" && v.audioBlocked) {
    actions.unshift({ id: "sound", label: "Turn on sound", icon: VolumeX, quick: true, onClick: () => quiet(voice.resumeAudio()) });
  }

  return [
    {
      id: "voice",
      priority: 100,
      icon: Volume2,
      tone: v.status === "lost" || v.audioBlocked ? "warn" : "live",
      title: channel?.room.name ?? "Voice",
      detail,
      since: v.status === "connected" ? v.joinedAt : null,
      onOpen: () => navigate(`/rooms/r/${roomId}`),
      actions,
    },
  ];
}

export const voiceFeed: DockFeed = { id: "voice", useCards };
