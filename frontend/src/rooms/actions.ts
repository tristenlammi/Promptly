import type { QueryClient } from "@tanstack/react-query";

import { roomsApi, type Attachment, type Message } from "@/api/rooms";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { patchRoom } from "./cache";
import { newClientId } from "./format";
import { useRoomsStore, type PendingMessage } from "./store";

export function toggleReaction(m: Message, emoji: string, meId: string) {
  const store = useRoomsStore.getState();
  const had = m.reactions.some((r) => r.emoji === emoji && r.user_ids.includes(meId));
  const before = m.reactions;
  // Optimistic: the server's ``reaction`` event replaces this with the truth.
  store.patchMessage(m.room_id, m.id, (cur) => {
    let reactions = cur.reactions.map((r) =>
      r.emoji === emoji ? { ...r, user_ids: had ? r.user_ids.filter((u) => u !== meId) : [...r.user_ids, meId] } : r,
    );
    if (!had && !reactions.some((r) => r.emoji === emoji)) reactions = [...reactions, { emoji, user_ids: [meId] }];
    return { ...cur, reactions: reactions.filter((r) => r.user_ids.length > 0) };
  });
  const call = had ? roomsApi.removeReaction(m.id, emoji) : roomsApi.addReaction(m.id, emoji);
  call.catch((err) => {
    store.patchMessage(m.room_id, m.id, (cur) => ({ ...cur, reactions: before }));
    toast.error(apiErrorMessage(err, "Couldn't react to that message."));
  });
}

export async function togglePin(m: Message) {
  const store = useRoomsStore.getState();
  store.patchMessage(m.room_id, m.id, (cur) => ({ ...cur, pinned: !m.pinned }));
  try {
    const updated = await roomsApi.editMessage(m.id, { pinned: !m.pinned });
    if (updated) store.upsertMessage(updated);
    toast.success(m.pinned ? "Unpinned" : "Pinned to this room");
  } catch (err) {
    store.patchMessage(m.room_id, m.id, (cur) => ({ ...cur, pinned: m.pinned }));
    toast.error(apiErrorMessage(err, "Couldn't pin that message."));
  }
}

/** How long "Undo" stays on offer after a delete. */
const UNDO_MS = 10_000;

/** Delete now, for everyone, with a few seconds to change your mind: Undo
 *  asks the server to put the message back exactly as it was. */
export function deleteMessage(m: Message) {
  if (m.deleted) return;
  const store = useRoomsStore.getState();
  store.patchMessage(m.room_id, m.id, (cur) => ({ ...cur, deleted: true, body: "", attachments: [], reactions: [] }));
  roomsApi.deleteMessage(m.id).then(
    () => {
      toast.success("Message deleted", {
        duration: UNDO_MS,
        action: {
          label: "Undo",
          onClick: () => {
            roomsApi.restoreMessage(m.id).then(
              (back) => store.upsertMessage(back),
              (err) => toast.error(apiErrorMessage(err, "Couldn't bring that message back.")),
            );
          },
        },
      });
    },
    (err) => {
      store.patchMessage(m.room_id, m.id, () => m);
      toast.error(apiErrorMessage(err, "Couldn't delete that message, so it's back."));
    },
  );
}

export async function editMessage(m: Message, body: string): Promise<boolean> {
  const store = useRoomsStore.getState();
  const prev = m;
  store.patchMessage(m.room_id, m.id, (cur) => ({ ...cur, body, edited_at: new Date().toISOString() }));
  try {
    const updated = await roomsApi.editMessage(m.id, { body });
    if (updated) store.upsertMessage(updated);
    return true;
  } catch (err) {
    store.patchMessage(m.room_id, m.id, () => prev);
    toast.error(apiErrorMessage(err, "Couldn't save your edit."));
    return false;
  }
}

export async function copyText(m: Message) {
  try {
    await navigator.clipboard.writeText(m.body);
    toast.success("Copied");
  } catch {
    toast.error("Couldn't copy — your browser blocked the clipboard.");
  }
}

/** Optimistic send: a pending row appears at once and is swapped for the
 *  real message when the server answers (or its live event arrives). */
export async function sendMessage(
  qc: QueryClient,
  roomId: string,
  input: { body: string; reply_to_id: string | null; attachments: Attachment[] },
  retryOf?: PendingMessage,
) {
  const store = useRoomsStore.getState();
  const pending: PendingMessage = retryOf
    ? { ...retryOf, status: "sending" }
    : {
        client_id: newClientId(),
        room_id: roomId,
        body: input.body,
        reply_to_id: input.reply_to_id,
        attachments: input.attachments,
        status: "sending",
        created_at: new Date().toISOString(),
      };
  if (retryOf) store.setPendingStatus(roomId, retryOf.client_id, "sending");
  else store.addPending(pending);
  try {
    const msg = await roomsApi.send(roomId, {
      body: pending.body,
      reply_to_id: pending.reply_to_id,
      attachment_ids: pending.attachments.map((a) => a.id),
      client_id: pending.client_id,
    });
    store.removePending(roomId, pending.client_id);
    store.upsertMessage(msg);
    patchRoom(qc, roomId, (r) => ({
      ...r,
      last_seq: Math.max(r.last_seq, msg.seq),
      last_read_seq: Math.max(r.last_read_seq, msg.seq),
      last_message_at: msg.created_at,
      preview: { author_id: msg.author_id, body: msg.body, kind: msg.kind },
      unread: 0,
      mentions: 0,
    }));
  } catch (err) {
    store.setPendingStatus(roomId, pending.client_id, "failed");
    toast.error(apiErrorMessage(err, "Your message didn't send. Tap it to retry."));
  }
}
