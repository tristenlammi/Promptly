import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Hash, Loader2, MessagesSquare } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { roomsApi, type Message, type Room } from "@/api/rooms";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { sendMessage } from "../actions";
import { loadAround, loadNewer, loadOlder, loadTail, patchRoom, refreshTail } from "../cache";
import { dayLabel, sameDay } from "../format";
import { clearRoomNotifications, readingNow } from "../live";
import { useRoomsStore, type PendingMessage } from "../store";
import { MessageItem, PendingItem, type MessageCtx } from "./MessageItem";
import { SrOnly } from "./ui";

const EMPTY_PENDING: PendingMessage[] = [];
const GROUP_MS = 5 * 60 * 1000;
const EDGE_PX = 400;

function groupsWith(prev: Message | undefined, m: Message): boolean {
  if (!prev) return false;
  if (m.kind === "system" || prev.kind === "system") return false;
  if (prev.kind !== m.kind || prev.author_id !== m.author_id) return false;
  if (m.reply_to) return false;
  if (!sameDay(prev.created_at, m.created_at)) return false;
  return new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < GROUP_MS;
}

/**
 * The open room's messages. One scroll container (newest at the bottom),
 * holding the room's loaded window (≤ 300 messages — paging trims the far
 * end), so the DOM stays bounded without a virtualiser fighting reverse
 * scroll. Scroll position is anchored on the message at the top of the
 * view, which keeps it still when older pages arrive or the window trims.
 */
export function MessageList({
  room,
  title,
  ctx,
  empty,
}: {
  room: Room;
  title: string;
  ctx: MessageCtx;
  empty?: ReactNode;
}) {
  const roomId = room.id;
  const qc = useQueryClient();
  const w = useRoomsStore((s) => s.windows[roomId]);
  const pending = useRoomsStore((s) => s.pending[roomId]) ?? EMPTY_PENDING;
  const jump = useRoomsStore((s) => s.jump);

  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const initialScroll = useRef(true);
  const roomRef = useRef(room);
  roomRef.current = room;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [farFromBottom, setFarFromBottom] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  // The read position when the room was opened: the "New messages" line
  // sits after it until you leave the room.
  const [newAfter] = useState<number | null>(() => (room.unread > 0 ? room.last_read_seq : null));
  const jumpTried = useRef<number | null>(null);

  // ---- open a room ----
  useEffect(() => {
    // (RoomView is keyed by room, so this list mounts fresh for each room.)
    const r = roomRef.current;
    const st = useRoomsStore.getState();
    const j = st.jump;
    const p =
      j && j.roomId === roomId
        ? Promise.resolve() // the jump effect loads around the target
        : st.windows[roomId]
          ? refreshTail(roomId)
          : r.unread > 45
            ? loadAround(roomId, r.last_read_seq + 1)
            : loadTail(roomId);
    p.catch(() => setError(true));
    return () => {
      if (readingNow.roomId === roomId) readingNow.roomId = null;
    };
  }, [roomId]);

  const messages = w?.messages;
  const lastSeq = messages?.[messages.length - 1]?.seq ?? 0;

  // ---- reading / mark read ----
  const markTimer = useRef<number | null>(null);
  const maybeMarkRead = useCallback(() => {
    const win = useRoomsStore.getState().windows[roomId];
    const visible = document.visibilityState === "visible" && document.hasFocus();
    const reading = visible && atBottom.current && !!win && !win.hasMoreAfter;
    readingNow.roomId = reading ? roomId : readingNow.roomId === roomId ? null : readingNow.roomId;
    if (!reading || !win) return;
    const seq = win.messages[win.messages.length - 1]?.seq ?? 0;
    const r = roomRef.current;
    if (!seq || (seq <= r.last_read_seq && r.unread === 0)) return;
    if (markTimer.current) window.clearTimeout(markTimer.current);
    markTimer.current = window.setTimeout(() => {
      patchRoom(qc, roomId, (cur) => ({ ...cur, last_read_seq: Math.max(cur.last_read_seq, seq), unread: 0, mentions: 0 }));
      void roomsApi.markRead(roomId, seq).catch(() => undefined);
      clearRoomNotifications(roomId);
    }, 400);
  }, [qc, roomId]);

  // Opening a room clears its notification from the tray.
  useEffect(() => clearRoomNotifications(roomId), [roomId]);

  useEffect(() => {
    const on = () => maybeMarkRead();
    window.addEventListener("focus", on);
    window.addEventListener("blur", on);
    document.addEventListener("visibilitychange", on);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", on);
      document.removeEventListener("visibilitychange", on);
      if (markTimer.current) window.clearTimeout(markTimer.current);
    };
  }, [maybeMarkRead]);

  // ---- scrolling ----
  const scrollToBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setFarFromBottom(false);
    setUnseen(0);
  }, []);

  const recordAnchor = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const rows = el.querySelectorAll<HTMLElement>("[data-id]");
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (r.bottom > top + 4) {
        anchor.current = { id: row.dataset.id!, offset: r.top - top };
        return;
      }
    }
    anchor.current = null;
  }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const win = useRoomsStore.getState().windows[roomId];
    atBottom.current = dist < 48 && !win?.hasMoreAfter;
    setFarFromBottom(dist > el.clientHeight * 0.75 || !!win?.hasMoreAfter);
    if (atBottom.current) setUnseen(0);
    recordAnchor();
    if (!win || initialScroll.current) return;
    if (el.scrollTop < EDGE_PX && win.hasMoreBefore) {
      setLoadingOlder(true);
      void loadOlder(roomId)
        .catch(() => toast.error("Couldn't load older messages."))
        .finally(() => setLoadingOlder(false));
    }
    if (dist < EDGE_PX && win.hasMoreAfter) void loadNewer(roomId).catch(() => undefined);
    maybeMarkRead();
  }, [roomId, recordAnchor, maybeMarkRead]);

  // After every change to what's shown: keep the view where it was.
  const prevLast = useRef(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !w) return;
    if (initialScroll.current) {
      if (useRoomsStore.getState().jump?.roomId === roomId) return; // the jump effect places it
      initialScroll.current = false;
      const line = el.querySelector<HTMLElement>("[data-new-line]");
      const lineTop = line ? line.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : 0;
      if (line && el.scrollHeight - lineTop > el.clientHeight * 0.7) {
        el.scrollTop = Math.max(0, lineTop - el.clientHeight * 0.3);
        atBottom.current = false;
      } else {
        scrollToBottom();
      }
      prevLast.current = lastSeq;
      recordAnchor();
      maybeMarkRead();
      return;
    }
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if (anchor.current) {
      const row = el.querySelector<HTMLElement>(`[data-id="${CSS.escape(anchor.current.id)}"]`);
      if (row) {
        const delta = row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.current.offset;
        if (Math.abs(delta) > 0.5) el.scrollTop += delta;
      }
      if (lastSeq > prevLast.current && prevLast.current) setUnseen((n) => n + (lastSeq - prevLast.current));
    }
    prevLast.current = lastSeq;
    recordAnchor();
    maybeMarkRead();
    // A short first page that doesn't fill the view: fetch more history.
    if (el.scrollHeight <= el.clientHeight + 20 && w.hasMoreBefore) void loadOlder(roomId).catch(() => undefined);
  }, [w, pending.length, roomId, lastSeq, scrollToBottom, recordAnchor, maybeMarkRead]);

  // Stay pinned to the bottom while images / embeds settle.
  useEffect(() => {
    const el = scroller.current;
    const inner = el?.firstElementChild;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [roomId]);

  // Sending a message brings you back to the latest.
  const prevPending = useRef(pending.length);
  useEffect(() => {
    if (pending.length > prevPending.current) {
      if (useRoomsStore.getState().windows[roomId]?.hasMoreAfter) void loadTail(roomId);
      atBottom.current = true;
      requestAnimationFrame(scrollToBottom);
    }
    prevPending.current = pending.length;
  }, [pending.length, roomId, scrollToBottom]);

  // ---- jump to a message (search, pins, a reply's quote) ----
  useEffect(() => {
    if (!jump || jump.roomId !== roomId || !w) {
      if (jump && jump.roomId === roomId && !w && jumpTried.current !== jump.nonce) {
        jumpTried.current = jump.nonce;
        atBottom.current = false;
        loadAround(roomId, jump.seq).catch(() => {
          toast.error("Couldn't load that message.");
          useRoomsStore.getState().clearJump();
        });
      }
      return;
    }
    const el = scroller.current;
    const target = w.messages.find((m) => m.seq === jump.seq);
    const row = target && el?.querySelector<HTMLElement>(`[data-id="${CSS.escape(target.id)}"]`);
    if (row && el) {
      initialScroll.current = false;
      atBottom.current = false;
      row.scrollIntoView({ block: "center" });
      setHighlightId(target.id);
      window.setTimeout(() => setHighlightId((h) => (h === target.id ? null : h)), 2200);
      useRoomsStore.getState().clearJump();
      recordAnchor();
      onScroll();
      return;
    }
    if (jumpTried.current === jump.nonce) {
      initialScroll.current = false;
      toast.info("That message isn't available any more.");
      useRoomsStore.getState().clearJump();
      return;
    }
    jumpTried.current = jump.nonce;
    atBottom.current = false;
    loadAround(roomId, jump.seq).catch(() => {
      toast.error("Couldn't load that message.");
      useRoomsStore.getState().clearJump();
    });
  }, [jump, w, roomId, recordAnchor, onScroll]);

  const jumpToLatest = () => {
    if (w?.hasMoreAfter) {
      void loadTail(roomId).then(() => {
        atBottom.current = true;
        requestAnimationFrame(scrollToBottom);
      });
    } else {
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
      atBottom.current = true;
      setUnseen(0);
    }
  };

  const onJumpLocal = useCallback(
    (seq: number, id?: string) => {
      const win = useRoomsStore.getState().windows[roomId];
      const hit = win?.messages.find((m) => (id ? m.id === id : m.seq === seq));
      if (hit) useRoomsStore.getState().requestJump(roomId, hit.seq);
      else if (seq > 0) useRoomsStore.getState().requestJump(roomId, seq);
      else toast.info("That message is further back than what's loaded.");
    },
    [roomId],
  );

  const listCtx = useMemo<MessageCtx>(() => ({ ...ctx, onJump: onJumpLocal }), [ctx, onJumpLocal]);

  if (error && !w) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-[var(--text-muted)]">
        Couldn't load messages.
        <button
          type="button"
          className="font-semibold text-[var(--item-accent)] underline"
          onClick={() => {
            setError(false);
            loadTail(roomId).catch(() => setError(true));
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const showPending = !!w && !w.hasMoreAfter;
  const lastShown = messages?.[messages.length - 1];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
        role="log"
        aria-label={`Messages in ${title}`}
        aria-live="off"
        tabIndex={0}
      >
        <div className="flex min-h-full flex-col justify-end pb-2">
          {!w ? (
            <div className="flex flex-1 items-center justify-center py-16 text-[var(--text-muted)]">
              <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading messages" />
            </div>
          ) : (
            <>
              {w.hasMoreBefore ? (
                <div className="flex h-12 items-center justify-center text-[var(--text-muted)]">
                  {loadingOlder && <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading older messages" />}
                </div>
              ) : (
                <RoomStart room={room} title={title} empty={w.messages.length === 0 && pending.length === 0 ? empty : null} />
              )}
              {w.messages.map((m, i) => {
                const prev = w.messages[i - 1];
                const newDay = !prev || !sameDay(prev.created_at, m.created_at);
                const newLine =
                  newAfter !== null &&
                  m.seq > newAfter &&
                  (!prev || prev.seq <= newAfter) &&
                  !(m.kind === "user" && m.author_id === ctx.meId);
                return (
                  <Fragment key={m.id}>
                    {newDay && <DayDivider label={dayLabel(m.created_at)} />}
                    {newLine && (
                      <div data-new-line className="relative my-1 flex items-center px-4" role="separator" aria-label="New messages">
                        <span className="h-px flex-1 bg-[var(--danger)]" />
                        <span className="ml-2 rounded bg-[var(--danger)] px-1.5 text-[10px] font-bold uppercase tracking-wide text-white">New</span>
                      </div>
                    )}
                    <MessageItem m={m} grouped={!newDay && !newLine && groupsWith(prev, m)} highlight={highlightId === m.id} ctx={listCtx} />
                  </Fragment>
                );
              })}
              {showPending &&
                pending.map((p, i) => (
                  <PendingItem
                    key={p.client_id}
                    p={p}
                    ctx={listCtx}
                    grouped={i > 0 || (lastShown?.kind === "user" && lastShown.author_id === ctx.meId && !p.reply_to_id)}
                    onRetry={() => void sendMessage(qc, roomId, p, p)}
                    onDiscard={() => useRoomsStore.getState().removePending(roomId, p.client_id)}
                  />
                ))}
            </>
          )}
        </div>
      </div>
      {(farFromBottom || unseen > 0) && w && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 z-10 inline-flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full bg-[var(--item-accent)] px-4 text-sm font-semibold text-white shadow-[var(--shadow-lg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <ArrowDown className="h-4 w-4" />
          {unseen > 0 ? `${unseen} new message${unseen === 1 ? "" : "s"}` : "Jump to latest"}
        </button>
      )}
      <SrOnly live="polite">{unseen > 0 ? `${unseen} new message${unseen === 1 ? "" : "s"}` : ""}</SrOnly>
    </div>
  );
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="my-2 flex items-center gap-3 px-4" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-[var(--border)]" />
      <span className="text-[11px] font-semibold text-[var(--text-muted)]">{label}</span>
      <span className="h-px flex-1 bg-[var(--border)]" />
    </div>
  );
}

function RoomStart({ room, title, empty }: { room: Room; title: string; empty: ReactNode }) {
  const dm = !room.space_id;
  return (
    <div className={cn("flex flex-col gap-2 px-4 pb-4 pt-8")}>
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]">
        {dm ? <MessagesSquare className="h-7 w-7" /> : <Hash className="h-7 w-7" />}
      </span>
      <h2 className="text-xl font-bold text-[var(--text)]">{dm ? title : `Welcome to #${title}`}</h2>
      <p className="max-w-lg text-sm text-[var(--text-muted)]">
        {dm
          ? `This is the start of your conversation with ${title}.`
          : room.topic || `This is the start of #${title}.`}{" "}
        Type <b>@promptly</b> in a message to ask Promptly — it only reads{" "}
        {room.ai_context ? "this room's recent messages" : "the message that mentions it"}.
      </p>
      {empty}
    </div>
  );
}
