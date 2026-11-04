import { useEffect, useRef } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { loadMapLibre, serverMapStyle } from "@/components/maps/mapStyle";
import { useThemeStore } from "@/store/themeStore";

/** A clustered map of points (MapLibre): the Photos map's map, shared with
 *  Places. Streets, towns and place names come from this server's own map
 *  (P Maps); nothing is fetched from anywhere else. Without one, the bundled
 *  countries (Natural Earth, public domain). Clicking a dot or a cluster hands
 *  its point ids to ``onPick``. */

const COLORS = {
  light: { sea: "#dfe9f2", land: "#f6f3ee", border: "#c9c2b6", dot: "#c66e51" },
  dark: { sea: "#16202a", land: "#23211f", border: "#3d3935", dot: "#e08b6d" },
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
  onPick: (pick: MapPick) => void;
  label: string;
  /** Fly here when it changes (a place picked in a list). */
  focus?: { lat: number; lon: number; zoom?: number } | null;
}

export function ClusterMap({ points, basemap, onPick, label, focus }: ClusterMapProps) {
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
      const maplibre = await loadMapLibre();
      const c = COLORS[theme];
      const pointsSource = {
        type: "geojson", cluster: true, clusterRadius: 44, clusterMaxZoom: 15,
        clusterProperties: { weight: ["+", ["get", "weight"]] },
        data: {
          type: "FeatureCollection",
          features: points.map((p) => ({ type: "Feature", properties: { id: p.id, weight: p.weight ?? 1 }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })),
        },
      };
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
      let style: unknown;
      if (basemap) {
        const base = await serverMapStyle(maplibre, theme, basemap);
        style = { ...base, sources: { ...base.sources, points: pointsSource }, layers: [...base.layers, ...dots] };
      } else {
        style = {
          version: 8,
          sources: { countries: { type: "geojson", data: "/map-assets/countries-110m.geojson" }, points: pointsSource },
          layers: [
            { id: "sea", type: "background", paint: { "background-color": c.sea } },
            { id: "countries", type: "fill", source: "countries", paint: { "fill-color": c.land } },
            { id: "borders", type: "line", source: "countries", paint: { "line-color": c.border, "line-width": 0.7 } },
            ...dots,
          ],
        };
      }
      if (off || !box.current) return;
      map = new maplibre.Map({
        container: box.current,
        style: style as never,
        center: [0, 20], zoom: 1,
        attributionControl: basemap ? { compact: true } : { compact: true, customAttribution: "Natural Earth" },
      });
      mapRef.current = map;
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        if (!map) return;
        if (!points.length) return;
        const b = new maplibre.LngLatBounds();
        points.forEach((p) => b.extend([p.lon, p.lat]));
        // Countries only: no closer than a country fills the screen.
        map.fitBounds(b, { padding: 60, maxZoom: basemap ? 12 : 4, duration: 0 });
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
  }, [points, basemap, theme]);

  useEffect(() => {
    if (focus && mapRef.current) mapRef.current.easeTo({ center: [focus.lon, focus.lat], zoom: focus.zoom ?? 9 });
  }, [focus]);

  // MapLibre makes its container position: relative — the size comes from
  // the caller's wrapper.
  return <div ref={box} aria-label={label} role="region" className="h-full w-full" />;
}
