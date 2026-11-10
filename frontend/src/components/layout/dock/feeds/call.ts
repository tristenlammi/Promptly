import { Mic, MicOff, Phone, PhoneOff } from "lucide-react";

import { calls } from "@/rtc/call/actions";
import { useCallStore, type CallStoreState } from "@/rtc/call/store";

import type { DockCardData, DockFeed } from "../types";

const quiet = (p: Promise<unknown>) => void p.catch(() => undefined);
const SEP = "|";

function peerNames(s: CallStoreState, onlySpeaking: boolean): string {
  return Object.values(s.peers)
    .filter((p) => !onlySpeaking || p.speaking)
    .map((p) => s.users[p.userId]?.username || p.name)
    .filter(Boolean)
    .sort()
    .join(SEP);
}

/** A call you're on in this tab: who with, how long, Mute and Hang up.
 *  Tapping brings the call's own screen back. */
function useCards(): DockCardData[] {
  const status = useCallStore((s) => s.status);
  const muted = useCallStore((s) => s.muted);
  const connectedAt = useCallStore((s) => s.connectedAt);
  const group = useCallStore((s) => !!s.call?.group);
  const names = useCallStore((s) => peerNames(s, false));
  const talking = useCallStore((s) => peerNames(s, true));
  if (status === "idle" || status === "ended") return [];

  const people = names ? names.split(SEP) : [];
  const speakers = talking ? talking.split(SEP) : [];
  const title = group || people.length > 1 ? "Group call" : people.length === 1 ? `Call with ${people[0]}` : "Call";

  let detail: string;
  if (status === "calling") detail = "Ringing…";
  else if (status === "connecting") detail = "Connecting…";
  else if (status === "reconnecting") detail = "Reconnecting…";
  else if (speakers.length === 1) detail = `${speakers[0]} is speaking`;
  else if (speakers.length > 1) detail = `${speakers.length} people are speaking`;
  else if (muted) detail = "You're muted";
  else detail = "On the call";

  return [
    {
      id: "call",
      priority: 95,
      icon: Phone,
      tone: "live",
      title,
      detail,
      since: status === "connected" ? connectedAt : null,
      onOpen: () => calls.expand(),
      actions: [
        {
          id: "mute",
          label: muted ? "Unmute" : "Mute",
          icon: muted ? MicOff : Mic,
          pressed: muted,
          quick: true,
          onClick: () => quiet(calls.toggleMute()),
        },
        { id: "hangup", label: "Hang up", icon: PhoneOff, danger: true, quick: true, onClick: () => quiet(calls.hangUp()) },
      ],
    },
  ];
}

export const callFeed: DockFeed = { id: "call", useCards };
