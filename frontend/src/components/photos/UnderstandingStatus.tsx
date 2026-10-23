import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";

import { photosApi } from "@/api/photos";

/** How far understanding your photos has got (PH-2) — shown only while
 *  there's work left, as one quiet line in the Photos header. */
export function UnderstandingStatus() {
  const { data } = useQuery({
    queryKey: ["photos", "understanding"],
    queryFn: photosApi.understanding,
    refetchInterval: (q) => (q.state.data?.complete ? false : 60_000),
  });
  if (!data || data.complete) return null;
  const total = data.stages.reduce((n, s) => n + s.total, 0);
  const done = data.stages.reduce((n, s) => n + s.done + s.failed, 0);
  const pct = total ? Math.floor((100 * done) / total) : 0;
  const detail = data.stages
    .map((s) => `${s.label} ${s.total ? Math.floor((100 * (s.done + s.failed)) / s.total) : 100}%${s.waiting ? ` (${s.waiting.toLowerCase()})` : ""}`)
    .join(" · ");
  return (
    <span role="status" title={detail} className="flex items-center gap-1 whitespace-nowrap text-xs text-[var(--text-muted)]">
      <Sparkles className="h-3.5 w-3.5" />
      <span className="sr-only 2xl:not-sr-only">Understanding your photos · </span>
      {pct}%
    </span>
  );
}
