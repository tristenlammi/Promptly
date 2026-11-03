import { useEffect, useRef } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { useAuthStore } from "@/store/authStore";
import { useThemeStore } from "@/store/themeStore";

/** A clustered map of points (MapLibre) — the Photos map's map, shared with
 *  Places. Streets, towns and place names come from the server's own
 *  offline basemap (a Protomaps PMTiles extract) when the admin put one
 *  there; otherwise from OpenFreeMap (free, no key — the browser fetches
 *  the tiles of the area on screen; ``PHOTOS_ONLINE_MAP``). With neither,
 *  the bundled countries (Natural Earth, public domain). Clicking a dot or
 *  a cluster hands its point ids to ``onPick``. */

// OpenFreeMap's styles (openfreemap.org): a light and a dark one.
const ONLINE_STYLE = {
  light: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.openfreemap.org/styles/dark",
};

const COLORS = {
  light: { sea: "#dfe9f2", land: "#f6f3ee", border: "#c9c2b6", water: "#bcd4ea", road: "#ffffff", roadEdge: "#e2dccf", park: "#e3eedb", dot: "#c66e51" },
  dark: { sea: "#16202a", land: "#23211f", border: "#3d3935", water: "#1b2a38", road: "#3a3632", roadEdge: "#2b2825", park: "#232b21", dot: "#e08b6d" },
};

export interface MapPoint {
  id: string;
  lat: number;
  lon: number;
  /** Counts toward a cluster's total (default 1) — e.g. photos at a place. */
  weight?: number;
}

export interface MapPick {
  ids: string[];
  total: number;
  zoomTo?: () => void;
}

export interface ClusterMapProps {
  /** Memoise this: a new array rebuilds the map. */
  points: MapPoint[];
  basemap: string | null;
  online: boolean;
  onPick: (pick: MapPick) => void;
  label: string;
  /** Fly here when it changes (a place picked in a list). */
  focus?: { lat: number; lon: number; zoom?: number } | null;
}

export function ClusterMap({ points, basemap, online: onlineAllowed, onPick, label, focus }: ClusterMapProps) {
  const theme = useThemeStore((s) => s.resolved());
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    if (!box.current) return;
    let map: MapLibreMap | null = null;
    let off = false;
    void (async () => {
      const [maplibre, worker] = await Promise.all([
        import("maplibre-gl"),
        // Its worker, bundled here: v6 looks for it beside its own module file,
        // which isn't where a bundle puts it.
        import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"),
      ]);
      // Run it from an in-page copy (a blob URL), so it follows this page's
      // security rules. Started from its own URL it follows the headers that
      // file was cached with — on an update that changes the rules (letting
      // the map's tiles in), an old copy kept the old ones and every tile
      // was refused. The worker is one self-contained file.
      let workerUrl = worker.default;
      try {
        const code = await (await fetch(worker.default)).text();
        workerUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      } catch {
        /* the file's own URL still works where the rules allow it */
      }
      maplibre.setWorkerUrl(workerUrl);
      const c = COLORS[theme];
      const sources: Record<string, unknown> = {
        countries: { type: "geojson", data: "/maps/countries-110m.geojson" },
        points: {
          type: "geojson", cluster: true, clusterRadius: 44, clusterMaxZoom: 15,
          clusterProperties: { weight: ["+", ["get", "weight"]] },
          data: {
            type: "FeatureCollection",
            features: points.map((p) => ({ type: "Feature", properties: { id: p.id, weight: p.weight ?? 1 }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })),
          },
        },
      };
      const online = !basemap && onlineAllowed;
      const layers: unknown[] = [
        { id: "sea", type: "background", paint: { "background-color": c.sea } },
        { id: "countries", type: "fill", source: "countries", paint: { "fill-color": c.land } },
        { id: "borders", type: "line", source: "countries", paint: { "line-color": c.border, "line-width": 0.7 } },
      ];
      if (basemap) {
        // Streets and towns from the server's offline basemap (Protomaps' layers).
        const { Protocol, PMTiles, FetchSource } = await import("pmtiles");
        const url = `${window.location.origin}${basemap}`;
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
      const dots: unknown[] = [
        {
          id: "clusters", type: "circle", source: "points", filter: ["has", "point_count"],
          paint: {
            "circle-color": c.dot, "circle-opacity": 0.85, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2,
            "circle-radius": ["step", ["get", "weight"], 12, 10, 16, 100, 22, 1000, 30],
          },
        },
        {
          id: "point", type: "circle", source: "points", filter: ["!", ["has", "point_count"]],
          paint: { "circle-color": c.dot, "circle-radius": 7, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
        },
      ];
      if (!online) layers.push(...dots);
      if (off || !box.current) return;
      map = new maplibre.Map({
        container: box.current,
        // Online: OpenFreeMap's style (its attribution comes with it); the
        // points go on top once it's loaded.
        style: online ? ONLINE_STYLE[theme] : ({ version: 8, sources, layers } as never),
        center: [0, 20], zoom: 1,
        attributionControl: online ? { compact: true } : { compact: true, customAttribution: "Natural Earth" },
      });
      mapRef.current = map;
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        if (!map) return;
        if (online) {
          map.addSource("points", sources.points as never);
          for (const layer of dots) map.addLayer(layer as never);
        }
        if (!points.length) return;
        const b = new maplibre.LngLatBounds();
        points.forEach((p) => b.extend([p.lon, p.lat]));
        // Countries only: no closer than a country fills the screen.
        map.fitBounds(b, { padding: 60, maxZoom: basemap || online ? 12 : 4, duration: 0 });
      });
      map.on("click", "clusters", async (e) => {
        const f = e.features?.[0];
        if (!map || !f) return;
        const src = map.getSource("points") as GeoJSONSource;
        const clusterId = f.properties.cluster_id as number;
        const count = f.properties.point_count as number;
        const total = (f.properties.weight as number) ?? count;
        const leaves = await src.getClusterLeaves(clusterId, 200, 0);
        const zoom = await src.getClusterExpansionZoom(clusterId);
        const at = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
        pickRef.current({ ids: leaves.map((l) => String(l.properties?.id)), total, zoomTo: () => map?.easeTo({ center: at, zoom }) });
      });
      map.on("click", "point", (e) => {
        const props = e.features?.[0]?.properties;
        if (props?.id) pickRef.current({ ids: [String(props.id)], total: Number(props.weight) || 1 });
      });
      for (const layer of ["clusters", "point"]) {
        map.on("mouseenter", layer, () => map && (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => map && (map.getCanvas().style.cursor = ""));
      }
    })();
    return () => {
      off = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [points, basemap, onlineAllowed, theme]);

  useEffect(() => {
    if (focus && mapRef.current) mapRef.current.easeTo({ center: [focus.lon, focus.lat], zoom: focus.zoom ?? 9 });
  }, [focus]);

  // MapLibre makes its container position: relative — the size comes from
  // the caller's wrapper.
  return <div ref={box} aria-label={label} role="region" className="h-full w-full" />;
}
