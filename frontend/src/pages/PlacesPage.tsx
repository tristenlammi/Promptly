import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronRight, Contact, Images, List, Map as MapIcon, MapPin, Navigation, Plane, X } from "lucide-react";

import { placesApi, type Place, type PlaceSource } from "@/api/places";
import { ClusterMap, type MapPick } from "@/components/maps/ClusterMap";
import { TopNav } from "@/components/layout/TopNav";
import { EmptyState } from "@/components/shared/EmptyState";
import { Skeleton } from "@/components/shared/Skeleton";
import { mapsPinLink } from "@/maps/links";
import { useMapsReady } from "@/maps/useMapsReady";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Places — where things are, across Promptly: trip stops, where your photos
 * were taken, event locations and contact addresses, grouped by town, each
 * linking back into its app. Matched offline (GeoNames); free-text places
 * that couldn't be matched are in the list but not on the map.
 */

const SOURCES: { key: PlaceSource; label: string; icon: typeof Plane }[] = [
  { key: "trip", label: "Trips", icon: Plane },
  { key: "photos", label: "Photos", icon: Images },
  { key: "event", label: "Events", icon: CalendarDays },
  { key: "contact", label: "Contacts", icon: Contact },
];
const ICON: Record<string, typeof Plane> = { trip: Plane, photos: Images, event: CalendarDays, contact: Contact };

function shortDate(when: string | null): string {
  if (!when) return "";
  const d = new Date(when.length <= 10 ? `${when}T12:00:00` : when);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

export function PlacesPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["places"], queryFn: placesApi.get, staleTime: 60_000 });
  const [only, setOnly] = useState<PlaceSource | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<MapPick | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lon: number } | null>(null);
  const [view, setView] = useState<"list" | "map">("list");
  const mapsReady = useMapsReady();

  const places = useMemo(
    () => (data?.places ?? []).filter((p) => !only || p.counts[only] > 0),
    [data, only],
  );
  const points = useMemo(
    () => places.filter((p) => p.lat != null && p.lon != null).map((p) => ({ id: p.key, lat: p.lat!, lon: p.lon!, weight: p.total })),
    [places],
  );
  const shown = picked ? places.filter((p) => picked.ids.includes(p.key)) : places;
  const unmapped = places.filter((p) => p.lat == null).length;

  const choose = (p: Place) => {
    setOpen((cur) => (cur === p.key ? null : p.key));
    if (p.lat != null && p.lon != null) setFocus({ lat: p.lat, lon: p.lon });
  };

  return (
    <>
      <TopNav title="Places" />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className={cn("flex min-h-0 flex-col border-[var(--border)] md:w-[26rem] md:shrink-0 md:border-r", view === "map" && "hidden md:flex", "flex-1 md:flex-none")}>
          <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-3 py-2">
            <button
              type="button"
              onClick={() => setOnly(null)}
              className={cn("rounded-full px-2.5 py-1 text-xs", !only ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:bg-[var(--hover)]")}
            >
              All
            </button>
            {SOURCES.map((s) => (
              <button
                key={s.key}
                type="button"
                aria-pressed={only === s.key}
                onClick={() => setOnly(only === s.key ? null : s.key)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs",
                  only === s.key ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:bg-[var(--hover)]",
                )}
              >
                <s.icon className="h-3 w-3" /> {s.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setView("map")}
              className="ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)] md:hidden"
            >
              <MapIcon className="h-3.5 w-3.5" /> Map
            </button>
          </div>
          {picked && (
            <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs text-[var(--text-muted)]">
              <span className="flex-1">
                {shown.length} {shown.length === 1 ? "place" : "places"} on the map spot you picked
              </span>
              {picked.zoomTo && (
                <button type="button" onClick={picked.zoomTo} className="rounded px-1.5 py-0.5 hover:bg-[var(--hover)]">
                  Zoom in
                </button>
              )}
              <button type="button" aria-label="Show all places" onClick={() => setPicked(null)} className="rounded p-0.5 hover:bg-[var(--hover)]">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="space-y-2 p-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : error ? (
              <p role="alert" className="p-6 text-sm text-[var(--text-muted)]">
                {apiErrorMessage(error, "Couldn't load your places.")}
              </p>
            ) : !shown.length ? (
              only || picked ? (
                <EmptyState
                  icon={<MapPin className="h-5 w-5" />}
                  title={picked ? "Nothing at that spot" : `No places from ${SOURCES.find((s) => s.key === only)?.label ?? "this"} yet`}
                  description={picked ? "Pick another spot on the map, or go back to all of your places." : "Your other places are still here."}
                  action={
                    <button
                      type="button"
                      onClick={() => {
                        setOnly(null);
                        setPicked(null);
                      }}
                      className="inline-flex h-10 items-center rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-white hover:opacity-90"
                    >
                      Show all places
                    </button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<MapPin className="h-5 w-5" />}
                  title="No places yet"
                  description="Trips with destinations, photos with a location, events with a place and contacts with an address show up here."
                />
              )
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {shown.map((p) => (
                  <PlaceRow key={p.key} place={p} open={open === p.key} onToggle={() => choose(p)} mapsReady={mapsReady} />
                ))}
              </ul>
            )}
            {data && (
              <p className="px-3 py-3 text-xs text-[var(--text-muted)]">
                {unmapped ? `${unmapped} ${unmapped === 1 ? "place isn't" : "places aren't"} on the map — written as text Promptly couldn't place. ` : ""}
                {data.attribution ?? (data.gazetteer ? "" : "Town names load the first time Photos needs them; until then only pinned places are on the map.")}
              </p>
            )}
          </div>
        </div>
        <div className={cn("relative min-h-[16rem] flex-1", view === "list" && "hidden md:block")}>
          <div className="absolute inset-0">
            {data && (
              <ClusterMap
                points={points}
                basemap={data.basemap}
                focus={focus}
                label="Map of your places"
                onPick={(pick) => {
                  setPicked(pick);
                  setView("list");
                  if (pick.ids.length === 1) setOpen(pick.ids[0]);
                }}
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => setView("list")}
            className="absolute left-3 top-3 z-10 inline-flex items-center gap-1 rounded-full bg-[var(--surface)] px-3 py-1 text-xs shadow md:hidden"
          >
            <List className="h-3.5 w-3.5" /> List
          </button>
        </div>
      </div>
    </>
  );
}

function PlaceRow({ place: p, open, onToggle, mapsReady }: { place: Place; open: boolean; onToggle: () => void; mapsReady: boolean }) {
  return (
    <li>
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--hover)]">
        <MapPin className={cn("h-4 w-4 shrink-0", p.lat != null ? "text-[var(--accent-text)]" : "text-[var(--text-muted)]")} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--text)]">{p.name}</span>
          {p.sub && <span className="block truncate text-xs text-[var(--text-muted)]">{p.sub}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-[var(--text-muted)]">
          {SOURCES.filter((s) => p.counts[s.key] > 0).map((s) => (
            <span key={s.key} className="inline-flex items-center gap-0.5" title={s.label}>
              <s.icon className="h-3 w-3" />
              {p.counts[s.key]}
            </span>
          ))}
        </span>
      </button>
      {open && (
        <ul className="pb-2">
          {mapsReady && p.lat != null && p.lon != null && (
            <li>
              <Link to={mapsPinLink(p.lat, p.lon, p.name)} className="flex min-h-10 items-center gap-2.5 px-3 py-1.5 pl-10 hover:bg-[var(--hover)] md:min-h-0">
                <Navigation className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" />
                <span className="min-w-0 flex-1 truncate text-sm">Open in Maps</span>
                <ChevronRight className="h-3.5 w-3.5 text-[var(--text-muted)]" />
              </Link>
            </li>
          )}
          {p.photos && (
            <li>
              <Link to={p.photos.url} className="flex items-center gap-2.5 px-3 py-1.5 pl-10 hover:bg-[var(--hover)]">
                <Images className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {p.photos.count} {p.photos.count === 1 ? "photo" : "photos"}
                </span>
                <ChevronRight className="h-3.5 w-3.5 text-[var(--text-muted)]" />
              </Link>
            </li>
          )}
          {p.items.map((m, i) => {
            const Icon = ICON[m.source] ?? MapPin;
            return (
              <li key={`${m.url}-${i}`}>
                <Link to={m.url} className="flex items-center gap-2.5 px-3 py-1.5 pl-10 hover:bg-[var(--hover)]">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{m.title}</span>
                    <span className="block truncate text-xs text-[var(--text-muted)]">
                      {[m.detail, shortDate(m.when), m.place && m.place !== m.title ? m.place : ""].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                </Link>
              </li>
            );
          })}
          {p.more > 0 && <li className="px-3 pl-10 text-xs text-[var(--text-muted)]">and {p.more} more</li>}
        </ul>
      )}
    </li>
  );
}
