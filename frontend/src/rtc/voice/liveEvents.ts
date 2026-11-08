/**
 * Who's in which voice channel and who's speaking, for channel lists
 * anywhere in the app, from the Rooms stream's ``voice_state`` /
 * ``voice_speaking`` events and the Rooms bootstrap. Light: doesn't load
 * the voice engine.
 */
import type { RoomEvent } from "@/api/rooms";
import type { VoiceMember } from "@/api/voiceChannels";

import { useVoiceStore } from "./store";

export function applyVoiceListEvent(ev: RoomEvent): void {
  if (ev.type === "voice_state") {
    useVoiceStore.setState((s) => {
      const speaking = s.speakingIn[ev.room_id];
      // Someone who left isn't speaking any more.
      let speakingIn = s.speakingIn;
      if (speaking) {
        const here = new Set(ev.members.map((m) => m.user_id));
        const kept = Object.fromEntries(Object.keys(speaking).filter((u) => here.has(u)).map((u) => [u, true as const]));
        speakingIn = { ...s.speakingIn, [ev.room_id]: kept };
      }
      return { channels: { ...s.channels, [ev.room_id]: ev.members }, speakingIn };
    });
  } else if (ev.type === "voice_speaking") {
    useVoiceStore.setState((s) => {
      const room = { ...(s.speakingIn[ev.room_id] ?? {}) };
      if (ev.on) room[ev.user_id] = true;
      else delete room[ev.user_id];
      return { speakingIn: { ...s.speakingIn, [ev.room_id]: room } };
    });
  }
}

/** The bootstrap's ``voice`` map: who's in each channel right now. */
export function seedVoiceChannels(voice: Record<string, VoiceMember[]> | undefined, voiceRoomIds: string[] = []): void {
  if (!voice) return;
  useVoiceStore.setState((s) => {
    const channels = { ...s.channels };
    for (const id of voiceRoomIds) channels[id] = [];
    for (const [id, members] of Object.entries(voice)) channels[id] = members;
    return { channels };
  });
}
