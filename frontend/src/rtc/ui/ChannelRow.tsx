/**
 * A voice channel in a space's room list, Discord-style: 🔊 and its name,
 * and under it everyone in it right now with their speaking ring and
 * mute / deafen / camera / LIVE icons. One click joins (or moves you
 * here); hovering warms the connection up.
 */
import { MessageSquare, Settings, Volume2 } from "lucide-react";
import type { MouseEvent } from "react";
import { useNavigate } from "react-router-dom";

import type { Bootstrap, Room, Space } from "@/api/rooms";
import type { VoiceMember } from "@/api/voiceChannels";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { voice } from "../voice/actions";
import { useVoice } from "../voice/hooks";
import { useVoiceStore } from "../voice/store";
import { MemberIcons, VoiceAvatar } from "./bits";
import { isSpaceAdmin, nameOf, useChannelMembers, useSpeaking } from "./directory";
import { joinVoice, useVoiceUi } from "./uiStore";

const rowFocus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]";

/** Join a voice channel and open it (or just open it if you're in it). */
export async function joinAndOpen(roomId: string, roomName: string, navigate: (to: string) => void, opts: { full?: boolean; admin?: boolean } = {}) {
  const s = useVoiceStore.getState();
  navigate(`/rooms/r/${roomId}`);
  if (s.roomId === roomId && s.status !== "idle" && s.status !== "lost") return;
  if (opts.full && !opts.admin) {
    toast.info(`${roomName} is full.`);
    return;
  }
  await joinVoice(roomId);
}

export function VoiceChannelRow({
  b,
  space,
  room,
  active,
  isPhone,
  onSettings,
}: {
  b: Bootstrap;
  space: Space;
  room: Room;
  /** This channel's page is open. */
  active: boolean;
  isPhone: boolean;
  onSettings?: () => void;
}) {
  const navigate = useNavigate();
  const available = b.voice_available !== false;
  const members = useChannelMembers(room.id);
  const { inHere, joiningHere } = useVoice((s) => ({
    inHere: s.roomId === room.id && s.status !== "idle",
    joiningHere: s.joiningRoomId === room.id,
  }));
  const admin = isSpaceAdmin(space);
  const limit = room.voice?.user_limit ?? 0;
  const full = limit > 0 && members.length >= limit && !inHere;
  const openMenu = useVoiceUi((s) => s.openPersonMenu);
  const unread = room.unread > 0 && room.notify !== "none";

  const label = !available
    ? `${room.name} (voice channel)`
    : inHere
      ? `Open ${room.name}`
      : full && !admin
        ? `${room.name} is full`
        : `Join ${room.name}`;

  const onClick = () => {
    if (!available) {
      navigate(`/rooms/r/${room.id}`);
      return;
    }
    void joinAndOpen(room.id, room.name, navigate, { full, admin });
  };

  const onMember = (e: MouseEvent<HTMLButtonElement>, userId: string) => {
    e.preventDefault();
    const point = e.type === "contextmenu" && e.clientX ? { x: e.clientX, y: e.clientY } : null;
    openMenu({ userId, roomId: room.id, anchor: e.currentTarget, point });
  };

  return (
    <li>
      <div className={cn("group relative flex items-center rounded-xl", active ? "bg-[var(--hover)]" : "hover:bg-[var(--hover)]")}>
        <button
          type="button"
          onClick={onClick}
          onMouseEnter={() => available && !inHere && void voice.prepare()}
          onFocus={() => available && !inHere && void voice.prepare()}
          aria-label={label}
          title={label}
          aria-current={active ? "page" : undefined}
          data-testid={`voice-channel-${room.name}`}
          className={cn(
            "flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 text-left text-[15px] md:h-9 md:text-sm",
            rowFocus,
            active || inHere || unread ? "text-[var(--text)]" : "text-[var(--text-muted)] group-hover:text-[var(--text)]",
          )}
        >
          <Volume2 className={cn("h-4 w-4 shrink-0", inHere ? "text-[var(--success)]" : "opacity-70")} aria-hidden />
          <span className={cn("min-w-0 flex-1 truncate", (active || inHere || unread) && "font-semibold")}>{room.name}</span>
          {joiningHere && <span className="text-[11px] text-[var(--text-muted)]">Joining…</span>}
          {limit > 0 && available && (
            <span
              className={cn(
                "shrink-0 rounded-md px-1 text-[11px] tabular-nums",
                full ? "bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-[var(--danger)]" : "text-[var(--text-muted)]",
              )}
              aria-label={`${members.length} of ${limit} places taken`}
            >
              {String(members.length).padStart(2, "0")}/{String(limit).padStart(2, "0")}
            </span>
          )}
        </button>
        {/* Open the channel's chat without joining; settings for admins. */}
        <div
          className={cn(
            "items-center pr-1",
            isPhone
              ? "flex shrink-0"
              : "absolute inset-y-0 right-0 hidden rounded-r-xl bg-[color-mix(in_srgb,var(--text)_5%,var(--surface))] pl-1 group-focus-within:flex group-hover:flex",
          )}
        >
          <button
            type="button"
            aria-label={`Open chat in ${room.name}`}
            title="Open chat"
            onClick={() => navigate(`/rooms/r/${room.id}`)}
            className={cn("flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text)]", rowFocus)}
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
          {admin && onSettings && (
            <button
              type="button"
              aria-label={`${room.name} settings`}
              title="Channel settings"
              onClick={onSettings}
              className={cn("hidden h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text)] md:flex", rowFocus)}
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {available && members.length > 0 && (
        <ul className="mb-1 ml-6 flex flex-col gap-px" aria-label={`In ${room.name}`} data-testid={`voice-members-${room.name}`}>
          {members.map((m) => (
            <MemberRow key={m.user_id} b={b} roomId={room.id} m={m} onMenu={onMember} />
          ))}
        </ul>
      )}
    </li>
  );
}

function MemberRow({
  b,
  roomId,
  m,
  onMenu,
}: {
  b: Bootstrap;
  roomId: string;
  m: VoiceMember;
  onMenu: (e: MouseEvent<HTMLButtonElement>, userId: string) => void;
}) {
  const speaking = useSpeaking(roomId, m.user_id);
  const name = nameOf(b, m.user_id);
  const states = [
    speaking && "speaking",
    m.server_muted ? "muted by an admin" : m.muted && "muted",
    m.server_deafened ? "deafened by an admin" : m.deafened && "deafened",
    m.video && "camera on",
    m.live && "live",
  ].filter(Boolean);
  return (
    <li>
      <button
        type="button"
        onClick={(e) => onMenu(e, m.user_id)}
        onContextMenu={(e) => onMenu(e, m.user_id)}
        aria-label={`${name}${states.length ? `, ${states.join(", ")}` : ""}. Options`}
        aria-haspopup="dialog"
        data-testid={`voice-member-${name}`}
        data-speaking={speaking ? "true" : "false"}
        className={cn("flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-[var(--hover)] md:h-8", rowFocus)}
      >
        <VoiceAvatar user={b.users[m.user_id]} size={22} speaking={speaking} />
        <span className={cn("min-w-0 flex-1 truncate text-[13px]", speaking ? "font-medium text-[var(--text)]" : "text-[var(--text-muted)]")}>{name}</span>
        <MemberIcons m={m} />
      </button>
    </li>
  );
}
