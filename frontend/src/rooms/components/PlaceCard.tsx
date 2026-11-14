import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, MapPin, Navigation, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import type { SharedPlace } from "@/api/rooms";
import { mapsApi } from "@/maps/api";
import { mapsPinLink } from "@/maps/links";
import { useThemeStore } from "@/store/themeStore";
import { cn } from "@/utils/cn";

import { keptPreview, placePreview } from "../placePreview";

/** Straight to directions to the place, from where you are. */
export function mapsDirectionsLink(p: SharedPlace): string {
  return `${mapsPinLink(p.lat, p.lon, p.name)}&go=1`;
}

/**
 * A place sent from P Maps (the message's ``meta.place``): a small picture of
 * the map with a pin, its name and address, and two things to do with it.
 * The picture is drawn from this server's own map once the card scrolls into
 * view; where P Maps isn't set up for you, the card is the same without it.
 */
export function PlaceCard({ place, own }: { place: SharedPlace; own?: boolean }) {
  const theme = useThemeStore((s) => s.resolved());
  const { data: config } = useQuery({ queryKey: ["maps-config"], queryFn: mapsApi.config, staleTime: 3_600_000, retry: false });
  const basemap = config?.ready ? config.basemap : null;
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [img, setImg] = useState<string | null>(() => keptPreview(theme, place.lat, place.lon));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  useEffect(() => {
    const have = keptPreview(theme, place.lat, place.lon);
    setImg(have);
    setFailed(false);
    if (have || !seen || !basemap) return;
    let live = true;
    void placePreview(basemap, theme, place.lat, place.lon).then((url) => {
      if (!live) return;
      if (url) setImg(url);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [seen, basemap, theme, place.lat, place.lon]);

  const withMap = !!basemap && !failed;
  const pin = mapsPinLink(place.lat, place.lon, place.name);

  return (
    <div
      ref={box}
      className={cn(
        "mt-1 w-[min(20rem,100%)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-left shadow-[var(--shadow-sm)]",
        own && "self-end",
      )}
    >
      {withMap && (
        <Link to={pin} aria-label={`${place.name} on the map`} className="relative block aspect-[7/3] w-full overflow-hidden bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]">
          {img ? (
            <img src={img} alt="" draggable={false} className="rooms-place-map h-full w-full object-cover" />
          ) : (
            <span className="absolute inset-0 animate-pulse bg-[var(--hover)]" aria-hidden="true" />
          )}
          {/* The pin: its tip sits on the place, at the middle of the picture. */}
          <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full" aria-hidden="true">
            <svg width="30" height="38" viewBox="0 0 30 38" className="drop-shadow-[0_2px_3px_rgba(0,0,0,0.35)]">
              <path d="M15 1.5c-7.2 0-13 5.7-13 12.8 0 9.3 10.6 20.2 12.1 21.7a1.3 1.3 0 0 0 1.800 0C17.400 34.500 28 23.600 28 14.3 28 7.2 22.200 1.500 15 1.500Z" fill="#D97757" stroke="#fff" strokeWidth="2" />
              <circle cx="15" cy="14.3" r="4.6" fill="#fff" />
            </svg>
          </span>
          {img && <span className="pointer-events-none absolute bottom-1 right-1.5 rounded bg-[color-mix(in_srgb,var(--surface)_78%,transparent)] px-1 text-[10px] leading-4 text-[var(--text-muted)]">© OpenStreetMap</span>}
        </Link>
      )}
      <div className="flex items-start gap-2.5 px-3 pt-2.5">
        {!withMap && (
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent-text)]">
            <MapPin className="h-5 w-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 break-words text-sm font-semibold leading-snug text-[var(--text)]">{place.name}</p>
          {place.address && place.address !== place.name && <p className="mt-0.5 line-clamp-2 break-words text-xs leading-snug text-[var(--text-muted)]">{place.address}</p>}
        </div>
      </div>
      <div className="flex gap-2 p-3 pt-2.5">
        <Link
          to={mapsDirectionsLink(place)}
          className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[var(--accent-strong)] px-3 text-sm font-semibold text-white transition hover:bg-[var(--accent-strong-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] md:h-9"
        >
          <Navigation className="h-4 w-4" />
          Directions
        </Link>
        <Link
          to={pin}
          className="inline-flex h-10 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-xl border border-[var(--border)] px-3 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] md:h-9"
        >
          Open in P Maps
          <ArrowUpRight className="h-3.5 w-3.5 text-[var(--text-muted)]" />
        </Link>
      </div>
    </div>
  );
}

/** The place waiting above the box you type in: sent with your next message. */
export function AttachedPlace({ place, onRemove }: { place: SharedPlace; onRemove: () => void }) {
  return (
    <div className="mb-1.5 flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2" role="group" aria-label="Place attached to your message">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent-text)]">
        <MapPin className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[var(--text)]">{place.name}</span>
        <span className="block truncate text-xs text-[var(--text-muted)]">{place.address && place.address !== place.name ? place.address : "A place on the map"}</span>
      </span>
      <button
        type="button"
        aria-label="Remove the place"
        onClick={onRemove}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
