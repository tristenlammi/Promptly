import { create } from "zustand";

import type { Attachment, Message } from "@/api/rooms";

/**
 * Client state for Rooms that isn't a plain server read:
 *
 *  - **windows** — for each room, one contiguous run of loaded messages
 *    ``[first..last]`` with ``hasMoreBefore`` / ``hasMoreAfter``. Paging
 *    grows it at one end and trims it at the other past ``MAX_WINDOW``, so
 *    the DOM stays bounded and a jump (``around``) just replaces it.
 *  - **pending** — optimistic sends (``client_id``), shown after the window.
 *  - **typing** / **thinking** — short-lived live indicators.
 *
 * The bootstrap (spaces, rooms, DMs, users, unread counts) is react-query's
 * ``["rooms", "bootstrap"]``; see ``cache.ts``.
 */

export const MAX_WINDOW = 300;

export interface RoomWindow {
  messages: Message[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  /** Bumped whenever the window is replaced (a jump / reload) so the list
   *  knows to re-anchor instead of treating it as a page. */
  version: number;
}

export interface PendingMessage {
  client_id: string;
  room_id: string;
  body: string;
  reply_to_id: string | null;
  attachments: Attachment[];
  status: "sending" | "failed";
  created_at: string;
}

export interface JumpTarget {
  roomId: string;
  seq: number;
  /** Unique per request so jumping twice to the same message re-scrolls. */
  nonce: number;
}

export type RailSel = "dms" | string;

interface RoomsState {
  windows: Record<string, RoomWindow>;
  pending: Record<string, PendingMessage[]>;
  /** roomId → userId → expiry (ms). */
  typing: Record<string, Record<string, number>>;
  thinking: Record<string, boolean>;
  railSel: RailSel | null;
  jump: JumpTarget | null;

  setWindow: (roomId: string, w: Omit<RoomWindow, "version">) => void;
  /** Merge a page into the window at one end. */
  addPage: (roomId: string, page: Message[], dir: "before" | "after", hasMore: boolean) => void;
  /** A live message (or the server's answer to a send). */
  upsertMessage: (m: Message) => void;
  patchMessage: (roomId: string, id: string, patch: (m: Message) => Message) => void;
  dropRoom: (roomId: string) => void;

  addPending: (p: PendingMessage) => void;
  setPendingStatus: (roomId: string, clientId: string, status: PendingMessage["status"]) => void;
  removePending: (roomId: string, clientId: string) => void;

  setTyping: (roomId: string, userId: string) => void;
  clearTyping: (roomId: string, userId: string) => void;
  sweepTyping: () => void;
  setThinking: (roomId: string, on: boolean) => void;

  setRailSel: (sel: RailSel | null) => void;
  requestJump: (roomId: string, seq: number) => void;
  clearJump: () => void;
}

function bySeq(a: Message, b: Message) {
  return a.seq - b.seq;
}

function mergeUnique(base: Message[], extra: Message[]): Message[] {
  const map = new Map<string, Message>();
  for (const m of base) map.set(m.id, m);
  for (const m of extra) map.set(m.id, m);
  return [...map.values()].sort(bySeq);
}

export function messageClientId(m: Message): string | null {
  const top = m.client_id;
  if (typeof top === "string" && top) return top;
  const meta = m.meta?.client_id;
  return typeof meta === "string" && meta ? meta : null;
}

export const useRoomsStore = create<RoomsState>((set) => ({
  windows: {},
  pending: {},
  typing: {},
  thinking: {},
  railSel: null,
  jump: null,

  setWindow: (roomId, w) =>
    set((s) => ({
      windows: {
        ...s.windows,
        [roomId]: { ...w, messages: [...w.messages].sort(bySeq), version: (s.windows[roomId]?.version ?? 0) + 1 },
      },
    })),

  addPage: (roomId, page, dir, hasMore) =>
    set((s) => {
      const w = s.windows[roomId];
      if (!w) return s;
      let messages = mergeUnique(w.messages, page);
      let { hasMoreBefore, hasMoreAfter } = w;
      if (dir === "before") {
        hasMoreBefore = hasMore;
        if (messages.length > MAX_WINDOW) {
          messages = messages.slice(0, MAX_WINDOW);
          hasMoreAfter = true;
        }
      } else {
        hasMoreAfter = hasMore;
        if (messages.length > MAX_WINDOW) {
          messages = messages.slice(messages.length - MAX_WINDOW);
          hasMoreBefore = true;
        }
      }
      return { windows: { ...s.windows, [roomId]: { ...w, messages, hasMoreBefore, hasMoreAfter } } };
    }),

  upsertMessage: (m) =>
    set((s) => {
      const out: Partial<RoomsState> = {};
      const cid = messageClientId(m);
      const pend = s.pending[m.room_id];
      if (cid && pend?.some((p) => p.client_id === cid)) {
        out.pending = { ...s.pending, [m.room_id]: pend.filter((p) => p.client_id !== cid) };
      }
      const w = s.windows[m.room_id];
      if (w) {
        const idx = w.messages.findIndex((x) => x.id === m.id);
        if (idx >= 0) {
          const messages = w.messages.slice();
          messages[idx] = m;
          out.windows = { ...s.windows, [m.room_id]: { ...w, messages } };
        } else {
          const last = w.messages[w.messages.length - 1];
          const first = w.messages[0];
          const inside = first && m.seq > first.seq && last && m.seq < last.seq;
          const atTail = !w.hasMoreAfter && (!last || m.seq > last.seq);
          if (inside || atTail) {
            let messages = mergeUnique(w.messages, [m]);
            let hasMoreBefore = w.hasMoreBefore;
            if (messages.length > MAX_WINDOW) {
              messages = messages.slice(messages.length - MAX_WINDOW);
              hasMoreBefore = true;
            }
            out.windows = { ...s.windows, [m.room_id]: { ...w, messages, hasMoreBefore } };
          }
        }
      }
      return out;
    }),

  patchMessage: (roomId, id, patch) =>
    set((s) => {
      const w = s.windows[roomId];
      if (!w) return s;
      const idx = w.messages.findIndex((x) => x.id === id);
      if (idx < 0) return s;
      const messages = w.messages.slice();
      messages[idx] = patch(messages[idx]);
      return { windows: { ...s.windows, [roomId]: { ...w, messages } } };
    }),

  dropRoom: (roomId) =>
    set((s) => {
      const windows = { ...s.windows };
      delete windows[roomId];
      const pending = { ...s.pending };
      delete pending[roomId];
      return { windows, pending };
    }),

  addPending: (p) =>
    set((s) => ({ pending: { ...s.pending, [p.room_id]: [...(s.pending[p.room_id] ?? []), p] } })),
  setPendingStatus: (roomId, clientId, status) =>
    set((s) => ({
      pending: {
        ...s.pending,
        [roomId]: (s.pending[roomId] ?? []).map((p) => (p.client_id === clientId ? { ...p, status } : p)),
      },
    })),
  removePending: (roomId, clientId) =>
    set((s) => ({
      pending: { ...s.pending, [roomId]: (s.pending[roomId] ?? []).filter((p) => p.client_id !== clientId) },
    })),

  setTyping: (roomId, userId) =>
    set((s) => ({
      typing: { ...s.typing, [roomId]: { ...(s.typing[roomId] ?? {}), [userId]: Date.now() + 6000 } },
    })),
  clearTyping: (roomId, userId) =>
    set((s) => {
      const cur = s.typing[roomId];
      if (!cur || !(userId in cur)) return s;
      const next = { ...cur };
      delete next[userId];
      return { typing: { ...s.typing, [roomId]: next } };
    }),
  sweepTyping: () =>
    set((s) => {
      const now = Date.now();
      let changed = false;
      const typing: RoomsState["typing"] = {};
      for (const [roomId, users] of Object.entries(s.typing)) {
        const kept: Record<string, number> = {};
        for (const [uid, exp] of Object.entries(users)) {
          if (exp > now) kept[uid] = exp;
          else changed = true;
        }
        typing[roomId] = kept;
      }
      return changed ? { typing } : s;
    }),
  setThinking: (roomId, on) => set((s) => ({ thinking: { ...s.thinking, [roomId]: on } })),

  setRailSel: (railSel) => set({ railSel }),
  requestJump: (roomId, seq) => set({ jump: { roomId, seq, nonce: Date.now() + Math.random() } }),
  clearJump: () => set({ jump: null }),
}));
