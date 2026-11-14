import { BellOff } from "lucide-react";
import { useEffect, useState } from "react";

import type { RoomUser } from "@/api/rooms";
import { cn } from "@/utils/cn";

import { isMuted, muteChoices, mutedUntilLabel, RECEIPT_WORD, type ReceiptMark } from "../receipts";
import { UserAvatar } from "./ui";

/** Under one of your messages in a conversation: who has seen up to here, or
 *  Sent / Delivered on your latest. */
export function ReceiptLine({ mark, users, solo }: { mark: ReceiptMark; users: Record<string, RoomUser>; solo?: boolean }) {
  if (mark.seenBy.length > 0) {
    const names = mark.seenBy.map((id) => users[id]?.username ?? "Someone");
    const label = `Seen by ${names.join(", ")}`;
    return (
      <div className="flex items-center justify-end gap-1 px-4 pb-1 pt-0.5" role="note" aria-label={label} title={label}>
        {solo && <span className="text-[11px] leading-none text-[var(--text-muted)]">Seen</span>}
        <span className="flex -space-x-1">
          {mark.seenBy.slice(0, 6).map((id) => (
            <UserAvatar key={id} user={users[id]} size={14} className="ring-1 ring-[var(--bg)]" />
          ))}
        </span>
        {mark.seenBy.length > 6 && <span className="text-[11px] leading-none text-[var(--text-muted)]">+{mark.seenBy.length - 6}</span>}
      </div>
    );
  }
  if (!mark.state) return null;
  return (
    <div className="flex justify-end px-4 pb-1 pt-0.5" role="note">
      <span className="text-[11px] leading-none text-[var(--text-muted)]">{RECEIPT_WORD[mark.state]}</span>
    </div>
  );
}

/** "Mute for 1 hour / 8 hours / Until tomorrow", or "Muted until 3:40 pm · Unmute". */
export function MuteControl({
  until,
  onChange,
  className,
}: {
  until: string | null | undefined;
  onChange: (until: string | null) => void;
  className?: string;
}) {
  // The mute ends by itself: show that without a reload.
  const [, tick] = useState(0);
  const muted = isMuted(until);
  useEffect(() => {
    if (!muted || !until) return;
    const ms = Date.parse(until) - Date.now();
    const t = window.setTimeout(() => tick((n) => n + 1), Math.min(Math.max(ms, 0) + 500, 2_000_000_000));
    return () => window.clearTimeout(t);
  }, [muted, until]);

  const chip =
    "inline-flex h-9 items-center rounded-full border border-[var(--border)] px-3 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
  if (muted && until) {
    return (
      <div className={cn("flex flex-wrap items-center gap-2", className)}>
        <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <BellOff className="h-3.5 w-3.5" aria-hidden /> {mutedUntilLabel(until)}
        </span>
        <button type="button" className={chip} onClick={() => onChange(null)}>
          Unmute
        </button>
      </div>
    );
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <span className="text-xs text-[var(--text-muted)]">Mute for</span>
      {muteChoices().map((c) => (
        <button key={c.key} type="button" className={chip} onClick={() => onChange(c.until)}>
          {c.label}
        </button>
      ))}
    </div>
  );
}
