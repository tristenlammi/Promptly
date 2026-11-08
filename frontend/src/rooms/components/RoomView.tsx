import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, CalendarDays, Hash, Pin, Search, Settings, Sparkles, Upload, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import type { Bootstrap, Message } from "@/api/rooms";
import { blockPerson, unblockPerson } from "@/components/people/blockActions";
import { Sheet } from "@/items/ui";
import { cn } from "@/utils/cn";

import { dmTitle, findRoom } from "../cache";
import { useRoomsStore } from "../store";
import { Composer, type ComposerHandle } from "./Composer";
import { MessageActionSheet } from "./MessageActionSheet";
import type { MessageCtx } from "./MessageItem";
import { MessageList } from "./MessageList";
import { MembersPanel, PanelFrame, PinsPanel, SearchPanel, UpcomingPanel } from "./Panels";
import { PlanEventSheet } from "./PlanEventSheet";
import { DmSettingsSheet, RoomSettingsSheet } from "./RoomSheets";
import { UserAvatar } from "./ui";

type Panel = "members" | "pins" | "search" | "events" | null;

const NO_TYPING: Record<string, number> = {};

export function RoomView({ roomId, b, isPhone, onBack }: { roomId: string; b: Bootstrap; isPhone: boolean; onBack?: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const found = findRoom(b, roomId);
  const [panel, setPanel] = useState<Panel>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [actionsFor, setActionsFor] = useState<Message | null>(null);
  const [dragging, setDragging] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const typing = useRoomsStore((s) => s.typing[roomId]) ?? NO_TYPING;
  const thinking = useRoomsStore((s) => !!s.thinking[roomId]);

  const room = found?.room;
  const space = found?.space ?? null;
  const memberIds = useMemo(() => (space ? space.member_ids : room?.members ?? []), [space, room?.members]);
  const usernames = useMemo(() => memberIds.map((id) => b.users[id]?.username).filter((x): x is string => !!x), [memberIds, b.users]);
  const members = useMemo(() => memberIds.map((id) => b.users[id]).filter((u): u is NonNullable<typeof u> => !!u), [memberIds, b.users]);
  const canModerate = !!space && (space.role === "owner" || space.role === "admin");

  const onReply = useCallback((m: Message) => {
    setEditing(null);
    setReplyTo(m);
  }, []);
  const onEdit = useCallback((m: Message | null) => {
    setReplyTo(null);
    setEditing(m);
  }, []);

  const ctx = useMemo<MessageCtx>(
    () => ({
      meId: b.me.id,
      meName: b.me.username,
      users: b.users,
      usernames,
      canModerate,
      isPhone,
      onReply,
      onEdit,
      onJump: () => undefined, // MessageList supplies its own
      onActions: setActionsFor,
    }),
    [b.me.id, b.me.username, b.users, usernames, canModerate, isPhone, onReply, onEdit],
  );

  const closePlanning = useCallback(() => setPlanning(false), []);

  const jumpTo = useCallback(
    (rid: string, seq: number) => {
      useRoomsStore.getState().requestJump(rid, seq);
      if (rid !== roomId) navigate(`/rooms/r/${rid}`);
      if (isPhone) setPanel(null);
    },
    [roomId, navigate, isPhone],
  );

  // ``?m=<seq>`` — a "Mentioned in" entry opening one message.
  const [params, setParams] = useSearchParams();
  const linkedSeq = Number(params.get("m")) || null;
  useEffect(() => {
    if (!linkedSeq || !room) return;
    useRoomsStore.getState().requestJump(room.id, linkedSeq);
    const next = new URLSearchParams(params);
    next.delete("m");
    setParams(next, { replace: true });
  }, [linkedSeq, room, params, setParams]);

  if (!room) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-[var(--text-muted)]">This room isn't here any more, or you're not in it.</p>
        <button type="button" onClick={() => navigate("/rooms/")} className="text-sm font-semibold text-[var(--item-accent)] underline">
          Back to Rooms
        </button>
      </div>
    );
  }

  const title = space ? room.name : dmTitle(b, room);
  const aiOn = space ? room.ai_context : (room.members ?? []).length > 0 && (room.members ?? []).every((id) => room.ai_ok?.[id]);
  const others = (room.members ?? []).filter((id) => id !== b.me.id);
  // A 1:1 conversation: Block / Unblock the other person (decision D7).
  const oneToOne = !space && room.kind === "dm" && others.length === 1 ? b.users[others[0]] ?? null : null;
  const toggleBlock = () => {
    if (!oneToOne) return;
    void (room.blocked ? unblockPerson(qc, oneToOne) : blockPerson(qc, oneToOne));
  };
  const typers = Object.keys(typing)
    .filter((id) => id !== b.me.id)
    .map((id) => b.users[id]?.username ?? "Someone");
  const typingText =
    typers.length === 0
      ? ""
      : typers.length === 1
        ? `${typers[0]} is typing…`
        : typers.length === 2
          ? `${typers[0]} and ${typers[1]} are typing…`
          : "Several people are typing…";

  const panelBody =
    panel === "search" ? (
      <SearchPanel b={b} roomId={roomId} onJump={jumpTo} />
    ) : panel === "pins" ? (
      <PinsPanel b={b} roomId={roomId} onJump={jumpTo} />
    ) : panel === "members" ? (
      <MembersPanel b={b} memberIds={memberIds} space={space} />
    ) : panel === "events" ? (
      <UpcomingPanel
        roomId={roomId}
        meId={b.me.id}
        onPlan={() => {
          if (isPhone) setPanel(null);
          setPlanning(true);
        }}
      />
    ) : null;
  const panelTitle =
    panel === "search" ? "Search" : panel === "pins" ? "Pinned messages" : panel === "members" ? `Members (${memberIds.length})` : panel === "events" ? "Events" : "";

  const headerBtn = (p: Exclude<Panel, null>, label: string, Icon: typeof Pin) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={panel === p}
      onClick={() => setPanel(panel === p ? null : p)}
      className={cn(
        "flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] md:h-9 md:w-9",
        panel === p && "bg-[var(--hover)] !text-[var(--item-accent)]",
      )}
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        composer.current?.addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={space ? `#${title}` : title}>
        <header className="flex h-14 shrink-0 items-center gap-1 border-b border-[var(--border)] px-1.5 md:gap-2 md:px-4">
          {onBack && (
            <button
              type="button"
              aria-label="Back"
              onClick={onBack}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text)] hover:bg-[var(--hover)]"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1 py-1 text-left hover:bg-[var(--hover)] md:flex-none md:max-w-[50%]"
            aria-label={`${space ? `#${title}` : title} settings`}
          >
            {space ? (
              <Hash className="h-5 w-5 shrink-0 text-[var(--text-muted)]" />
            ) : others.length === 1 ? (
              <UserAvatar user={b.users[others[0]]} size={28} />
            ) : (
              <Users className="h-5 w-5 shrink-0 text-[var(--text-muted)]" />
            )}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[15px] font-semibold leading-tight text-[var(--text)]">{title}</span>
              {(room.topic || (isPhone && space)) && (
                <span className="truncate text-[11px] leading-tight text-[var(--text-muted)]">{room.topic || space?.name}</span>
              )}
            </span>
          </button>
          {aiOn && (
            <span
              className="hidden shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--item-accent)] sm:inline-flex"
              title="Promptly can read this room's recent messages when someone asks it something."
            >
              <Sparkles className="h-3 w-3" /> AI can read this room
            </span>
          )}
          {aiOn && (
            <span className="inline-flex shrink-0 sm:hidden" title="AI can read this room" aria-label="AI can read this room">
              <Sparkles className="h-4 w-4 text-[var(--item-accent)]" />
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center">
            {headerBtn("search", "Search this conversation", Search)}
            {headerBtn("events", "Events", CalendarDays)}
            {headerBtn("pins", "Pinned messages", Pin)}
            {(!isPhone || space) && headerBtn("members", "Members", Users)}
            {oneToOne && (
              <button
                type="button"
                aria-label={room.blocked ? `Unblock ${oneToOne.username}` : `Block ${oneToOne.username}`}
                title={room.blocked ? `Unblock ${oneToOne.username}` : `Block ${oneToOne.username}`}
                aria-pressed={!!room.blocked}
                onClick={toggleBlock}
                className={cn(
                  "flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] md:h-9 md:w-9",
                  room.blocked && "!text-[var(--danger)]",
                )}
              >
                <Ban className="h-[18px] w-[18px]" />
              </button>
            )}
            <button
              type="button"
              aria-label="Settings"
              title="Settings"
              onClick={() => setSettingsOpen(true)}
              className="hidden h-9 w-9 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] md:flex"
            >
              <Settings className="h-[18px] w-[18px]" />
            </button>
          </div>
        </header>

        <MessageList room={room} title={title} ctx={ctx} />

        <div className="flex h-5 shrink-0 items-center gap-3 px-4 text-[11px] text-[var(--text-muted)]" aria-live="polite">
          {thinking && (
            <span className="inline-flex items-center gap-1 font-medium text-[var(--item-accent)]">
              <Sparkles className="h-3 w-3 animate-pulse" /> Promptly is thinking…
            </span>
          )}
          {typingText && <span className="truncate">{typingText}</span>}
        </div>

        {room.can_send === false ? (
          // Closed by a block. The person who was blocked only ever sees the
          // plain line, never the word "block".
          <div className="shrink-0 border-t border-[var(--border)] px-4 py-3 text-center text-sm text-[var(--text-muted)]">
            {room.blocked && oneToOne ? (
              <>
                You've blocked {oneToOne.username}. You can still read your conversation.{" "}
                <button type="button" onClick={toggleBlock} className="font-semibold text-[var(--item-accent)] underline">
                  Unblock
                </button>
              </>
            ) : (
              "Messages can't be sent in this conversation."
            )}
          </div>
        ) : (
        <Composer
          ref={composer}
          roomId={roomId}
          placeholder={space ? `Message #${title}` : `Message ${title}`}
          members={members}
          meId={b.me.id}
          isPhone={isPhone}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          editing={editing}
          onEdit={onEdit}
          users={b.users}
          onPlanEvent={() => setPlanning(true)}
        />
        )}
      </section>

      {!isPhone && panel && (
        <aside className="hidden w-80 shrink-0 border-l border-[var(--border)] bg-[var(--surface)] md:block" aria-label={panelTitle}>
          <PanelFrame title={panelTitle} onClose={() => setPanel(null)}>
            {panelBody}
          </PanelFrame>
        </aside>
      )}
      {isPhone && (
        <Sheet open={!!panel} onClose={() => setPanel(null)} title={panelTitle} size="lg">
          <div className="-mx-5 h-[70dvh]">{panelBody}</div>
        </Sheet>
      )}

      {space ? (
        <RoomSettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} room={room} space={space} />
      ) : (
        <DmSettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} room={room} b={b} />
      )}

      <PlanEventSheet
        open={planning}
        onClose={closePlanning}
        room={{ id: room.id, name: space ? `#${title}` : title }}
        members={members}
        meId={b.me.id}
      />

      <MessageActionSheet
        m={actionsFor}
        onClose={() => setActionsFor(null)}
        meId={b.me.id}
        canModerate={canModerate}
        onReply={onReply}
        onEdit={onEdit}
      />

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_10%,var(--bg))]">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--item-accent)]">
            <Upload className="h-5 w-5" /> Drop to attach to {space ? `#${title}` : title}
          </span>
        </div>
      )}
    </div>
  );
}
