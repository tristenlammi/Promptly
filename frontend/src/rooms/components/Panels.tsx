import { useQuery } from "@tanstack/react-query";
import { Crown, Loader2, Pin, Search, Shield, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { roomsApi, type Bootstrap, type Message, type Space } from "@/api/rooms";
import { cn } from "@/utils/cn";

import { findRoom, roomTitle } from "../cache";
import { plainSnippet, shortWhen } from "../format";
import { PromptlyAvatar, UserAvatar } from "./ui";

export function PanelFrame({ title, onClose, children }: { title: ReactNode; onClose?: () => void; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-4">
        <h2 className="truncate text-sm font-semibold text-[var(--text)]">{title}</h2>
        {onClose && (
          <button
            type="button"
            aria-label="Close panel"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function MessageRow({
  m,
  b,
  roomLabel,
  onClick,
}: {
  m: Message;
  b: Bootstrap;
  roomLabel?: string;
  onClick: () => void;
}) {
  const user = m.author_id ? b.users[m.author_id] : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full gap-2.5 px-4 py-2.5 text-left hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none"
    >
      {m.kind === "promptly" ? <PromptlyAvatar size={28} /> : <UserAvatar user={user} size={28} />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-1.5 text-xs">
          <b className="truncate text-[var(--text)]">{m.kind === "promptly" ? "Promptly" : user?.username ?? "Someone"}</b>
          {roomLabel && <span className="truncate text-[var(--text-muted)]">{roomLabel}</span>}
          <span className="ml-auto shrink-0 text-[var(--text-muted)]">{shortWhen(m.created_at)}</span>
        </span>
        <span className="line-clamp-3 break-words text-sm text-[var(--text)]">
          {m.deleted ? <i className="text-[var(--text-muted)]">Message deleted</i> : plainSnippet(m.body, 240) || "Attachment"}
        </span>
      </span>
    </button>
  );
}

/** Search messages — in one room, or (no ``roomId``) everywhere you can see. */
export function SearchPanel({
  b,
  roomId,
  onJump,
  autoFocus = true,
}: {
  b: Bootstrap;
  roomId: string | null;
  onJump: (roomId: string, seq: number) => void;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);
  const { data, isFetching, isError } = useQuery({
    queryKey: ["rooms", "search", roomId, debounced],
    queryFn: () => roomsApi.search(debounced, roomId),
    enabled: debounced.length >= 2,
    staleTime: 10_000,
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 p-3">
        <label className="flex h-11 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 focus-within:border-[var(--item-accent)] md:h-10">
          <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          <input
            data-autofocus={autoFocus ? "" : undefined}
            autoFocus={autoFocus}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={roomId ? "Search this conversation" : "Search all your rooms"}
            aria-label="Search messages"
            className="h-full min-w-0 flex-1 bg-transparent text-base text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] md:text-sm"
          />
          {isFetching && <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        {debounced.length < 2 ? (
          <p className="px-4 py-6 text-center text-sm text-[var(--text-muted)]">Type at least two letters.</p>
        ) : isError ? (
          <p className="px-4 py-6 text-center text-sm text-[var(--danger)]">Search didn't work. Try again.</p>
        ) : data && data.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-[var(--text-muted)]">No messages match “{debounced}”.</p>
        ) : (
          data?.map((h) => {
            const found = findRoom(b, h.room_id);
            const label = !roomId && found ? (found.space ? `${found.space.name} · #${found.room.name}` : roomTitle(b, found.room)) : undefined;
            return <MessageRow key={h.message.id} m={h.message} b={b} roomLabel={label} onClick={() => onJump(h.room_id, h.message.seq)} />;
          })
        )}
      </div>
    </div>
  );
}

export function PinsPanel({ b, roomId, onJump }: { b: Bootstrap; roomId: string; onJump: (roomId: string, seq: number) => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["rooms", "pins", roomId],
    queryFn: () => roomsApi.pins(roomId),
    staleTime: 0,
  });
  if (isLoading)
    return (
      <div className="flex justify-center py-10 text-[var(--text-muted)]">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  if (isError) return <p className="px-4 py-6 text-center text-sm text-[var(--danger)]">Couldn't load pins.</p>;
  if (!data?.length)
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-[var(--text-muted)]">
        <Pin className="h-6 w-6" />
        Nothing pinned yet. Pin a message to keep it handy for everyone here.
      </div>
    );
  return (
    <div className="flex flex-col divide-y divide-[var(--border)]">
      {data.map((m) => (
        <MessageRow key={m.id} m={m} b={b} onClick={() => onJump(roomId, m.seq)} />
      ))}
    </div>
  );
}

export function MembersPanel({ b, memberIds, space }: { b: Bootstrap; memberIds: string[]; space: Space | null }) {
  const roleOf = (id: string) => space?.member_roles?.[id];
  const sorted = [...memberIds].sort((x, y) => {
    const rank = (id: string) => (roleOf(id) === "owner" ? 0 : roleOf(id) === "admin" ? 1 : 2);
    return rank(x) - rank(y) || (b.users[x]?.username ?? "").localeCompare(b.users[y]?.username ?? "");
  });
  return (
    <ul className="flex flex-col py-2">
      {sorted.map((id) => {
        const u = b.users[id];
        const role = roleOf(id);
        return (
          <li key={id} className="flex h-12 items-center gap-2.5 px-4">
            <UserAvatar user={u} size={32} />
            <span className={cn("min-w-0 flex-1 truncate text-sm", id === b.me.id ? "font-semibold" : "", "text-[var(--text)]")}>
              {u?.username ?? "Someone"}
              {id === b.me.id && <span className="font-normal text-[var(--text-muted)]"> (you)</span>}
            </span>
            {role === "owner" && <Crown className="h-4 w-4 text-[#C08B2C]" aria-label="Owner" />}
            {role === "admin" && <Shield className="h-4 w-4 text-[var(--item-accent)]" aria-label="Admin" />}
          </li>
        );
      })}
    </ul>
  );
}
