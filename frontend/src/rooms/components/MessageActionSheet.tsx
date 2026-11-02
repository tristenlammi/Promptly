import { Copy, CornerUpLeft, Pencil, Pin, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";

import type { Message } from "@/api/rooms";
import { Sheet } from "@/items/ui";
import { cn } from "@/utils/cn";

import { copyText, deleteMessage, togglePin, toggleReaction } from "../actions";
import { QUICK_REACTIONS } from "../emoji";
import { plainSnippet } from "../format";
import { EmojiGrid } from "./ui";

/** Long-press a message on a phone: react, reply, edit, pin, copy, delete. */
export function MessageActionSheet({
  m,
  onClose,
  meId,
  canModerate,
  onReply,
  onEdit,
}: {
  m: Message | null;
  onClose: () => void;
  meId: string;
  canModerate: boolean;
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
}) {
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [m?.id]);
  if (!m) return null;
  const own = m.kind === "user" && m.author_id === meId;
  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Sheet open={!!m} onClose={onClose} title={plainSnippet(m.body, 60) || "Message"}>
      {more ? (
        <EmojiGrid
          onPick={(e) => {
            toggleReaction(m, e, meId);
            onClose();
          }}
        />
      ) : (
        <div className="flex flex-col gap-3 pb-2">
          <div className="flex justify-between gap-1">
            {QUICK_REACTIONS.map((e) => {
              const mine = m.reactions.some((r) => r.emoji === e && r.user_ids.includes(meId));
              return (
                <button
                  key={e}
                  type="button"
                  aria-label={`React ${e}`}
                  aria-pressed={mine}
                  onClick={act(() => toggleReaction(m, e, meId))}
                  className={cn(
                    "flex h-12 w-12 items-center justify-center rounded-full text-2xl",
                    mine ? "bg-[color-mix(in_srgb,var(--item-accent)_18%,transparent)]" : "bg-[var(--surface-2)]",
                  )}
                >
                  {e}
                </button>
              );
            })}
            <button
              type="button"
              aria-label="More reactions"
              onClick={() => setMore(true)}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
          <div className="flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            <Row icon={CornerUpLeft} label="Reply" onClick={act(() => onReply(m))} />
            {own && typeof m.meta?.event_id !== "string" && !m.meta?.event_reminder && (!m.meta?.share || (m.meta.share as { has_note?: boolean }).has_note) && <Row icon={Pencil} label="Edit" onClick={act(() => onEdit(m))} />}
            <Row icon={Pin} label={m.pinned ? "Unpin" : "Pin"} onClick={act(() => void togglePin(m))} />
            {m.body && <Row icon={Copy} label="Copy text" onClick={act(() => void copyText(m))} />}
            {(own || canModerate) && <Row icon={Trash2} label="Delete" danger onClick={act(() => void deleteMessage(m))} />}
          </div>
        </div>
      )}
    </Sheet>
  );
}

function Row({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-12 items-center gap-3 border-b border-[var(--border)] px-4 text-left text-[15px] last:border-b-0 active:bg-[var(--hover)]",
        danger ? "text-[var(--danger)]" : "text-[var(--text)]",
      )}
    >
      <Icon className="h-5 w-5" />
      {label}
    </button>
  );
}
