import { useQuery } from "@tanstack/react-query";

import { roomsApi, type Bootstrap, type RoomFeatures } from "@/api/rooms";

import { BOOTSTRAP_KEY } from "./cache";

const ALL_ON: RoomFeatures = { voice_messages: true, voice_max_seconds: 600, polls: true };

/** What the admin has on for everyone (voice messages, polls). An older
 *  server that doesn't say: everything on, and the server has the last word. */
export function useRoomFeatures(): RoomFeatures {
  const { data } = useQuery<Bootstrap>({ queryKey: BOOTSTRAP_KEY, queryFn: roomsApi.bootstrap, staleTime: Infinity });
  return data?.features ?? ALL_ON;
}
