import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, List, X, ZoomIn } from "lucide-react";
import { Link } from "react-router-dom";

import { usePhotosPath } from "@/components/photos/photosPath";
import { photosApi, type PhotoItem } from "@/api/photos";
import { ClusterMap, type MapPick } from "@/components/maps/ClusterMap";
import { PhotoViewer } from "@/components/photos/PhotoViewer";
import { apiErrorMessage } from "@/utils/apiError";

/** The Photos map (PH-5): where your photos were taken, clustered — click
 *  a cluster for its photos. Streets, towns and place names come from this
 *  server's own map (P Maps). Without it, the bundled countries (Natural
 *  Earth, public domain). */

export function PhotoMapPage() {
  const photosPath = usePhotosPath();
  const { data, error, isLoading } = useQuery({ queryKey: ["photo-map"], queryFn: photosApi.map, staleTime: 5 * 60_000 });
  const [picked, setPicked] = useState<MapPick | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const { data: pickedItems } = useQuery({
    queryKey: ["photo-map-picked", picked?.ids],
    queryFn: () => photosApi.items(picked!.ids.slice(0, 200)),
    enabled: !!picked?.ids.length,
  });
  const points = useMemo(() => (data ? data.ids.map((id, i) => ({ id, lat: data.lat[i], lon: data.lon[i] })) : []), [data]);

  const items: PhotoItem[] = pickedItems ?? [];
  return (
    // flex-1 as well as h-full: the map's box must have a real height.
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <Link to={photosPath("/places")} aria-label="Back to places" className="rounded p-1 hover:bg-[var(--hover)]">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="flex-1 text-base font-semibold text-[var(--text)]">Map</h1>
        <span className="text-xs text-[var(--text-muted)]">
          {data ? `${data.ids.length.toLocaleString()} ${data.ids.length === 1 ? "photo" : "photos"} with a place` : ""}
        </span>
        <Link to={photosPath("/places")} className="flex items-center gap-1 rounded-full px-3 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <List className="h-3.5 w-3.5" /> List
        </Link>
      </header>
      <div className="relative min-h-0 flex-1">
        {isLoading && <p className="p-6 text-sm text-[var(--text-muted)]">Loading…</p>}
        {error && <p role="alert" className="p-6 text-sm text-[var(--text-muted)]">{apiErrorMessage(error, "Couldn't load the map.")}</p>}
        {/* MapLibre makes its container position: relative — the size comes
            from this wrapper. */}
        <div className="absolute inset-0">
          {data && <ClusterMap points={points} basemap={data.basemap} onPick={setPicked} label="Map of your photos" />}
        </div>
        {data && !data.ids.length && (
          <p className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-[var(--surface)] px-3 py-1 text-xs text-[var(--text-muted)] shadow">
            No photos with a location yet.
          </p>
        )}
        {picked && (
          <aside aria-label="Photos here" className="absolute bottom-0 left-0 right-0 z-10 max-h-[45%] overflow-y-auto border-t border-[var(--border)] bg-[var(--surface)] p-3 sm:bottom-auto sm:left-auto sm:right-3 sm:top-3 sm:max-h-[calc(100%-1.5rem)] sm:w-80 sm:rounded-card sm:border sm:shadow-xl">
            <div className="mb-2 flex items-center gap-2">
              <p className="flex-1 text-sm font-medium text-[var(--text)]">
                {picked.total.toLocaleString()} {picked.total === 1 ? "photo" : "photos"} here
              </p>
              {picked.zoomTo && (
                <button type="button" onClick={picked.zoomTo} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]">
                  <ZoomIn className="h-3.5 w-3.5" /> Zoom in
                </button>
              )}
              <button type="button" aria-label="Close" onClick={() => setPicked(null)} className="rounded p-1 hover:bg-[var(--hover)]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <ul className="grid grid-cols-3 gap-1">
              {items.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => setViewing(p.id)} aria-label={`Photo, ${new Date(p.taken_local).toLocaleString()}`}
                    className="block aspect-square w-full overflow-hidden rounded bg-[var(--hover)]">
                    {p.thumb && <img src={p.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />}
                  </button>
                </li>
              ))}
            </ul>
            {picked.total > 200 && <p className="mt-2 text-xs text-[var(--text-muted)]">The first 200 — zoom in for the rest.</p>}
          </aside>
        )}
      </div>
      {viewing && (
        <PhotoViewer items={items} startId={viewing} loadMore={async () => []} onClose={() => setViewing(null)} onChanged={() => {}} />
      )}
    </div>
  );
}
