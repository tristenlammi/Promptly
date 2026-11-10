import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { photosApi } from "@/api/photos";

import type { DockCardData, DockFeed } from "../types";

/** Photos: how far "understanding your photos" has got, while there's work
 *  left. Shares the Photos header's cache; once a minute while it's working,
 *  every ten minutes otherwise (to notice a new batch). */
function useCards(): DockCardData[] {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["photos", "understanding"],
    queryFn: photosApi.understanding,
    staleTime: 60_000,
    retry: false,
    refetchInterval: (q) => (q.state.data && !q.state.data.complete ? 60_000 : 10 * 60_000),
  });
  if (!data || data.complete) return [];
  const stages = data.stages ?? [];
  const total = stages.reduce((n, s) => n + s.total, 0);
  if (total <= 0) return [];
  const done = stages.reduce((n, s) => n + s.done + s.failed, 0);
  const progress = Math.min(1, done / total);
  return [
    {
      id: "photos:understanding",
      priority: 20,
      icon: Sparkles,
      title: "Understanding your photos",
      detail: `${Math.floor(progress * 100)}% done`,
      progress,
      onOpen: () => navigate("/photos"),
    },
  ];
}

export const photosFeed: DockFeed = { id: "photos", useCards };
