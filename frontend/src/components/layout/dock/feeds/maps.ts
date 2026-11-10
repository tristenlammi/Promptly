import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Navigation, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { apiClient } from "@/api/client";
import { useMapsReady } from "@/maps/useMapsReady";
import { toast } from "@/store/toastStore";

import type { DockCardData, DockFeed } from "../types";
import { clock } from "../useNow";

/** The same shape and cache key as the Maps app's "People" panel. */
interface Shares {
  sharing_with: { user_id: string; name: string; expires_at: string | null }[];
  shared_with_me: { user_id: string; name: string; live: { destination: string | null; eta: string | null; at: string } | null }[];
}

/**
 * Maps, only when maps are set up here: "Sharing your location with N until
 * HH:MM" with Stop, and someone on their way to you with their arrival time.
 */
function useCards(): DockCardData[] {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ready = useMapsReady(true);
  const { data } = useQuery({
    queryKey: ["maps-shares"],
    queryFn: async () => (await apiClient.get<Shares>("/maps/share")).data,
    enabled: ready,
    staleTime: 60_000,
    retry: false,
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && (d.sharing_with.length > 0 || d.shared_with_me.some((p) => p.live?.eta)) ? 60_000 : 5 * 60_000;
    },
  });
  if (!ready || !data) return [];

  const open = () => navigate("/maps");
  const cards: DockCardData[] = [];
  const mine = data.sharing_with ?? [];

  if (mine.length > 0) {
    const who = mine.length === 1 ? mine[0].name : `${mine.length} people`;
    const ends = mine.map((s) => (s.expires_at ? Date.parse(s.expires_at) : NaN));
    const until = ends.every((t) => Number.isFinite(t)) ? `until ${clock(Math.max(...ends))}` : "until you stop";
    const ids = mine.map((s) => s.user_id);
    cards.push({
      id: "maps:sharing",
      priority: 60,
      icon: MapPin,
      tone: "accent",
      title: "Sharing your location",
      detail: `With ${who} ${until}`,
      onOpen: open,
      actions: [
        {
          id: "stop",
          label: "Stop sharing",
          icon: X,
          danger: true,
          onClick: () => {
            void Promise.all(ids.map((id) => apiClient.delete(`/maps/share/${id}`)))
              .then(() => toast.success("Stopped sharing your location"))
              .catch(() => toast.error("Couldn't stop sharing. Open Maps and try there."))
              .finally(() => void qc.invalidateQueries({ queryKey: ["maps-shares"] }));
          },
        },
      ],
    });
  }

  const coming = (data.shared_with_me ?? []).filter((p) => p.live?.eta && Date.parse(p.live.eta) > Date.now());
  if (coming.length > 0) {
    const p = coming[0];
    const eta = p.live?.eta ? clock(p.live.eta) : "";
    cards.push({
      id: `maps:eta:${p.user_id}`,
      priority: 58,
      icon: Navigation,
      title: `${p.name} is on the way`,
      detail: p.live?.destination ? `To ${p.live.destination} · arriving ${eta}` : `Arriving ${eta}`,
      onOpen: open,
    });
  }
  return cards;
}

export const mapsFeed: DockFeed = { id: "maps", useCards };
