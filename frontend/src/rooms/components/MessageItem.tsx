import { AlertCircle, Copy, CornerUpLeft, Loader2, MoreHorizontal, Pencil, Pin, RotateCw, SmilePlus, Trash2, Users } from "lucide-react";
import { memo, useRef, useState, type ReactNode } from "react";

import type { ShareKind } from "@/api/crossapp";
import type { Message, RoomUser } from "@/api/rooms";
import { Sheet } from "@/items/ui";
import { cn } from "@/utils/cn";

import { copyText, deleteMessage, togglePin, toggleReaction } from "../actions";
import { QUICK_REACTIONS } from "../emoji";
import { fullDate, plainSnippet, timeOf } from "../format";
import type { PendingMessage } from "../store";
import { AttachmentList } from "./Attachments";
import { EventCard } from "./EventCard";
import { MessageBody } from "./MessageBody";
import { ShareCard } from "./ShareCard";
import { CallLine, callMetaOf } from "@/rtc/call/ui/CallLine";
import { EmojiGrid, Popover, PromptlyAvatar, UserAvatar } from "./ui";

/** A "Send to…" card's ``meta.share`` (see ShareCard), if this message is one. */
function shareOf(m: Message): { kind: string; label?: string; has_note?: boolean } | null {
  const s = m.meta?.share as { kind?: unknown; label?: unknown; has_note?: unknown } | undefined;
  return s && typeof s === "object" && typeof s.kind === "string"
    ? { kind: s.kind, label: typeof s.label === "string" ? s.label : undefined, has_note: s.has_note === true }
    : null;
}

export interface MessageCtx {
  meId: string;
  meName: string;
  users: Record<string, RoomUser>;
  usernames: string[];
  canModerate: boolean;
  isPhone: boolean;
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
  onJump: (seq: number, id?: string) => void;
  onActions: (m: Message) => void;
  /** Calls: a group conversation (call lines say who started it). */
  groupConversation?: boolean;
  /** Calls: "Call back" on call lines. */
  canCall?: boolean;
}

/** Room for the hover action bar beside a bubble (nine 32px buttons and their gaps). */
const TOOLBAR_W = 316;
/** A message this recent, on arrival, eases in. */
const FRESH_MS = 8000;

function authorName(m: Pick<Message, "author_id" | "kind">, users: Record<string, RoomUser>) {
  if (m.kind === "promptly") return "Promptly";
  return m.author_id ? users[m.author_id]?.username ?? "Someone" : "Someone";
}

export const MessageItem = memo(function MessageItem({
  m,
  grouped,
  highlight,
  ctx,
}: {
  m: Message;
  grouped: boolean;
  highlight: boolean;
  ctx: MessageCtx;
}) {
  const [hoverPicker, setHoverPicker] = useState<HTMLElement | null>(null);
  const press = useRef<{ t: number; x: number; y: number } | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  // The action bar sits beside a short bubble, and on the top corner of a wide one.
  const [beside, setBeside] = useState(false);
  // Phones: tap a grouped message to see when it was sent.
  const [showTime, setShowTime] = useState(false);
  const own = m.kind === "user" && m.author_id === ctx.meId;
  // Someone else's message arriving while you watch eases in (yours already
  // did, as the "Sending…" row).
  const [fresh] = useState(() => !own && Math.abs(Date.now() - new Date(m.created_at).getTime()) < FRESH_MS);

  if (m.kind === "system") {
    const call = callMetaOf(m);
    if (call) {
      return (
        <CallLine m={m} meta={call} meId={ctx.meId} users={ctx.users} group={!!ctx.groupConversation} time={timeOf(m.created_at)} canCall={!!ctx.canCall} />
      );
    }
    return (
      <div data-seq={m.seq} data-id={m.id} className="flex justify-center px-4 py-1.5">
        <span className="max-w-[80%] text-center text-xs text-[var(--text-muted)]">
          {m.body} · {timeOf(m.created_at)}
        </span>
      </div>
    );
  }

  const isPromptly = m.kind === "promptly";
  const name = authorName(m, ctx.users);
  const user = m.author_id ? ctx.users[m.author_id] : undefined;

  const onTouchStart = (e: React.TouchEvent) => {
    if (!ctx.isPhone || m.deleted) return;
    const t = e.touches[0];
    const timer = window.setTimeout(() => {
      press.current = null;
      navigator.vibrate?.(12);
      ctx.onActions(m);
    }, 450);
    press.current = { t: timer, x: t.clientX, y: t.clientY };
  };
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.t);
    press.current = null;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const p = press.current;
    if (!p) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - p.x) > 10 || Math.abs(t.clientY - p.y) > 10) cancelPress();
  };

  return (
    <div
      data-seq={m.seq}
      data-id={m.id}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={cancelPress}
      onTouchCancel={cancelPress}
      onContextMenu={(e) => {
        if (ctx.isPhone && !m.deleted) {
          e.preventDefault();
          ctx.onActions(m);
        }
      }}
      onMouseEnter={() => {
        const a = anchor.current;
        const col = a?.parentElement;
        if (a && col) setBeside(a.offsetWidth + TOOLBAR_W <= col.clientWidth);
      }}
      className={cn(
        "group relative flex gap-3 px-3 transition-colors md:px-4",
        own && "flex-row-reverse",
        grouped ? "py-0.5" : "pt-2 pb-0.5",
        fresh && "rooms-msg-in",
        isPromptly && "bg-[color-mix(in_srgb,var(--accent)_7%,transparent)]",
        highlight && "!bg-[color-mix(in_srgb,var(--warning)_22%,transparent)]",
        !ctx.isPhone && "hover:bg-[var(--hover)]",
        ctx.isPhone && "select-none [-webkit-touch-callout:none]",
      )}
    >
      <div className={cn("w-9 shrink-0", own && "hidden")}>
        {!grouped ? (
          isPromptly ? (
            <PromptlyAvatar size={36} />
          ) : (
            <UserAvatar user={user} size={36} />
          )
        ) : (
          <time
            dateTime={m.created_at}
            title={fullDate(m.created_at)}
            className="invisible block pt-0.5 text-right text-xs leading-5 text-[var(--text-muted)] group-hover:visible"
          >
            {timeOf(m.created_at).replace(/\s?[AP]M$/i, "")}
          </time>
        )}
      </div>
      <div className={cn("flex min-w-0 flex-1 flex-col", own ? "items-end pl-10 md:pl-24" : "items-start pr-10 md:pr-24")}>
        {!grouped && own && (
          <time dateTime={m.created_at} title={fullDate(m.created_at)} className="mb-0.5 text-xs text-[var(--text-muted)]">
            {timeOf(m.created_at)}
          </time>
        )}
        {!grouped && !own && (
          <div className="flex items-baseline gap-2">
            <span className={cn("truncate text-sm font-semibold", isPromptly ? "text-[var(--accent-text)]" : "text-[var(--text)]")}>{name}</span>
            {isPromptly && typeof m.meta?.asked_by === "string" && (
              <span className="truncate text-xs text-[var(--text-muted)]">answering {ctx.users[m.meta.asked_by as string]?.username ?? "someone"}</span>
            )}
            <time dateTime={m.created_at} title={fullDate(m.created_at)} className="shrink-0 text-xs text-[var(--text-muted)]">
              {timeOf(m.created_at)}
            </time>
          </div>
        )}
        {m.reply_to && <ReplyQuote reply={m.reply_to} users={ctx.users} onJump={ctx.onJump} />}
        {m.deleted ? (
          <p className="text-sm italic text-[var(--text-muted)]">Message deleted</p>
        ) : (
          <>
            <div
              ref={anchor}
              className={cn("relative flex max-w-full flex-col", own ? "items-end" : "items-start")}
              onClick={(e) => {
                if (!ctx.isPhone || !grouped) return;
                if ((e.target as HTMLElement).closest("a,button,img,video,audio,input,textarea")) return;
                setShowTime((v) => !v);
              }}
            >
            {typeof m.meta?.event_id === "string" ? (
              <EventCard eventId={m.meta.event_id} fallback={m.body} meId={ctx.meId} users={ctx.users} />
            ) : shareOf(m) ? (
              <>
                {shareOf(m)!.has_note && m.body && (
                  <Bubble own={own}>
                    <MessageBody body={m.body} usernames={ctx.usernames} me={ctx.meName} />
                  </Bubble>
                )}
                <ShareCard messageId={m.id} kind={shareOf(m)!.kind as ShareKind} label={shareOf(m)!.label} />
              </>
            ) : (
              m.body && (
                <Bubble own={own}>
                  <MessageBody body={m.body} usernames={ctx.usernames} me={ctx.meName} />
                </Bubble>
              )
            )}
            {m.edited_at && <span className="text-xs text-[var(--text-muted)]" title={fullDate(m.edited_at)}>(edited)</span>}
            {m.pinned && (
              <span className="inline-flex items-center gap-0.5 text-xs text-[var(--text-muted)]">
                <Pin className="h-3 w-3" /> pinned
              </span>
            )}
            <AttachmentList attachments={m.attachments} />
            {showTime && grouped && ctx.isPhone && (
              <time dateTime={m.created_at} className="mt-0.5 animate-[fadeIn_120ms_ease-out] text-xs text-[var(--text-muted)]">
                {timeOf(m.created_at)}
              </time>
            )}
            {/* The action bar belongs to the bubble: beside a short one, on the
                top corner of a wide one. The strip is at least as wide as the
                bubble, so the bar can't slide under the avatar or off the pane. */}
            {!ctx.isPhone && (
        <div
          className={cn(
            "pointer-events-none absolute z-10 hidden w-max group-hover:flex group-focus-within:flex",
            beside
              ? cn("top-0", own ? "right-full pr-1.5" : "left-full pl-1.5")
              : cn("-top-8 min-w-full", own ? "right-0 justify-start" : "left-0 justify-end"),
            hoverPicker && "!flex",
          )}
        >
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-0.5 shadow-[var(--shadow-sm)]">
          {QUICK_REACTIONS.slice(0, 3).map((e) => (
            <ToolButton key={e} label={`React ${e}`} onClick={() => toggleReaction(m, e, ctx.meId)}>
              <span className="text-base leading-none">{e}</span>
            </ToolButton>
          ))}
          <ToolButton label="Add reaction" onClick={(el) => setHoverPicker(hoverPicker ? null : el)}>
            <SmilePlus className="h-4 w-4" />
          </ToolButton>
          <ToolButton label="Reply" onClick={() => ctx.onReply(m)}>
            <CornerUpLeft className="h-4 w-4" />
          </ToolButton>
          {own && typeof m.meta?.event_id !== "string" && (!shareOf(m) || shareOf(m)!.has_note) && (
            <ToolButton label="Edit" onClick={() => ctx.onEdit(m)}>
              <Pencil className="h-4 w-4" />
            </ToolButton>
          )}
          <ToolButton label={m.pinned ? "Unpin" : "Pin"} onClick={() => void togglePin(m)}>
            <Pin className="h-4 w-4" />
          </ToolButton>
          <ToolButton label="Copy text" onClick={() => void copyText(m)}>
            <Copy className="h-4 w-4" />
          </ToolButton>
          {(own || ctx.canModerate) && (
            <ToolButton label="Delete" onClick={() => deleteMessage(m)} danger>
              <Trash2 className="h-4 w-4" />
            </ToolButton>
          )}
          <Popover anchor={hoverPicker} open={!!hoverPicker} onClose={() => setHoverPicker(null)} width={312}>
            <EmojiGrid
              onPick={(e) => {
                toggleReaction(m, e, ctx.meId);
                setHoverPicker(null);
              }}
            />
          </Popover>
        </div>
        </div>
            )}
            </div>
            <Reactions m={m} ctx={ctx} />
          </>
        )}
      </div>

      {ctx.isPhone && !m.deleted && (
        <button
          type="button"
          aria-label="Message actions"
          onClick={() => ctx.onActions(m)}
          className="sr-only focus:not-sr-only focus:absolute focus:right-2 focus:top-1 focus:rounded-lg focus:bg-[var(--surface)] focus:p-2"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      )}
    </div>
  );
});

/** Text in a chat bubble: yours tinted on the right, everyone else's plain on the left. */
function Bubble({ own, children }: { own: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "max-w-full rounded-2xl px-3 py-1.5",
        own
          ? "rounded-br-md bg-[color-mix(in_srgb,var(--accent)_22%,var(--surface))]"
          : "rounded-bl-md bg-[var(--surface-2)]",
      )}
    >
      {children}
    </div>
  );
}

function ToolButton({
  label,
  onClick,
  children,
  danger,
}: {
  label: string;
  onClick: (el: HTMLElement, e: React.MouseEvent) => void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => onClick(e.currentTarget, e)}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        danger && "hover:!text-[var(--danger)]",
      )}
    >
      {children}
    </button>
  );
}

function ReplyQuote({
  reply,
  users,
  onJump,
}: {
  reply: NonNullable<Message["reply_to"]>;
  users: Record<string, RoomUser>;
  onJump: (seq: number, id?: string) => void;
}) {
  const name = reply.author_id ? users[reply.author_id]?.username ?? "Someone" : "Promptly";
  return (
    <button
      type="button"
      onClick={() => onJump(reply.seq ?? -1, reply.id)}
      className="mb-0.5 flex max-w-full items-center gap-1.5 rounded-md text-left text-xs text-[var(--text-muted)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      <CornerUpLeft className="h-3 w-3 shrink-0 -scale-y-100" />
      <span className="shrink-0 font-semibold">{name}</span>
      <span className="truncate">{reply.deleted ? <i>Message deleted</i> : plainSnippet(reply.body, 100) || "Attachment"}</span>
    </button>
  );
}

function Reactions({ m, ctx }: { m: Message; ctx: MessageCtx }) {
  const longPress = useRef<number | null>(null);
  const [who, setWho] = useState<string | null>(null);
  // Chips that were here when the message first showed stay still; one
  // added while you watch pops.
  const seen = useRef<Set<string> | null>(null);
  const popped = useRef(new Set<string>());
  if (!seen.current) seen.current = new Set(m.reactions.map((r) => r.emoji));
  for (const r of m.reactions) {
    if (!seen.current.has(r.emoji)) {
      seen.current.add(r.emoji);
      popped.current.add(r.emoji);
    }
  }
  const cancel = () => {
    if (longPress.current) window.clearTimeout(longPress.current);
    longPress.current = null;
  };
  const nameOf = (id: string) => (id === ctx.meId ? "You" : ctx.users[id]?.username ?? "Someone");
  if (m.reactions.length === 0) return null;
  const shown = who ? m.reactions.find((r) => r.emoji === who) ?? m.reactions[0] : undefined;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {m.reactions.map((r) => {
        const mine = r.user_ids.includes(ctx.meId);
        const names = r.user_ids.map(nameOf).join(", ");
        return (
          <button
            key={r.emoji}
            type="button"
            aria-pressed={mine}
            aria-label={`${r.emoji} ${r.user_ids.length}: ${names}`}
            title={names}
            onClick={() => toggleReaction(m, r.emoji, ctx.meId)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              cancel();
              setWho(r.emoji);
            }}
            onTouchStart={(e) => {
              // Holding a chip shows who reacted (not the message's own menu).
              e.stopPropagation();
              cancel();
              longPress.current = window.setTimeout(() => {
                navigator.vibrate?.(12);
                setWho(r.emoji);
              }, 450);
            }}
            onTouchEnd={cancel}
            onTouchMove={cancel}
            onTouchCancel={cancel}
            className={cn(
              "inline-flex h-9 min-w-[3rem] items-center justify-center gap-1.5 rounded-full border px-2.5 text-sm font-medium tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] md:h-8",
              popped.current.has(r.emoji) && "rooms-reaction-pop",
              mine
                ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--text)]"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            <span className="text-base leading-none">{r.emoji}</span>
            {r.user_ids.length}
          </button>
        );
      })}
      {!ctx.isPhone && (
        <button
          type="button"
          aria-label="See who reacted"
          title="See who reacted"
          onClick={() => setWho(m.reactions[0].emoji)}
          className="hidden h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] group-hover:flex"
        >
          <Users className="h-4 w-4" />
        </button>
      )}
      {/* The sheet is drawn elsewhere on the page, but its taps still bubble
          up to this row; stop them opening the message's own menu. */}
      <div
        className="contents"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
      <Sheet open={!!shown} onClose={() => setWho(null)} title="Who reacted" size="sm">
        {shown && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Reactions">
              {m.reactions.map((r) => (
                <button
                  key={r.emoji}
                  type="button"
                  role="tab"
                  aria-selected={r.emoji === shown.emoji}
                  onClick={() => setWho(r.emoji)}
                  className={cn(
                    "inline-flex h-10 min-w-[3.25rem] items-center justify-center gap-1.5 rounded-full border px-3 text-sm font-medium tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                    r.emoji === shown.emoji
                      ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--text)]"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]",
                  )}
                >
                  <span className="text-base leading-none">{r.emoji}</span>
                  {r.user_ids.length}
                </button>
              ))}
            </div>
            <ul className="flex flex-col">
              {shown.user_ids.map((id) => (
                <li key={id} className="flex min-h-[44px] items-center gap-3 py-1">
                  <UserAvatar user={ctx.users[id]} size={32} />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{nameOf(id)}</span>
                  <span className="text-lg leading-none">{shown.emoji}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Sheet>
      </div>
    </div>
  );
}

/** An optimistic send that's still on its way (or failed). */
export function PendingItem({
  p,
  grouped,
  ctx,
  onRetry,
  onDiscard,
}: {
  p: PendingMessage;
  grouped: boolean;
  ctx: MessageCtx;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const failed = p.status === "failed";
  return (
    <div className={cn("rooms-msg-in flex flex-row-reverse gap-3 px-3 md:px-4", grouped ? "py-0.5" : "pt-2 pb-0.5", !failed && "opacity-60")}>
      <div className="flex min-w-0 flex-1 flex-col items-end pl-10 md:pl-24">
        {!grouped && <span className="mb-0.5 text-xs text-[var(--text-muted)]">{failed ? "Not sent" : "Sending…"}</span>}
        {p.body && (
          <Bubble own>
            <MessageBody body={p.body} usernames={ctx.usernames} me={ctx.meName} />
          </Bubble>
        )}
        {p.attachments.length > 0 && <AttachmentList attachments={p.attachments} />}
        {failed ? (
          <div className="mt-1 flex items-center gap-2 text-xs text-[var(--danger)]">
            <AlertCircle className="h-3.5 w-3.5" /> Didn't send.
            <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-semibold underline">
              <RotateCw className="h-3 w-3" /> Retry
            </button>
            <button type="button" onClick={onDiscard} className="font-semibold text-[var(--text-muted)] underline">
              Discard
            </button>
          </div>
        ) : (
          <Loader2 className="mt-0.5 h-3 w-3 animate-spin text-[var(--text-muted)]" aria-label="Sending" />
        )}
      </div>
    </div>
  );
}
