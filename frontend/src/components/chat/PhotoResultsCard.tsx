import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Images } from "lucide-react";

import { photosApi, type PhotoChip } from "@/api/photos";
import { PhotoViewer } from "@/components/photos/PhotoViewer";

import type { ActivityStep } from "./ToolActivityCard";

interface PhotoResults {
  set_id: string;
  total: number;
  items: { id: string; chips: PhotoChip[]; similar: number }[];
  relaxed: string[];
  unresolved: string[];
}

/** The photos a chat turn found (PH-4): one gallery per search_photos /
 *  refine_photo_results call. Links are fetched fresh, so an old chat still
 *  shows its photos; only the asker's own come back. */
export function PhotoResultsCards({ steps }: { steps: ActivityStep[] }) {
  const sets = steps
    .filter((s) => s.status === "ok" && s.meta && typeof s.meta === "object" && "photo_results" in s.meta)
    .map((s) => (s.meta as { photo_results: PhotoResults }).photo_results);
  if (sets.length === 0) return null;
  // The last search of a turn is the answer; earlier ones were steps to it.
  return <Gallery results={sets[sets.length - 1]} />;
}

function Gallery({ results }: { results: PhotoResults }) {
  const ids = useMemo(() => results.items.map((i) => i.id), [results]);
  const { data } = useQuery({
    queryKey: ["photo-items", ids],
    queryFn: () => photosApi.items(ids),
    enabled: ids.length > 0,
    staleTime: 30 * 60 * 1000,
  });
  const [all, setAll] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const chips = useMemo(() => new Map(results.items.map((i) => [i.id, i])), [results]);
  const items = data ?? [];
  const shown = all ? items : items.slice(0, 8);
  return (
    <section aria-label="Photos found" className="mt-2 rounded-card border border-[var(--border)] bg-[var(--surface)] p-2">
      <p className="mb-1.5 flex items-center gap-1.5 px-1 text-xs text-[var(--text-muted)]">
        <Images className="h-3.5 w-3.5" />
        {results.total === 0 ? "No photos found" : `${results.total} ${results.total === 1 ? "photo" : "photos"}`}
        {results.relaxed.length > 0 && <span> · widened: {results.relaxed.join(", ")}</span>}
      </p>
      {results.unresolved.map((u) => (
        <p key={u} className="px-1 text-xs text-amber-600 dark:text-amber-400">Couldn't find {u}.</p>
      ))}
      {shown.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-1.5" aria-label="Found photos">
          {shown.map((p) => {
            const c = chips.get(p.id);
            const label = (c?.chips ?? []).map((x) => x.label).filter(Boolean).join(" · ");
            return (
              <li key={p.id}>
                <button type="button" title={label} aria-label={label || p.filename} data-photo={p.id}
                  onClick={() => setViewing(p.id)} className="relative block w-full overflow-hidden rounded-md bg-[var(--hover)]">
                  {p.thumb ? (
                    <img src={p.thumb} alt="" loading="lazy" className="aspect-square w-full object-cover" />
                  ) : (
                    <span className="block aspect-square" />
                  )}
                  {c && c.similar > 0 && (
                    <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] text-white">+{c.similar}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!all && items.length > 8 && (
        <button type="button" onClick={() => setAll(true)} className="mt-1.5 px-1 text-xs text-[var(--accent-text)] hover:underline">
          Show all {items.length}
        </button>
      )}
      {viewing && <PhotoViewer items={items} startId={viewing} loadMore={async () => []} onClose={() => setViewing(null)} onChanged={() => {}} />}
    </section>
  );
}
