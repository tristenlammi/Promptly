/**
 * Messages you sent that haven't reached the server yet (still sending, or
 * failed), kept on this device so a reload or a closed tab doesn't lose them.
 * When Rooms opens again they're back under the conversation and go out by
 * themselves; the server knows each one by its client id, so a message that
 * did arrive just before the reload isn't posted twice.
 *
 * Kept per person, on this device only. Storage can be missing or full
 * (private windows): every read and write may fail quietly, and sending then
 * works exactly as before.
 */
import type { QueryClient } from "@tanstack/react-query";

import { sendMessage } from "./actions";
import { useRoomsStore, type PendingMessage } from "./store";

/** The server recognises a resend for two days; older ones wait for a tap. */
const AUTO_RESEND_MS = 46 * 3600_000;
const KEEP_MS = 7 * 24 * 3600_000;
const MAX_KEPT = 100;

export const OUTBOX_PREFIX = "promptly:rooms:outbox:";
const keyFor = (meId: string) => `${OUTBOX_PREFIX}${meId}`;

function isPending(x: unknown): x is PendingMessage {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p.client_id === "string" &&
    typeof p.room_id === "string" &&
    typeof p.body === "string" &&
    typeof p.created_at === "string" &&
    Array.isArray(p.attachments)
  );
}

export function readOutbox(meId: string, now = Date.now()): PendingMessage[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(keyFor(meId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPending).filter((p) => {
      const at = Date.parse(p.created_at);
      return Number.isFinite(at) && now - at < KEEP_MS;
    });
  } catch {
    return [];
  }
}

function writeOutbox(meId: string, list: PendingMessage[]) {
  try {
    if (list.length === 0) localStorage.removeItem(keyFor(meId));
    else localStorage.setItem(keyFor(meId), JSON.stringify(list.slice(-MAX_KEPT)));
  } catch {
    /* in memory only */
  }
}

/** What changed between two views of the pending list, by client id. */
export function outboxDiff(before: PendingMessage[], after: PendingMessage[]): { added: PendingMessage[]; removed: string[] } {
  const was = new Set(before.map((p) => p.client_id));
  const is = new Set(after.map((p) => p.client_id));
  return { added: after.filter((p) => !was.has(p.client_id)), removed: before.filter((p) => !is.has(p.client_id)).map((p) => p.client_id) };
}

const flat = (pending: Record<string, PendingMessage[]>) => Object.values(pending).flat();

/**
 * Bring back what was waiting, send it, and keep the saved copy in step with
 * the page from here on. Another tab's waiting messages are left alone: each
 * change is applied to the saved list one message at a time.
 */
export function startOutbox(meId: string, qc: QueryClient): () => void {
  const store = useRoomsStore;
  const have = new Set(flat(store.getState().pending).map((p) => p.client_id));
  const back = readOutbox(meId).filter((p) => !have.has(p.client_id));
  // What they were doing when the page went away is unknown: "not sent" until
  // the resend below says otherwise.
  for (const p of back) store.getState().addPending({ ...p, status: "failed" });
  let seen = flat(store.getState().pending);

  const unsubscribe = store.subscribe((s, prev) => {
    if (s.pending === prev.pending) return;
    const now = flat(s.pending);
    const { added, removed } = outboxDiff(seen, now);
    seen = now;
    if (added.length === 0 && removed.length === 0) return;
    const gone = new Set(removed);
    const kept = readOutbox(meId).filter((p) => !gone.has(p.client_id));
    const known = new Set(kept.map((p) => p.client_id));
    writeOutbox(meId, [...kept, ...added.filter((p) => !known.has(p.client_id)).map((p) => ({ ...p, status: "failed" as const }))]);
  });

  if (typeof navigator === "undefined" || navigator.onLine !== false) {
    const now = Date.now();
    for (const p of back) {
      if (now - Date.parse(p.created_at) < AUTO_RESEND_MS) void sendMessage(qc, p.room_id, p, { ...p, status: "failed" }, { quiet: true });
    }
  }
  return unsubscribe;
}
