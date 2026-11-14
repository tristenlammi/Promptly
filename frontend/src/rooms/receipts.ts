/**
 * Sent → Delivered → Seen under your messages in a conversation, and
 * "mute for a while". Pure, so the unit tests run it without a browser.
 *
 * The server keeps, for each other person in a conversation, how far they've
 * read and how far the messages are known to have reached one of their
 * devices (`Room.receipts`, backend `rooms/receipts.py`). Space rooms have
 * none of this.
 */

export interface Receipt {
  read: number;
  delivered: number;
}

export type ReceiptState = "sent" | "delivered" | "seen";

export interface ReceiptMark {
  /** Who has read up to exactly here (their picture sits under this message). */
  seenBy: string[];
  /** The word under your latest message, when nobody's picture is there. */
  state?: ReceiptState;
}

interface Msg {
  id: string;
  seq: number;
  author_id: string | null;
  kind: string;
  deleted?: boolean;
}

/**
 * Where the marks go, by message id. Each person's picture sits under the
 * last of *your* messages they have read (once they've written something
 * after it, it's plain they've seen it, so there's no picture). Your latest
 * message says Sent or Delivered until somebody has seen it.
 */
export function receiptMarks(messages: Msg[], receipts: Record<string, Receipt> | undefined, meId: string): Record<string, ReceiptMark> {
  const out: Record<string, ReceiptMark> = {};
  if (!receipts) return out;
  const people = Object.keys(receipts);
  if (people.length === 0 || messages.length === 0) return out;
  const mine = (m: Msg) => m.kind === "user" && m.author_id === meId && !m.deleted;

  for (const uid of people) {
    const read = receipts[uid].read;
    // The last thing they've read that's on screen.
    let at: Msg | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].seq <= read) {
        at = messages[i];
        break;
      }
    }
    if (at && mine(at)) (out[at.id] ??= { seenBy: [] }).seenBy.push(uid);
  }

  let latest: Msg | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (mine(messages[i])) {
      latest = messages[i];
      break;
    }
  }
  if (latest && !out[latest.id]) {
    // Somebody has answered since: nothing to say.
    const last = messages[messages.length - 1];
    const answered = last.seq > latest.seq && messages.some((m) => m.seq > latest!.seq && m.kind === "user" && m.author_id !== meId);
    if (!answered) {
      const seq = latest.seq;
      const seen = people.some((u) => receipts[u].read >= seq);
      const delivered = people.some((u) => receipts[u].delivered >= seq);
      out[latest.id] = { seenBy: [], state: seen ? "seen" : delivered ? "delivered" : "sent" };
    }
  }
  return out;
}

export const RECEIPT_WORD: Record<ReceiptState, string> = { sent: "Sent", delivered: "Delivered", seen: "Seen" };

// ---- muting for a while ---------------------------------------------------

export function isMuted(until: string | null | undefined, now: number = Date.now()): boolean {
  if (!until) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now;
}

export interface MuteChoice {
  key: "1h" | "8h" | "tomorrow";
  label: string;
  until: string;
}

/** "Until tomorrow" is 8 in the morning by your own clock. */
export function muteChoices(now: Date = new Date()): MuteChoice[] {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  return [
    { key: "1h", label: "1 hour", until: new Date(now.getTime() + 3600_000).toISOString() },
    { key: "8h", label: "8 hours", until: new Date(now.getTime() + 8 * 3600_000).toISOString() },
    { key: "tomorrow", label: "Until tomorrow", until: tomorrow.toISOString() },
  ];
}

/** "Muted until 3:40 pm" / "Muted until Tue 8:00 am". */
export function mutedUntilLabel(until: string, now: Date = new Date()): string {
  const d = new Date(until);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  return `Muted until ${sameDay ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`}`;
}
