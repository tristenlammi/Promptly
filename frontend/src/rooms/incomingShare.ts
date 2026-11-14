/**
 * Something shared into Rooms from the phone's share sheet ("Share → P
 * Rooms"): photos, videos, files, a link or some words. The service worker
 * stashes it (``lib/shareTargetStash``); the app takes it here, asks which
 * conversation it's for, and that conversation's composer picks it up as
 * attachments and a draft. Nothing is sent until you press Send.
 */
import { useSyncExternalStore } from "react";

export interface IncomingShare {
  files: File[];
  text: string;
  /** The conversation it's going to, once chosen. */
  roomId: string | null;
}

let current: IncomingShare | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setIncomingShare(files: File[], text: string) {
  if (!files.length && !text.trim()) return;
  current = { files, text: text.trim(), roomId: null };
  emit();
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
export function takeIncomingShare(roomId: string): { files: File[]; text: string } | null {
  if (!current || current.roomId !== roomId) return null;
  const got = { files: current.files, text: current.text };
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
