import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, ExternalLink, Loader2, MapPin } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Modal } from "@/components/shared/Modal";
import { apiErrorMessage } from "@/utils/apiError";

import { decodeShape, formatDuration, formatKm, mapsApi, routeSeconds, trafficLine, type SavedPlace } from "./api";
import { mapsPinLink, mapsRouteLink } from "./links";
import type { MapCard } from "./MapChips";
import { MapView, type MapViewHandle } from "./MapView";

const NOTHING: never[] = [];
const noop = () => undefined;

/** A trip, some places or a stretch of timeline from a chat, in a window. The
 *  route is asked for afresh, so an old chat still shows a real one. */
export function MapCardModal({ card, onClose }: { card: MapCard; onClose: () => void }) {
  const map = useRef<MapViewHandle>(null);
  const [selected, setSelected] = useState(0);
  const [steps, setSteps] = useState(false);
  const { data: config, isLoading: loadingConfig } = useQuery({ queryKey: ["maps-config"], queryFn: mapsApi.config, staleTime: 3_600_000 });
  const { data: mine } = useQuery({ queryKey: ["maps-mine"], queryFn: mapsApi.mine });
  const saved: SavedPlace[] = mine?.places ?? NOTHING;
  const stops = useMemo(() => card.stops ?? [], [card]);
  const route = useQuery({
    queryKey: ["maps-card-route", stops, card.mode],
    queryFn: () => mapsApi.route(stops, { mode: card.mode ?? "drive", avoid_tolls: false, avoid_highways: false, avoid_ferries: false }),
    enabled: card.kind === "route" && stops.length >= 2,
    staleTime: 600_000,
    retry: false,
  });
  const routes = route.data?.routes ?? NOTHING;
  const current = routes[selected];

  const places = card.places ?? NOTHING;
  const stays = card.stays ?? NOTHING;
  const fitTo = useMemo<[number, number][]>(() => {
    if (routes.length) return routes[0].legs.flatMap((l) => decodeShape(l.shape));
    if (card.kind === "route") return stops.map((s) => [s.lon, s.lat]);
    if (card.kind === "timeline") return [...(card.lines ?? []).flat(), ...stays.map((s): [number, number] => [s.lon, s.lat])];
    return places.map((p) => [p.lon, p.lat]);
  }, [routes, card, stops, stays, places]);
  const marks = useMemo(() => (card.kind === "timeline" ? stays : places), [card.kind, stays, places]);
  const trail = useMemo(() => card.lines ?? NOTHING, [card]);

  const title = card.kind === "route" ? stops.map((s) => s.name).join(" to ") : card.title ?? "Map";
  const openLink = card.kind === "route"
    ? mapsRouteLink(stops, card.mode)
    : places[0] ? mapsPinLink(places[0].lat, places[0].lon, places[0].name) : "/maps";

  return (
    <Modal open onClose={onClose} title={title} widthClass="max-w-4xl">
      <div className="flex max-h-[75vh] flex-col gap-3">
        <div className="relative h-[52vh] min-h-[260px] overflow-hidden rounded-xl border border-[var(--border)]">
          {config?.basemap ? (
            <MapView
              ref={map}
              basemap={config.basemap}
              routes={routes}
              selected={selected}
              pin={null}
              stops={stops}
              chargers={NOTHING}
              parked={null}
              you={null}
              saved={saved}
              friends={NOTHING}
              marks={marks}
              trail={trail}
              fitTo={fitTo}
              onHold={noop}
              onPick={noop}
              onPickSaved={noop}
              onPickCharger={noop}
              onPickRoute={setSelected}
              onPickParked={noop}
              onMoved={noop}
            />
          ) : (
            <p className="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--text-muted)]">
              {loadingConfig ? "Loading the map…" : "Maps aren't set up on this server."}
            </p>
          )}
        </div>

        {card.kind === "route" && (
          <div className="min-h-0 overflow-y-auto">
            {route.isLoading && <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />Finding the way…</p>}
            {route.error && <p className="text-sm text-[var(--text-muted)]">{apiErrorMessage(route.error, "Couldn't get this route now.")}</p>}
            <div className="flex flex-wrap gap-2">
              {routes.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSelected(i)}
                  aria-pressed={i === selected}
                  className={`rounded-xl border px-3 py-1.5 text-left text-sm ${i === selected ? "border-[var(--accent)] bg-[var(--hover)]" : "border-[var(--border)] hover:bg-[var(--hover)]"}`}
                >
                  <span className="font-semibold text-[var(--text)]">{formatDuration(routeSeconds(r))}</span>
                  <span className="ml-2 text-[var(--text-muted)]">{formatKm(r.km)}{r.toll ? " · Tolls" : ""}{r.ferry ? " · Ferry" : ""}</span>
                  {trafficLine(r) && <span className="block text-xs text-[var(--text-muted)]">{trafficLine(r)}</span>}
                  {r.preferred && <span className="block text-xs font-medium text-[var(--accent-text)]">Your usual way</span>}
                  {r.incidents?.[0] && <span className="block text-xs font-medium text-[#C62828]">{r.incidents[0].label}{r.incidents[0].from ? ` on ${r.incidents[0].from}` : ""}{r.incidents.length > 1 ? `, and ${r.incidents.length - 1} more` : ""}</span>}
                </button>
              ))}
            </div>
            {current && !current.traffic && <p className="mt-1.5 text-xs text-[var(--text-muted)]">Times come from road speeds, without live traffic.</p>}
            {current && (
              <button type="button" onClick={() => setSteps((v) => !v)} aria-expanded={steps} className="mt-1.5 inline-flex items-center gap-1 text-sm text-[var(--text)] hover:underline">
                Steps{steps ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
            )}
            {current && steps && (
              <ol className="mt-1 text-sm">
                {current.legs.flatMap((l, li) => l.steps.map((s, si) => (
                  <li key={`${li}-${si}`} className="flex justify-between gap-3 border-b border-[var(--border)] py-1.5 last:border-0">
                    <span className="text-[var(--text)]">{s.text}</span>
                    {s.km > 0 && <span className="shrink-0 text-xs text-[var(--text-muted)]">{formatKm(s.km)}</span>}
                  </li>
                )))}
              </ol>
            )}
          </div>
        )}
        {card.kind !== "route" && marks.length > 0 && (
          <ul className="min-h-0 overflow-y-auto">
            {marks.map((p, i) => (
              <li key={i}>
                <button type="button" onClick={() => map.current?.flyTo(p.lat, p.lon, 15)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]">
                  <MapPin className="h-4 w-4 shrink-0 text-[var(--accent-text)]" />
                  <span className="truncate">{p.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end">
          <Link to={openLink} onClick={onClose} className="inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--accent-strong)] px-3.5 text-sm font-medium text-white hover:opacity-90">
            <ExternalLink className="h-4 w-4" />Open in Maps
          </Link>
        </div>
      </div>
    </Modal>
  );
}
