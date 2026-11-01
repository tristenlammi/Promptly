import type { QueryClient } from "@tanstack/react-query";

import { roomsApi, type Bootstrap, type Message, type NotifyLevel, type Room, type RoomUser, type Space } from "@/api/rooms";

import { useRoomsStore } from "./store";

export const BOOTSTRAP_KEY = ["rooms", "bootstrap"] as const;

export function updateBootstrap(qc: QueryClient, fn: (b: Bootstrap) => Bootstrap) {
  qc.setQueryData<Bootstrap>(BOOTSTRAP_KEY, (b) => (b ? fn(b) : b));
}

/** Change one room wherever it lives (a space's rooms or the DM list). */
export function patchRoom(qc: QueryClient, roomId: string, patch: (r: Room) => Room) {
  updateBootstrap(qc, (b) => ({
    ...b,
    spaces: b.spaces.map((s) =>
      s.rooms.some((r) => r.id === roomId) ? { ...s, rooms: s.rooms.map((r) => (r.id === roomId ? patch(r) : r)) } : s,
    ),
    dms: b.dms.map((r) => (r.id === roomId ? patch(r) : r)),
  }));
}

/** Insert or replace a room from the server. Returns false when its space
 *  isn't known yet (the caller refetches the bootstrap). */
export function upsertRoom(qc: QueryClient, room: Room): boolean {
  const b = qc.getQueryData<Bootstrap>(BOOTSTRAP_KEY);
  if (!b) return false;
  if (room.space_id && !b.spaces.some((s) => s.id === room.space_id)) return false;
  updateBootstrap(qc, (cur) => {
    if (room.space_id) {
      return {
        ...cur,
        spaces: cur.spaces.map((s) => {
          if (s.id !== room.space_id) return s;
          const exists = s.rooms.some((r) => r.id === room.id);
          const rooms = exists ? s.rooms.map((r) => (r.id === room.id ? { ...r, ...room } : r)) : [...s.rooms, room];
          return { ...s, rooms: [...rooms].sort((a, z) => a.position - z.position) };
        }),
      };
    }
    const exists = cur.dms.some((r) => r.id === room.id);
    return { ...cur, dms: exists ? cur.dms.map((r) => (r.id === room.id ? { ...r, ...room } : r)) : [room, ...cur.dms] };
  });
  return true;
}

export function removeRoom(qc: QueryClient, roomId: string) {
  updateBootstrap(qc, (b) => ({
    ...b,
    spaces: b.spaces.map((s) => ({ ...s, rooms: s.rooms.filter((r) => r.id !== roomId) })),
    dms: b.dms.filter((r) => r.id !== roomId),
  }));
  useRoomsStore.getState().dropRoom(roomId);
}

export function findRoom(b: Bootstrap | undefined, roomId: string | null | undefined): { room: Room; space: Space | null } | null {
  if (!b || !roomId) return null;
  for (const s of b.spaces) {
    const r = s.rooms.find((x) => x.id === roomId);
    if (r) return { room: r, space: s };
  }
  const dm = b.dms.find((x) => x.id === roomId);
  return dm ? { room: dm, space: null } : null;
}

export function userName(users: Record<string, RoomUser> | undefined, id: string | null | undefined): string {
  if (!id) return "Someone";
  return users?.[id]?.username ?? "Someone";
}

/** "Sam", "Sam, Alex and Jo" — a DM's name from its other members. */
export function dmTitle(b: Bootstrap | undefined, room: Room): string {
  if (room.name && room.kind === "group") return room.name;
  const others = (room.members ?? []).filter((id) => id !== b?.me.id);
  if (others.length === 0) return b?.me.username ? `${b.me.username} (you)` : "Just you";
  const names = others.map((id) => userName(b?.users, id));
  if (names.length === 1) return names[0];
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

export function roomTitle(b: Bootstrap | undefined, room: Room): string {
  return room.space_id ? room.name : dmTitle(b, room);
}

export function effectiveNotify(room: Room, space: Space | null): NotifyLevel {
  return room.notify ?? space?.notify ?? "all";
}

export function totals(b: Bootstrap | undefined) {
  let total = 0;
  let dmUnread = 0;
  const spaces: Record<string, { unread: boolean; mentions: number }> = {};
  if (!b) return { total, dmUnread, spaces };
  for (const s of b.spaces) {
    let unread = false;
    let mentions = 0;
    for (const r of s.rooms) {
      const n = effectiveNotify(r, s);
      if (r.unread > 0 && n === "all") unread = true;
      mentions += r.mentions;
      if (n === "all") total += r.unread;
      else if (n === "mentions") total += r.mentions;
    }
    spaces[s.id] = { unread, mentions };
  }
  for (const r of b.dms) {
    if (effectiveNotify(r, null) === "none") continue;
    dmUnread += r.unread;
  }
  total += dmUnread;
  return { total, dmUnread, spaces };
}

// ---- message windows -------------------------------------------------

const inflight = new Map<string, Promise<unknown>>();

function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const cur = inflight.get(key) as Promise<T> | undefined;
  if (cur) return cur;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function loadTail(roomId: string) {
  return once(`tail:${roomId}`, async () => {
    const page = await roomsApi.messages(roomId, {});
    useRoomsStore.getState().setWindow(roomId, {
      messages: page.messages,
      hasMoreBefore: page.has_more_before,
      hasMoreAfter: false,
    });
  });
}

export function loadAround(roomId: string, seq: number) {
  return once(`around:${roomId}:${seq}`, async () => {
    const page = await roomsApi.messages(roomId, { around: seq });
    useRoomsStore.getState().setWindow(roomId, {
      messages: page.messages,
      hasMoreBefore: page.has_more_before,
      hasMoreAfter: page.has_more_after,
    });
  });
}

export function loadOlder(roomId: string) {
  return once(`older:${roomId}`, async () => {
    const w = useRoomsStore.getState().windows[roomId];
    const first = w?.messages[0];
    if (!w || !first || !w.hasMoreBefore) return;
    const page = await roomsApi.messages(roomId, { before: first.seq });
    useRoomsStore.getState().addPage(roomId, page.messages, "before", page.has_more_before);
  });
}

export function loadNewer(roomId: string) {
  return once(`newer:${roomId}`, async () => {
    const w = useRoomsStore.getState().windows[roomId];
    const last = w?.messages[w.messages.length - 1];
    if (!w || !last || !w.hasMoreAfter) return;
    const page = await roomsApi.messages(roomId, { after: last.seq });
    useRoomsStore.getState().addPage(roomId, page.messages, "after", page.has_more_after);
  });
}

/** After a reconnect / focus: fetch what we missed at the tail. */
export async function refreshTail(roomId: string) {
  const w = useRoomsStore.getState().windows[roomId];
  if (!w) return loadTail(roomId);
  if (w.hasMoreAfter) return; // reading history; "Jump to latest" reloads
  const last = w.messages[w.messages.length - 1];
  if (!last) return loadTail(roomId);
  const page = await roomsApi.messages(roomId, { after: last.seq, limit: 100 });
  if (page.has_more_after) return loadTail(roomId); // too far behind — start over at the tail
  for (const m of page.messages) useRoomsStore.getState().upsertMessage(m);
}

export function lastLoadedSeq(roomId: string): number {
  const w = useRoomsStore.getState().windows[roomId];
  return w?.messages[w.messages.length - 1]?.seq ?? 0;
}

export function isOwn(m: Message, meId: string | undefined) {
  return !!meId && m.author_id === meId && m.kind === "user";
}
