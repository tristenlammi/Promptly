import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, MapPin, Navigation } from "lucide-react";
import { lazy, Suspense, useMemo } from "react";
import { Link } from "react-router-dom";

import { Modal } from "@/components/shared/Modal";
import { mapsApi } from "@/maps/api";
import { mapsDirectionsLink, mapsPinLink, mapsSearchLink } from "@/maps/links";

// The map library is big: it loads only when a preview is opened.
const MapView = lazy(() => import("@/maps/MapView").then((m) => ({ default: m.MapView })));

const NOTHING: never[] = [];
const noop = () => undefined;

/**
 * A place from some text (an address in an email, say), looked at before
 * leaving where you are: a small map with the pin, then "Open in P Maps" or
 * "Directions" if you want the whole thing. The address is looked up on your
 * own server; nothing goes to an outside map.
 */
export function PlacePreviewSheet({ address, onClose }: { address: string | null; onClose: () => void }) {
  const open = address !== null;
  const query = address ?? "";
  const { data: config } = useQuery({ queryKey: ["maps-config"], queryFn: mapsApi.config, staleTime: 3_600_000, retry: false, enabled: open });
  const found = useQuery({
    queryKey: ["place-preview", query],
    queryFn: ({ signal }) => mapsApi.search(query, null, signal),
    enabled: open && query.length > 0,
    staleTime: 600_000,
    retry: false,
  });
  const hit = found.data?.[0] ?? null;
  const pin = useMemo(() => (hit ? { lat: hit.lat, lon: hit.lon, name: hit.name } : null), [hit]);
  const fitTo = useMemo<[number, number][]>(() => (hit ? [[hit.lon, hit.lat]] : []), [hit]);
  const openLink = hit ? mapsPinLink(hit.lat, hit.lon, hit.name || query) : mapsSearchLink(query);
  // Directions start from where you are: Maps works that out itself.
  const directions = hit ? mapsDirectionsLink(hit.lat, hit.lon, hit.name || query) : null;

  return (
    <Modal open={open} onClose={onClose} title="Place" widthClass="max-w-md">
      <div className="flex flex-col gap-3">
        <p className="flex items-start gap-2 text-sm text-[var(--text)]">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text)]" />
          <span className="min-w-0 break-words">
            {query}
            {hit?.address && hit.address.toLowerCase() !== query.toLowerCase() && <span className="block text-xs text-[var(--text-muted)]">{hit.address}</span>}
          </span>
        </p>
        <div className="relative h-56 overflow-hidden rounded-xl border border-[var(--border)]">
          {found.isLoading ? (
            <p className="flex h-full items-center justify-center gap-2 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />Finding it…</p>
          ) : !hit ? (
            <p className="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--text-muted)]">
              {found.isError ? "Couldn't look this up now." : "Couldn't find this exact address. Open it in P Maps to search."}
            </p>
          ) : config?.basemap ? (
            <Suspense fallback={<p className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">Loading the map…</p>}>
              <MapView
                basemap={config.basemap}
                routes={NOTHING}
                selected={0}
                pin={pin}
                stops={NOTHING}
                chargers={NOTHING}
                parked={null}
                you={null}
                saved={NOTHING}
                friends={NOTHING}
                fitTo={fitTo}
                startAt={pin}
                onHold={noop}
                onPick={noop}
                onPickSaved={noop}
                onPickCharger={noop}
                onPickRoute={noop}
                onPickParked={noop}
                onMoved={noop}
              />
            </Suspense>
          ) : (
            <p className="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--text-muted)]">The map isn't available here.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={openLink} onClick={onClose} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:opacity-90">
            <ExternalLink className="h-4 w-4" />Open in P Maps
          </Link>
          {directions && (
            <Link to={directions} onClick={onClose} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]">
              <Navigation className="h-4 w-4" />Directions
            </Link>
          )}
        </div>
      </div>
    </Modal>
  );
}
