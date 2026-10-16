import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, List, X, ZoomIn } from "lucide-react";
import { Link } from "react-router-dom";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { photosApi, type PhotoItem } from "@/api/photos";
import { PhotoViewer } from "@/components/photos/PhotoViewer";
import { useAuthStore } from "@/store/authStore";
import { useThemeStore } from "@/store/themeStore";
import { apiErrorMessage } from "@/utils/apiError";

/** The Photos map (PH-5): where your photos were taken, clustered — click
 *  a cluster for its photos. Offline: the countries are bundled (Natural
 *  Earth, public domain); streets and towns come from a basemap the admin
 *  put on the server (a Protomaps PMTiles extract), when there is one. */

const COLORS = {
  light: { sea: "#dfe9f2", land: "#f6f3ee", border: "#c9c2b6", water: "#bcd4ea", road: "#ffffff", roadEdge: "#e2dccf", park: "#e3eedb", dot: "#c66e51" },
  dark: { sea: "#16202a", land: "#23211f", border: "#3d3935", water: "#1b2a38", road: "#3a3632", roadEdge: "#2b2825", park: "#232b21", dot: "#e08b6d" },
};

export function PhotoMapPage() {
  const { data, error, isLoading } = useQuery({ queryKey: ["photo-map"], queryFn: photosApi.map, staleTime: 5 * 60_000 });
  const theme = useThemeStore((s) => s.resolved());
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [picked, setPicked] = useState<{ ids: string[]; total: number; zoomTo?: () => void } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const { data: pickedItems } = useQuery({
    queryKey: ["photo-map-picked", picked?.ids],
    queryFn: () => photosApi.items(picked!.ids.slice(0, 200)),
    enabled: !!picked?.ids.length,
  });

  useEffect(() => {
    if (!data || !box.current) return;
    let map: MapLibreMap | null = null;
    let off = false;
    void (async () => {
      const [maplibre, worker] = await Promise.all([
        import("maplibre-gl"),
        // Its worker, bundled here: v6 looks for it beside its own module file,
        // which isn't where a bundle puts it.
        import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"),
      ]);
      maplibre.setWorkerUrl(worker.default);
      const c = COLORS[theme];
      const sources: Record<string, unknown> = {
        countries: { type: "geojson", data: "/maps/countries-110m.geojson" },
        photos: {
          type: "geojson", cluster: true, clusterRadius: 44, clusterMaxZoom: 15,
          data: {
            type: "FeatureCollection",
            features: data.ids.map((id, i) => ({ type: "Feature", properties: { id }, geometry: { type: "Point", coordinates: [data.lon[i], data.lat[i]] } })),
          },
        },
      };
      const layers: unknown[] = [
        { id: "sea", type: "background", paint: { "background-color": c.sea } },
        { id: "countries", type: "fill", source: "countries", paint: { "fill-color": c.land } },
        { id: "borders", type: "line", source: "countries", paint: { "line-color": c.border, "line-width": 0.7 } },
      ];
      if (data.basemap) {
        // Streets and towns from the server's offline basemap (Protomaps' layers).
        const { Protocol, PMTiles, FetchSource } = await import("pmtiles");
        const url = `${window.location.origin}${data.basemap}`;
        const protocol = new Protocol();
        const token = useAuthStore.getState().accessToken;
        protocol.add(new PMTiles(new FetchSource(url, new Headers(token ? { Authorization: `Bearer ${token}` } : {}))));
        maplibre.addProtocol("pmtiles", protocol.tile);
        sources.base = { type: "vector", url: `pmtiles://${url}` };
        layers.push(
          { id: "earth", type: "fill", source: "base", "source-layer": "earth", paint: { "fill-color": c.land } },
          { id: "park", type: "fill", source: "base", "source-layer": "landuse", filter: ["in", ["get", "kind"], ["literal", ["park", "forest", "wood", "nature_reserve", "grass"]]], paint: { "fill-color": c.park } },
          { id: "water", type: "fill", source: "base", "source-layer": "water", paint: { "fill-color": c.water } },
          { id: "road-edge", type: "line", source: "base", "source-layer": "roads", minzoom: 10, paint: { "line-color": c.roadEdge, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 16, 9] } },
          { id: "road", type: "line", source: "base", "source-layer": "roads", paint: { "line-color": c.road, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.4, 16, 7] } },
          { id: "base-borders", type: "line", source: "base", "source-layer": "boundaries", paint: { "line-color": c.border, "line-width": 0.8 } },
        );
      }
      layers.push(
        {
          id: "clusters", type: "circle", source: "photos", filter: ["has", "point_count"],
          paint: {
            "circle-color": c.dot, "circle-opacity": 0.85, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2,
            "circle-radius": ["step", ["get", "point_count"], 12, 10, 16, 100, 22, 1000, 30],
          },
        },
        {
          id: "photo", type: "circle", source: "photos", filter: ["!", ["has", "point_count"]],
          paint: { "circle-color": c.dot, "circle-radius": 7, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
        },
      );
      if (off || !box.current) return;
      map = new maplibre.Map({
        container: box.current,
        style: { version: 8, sources, layers } as never,
        center: [0, 20], zoom: 1, attributionControl: { compact: true, customAttribution: "Natural Earth" },
      });
      mapRef.current = map;
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        if (!map || !data.ids.length) return;
        const b = new maplibre.LngLatBounds();
        data.ids.forEach((_, i) => b.extend([data.lon[i], data.lat[i]]));
        // Countries only: no closer than a country fills the screen.
        map.fitBounds(b, { padding: 60, maxZoom: data.basemap ? 12 : 4, duration: 0 });
      });
      map.on("click", "clusters", async (e) => {
        const f = e.features?.[0];
        if (!map || !f) return;
        const src = map.getSource("photos") as GeoJSONSource;
        const clusterId = f.properties.cluster_id as number;
        const total = f.properties.point_count as number;
        const leaves = await src.getClusterLeaves(clusterId, 200, 0);
        const zoom = await src.getClusterExpansionZoom(clusterId);
        const at = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
        setPicked({ ids: leaves.map((l) => String(l.properties?.id)), total, zoomTo: () => map?.easeTo({ center: at, zoom }) });
      });
      map.on("click", "photo", (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (id) setPicked({ ids: [String(id)], total: 1 });
      });
      for (const layer of ["clusters", "photo"]) {
        map.on("mouseenter", layer, () => map && (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => map && (map.getCanvas().style.cursor = ""));
      }
    })();
    return () => {
      off = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [data, theme]);

  const items: PhotoItem[] = pickedItems ?? [];
  return (
    // flex-1 as well as h-full: the map's box must have a real height.
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <Link to="/files/photos" aria-label="Back to Photos" className="rounded p-1 hover:bg-[var(--hover)]">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="flex-1 text-base font-semibold text-[var(--text)]">Map</h1>
        <span className="text-xs text-[var(--text-muted)]">
          {data ? `${data.ids.length.toLocaleString()} ${data.ids.length === 1 ? "photo" : "photos"} with a place` : ""}
        </span>
        <Link to="/files/photos/places" className="flex items-center gap-1 rounded-full px-3 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <List className="h-3.5 w-3.5" /> List
        </Link>
      </header>
      <div className="relative min-h-0 flex-1">
        {isLoading && <p className="p-6 text-sm text-[var(--text-muted)]">Loading…</p>}
        {error && <p role="alert" className="p-6 text-sm text-[var(--text-muted)]">{apiErrorMessage(error, "Couldn't load the map.")}</p>}
        {/* MapLibre makes its container position: relative — the size comes
            from this wrapper. */}
        <div className="absolute inset-0">
          <div ref={box} aria-label="Map of your photos" role="region" className="h-full w-full" />
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
