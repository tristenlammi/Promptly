/**
 * Who and where, for the voice UI: people's names and avatars and the
 * voice channels' names come from the Rooms bootstrap (one cached query,
 * shared with the Rooms app), so the voice panel works on any Promptly
 * page. Also keeps the store's "who's in which channel" seeded from it.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { roomsApi, type Bootstrap, type Room, type RoomUser, type Space } from "@/api/rooms";
import type { VoiceMember } from "@/api/voiceChannels";
import { BOOTSTRAP_KEY } from "@/rooms/cache";
import { useAuthStore } from "@/store/authStore";

import { seedVoiceChannels } from "../voice/liveEvents";
import { useVoice } from "../voice/hooks";
import { useVoiceStore, type VoiceStoreState } from "../voice/store";

// Seed once per fetched ``voice`` map: a bootstrap patched locally (a new
// message, a renamed room) keeps the same map, and seeding it again would
// undo the live updates that came since.
const seeded = new WeakSet<object>();

export function seedFromBootstrap(b: Bootstrap | undefined): void {
  if (!b || !b.voice || seeded.has(b.voice)) return;
  seeded.add(b.voice);
  const ids = b.spaces.flatMap((s) => s.rooms.filter((r) => r.kind === "voice").map((r) => r.id));
  seedVoiceChannels(b.voice, ids);
}

/** The Rooms bootstrap (cached; fetched when ``enabled``). */
export function useRoomsBootstrap(enabled = true): Bootstrap | undefined {
  const { data } = useQuery({ queryKey: BOOTSTRAP_KEY, queryFn: roomsApi.bootstrap, staleTime: 30_000, enabled });
  useEffect(() => seedFromBootstrap(data), [data]);
  return data;
}

export interface ChannelRef {
  room: Room;
  space: Space;
}

export function findChannel(b: Bootstrap | undefined, roomId: string | null | undefined): ChannelRef | null {
  if (!b || !roomId) return null;
  for (const space of b.spaces) {
    const room = space.rooms.find((r) => r.id === roomId);
    if (room) return { room, space };
  }
  return null;
}

export function isSpaceAdmin(space: Space | null | undefined): boolean {
  return space?.role === "owner" || space?.role === "admin";
}

/** May I moderate this person here (the server's rule: the owner on
 *  anyone; admins on members and themselves)? */
export function canModerate(space: Space, meId: string, targetId: string): boolean {
  if (!isSpaceAdmin(space)) return false;
  if (targetId === meId) return true;
  const theirs = space.member_roles?.[targetId] ?? "member";
  return space.role === "owner" || theirs === "member";
}

export function userOf(b: Bootstrap | undefined, id: string): RoomUser | undefined {
  return b?.users[id];
}

export function nameOf(b: Bootstrap | undefined, id: string): string {
  return b?.users[id]?.username ?? "Someone";
}

const NO_MEMBERS: VoiceMember[] = [];

/** Who's in a voice channel now; your own row reflects your mute and
 *  deafen at once (the server's echo follows a moment later). */
export function useChannelMembers(roomId: string | null | undefined): VoiceMember[] {
  const meId = useAuthStore((s) => s.user?.id);
  const { list, mine, muted, deafened, live, camera } = useVoice((s: VoiceStoreState) => ({
    list: roomId ? (s.channels[roomId] ?? NO_MEMBERS) : NO_MEMBERS,
    mine: !!roomId && s.roomId === roomId && s.status !== "idle",
    muted: s.muted,
    deafened: s.deafened,
    live: s.live,
    camera: s.camera,
  }));
  return useMemo(
    () =>
      mine && meId
        ? list.map((m) => (m.user_id === meId ? { ...m, muted: muted || deafened, deafened, live: live || m.live, video: camera || m.video } : m))
        : list,
    [list, mine, meId, muted, deafened, live, camera],
  );
}

/** Is this person talking right now? Instant from LiveKit when you're in
 *  the same channel; from the server's speaking events otherwise. */
export function useSpeaking(roomId: string | null | undefined, userId: string): boolean {
  const meId = useAuthStore((s) => s.user?.id);
  return useVoiceStore((s) => {
    if (!roomId) return false;
    const here = s.roomId === roomId && s.status === "connected";
    if (here) {
      if (userId === meId && !s.remote) return s.speaking && !s.muted && !s.deafened && !s.serverMuted;
      const p = s.peers[userId];
      // (With the phone's app holding the audio, this page's connection
      // hears nobody, so LiveKit doesn't say who's talking: the server does.)
      if (p && !s.remote) return p.speaking;
    }
    return !!s.speakingIn[roomId]?.[userId];
  });
}
