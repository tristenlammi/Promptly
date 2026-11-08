import { useQueryClient } from "@tanstack/react-query";
import { BellOff, ChevronDown, Hash, LogOut, MessageSquarePlus, Plus, Settings, Sparkles, Users, Volume2 } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";

import { roomsApi, type Bootstrap, type NotifyLevel, type Room, type Space } from "@/api/rooms";
import { EmptyState, ItemButton } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { BOOTSTRAP_KEY, dmTitle, effectiveNotify, updateBootstrap } from "../cache";
import { plainSnippet, shortWhen } from "../format";
import { CountBadge, Popover, UserAvatar } from "./ui";
import { RoomSettingsSheet } from "./RoomSheets";
import { VoiceChannelRow } from "@/rtc/ui/ChannelRow";

const rowFocus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]";

export function SpaceRoomList({
  b,
  space,
  activeRoomId,
  onSettings,
  onNewRoom,
  onNewVoice,
  isPhone,
}: {
  b: Bootstrap;
  space: Space;
  activeRoomId: string | null;
  onSettings: () => void;
  onNewRoom: () => void;
  /** Calls: add a voice channel (admins, voice on). */
  onNewVoice?: () => void;
  isPhone: boolean;
}) {
  const qc = useQueryClient();
  const menuBtn = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [voiceSettings, setVoiceSettings] = useState<string | null>(null);
  const isAdmin = space.role === "owner" || space.role === "admin";
  const voiceOn = b.voice_available === true;
  const settingsRoom = space.rooms.find((r) => r.id === voiceSettings) ?? null;

  const setNotify = (notify: NotifyLevel) => {
    setMenu(false);
    updateBootstrap(qc, (cur) => ({ ...cur, spaces: cur.spaces.map((s) => (s.id === space.id ? { ...s, notify } : s)) }));
    roomsApi.setSpaceNotify(space.id, notify).catch((err) => {
      toast.error(apiErrorMessage(err, "Couldn't change notifications."));
      void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
    });
  };
  const leave = async () => {
    setMenu(false);
    if (space.role === "owner") {
      toast.info("You own this space — make someone else the owner or delete it from its settings.");
      return;
    }
    if (!window.confirm(`Leave ${space.name}?`)) return;
    try {
      await roomsApi.removeSpaceMember(space.id, b.me.id);
      updateBootstrap(qc, (cur) => ({ ...cur, spaces: cur.spaces.filter((s) => s.id !== space.id) }));
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't leave the space."));
    }
  };

  const menuItem = "flex h-10 w-full items-center gap-2.5 px-3 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!isPhone && (
        <div className="flex h-14 shrink-0 items-center border-b border-[var(--border)] px-2">
          <button
            ref={menuBtn}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
            className={cn("flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl px-2 text-left hover:bg-[var(--hover)]", rowFocus)}
          >
            <span className="min-w-0 flex-1 truncate font-semibold text-[var(--text)]">{space.name}</span>
            {space.notify === "none" && <BellOff className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-label="Muted" />}
            <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          </button>
        </div>
      )}
      <Popover anchor={menuBtn.current} open={menu} onClose={() => setMenu(false)} width={240}>
        <div role="menu" className="flex flex-col py-1">
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            onClick={() => {
              setMenu(false);
              onSettings();
            }}
          >
            <Settings className="h-4 w-4" /> Space settings
          </button>
          {isAdmin && (
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={() => {
                setMenu(false);
                onNewRoom();
              }}
            >
              <Plus className="h-4 w-4" /> New room
            </button>
          )}
          {isAdmin && voiceOn && onNewVoice && (
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={() => {
                setMenu(false);
                onNewVoice();
              }}
            >
              <Volume2 className="h-4 w-4" /> New voice channel
            </button>
          )}
          <div className="my-1 border-t border-[var(--border)]" />
          <p className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Notify me about</p>
          {(["all", "mentions", "none"] as NotifyLevel[]).map((n) => (
            <button key={n} type="button" role="menuitemradio" aria-checked={space.notify === n} className={menuItem} onClick={() => setNotify(n)}>
              <span className={cn("h-2 w-2 rounded-full", space.notify === n ? "bg-[var(--item-accent)]" : "bg-transparent")} />
              {n === "all" ? "All messages" : n === "mentions" ? "Only @mentions" : "Nothing"}
            </button>
          ))}
          {space.role !== "owner" && (
            <>
              <div className="my-1 border-t border-[var(--border)]" />
              <button type="button" role="menuitem" className={cn(menuItem, "!text-[var(--danger)]")} onClick={() => void leave()}>
                <LogOut className="h-4 w-4" /> Leave space
              </button>
            </>
          )}
        </div>
      </Popover>

      <nav className="min-h-0 flex-1 overflow-y-auto py-2" aria-label={`Rooms in ${space.name}`}>
        <div className="flex items-center justify-between px-3 pb-1 pt-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Rooms</span>
          {isAdmin && (
            <button
              type="button"
              aria-label="New room"
              title="New room"
              onClick={onNewRoom}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>
        <ul className="flex flex-col gap-0.5 px-2">
          {space.rooms.map((r) => {
            if (r.kind === "voice")
              return (
                <VoiceChannelRow
                  key={r.id}
                  b={b}
                  space={space}
                  room={r}
                  active={r.id === activeRoomId}
                  isPhone={isPhone}
                  onSettings={() => setVoiceSettings(r.id)}
                />
              );
            const n = effectiveNotify(r, space);
            const unread = r.unread > 0 && n !== "none";
            const active = r.id === activeRoomId;
            return (
              <li key={r.id}>
                <Link
                  to={`/rooms/r/${r.id}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group flex h-11 items-center gap-2 rounded-xl px-2.5 text-[15px] md:h-9 md:text-sm",
                    rowFocus,
                    active ? "bg-[var(--hover)] text-[var(--text)]" : unread ? "text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]",
                  )}
                >
                  <Hash className="h-4 w-4 shrink-0 opacity-70" />
                  <span className={cn("min-w-0 flex-1 truncate", (unread || active) && "font-semibold")}>{r.name}</span>
                  {r.ai_context && <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--item-accent)] opacity-70" aria-label="AI can read this room" />}
                  {r.notify === "none" && <BellOff className="h-3.5 w-3.5 shrink-0 opacity-60" aria-label="Muted" />}
                  <CountBadge n={r.mentions} />
                  {unread && r.mentions === 0 && <span className="sr-only">unread</span>}
                </Link>
              </li>
            );
          })}
        </ul>
        {isAdmin && voiceOn && onNewVoice && !space.rooms.some((r) => r.kind === "voice") && (
          <button
            type="button"
            onClick={onNewVoice}
            className={cn("mx-2 mt-1 flex h-9 w-[calc(100%-1rem)] items-center gap-2 rounded-xl px-2.5 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]", rowFocus)}
          >
            <Plus className="h-4 w-4" /> Add voice channel
          </button>
        )}
        {space.member_ids.length <= 1 && isAdmin && (
          <div className="m-3 rounded-2xl border border-dashed border-[var(--border)] p-3 text-xs text-[var(--text-muted)]">
            It's just you here.{" "}
            <button type="button" onClick={onSettings} className="font-semibold text-[var(--item-accent)] underline">
              Add people
            </button>{" "}
            to {space.name}.
          </div>
        )}
      </nav>
      {settingsRoom && (
        <RoomSettingsSheet open={!!settingsRoom} onClose={() => setVoiceSettings(null)} room={settingsRoom} space={space} />
      )}
    </div>
  );
}

export function DmRow({ b, room, active }: { b: Bootstrap; room: Room; active: boolean }) {
  const others = (room.members ?? []).filter((id) => id !== b.me.id);
  const n = effectiveNotify(room, null);
  const unread = room.unread > 0 && n !== "none";
  const p = room.preview;
  const who = p ? (p.kind === "promptly" ? "Promptly: " : p.author_id === b.me.id ? "You: " : others.length > 1 && p.author_id ? `${b.users[p.author_id]?.username ?? "Someone"}: ` : "") : "";
  return (
    <Link
      to={`/rooms/r/${room.id}`}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-16 items-center gap-3 rounded-xl px-2.5",
        rowFocus,
        active ? "bg-[var(--hover)]" : "hover:bg-[var(--hover)]",
      )}
    >
      {others.length <= 1 ? (
        <UserAvatar user={b.users[others[0] ?? b.me.id]} size={40} />
      ) : (
        <span className="relative h-10 w-10 shrink-0">
          <UserAvatar user={b.users[others[0]]} size={28} className="absolute left-0 top-0 ring-2 ring-[var(--bg)]" />
          <UserAvatar user={b.users[others[1]]} size={28} className="absolute bottom-0 right-0 ring-2 ring-[var(--bg)]" />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[15px] md:text-sm", unread ? "font-bold text-[var(--text)]" : "font-medium text-[var(--text)]")}>
            {dmTitle(b, room)}
          </span>
          <span className={cn("shrink-0 text-[11px]", unread ? "font-semibold text-[var(--item-accent)]" : "text-[var(--text-muted)]")}>
            {shortWhen(room.last_message_at)}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[13px]", unread ? "text-[var(--text)]" : "text-[var(--text-muted)]")}>
            {p ? `${who}${plainSnippet(p.body, 80) || "Sent an attachment"}` : "No messages yet"}
          </span>
          {n === "none" && <BellOff className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-label="Muted" />}
          <CountBadge n={unread ? room.unread : 0} />
        </span>
      </span>
    </Link>
  );
}

export function DmList({
  b,
  activeRoomId,
  onNew,
  isPhone,
}: {
  b: Bootstrap;
  activeRoomId: string | null;
  onNew: () => void;
  isPhone: boolean;
}) {
  const dms = [...b.dms].sort((x, y) => (y.last_message_at ?? "").localeCompare(x.last_message_at ?? ""));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!isPhone && (
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
          <span className="font-semibold text-[var(--text)]">Messages</span>
          <button
            type="button"
            aria-label="New message"
            title="New message"
            onClick={onNew}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <MessageSquarePlus className="h-[18px] w-[18px]" />
          </button>
        </div>
      )}
      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Messages">
        {dms.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Start a conversation"
            text="Message one person, or a few people at once. Only the people in it can read it."
            action={
              <ItemButton variant="primary" onClick={onNew} icon={<MessageSquarePlus className="h-4 w-4" />}>
                New message
              </ItemButton>
            }
            className="m-2"
          />
        ) : (
          <ul className="flex flex-col gap-0.5">
            {dms.map((r) => (
              <li key={r.id}>
                <DmRow b={b} room={r} active={r.id === activeRoomId} />
              </li>
            ))}
          </ul>
        )}
      </nav>
    </div>
  );
}
