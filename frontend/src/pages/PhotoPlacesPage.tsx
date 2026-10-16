import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Map as MapIcon, MapPin } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { photosApi, type PhotoItem } from "@/api/photos";
import { PhotoTile } from "@/components/photos/PhotoTile";
import { PhotoViewer } from "@/components/photos/PhotoViewer";
import { Button } from "@/components/shared/Button";
import { justify } from "@/lib/justify";
import { apiErrorMessage } from "@/utils/apiError";

/** Places (PH-5): the countries your photos were taken in, then a
 *  country's towns, then the photos taken there — most photos first. */
export function PhotoPlacesPage() {
  const { country, placeId } = useParams();
  if (country && placeId) return <PlacePhotos country={country} placeId={Number(placeId)} />;
  return <PlaceList country={country} />;
}

function Header({ back, label, title, sub, action }: { back: string; label: string; title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
      <Link to={back} aria-label={label} className="rounded p-1 hover:bg-[var(--hover)]">
        <ArrowLeft className="h-4 w-4" />
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold text-[var(--text)]">{title}</h1>
        {sub && <p className="truncate text-xs text-[var(--text-muted)]">{sub}</p>}
      </div>
      {action}
    </header>
  );
}

function PlaceList({ country }: { country?: string }) {
  const { data, isLoading, error } = useQuery({ queryKey: ["photo-places", country ?? ""], queryFn: () => photosApi.places(country) });
  const cards = country
    ? (data?.places ?? []).map((p) => ({ key: String(p.id), to: `/files/photos/places/${country}/${p.id}`, name: p.name, sub: p.admin1, count: p.count, cover: p.cover }))
    : (data?.countries ?? []).map((c) => ({ key: c.code, to: `/files/photos/places/${c.code}`, name: c.name, sub: null, count: c.count, cover: c.cover }));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header
        back={country ? "/files/photos/places" : "/files/photos"}
        label={country ? "Back to places" : "Back to Photos"}
        title={country ? data?.country?.name ?? country : "Places"}
        action={
          <Link to="/files/photos/map" className="flex items-center gap-1 rounded-full px-3 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]">
            <MapIcon className="h-3.5 w-3.5" /> Map
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <p className="text-sm text-[var(--text-muted)]">Loading…</p>
        ) : error ? (
          <p role="alert" className="text-sm text-[var(--text-muted)]">{apiErrorMessage(error, "Couldn't load your places.")}</p>
        ) : !cards.length ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center">
            <MapPin className="h-10 w-10 text-[var(--text-muted)]" />
            <p className="text-sm font-medium text-[var(--text)]">No places yet</p>
            <p className="max-w-sm text-xs text-[var(--text-muted)]">Photos with a location (most phone photos have one) show here by country and town once they've been looked at.</p>
          </div>
        ) : (
          <ul aria-label={country ? "Towns" : "Countries"} className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {cards.map((c) => (
              <li key={c.key}>
                <Link to={c.to} className="group block">
                  <div className="aspect-square overflow-hidden rounded-lg bg-[var(--hover)] transition group-hover:opacity-90">
                    {c.cover?.thumb && <img src={c.cover.thumb} alt="" className="h-full w-full object-cover" loading="lazy" />}
                  </div>
                  <p className="mt-1.5 truncate text-sm font-medium text-[var(--text)]">{c.name}</p>
                  <p className="truncate text-xs text-[var(--text-muted)]">
                    {c.count.toLocaleString()} {c.count === 1 ? "item" : "items"}
                    {c.sub ? ` · ${c.sub}` : ""}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PlacePhotos({ country, placeId }: { country: string; placeId: number }) {
  const { data: towns } = useQuery({ queryKey: ["photo-places", country], queryFn: () => photosApi.places(country) });
  const town = towns?.places?.find((p) => p.id === placeId);
  const pages = useInfiniteQuery({
    queryKey: ["photo-places", country, placeId, "items"],
    queryFn: ({ pageParam }) => photosApi.timeline({ view: "all", before: pageParam, place: placeId, limit: 150 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
  const items = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!box) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);
  const rows = useMemo(
    () => justify(items.map((p) => ({ aspect: p.width && p.height ? p.width / p.height : null })), { width, targetHeight: width < 640 ? 110 : 200, gap: 4 }),
    [items, width],
  );
  const [viewing, setViewing] = useState<string | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header
        back={`/files/photos/places/${country}`}
        label={`Back to ${towns?.country?.name ?? "the country"}`}
        title={town?.name ?? "Photos"}
        sub={[town?.admin1, towns?.country?.name].filter(Boolean).join(", ")}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-4">
        <div ref={setBox} aria-label="Photos taken here" className="flex flex-col gap-1">
          {rows.map((r, ri) => (
            <div key={ri} className="flex gap-1" style={{ height: r.height }}>
              {r.items.map((idx, k) => {
                const p = items[idx];
                return (
                  <PhotoTile key={p.id} photo={p} width={r.widths[k]} height={r.height} selected={false} selecting={false}
                    onToggle={() => {}} onOpen={(ph: PhotoItem) => setViewing(ph.id)} />
                );
              })}
            </div>
          ))}
        </div>
        {pages.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button size="sm" variant="secondary" onClick={() => void pages.fetchNextPage()} loading={pages.isFetchingNextPage}>
              Show more
            </Button>
          </div>
        )}
      </div>
      {viewing && (
        <PhotoViewer
          items={items}
          startId={viewing}
          loadMore={async (dir) => {
            if (dir !== 1 || !pages.hasNextPage) return [];
            const got = await pages.fetchNextPage();
            return got.data?.pages.at(-1)?.items ?? [];
          }}
          onClose={() => setViewing(null)}
          onChanged={() => void pages.refetch()}
        />
      )}
    </div>
  );
}
