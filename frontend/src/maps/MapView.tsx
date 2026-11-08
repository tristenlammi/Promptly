import type { GeoJSONSource, LngLatBoundsLike, Map as MapLibreMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

import { loadMapLibre, serverMapStyle, signTrafficRequest } from "@/components/maps/mapStyle";
import { useThemeStore } from "@/store/themeStore";

import { PLACE_ICON_SVG } from "./placeIcons";
import { decodeShape, type Charger, type Parked, type Route, type RouteIncident, type SavedPlace, type Spot } from "./api";

export interface MapViewHandle {
  flyTo(lat: number, lon: number, zoom?: number): void;
  fit(points: [number, number][], padding?: { top: number; bottom: number; left: number; right: number }): void;
  center(): { lat: number; lon: number } | null;
  bounds(): [number, number, number, number] | null;
  /** The part of the map you can see past the panels (pixels covered on each side). */
  visibleBounds(inset: { top: number; bottom: number; left: number; right: number }): [number, number, number, number] | null;
}

interface Props {
  basemap: string | null;
  routes: Route[];
  selected: number;
  pin: Spot | null;
  stops: Spot[];
  chargers: Charger[];
  parked: Parked | null;
  you: { lat: number; lon: number; accuracy: number } | null;
  /** Your saved places: always on the map. */
  saved: SavedPlace[];
  onPickSaved: (place: SavedPlace) => void;
  friends: { user_id: string; name: string; live: { lat: number; lon: number } | null }[];
  /** Numbered dots: search results, or the stays of a day. */
  marks?: { lat: number; lon: number; name: string }[];
  /** Lines of [lon, lat]: journeys on your timeline. */
  trail?: [number, number][][];
  /** Tapped a warning on the route, or one on the traffic layer. */
  onPickIncident?: (incident: Pick<RouteIncident, "label" | "text" | "lat" | "lon" | "delay_seconds">) => void;
  /** Colour the roads by how busy they are. */
  showTraffic?: boolean;
  /** 1-degree squares ("<west>_<south>") shaded on the map: an offline area's. */
  squares?: string[];
  /** Frame these once the map's ready, and whenever they change. */
  fitTo?: [number, number][];
  /** Choosing a point on the map: a tap goes here and nothing else happens. */
  onPickPoint?: (lat: number, lon: number) => void;
  /** A long-press, or a right-click: what's here? */
  onHold: (lat: number, lon: number) => void;
  /** A name on the map tapped. */
  onPick: (spot: Spot) => void;
  onPickCharger: (c: Charger) => void;
  onPickRoute: (index: number) => void;
  onPickParked: () => void;
  onMoved: () => void;
}

const EMPTY = { type: "FeatureCollection", features: [] };
const ROUTE = "#D97757";

// A kind's own look, until you choose another.
const SAVED_LOOK: Record<SavedPlace["kind"], { colour: string; icon: string }> = {
  home: { colour: "#D97757", icon: "home" },
  work: { colour: "#5B6B7F", icon: "briefcase" },
  favourite: { colour: "#D9982B", icon: "bookmark" },
  list: { colour: "#C2557A", icon: "list" },
};

export function placeLook(place: Pick<SavedPlace, "kind" | "icon" | "colour">): { colour: string; svg: string } {
  const own = SAVED_LOOK[place.kind];
  const fixed = place.kind === "home" || place.kind === "work";
  const icon = (!fixed && place.icon) || own.icon;
  return { colour: (!fixed && place.colour) || own.colour, svg: PLACE_ICON_SVG[icon] ?? PLACE_ICON_SVG[own.icon] };
}

function savedMarker(place: SavedPlace, onPick: () => void): HTMLButtonElement {
  const look = placeLook(place);
  const el = document.createElement("button");
  el.type = "button";
  el.className = "flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border-2 border-white shadow-md";
  el.style.backgroundColor = look.colour;
  el.title = place.name;
  el.setAttribute("aria-label", place.name);
  el.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${look.svg}</svg>`;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    onPick();
  });
  return el;
}

const sameSpot = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.abs(a.lat - b.lat) < 0.0001 && Math.abs(a.lon - b.lon) < 0.0001;

function dot(html: string, className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  el.innerHTML = html;
  return el;
}

export const MapView = forwardRef<MapViewHandle, Props>(function MapView(props, ref) {
  const { basemap, routes, selected, pin, stops, chargers, parked, you, saved, friends, marks, trail, fitTo, showTraffic, squares } = props;
  const theme = useThemeStore((s) => s.resolved());
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);
  const [ready, setReady] = useState(false);
  const calls = useRef(props);
  calls.current = props;
  const view = useRef<{ center: [number, number]; zoom: number }>({ center: [134, -27], zoom: 3.4 });

  useImperativeHandle(ref, () => ({
    flyTo(lat, lon, zoom) {
      mapRef.current?.easeTo({ center: [lon, lat], zoom: zoom ?? Math.max(mapRef.current.getZoom(), 14), duration: 600 });
    },
    fit(points, padding) {
      const map = mapRef.current;
      const lib = libRef.current;
      if (!map || !lib || !points.length) return;
      const b = new lib.LngLatBounds(points[0], points[0]);
      points.forEach((p) => b.extend(p));
      map.fitBounds(b as LngLatBoundsLike, { padding: padding ?? 60, maxZoom: 16, duration: 600 });
    },
    center() {
      const c = mapRef.current?.getCenter();
      return c ? { lat: c.lat, lon: c.lng } : null;
    },
    bounds() {
      const b = mapRef.current?.getBounds();
      return b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null;
    },
    visibleBounds(inset) {
      const map = mapRef.current;
      if (!map) return null;
      const { clientWidth: w, clientHeight: h } = map.getContainer();
      // Too little left uncovered (a small window): the whole map.
      const left = w - inset.left - inset.right < 120 ? 0 : inset.left;
      const right = w - inset.left - inset.right < 120 ? 0 : inset.right;
      const top = h - inset.top - inset.bottom < 120 ? 0 : inset.top;
      const bottom = h - inset.top - inset.bottom < 120 ? 0 : inset.bottom;
      const corners = [[left, top], [w - right, top], [left, h - bottom], [w - right, h - bottom]].map(([x, y]) => map.unproject([x, y]));
      const lons = corners.map((c) => c.lng);
      const lats = corners.map((c) => c.lat);
      const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
      return [clamp(Math.min(...lons), -180, 180), clamp(Math.min(...lats), -85, 85), clamp(Math.max(...lons), -180, 180), clamp(Math.max(...lats), -85, 85)];
    },
  }));

  // The map. A new theme means a new style, so the view is carried across.
  useEffect(() => {
    if (!box.current || !basemap) return;
    let map: MapLibreMap | null = null;
    let off = false;
    void (async () => {
      const maplibre = await loadMapLibre();
      const style = await serverMapStyle(maplibre, theme, basemap);
      if (off || !box.current) return;
      libRef.current = maplibre;
      map = new maplibre.Map({
        container: box.current,
        style,
        center: view.current.center,
        zoom: view.current.zoom,
        attributionControl: { compact: true },
        transformRequest: signTrafficRequest,
      });
      mapRef.current = map;
      map.on("load", () => {
        if (!map) return;
        map.addSource("alts", { type: "geojson", data: EMPTY as never });
        map.addSource("route", { type: "geojson", data: EMPTY as never });
        map.addSource("chargers", { type: "geojson", data: EMPTY as never });
        map.addSource("you", { type: "geojson", data: EMPTY as never });
        map.addSource("trail", { type: "geojson", data: EMPTY as never });
        map.addSource("squares", { type: "geojson", data: EMPTY as never });
        map.addLayer({ id: "squares", type: "fill", source: "squares", paint: { "fill-color": ROUTE, "fill-opacity": 0.12 } });
        map.addLayer({ id: "squares-edge", type: "line", source: "squares", paint: { "line-color": ROUTE, "line-width": 1.5, "line-opacity": 0.7 } });
        map.addLayer({ id: "trail", type: "line", source: "trail", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#4F7FE0", "line-width": 4, "line-opacity": 0.85 } });
        map.addLayer({ id: "alts", type: "line", source: "alts", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": theme === "dark" ? "#8a8580" : "#a8a29a", "line-width": 6, "line-opacity": 0.9 } });
        map.addLayer({ id: "route-edge", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#8f4630", "line-width": 9 } });
        map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ROUTE, "line-width": 6 } });
        map.addSource("jams", { type: "geojson", data: EMPTY as never });
        map.addLayer({
          id: "jams", type: "line", source: "jams", layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ["match", ["get", "kind"], "jam", "#C62828", "#EF9A1A"], "line-width": 6 },
        });
        map.addLayer({ id: "chargers", type: "circle", source: "chargers", paint: { "circle-color": "#2F9E6E", "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3, 12, 8], "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
        map.addLayer({ id: "you-range", type: "circle", source: "you", paint: { "circle-color": "#4F7FE0", "circle-opacity": 0.14, "circle-radius": 22 } });
        map.addLayer({ id: "you", type: "circle", source: "you", paint: { "circle-color": "#4F7FE0", "circle-radius": 7, "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
        setReady(true);
      });
      map.on("moveend", () => {
        if (!map) return;
        const c = map.getCenter();
        view.current = { center: [c.lng, c.lat], zoom: map.getZoom() };
        calls.current.onMoved();
      });
      map.on("contextmenu", (e) => calls.current.onHold(e.lngLat.lat, e.lngLat.lng));
      let timer: number | undefined;
      map.on("touchstart", (e) => {
        if (e.originalEvent.touches.length !== 1) return;
        const at = e.lngLat;
        timer = window.setTimeout(() => calls.current.onHold(at.lat, at.lng), 550);
      });
      const cancel = () => window.clearTimeout(timer);
      map.on("touchend", cancel);
      map.on("touchcancel", cancel);
      map.on("movestart", cancel);
      map.on("click", (e) => {
        if (!map) return;
        if (calls.current.onPickPoint) {
          calls.current.onPickPoint(e.lngLat.lat, e.lngLat.lng);
          return;
        }
        const alt = map.queryRenderedFeatures(e.point, { layers: ["alts"] })[0];
        if (alt) {
          calls.current.onPickRoute(Number(alt.properties.index));
          return;
        }
        const shown = map.getLayer("incidents") ? map.queryRenderedFeatures(e.point, { layers: ["incidents"] })[0] : undefined;
        if (shown) {
          const p = shown.properties as Record<string, unknown>;
          const label = String(p.description ?? p.description_0 ?? "Incident");
          calls.current.onPickIncident?.({ label, text: label, lat: e.lngLat.lat, lon: e.lngLat.lng, delay_seconds: Number(p.delay) || 0 });
          return;
        }
        const c = map.queryRenderedFeatures(e.point, { layers: ["chargers"] })[0];
        if (c) {
          calls.current.onPickCharger(JSON.parse(String(c.properties.json)) as Charger);
          return;
        }
        // A name on the map: a shop, a park, a suburb.
        const named = map.queryRenderedFeatures(e.point).find((f) => f.layer.type === "symbol" && f.properties?.name);
        if (named) {
          const geometry = named.geometry as { type: string; coordinates: [number, number] };
          const [lon, lat] = geometry.type === "Point" ? geometry.coordinates : [e.lngLat.lng, e.lngLat.lat];
          calls.current.onPick({ lat, lon, name: String(named.properties.name) });
        }
      });
      for (const layer of ["alts", "chargers"]) {
        map.on("mouseenter", layer, () => map && (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => map && (map.getCanvas().style.cursor = ""));
      }
    })();
    return () => {
      off = true;
      setReady(false);
      map?.remove();
      mapRef.current = null;
    };
  }, [basemap, theme]);

  const routeLines = useMemo(() => routes.map((r) => r.legs.flatMap((l) => decodeShape(l.shape))), [routes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const feature = (coordinates: [number, number][], index: number) => ({ type: "Feature", properties: { index }, geometry: { type: "LineString", coordinates } });
    (map.getSource("route") as GeoJSONSource).setData({ type: "FeatureCollection", features: routeLines[selected] ? [feature(routeLines[selected], selected)] : [] } as never);
    (map.getSource("alts") as GeoJSONSource).setData({ type: "FeatureCollection", features: routeLines.map((l, i) => feature(l, i)).filter((_, i) => i !== selected) } as never);
    // The busy stretches of the route you've picked.
    (map.getSource("jams") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: (routes[selected]?.traffic?.jams ?? []).map((j) => ({ type: "Feature", properties: { kind: j.kind }, geometry: { type: "LineString", coordinates: j.line } })),
    } as never);
  }, [ready, routeLines, routes, selected]);

  // The traffic layer: only asked for while it's on.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const on = !!map.getLayer("traffic");
    if (showTraffic && !on) {
      map.addSource("traffic", {
        type: "vector",
        tiles: [`${window.location.origin}/api/maps/traffic/tile/{z}/{x}/{y}.pbf`],
        // Not further out, and no more detail than this: each square is a request,
        // and looking around the map shouldn't use up the day's allowance.
        minzoom: 9,
        maxzoom: 11,
        attribution: "Traffic © TomTom",
      });
      map.addSource("incidents", {
        type: "vector",
        tiles: [`${window.location.origin}/api/maps/traffic/incidents/{z}/{x}/{y}.pbf`],
        // Further out, TomTom only sends groups with no detail.
        minzoom: 13,
        maxzoom: 13,
      });
      map.addLayer(
        {
          id: "traffic",
          type: "line",
          source: "traffic",
          "source-layer": "Traffic flow",
          // City roads sit around 0.7 from traffic lights alone: only colour what's really slow.
          filter: ["all", [">", ["get", "traffic_level"], 0], ["<", ["get", "traffic_level"], 0.6]],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["step", ["get", "traffic_level"], "#8E1B1B", 0.2, "#C62828", 0.35, "#EF8A1A"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.5, 14, 4],
          },
        },
        "alts",
      );
      // A spot with several things on it numbers its fields: _0 is the first.
      const category = ["coalesce", ["get", "icon_category"], ["get", "icon_category_0"]] as never;
      const single = ["!", ["has", "cluster_id"]] as never;
      map.addLayer({
        id: "incidents", type: "circle", source: "incidents", "source-layer": "Traffic incident POI", minzoom: 13, filter: single,
        paint: { "circle-color": ["match", category, [8, 1], "#C62828", "#EF8A1A"], "circle-radius": 10, "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
      });
      map.addLayer({
        id: "incident-marks", type: "symbol", source: "incidents", "source-layer": "Traffic incident POI", minzoom: 13, filter: single,
        layout: { "text-field": "!", "text-font": ["Noto Sans Medium"], "text-size": 14, "text-allow-overlap": true, "icon-allow-overlap": true },
        paint: { "text-color": "#fff" },
      });
    } else if (!showTraffic && on) {
      map.removeLayer("incident-marks");
      map.removeLayer("incidents");
      map.removeLayer("traffic");
      map.removeSource("incidents");
      map.removeSource("traffic");
    }
  }, [ready, showTraffic]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("chargers") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: chargers.map((c) => ({ type: "Feature", properties: { json: JSON.stringify(c) }, geometry: { type: "Point", coordinates: [c.lon, c.lat] } })),
    } as never);
  }, [ready, chargers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("you") as GeoJSONSource).setData(
      (you ? { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [you.lon, you.lat] } } : EMPTY) as never,
    );
  }, [ready, you]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("trail") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: (trail ?? []).map((coordinates) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } })),
    } as never);
  }, [ready, trail]);

  // An offline area's squares, lightly shaded.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const features = (squares ?? []).flatMap((cell) => {
      const [x, y] = cell.split("_").map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
      return [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]] } }];
    });
    (map.getSource("squares") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features } as never);
  }, [ready, squares]);

  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib || !fitTo?.length) return;
    const b = new lib.LngLatBounds(fitTo[0], fitTo[0]);
    fitTo.forEach((p) => b.extend(p));
    map.fitBounds(b as LngLatBoundsLike, { padding: 50, maxZoom: 15, duration: 0 });
  }, [ready, fitTo]);

  // Pins: the place you're looking at, the stops, the car.
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib) return;
    const markers: Marker[] = [];
    const add = (el: HTMLElement, lat: number, lon: number, anchor: "center" | "bottom" = "center") => {
      markers.push(new lib.Marker({ element: el, anchor }).setLngLat([lon, lat]).addTo(map));
    };
    // Under everything else; a route's stop letter takes the spot if it's there.
    for (const place of saved) {
      if (stops.some((s) => sameSpot(s, place))) continue;
      add(savedMarker(place, () => calls.current.onPickSaved(place)), place.lat, place.lon);
    }
    (routes[selected]?.incidents ?? []).forEach((incident) => {
      const el = dot("!", `flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border-2 border-white text-sm font-bold text-white shadow ${incident.closed || incident.category === 1 ? "bg-[#C62828]" : "bg-[#EF8A1A]"}`);
      el.title = incident.label;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        calls.current.onPickIncident?.(incident);
      });
      add(el, incident.lat, incident.lon);
    });
    (marks ?? []).forEach((m, i) => {
      const el = dot(String(i + 1), "flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-[#4F7FE0] text-xs font-semibold text-white shadow");
      el.title = m.name;
      add(el, m.lat, m.lon);
    });
    stops.forEach((s, i) => {
      add(dot(String.fromCharCode(65 + i), "flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-[#D97757] text-xs font-semibold text-white shadow"), s.lat, s.lon);
    });
    if (pin && !stops.some((s) => s.lat === pin.lat && s.lon === pin.lon) && !saved.some((p) => sameSpot(p, pin))) {
      add(
        dot(
          '<svg viewBox="0 0 24 32" width="30" height="40"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z" fill="#D97757" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="12" r="4.5" fill="#fff"/></svg>',
          "drop-shadow",
        ),
        pin.lat,
        pin.lon,
        "bottom",
      );
    }
    if (parked) {
      const el = dot("P", "flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border-2 border-white bg-[#4F7FE0] text-sm font-bold text-white shadow");
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        calls.current.onPickParked();
      });
      add(el, parked.lat, parked.lon);
    }
    for (const f of friends) {
      if (!f.live) continue;
      const el = dot("", "flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-[#7C5CCB] text-sm font-semibold text-white shadow");
      el.textContent = f.name.slice(0, 1).toUpperCase();
      el.title = f.name;
      add(el, f.live.lat, f.live.lon);
    }
    return () => markers.forEach((m) => m.remove());
  }, [ready, pin, stops, parked, saved, friends, marks, routes, selected]);

  return <div ref={box} role="region" aria-label="Map" className="h-full w-full" />;
});
