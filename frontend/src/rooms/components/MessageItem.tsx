import { AlertCircle, Copy, CornerUpLeft, Loader2, MoreHorizontal, Pencil, Pin, RotateCw, SmilePlus, Trash2 } from "lucide-react";
import { memo, useRef, useState, type ReactNode } from "react";

import type { Message, RoomUser } from "@/api/rooms";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { copyText, deleteMessage, togglePin, toggleReaction } from "../actions";
import { QUICK_REACTIONS } from "../emoji";
import { fullDate, plainSnippet, timeOf } from "../format";
import type { PendingMessage } from "../store";
import { AttachmentList } from "./Attachments";
import { MessageBody } from "./MessageBody";
import { EmojiGrid, Popover, PromptlyAvatar, UserAvatar } from "./ui";

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
}

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
  const own = m.kind === "user" && m.author_id === ctx.meId;

  if (m.kind === "system") {
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
      className={cn(
        "group relative flex gap-3 px-3 transition-colors md:px-4",
        grouped ? "py-0.5" : "pt-2 pb-0.5",
        isPromptly && "bg-[color-mix(in_srgb,var(--item-accent)_7%,transparent)]",
        highlight && "!bg-[color-mix(in_srgb,#C08B2C_22%,transparent)]",
        !ctx.isPhone && "hover:bg-[var(--hover)]",
        ctx.isPhone && "select-none [-webkit-touch-callout:none]",
      )}
    >
      <div className="w-9 shrink-0">
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
            className="invisible block pt-0.5 text-right text-[10px] leading-5 text-[var(--text-muted)] group-hover:visible"
          >
            {timeOf(m.created_at).replace(/\s?[AP]M$/i, "")}
          </time>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className={cn("truncate text-sm font-semibold", isPromptly ? "text-[var(--item-accent)]" : "text-[var(--text)]")}>{name}</span>
            {isPromptly && typeof m.meta?.asked_by === "string" && (
              <span className="truncate text-[11px] text-[var(--text-muted)]">answering {ctx.users[m.meta.asked_by as string]?.username ?? "someone"}</span>
            )}
            <time dateTime={m.created_at} title={fullDate(m.created_at)} className="shrink-0 text-[11px] text-[var(--text-muted)]">
              {timeOf(m.created_at)}
            </time>
          </div>
        )}
        {m.reply_to && <ReplyQuote reply={m.reply_to} users={ctx.users} onJump={ctx.onJump} />}
        {m.deleted ? (
          <p className="text-sm italic text-[var(--text-muted)]">Message deleted</p>
        ) : (
          <>
            {m.body && <MessageBody body={m.body} usernames={ctx.usernames} me={ctx.meName} />}
            {m.edited_at && <span className="text-[10px] text-[var(--text-muted)]" title={fullDate(m.edited_at)}>(edited)</span>}
            {m.pinned && (
              <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-[var(--text-muted)]">
                <Pin className="h-3 w-3" /> pinned
              </span>
            )}
            <AttachmentList attachments={m.attachments} />
            {m.reactions.length > 0 && <Reactions m={m} ctx={ctx} />}
          </>
        )}
      </div>

      {!ctx.isPhone && !m.deleted && (
        <div
          className={cn(
            "absolute -top-3 right-3 z-10 hidden items-center gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-0.5 shadow-[var(--shadow-sm)] group-hover:flex group-focus-within:flex",
            hoverPicker && "!flex",
          )}
        >
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
          {own && (
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
            <ToolButton label="Delete (Shift-click skips the question)" onClick={(_el, e) => void deleteMessage(m, e.shiftKey)} danger>
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
      )}
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
        "flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
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
      className="mb-0.5 flex max-w-full items-center gap-1.5 rounded-md text-left text-xs text-[var(--text-muted)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
    >
      <CornerUpLeft className="h-3 w-3 shrink-0 -scale-y-100" />
      <span className="shrink-0 font-semibold">{name}</span>
      <span className="truncate">{reply.deleted ? <i>Message deleted</i> : plainSnippet(reply.body, 100) || "Attachment"}</span>
    </button>
  );
}

function Reactions({ m, ctx }: { m: Message; ctx: MessageCtx }) {
  const longPress = useRef<number | null>(null);
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {m.reactions.map((r) => {
        const mine = r.user_ids.includes(ctx.meId);
        const names = r.user_ids.map((id) => (id === ctx.meId ? "You" : ctx.users[id]?.username ?? "Someone")).join(", ");
        return (
          <button
            key={r.emoji}
            type="button"
            aria-pressed={mine}
            aria-label={`${r.emoji} ${r.user_ids.length} — ${names}`}
            title={names}
            onClick={() => toggleReaction(m, r.emoji, ctx.meId)}
            onTouchStart={() => {
              longPress.current = window.setTimeout(() => toast.info(`${r.emoji} ${names}`), 500);
            }}
            onTouchEnd={() => longPress.current && window.clearTimeout(longPress.current)}
            onTouchMove={() => longPress.current && window.clearTimeout(longPress.current)}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-full border px-2 text-xs font-medium tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
              mine
                ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--text)]"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            <span className="text-sm leading-none">{r.emoji}</span>
            {r.user_ids.length}
          </button>
        );
      })}
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
    <div className={cn("flex gap-3 px-3 md:px-4", grouped ? "py-0.5" : "pt-2 pb-0.5", !failed && "opacity-60")}>
      <div className="w-9 shrink-0">{!grouped && <UserAvatar user={ctx.users[ctx.meId]} size={36} />}</div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-[var(--text)]">{ctx.meName}</span>
            <span className="text-[11px] text-[var(--text-muted)]">{failed ? "Not sent" : "Sending…"}</span>
          </div>
        )}
        {p.body && <MessageBody body={p.body} usernames={ctx.usernames} me={ctx.meName} />}
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
