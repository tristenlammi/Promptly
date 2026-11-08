/**
 * A call's line in the conversation (the server's system message with
 * ``meta.call``), in each person's own words: "Call · 12 min", "Missed
 * call from Alice · Call back", "No answer · Call again", "You declined
 * a call". Missed calls are red, like a phone's call list.
 */
import { Phone, PhoneMissed, PhoneOff, Video } from "lucide-react";

import type { CallLineMeta } from "@/api/dmCalls";
import type { Message, RoomUser } from "@/api/rooms";
import { cn } from "@/utils/cn";

import { calls } from "../actions";
import { callLineWords } from "../words";

export function callMetaOf(m: Pick<Message, "meta">): CallLineMeta | null {
  const c = m.meta?.call as CallLineMeta | undefined;
  return c && typeof c === "object" && typeof c.id === "string" ? c : null;
}

export function CallLine({
  m,
  meta,
  meId,
  users,
  group,
  time,
  canCall,
}: {
  m: Message;
  meta: CallLineMeta;
  meId: string;
  users: Record<string, RoomUser>;
  group: boolean;
  time: string;
  canCall: boolean;
}) {
  const w = callLineWords(meta, meId, users, group);
  const Icon = w.missed ? PhoneMissed : meta.outcome === "cancelled" ? PhoneOff : meta.media === "video" ? Video : Phone;
  return (
    <div data-seq={m.seq} data-id={m.id} className="flex justify-center px-4 py-1.5" data-testid="call-line">
      <span
        className={cn(
          "inline-flex max-w-[90%] flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-full border px-3 py-1.5 text-xs",
          w.missed ? "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]",
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className={cn("font-medium", !w.missed && "text-[var(--text)]")}>{w.text}</span>
        <span aria-hidden>·</span>
        <span>{time}</span>
        {w.again && canCall && m.room_id && (
          <button
            type="button"
            onClick={() => void calls.start(m.room_id, meta.media)}
            className="font-semibold text-[var(--item-accent)] underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {w.again}
          </button>
        )}
      </span>
    </div>
  );
}
