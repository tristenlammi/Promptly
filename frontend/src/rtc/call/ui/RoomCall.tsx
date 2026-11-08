/**
 * Calls in a conversation's own screen (Rooms DMs and group DMs): the
 * phone and camera buttons in its header, and the green "Call in progress
 * · 2 people · Join" bar while a call is on that you're not in here.
 */
import { Phone, PhoneCall, Video } from "lucide-react";

import type { Bootstrap, Room } from "@/api/rooms";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

import { calls } from "../actions";
import { inCallHere, useCallStore } from "../store";
import { CALL_GREEN } from "./bits";

/** Calls are possible in this conversation (a DM or group DM, calls on). */
export function canCallIn(b: Bootstrap, room: Room | undefined | null): boolean {
  return !!room && !room.space_id && (room.kind === "dm" || room.kind === "group") && b.voice_available === true;
}

function useRoomCall(roomId: string) {
  return useCallStore((s) => Object.values(s.live).find((c) => c.room_id === roomId && c.live) ?? null);
}

export function CallHeaderButtons({ b, room, otherName }: { b: Bootstrap; room: Room; otherName: string | null }) {
  const here = useCallStore((s) => (inCallHere(s) ? s.roomId : null));
  const live = useRoomCall(room.id);
  if (!canCallIn(b, room)) return null;
  const blocked = !!room.blocked;
  const inThis = here === room.id;
  const btn =
    "flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] disabled:cursor-not-allowed disabled:opacity-40 md:h-9 md:w-9";
  const why = blocked && otherName ? `Unblock ${otherName} to call` : null;
  if (inThis) {
    return (
      <button type="button" className={cn(btn, "!text-[#15803d]")} aria-label="Back to the call" title="Back to the call" onClick={() => calls.expand()}>
        <PhoneCall className="h-[18px] w-[18px]" />
      </button>
    );
  }
  const who = otherName ?? "everyone";
  const onLive = !!live && live.in_call.length > 0;
  return (
    <>
      <button
        type="button"
        className={btn}
        disabled={blocked}
        aria-label={why ?? (onLive ? "Join the call" : `Call ${who}`)}
        title={why ?? (onLive ? "Join the call" : `Call ${who}`)}
        onClick={() => void calls.start(room.id, "audio")}
        data-testid="room-call-audio"
      >
        <Phone className="h-[18px] w-[18px]" />
      </button>
      <button
        type="button"
        className={btn}
        disabled={blocked}
        aria-label={why ?? (onLive ? "Join the call with video" : `Video call ${who}`)}
        title={why ?? (onLive ? "Join the call with video" : `Video call ${who}`)}
        onClick={() => void calls.start(room.id, "video")}
        data-testid="room-call-video"
      >
        <Video className="h-[18px] w-[18px]" />
      </button>
    </>
  );
}

export function CallInProgressBar({ b, room }: { b: Bootstrap; room: Room }) {
  const call = useRoomCall(room.id);
  const here = useCallStore((s) => inCallHere(s) && s.callId === call?.id);
  const self = useAuthStore((s) => s.user?.id);
  // Ringing you: the incoming call says it all.
  const ringingMe = useCallStore((s) => !!call && !!s.incoming[call.id]);
  if (!call || here || ringingMe || !canCallIn(b, room) || call.in_call.length === 0) return null;
  const meElsewhere = !!self && call.in_call.includes(self);
  const n = call.in_call.length;
  const what = call.media === "video" ? "Video call in progress" : "Call in progress";
  const people = `${n} ${n === 1 ? "person" : "people"}`;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 px-3 py-2 text-sm text-white md:px-4"
      style={{ background: CALL_GREEN }}
      data-testid="call-in-progress"
    >
      <PhoneCall className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-medium">
        {meElsewhere ? "You're in this call on another device" : `${what} · ${people}`}
      </span>
      <button
        type="button"
        onClick={() => void calls.answer(call.id, { video: false, roomId: room.id, media: call.media })}
        className="shrink-0 rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-[#14532d] hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#15803d]"
        data-testid="call-join"
      >
        {meElsewhere ? "Switch here" : "Join"}
      </button>
    </div>
  );
}
