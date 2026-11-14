/**
 * Something on its way into Rooms: from the phone's share sheet ("Share → P
 * Rooms": photos, videos, files, a link or some words, stashed by the service
 * worker in ``lib/shareTargetStash``), or from another part of Promptly
 * ("Send in Rooms" on an email, a place or a trip; see ``sendInRooms``). The
 * app takes it here, asks which conversation it's for, and that
 * conversation's composer picks it up as attachments, a place and a draft.
 * Nothing is sent until you press Send.
 */
import { useSyncExternalStore } from "react";

import type { SharedPlace } from "@/api/rooms";

export interface IncomingShare {
  files: File[];
  text: string;
  /** A place from P Maps, sent as a card. */
  place: SharedPlace | null;
  /** The conversation it's going to, once chosen. */
  roomId: string | null;
}

let current: IncomingShare | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setIncomingShare(files: File[], text: string, place: SharedPlace | null = null) {
  if (!files.length && !text.trim() && !place) return;
  current = { files, text: text.trim(), place, roomId: null };
  emit();
}

/**
 * "Send in Rooms" from elsewhere in Promptly: leave the words (and a place)
 * here and open Rooms, which asks who it's for. ``go`` is the router's
 * navigate. Nothing is sent until Send is pressed in the conversation.
 */
export function sendInRooms(go: (to: string) => void, what: { text?: string; place?: SharedPlace | null }) {
  setIncomingShare([], what.text ?? "", what.place ?? null);
  if (current) go("/rooms/");
}

/** Send it to this conversation: its composer takes it from here. */
export function aimIncomingShare(roomId: string) {
  if (!current) return;
  current = { ...current, roomId };
  emit();
}

export function dropIncomingShare() {
  if (!current) return;
  current = null;
  emit();
}

/** The composer of ``roomId`` takes what's waiting for it (once). */
export function takeIncomingShare(roomId: string): { files: File[]; text: string; place: SharedPlace | null } | null {
  if (!current || current.roomId !== roomId) return null;
  const got = { files: current.files, text: current.text, place: current.place };
  current = null;
  emit();
  return got;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useIncomingShare(): IncomingShare | null {
  return useSyncExternalStore(subscribe, () => current);
}
