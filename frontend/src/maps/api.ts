import { apiClient } from "@/api/client";

/** P Maps (``backend/app/maps``). Searches and routes go only to this server. */

export interface MapsConfig {
  basemap: string | null;
  ready: boolean;
  building: boolean;
  step: string | null;
  failed: boolean;
  built_at: string | null;
  osm_data: string | null;
  attribution: string;
  traffic?: boolean;
}

export interface Spot {
  lat: number;
  lon: number;
  name: string;
  address?: string | null;
}

export interface SearchResult extends Spot {
  kind: "home" | "work" | "favourite" | "list" | "contact" | "recent" | "place" | "address" | "pin";
  id?: string;
  category?: string | null;
  /** From you, for what's around you. */
  distance_m?: number;
  /** How long stopping here adds, for what's on the way. */
  adds_seconds?: number;
  along_m?: number;
}

/** What "nearby" can look for. */
export const NEARBY = [
  { id: "fuel", label: "Fuel" },
  { id: "food", label: "Food" },
  { id: "coffee", label: "Coffee" },
  { id: "groceries", label: "Groceries" },
  { id: "chemist", label: "Chemist" },
  { id: "toilets", label: "Toilets" },
  { id: "parking", label: "Parking" },
  { id: "atm", label: "ATM" },
  { id: "hotel", label: "Places to stay" },
] as const;

export interface SavedPlace extends Spot {
  id: string;
  kind: "home" | "work" | "favourite" | "list";
  list_name: string | null;
  note: string | null;
  icon: string | null;
  colour: string | null;
}

export interface Parked {
  lat: number;
  lon: number;
  note: string | null;
  at: string;
  source: "manual" | "auto";
}

export interface MyPlaces {
  places: SavedPlace[];
  recents: Spot[];
  parked: Parked | null;
}

export type Mode = "drive" | "walk" | "cycle";

export interface RouteStep {
  text: string;
  km: number;
  seconds: number;
  type: number;
  street: string | null;
  at: number;
}

export interface RouteLeg {
  shape: string;
  km: number;
  seconds: number;
  steps: RouteStep[];
}

export interface ThroughPoint {
  lat: number;
  lon: number;
  heading?: number;
}

export interface PreferredRoute {
  id: string;
  name: string;
  mode: Mode;
  from_name: string;
  to_name: string;
  from: Spot;
  to: Spot;
  tolerance_minutes: number;
}

export interface RouteTraffic {
  seconds: number;
  free_seconds: number;
  adds_seconds: number;
  covered: number;
  closures: number;
  jams: { kind: "slow" | "jam"; line: [number, number][] }[];
}

export interface RouteIncident {
  id: string;
  category: number;
  label: string;
  text: string;
  from: string | null;
  to: string | null;
  delay_seconds: number;
  ends: string | null;
  closed: boolean;
  lat: number;
  lon: number;
  along_km: number;
}

export interface PlaceMore {
  found: boolean;
  name?: string | null;
  phone?: string | null;
  url?: string | null;
  categories?: string[];
  hours?: { date: string; opens: string; closes: string }[];
}

export interface Route {
  /** Crashes, closures and hazards on this route, in the order you'd reach them. */
  incidents?: RouteIncident[];
  /** The closed roads this route goes around. */
  avoids?: string[];
  km: number;
  seconds: number;
  traffic?: RouteTraffic;
  /** This is the way you prefer between these two places. */
  preferred?: { id: string; name: string; tolerance_minutes: number };
  /** How much longer than the quickest on offer. */
  slower_seconds?: number;
  /** The road most of it is on. */
  via_name?: string | null;
  /** Points that bring a new request back onto this route. */
  through?: ThroughPoint[];
  toll: boolean;
  highway: boolean;
  ferry: boolean;
  legs: RouteLeg[];
}

export interface RouteOptions {
  mode: Mode;
  avoid_tolls: boolean;
  avoid_highways: boolean;
  avoid_ferries: boolean;
  best_order?: boolean;
  via?: { lat: number; lon: number }[];
}

export interface Socket {
  type: string;
  count: number | null;
  kw: number | null;
}

export interface Charger {
  lat: number;
  lon: number;
  name: string;
  operator: string | null;
  sockets: Socket[];
  max_kw: number | null;
  access: string | null;
  fee: string | null;
  hours: string | null;
  along_m?: number;
}

export const mapsApi = {
  async config() {
    return (await apiClient.get<MapsConfig>("/maps/config")).data;
  },
  async search(q: string, near?: { lat: number; lon: number } | null) {
    const params = near ? { q, lat: near.lat, lon: near.lon } : { q };
    return (await apiClient.get<{ results: SearchResult[] }>("/maps/search", { params })).data.results;
  },
  async reverse(lat: number, lon: number) {
    return (await apiClient.get<SearchResult>("/maps/reverse", { params: { lat, lon } })).data;
  },
  async route(stops: Spot[], options: RouteOptions) {
    const body = { stops: stops.map((s) => ({ lat: s.lat, lon: s.lon, name: s.name })), ...options };
    return (await apiClient.post<{ routes: Route[]; order: number[]; traffic?: boolean }>("/maps/route", body)).data;
  },
  async nearby(category: string, lat: number, lon: number) {
    return (await apiClient.get<{ results: SearchResult[] }>("/maps/nearby", { params: { category, lat, lon } })).data.results;
  },
  async nearbyAlong(category: string, shapes: string[], here: Spot, to: Spot, mode: Mode) {
    const spot = (s: Spot) => ({ lat: s.lat, lon: s.lon, name: s.name });
    const body = { category, shapes, here: spot(here), to: spot(to), mode };
    return (await apiClient.post<{ results: SearchResult[] }>("/maps/nearby/along", body)).data.results;
  },
  async preferred() {
    return (await apiClient.get<{ routes: PreferredRoute[] }>("/maps/preferred")).data.routes;
  },
  async prefer(start: Spot, end: Spot, through: ThroughPoint[], mode: Mode) {
    const spot = (s: Spot) => ({ lat: s.lat, lon: s.lon, name: s.name });
    return (await apiClient.post<PreferredRoute>("/maps/preferred", { start: spot(start), end: spot(end), through, mode })).data;
  },
  async editPreferred(id: string, patch: { name?: string; tolerance_minutes?: number }) {
    return (await apiClient.patch<PreferredRoute>(`/maps/preferred/${id}`, patch)).data;
  },
  async unprefer(id: string) {
    await apiClient.delete(`/maps/preferred/${id}`);
  },
  /** Tells TomTom which place, so only when you press the button. */
  async placeMore(name: string, lat: number, lon: number) {
    return (await apiClient.post<PlaceMore>("/maps/place/details", { name, lat, lon })).data;
  },
  async mine() {
    return (await apiClient.get<MyPlaces>("/maps/places")).data;
  },
  async save(place: Spot & { kind: SavedPlace["kind"]; list_name?: string | null; icon?: string | null; colour?: string | null }) {
    return (await apiClient.post<SavedPlace>("/maps/places", place)).data;
  },
  async editPlace(id: string, patch: { name?: string; list_name?: string | null; icon?: string | null; colour?: string | null }) {
    return (await apiClient.patch<SavedPlace>(`/maps/places/${id}`, patch)).data;
  },
  async remove(id: string) {
    await apiClient.delete(`/maps/places/${id}`);
  },
  async recent(spot: Spot) {
    await apiClient.post("/maps/recents", { name: spot.name, address: spot.address ?? null, lat: spot.lat, lon: spot.lon });
  },
  async clearRecents() {
    await apiClient.delete("/maps/recents");
  },
  async park(lat: number, lon: number, note?: string | null) {
    await apiClient.put("/maps/parked", { lat, lon, note: note ?? null, source: "manual" });
  },
  async unpark() {
    await apiClient.delete("/maps/parked");
  },
  async chargers(bbox: [number, number, number, number], plug?: string | null, minKw?: number | null) {
    const params = { bbox: bbox.join(","), ...(plug ? { plug } : {}), ...(minKw ? { min_kw: minKw } : {}) };
    return (await apiClient.get<{ chargers: Charger[] }>("/maps/chargers", { params })).data.chargers;
  },
  async chargersAlong(shapes: string[], plug?: string | null, minKw?: number | null) {
    return (await apiClient.post<{ chargers: Charger[] }>("/maps/chargers/along", { shapes, plug: plug || null, min_kw: minKw || null })).data.chargers;
  },
  /** A one-time code the phone's native driving screen signs in with. */
  async pairCode() {
    return (await apiClient.post<{ code: string }>("/devices/pair", { origin: window.location.origin })).data.code;
  },
};

/** (lon, lat) pairs from a route's encoded shape. */
export function decodeShape(encoded: string): [number, number][] {
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let shift = 0;
    let result = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lon += next();
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}

/** The best time we have for a route: with traffic, if there is any. */
export function routeSeconds(route: Route): number {
  return route.traffic?.seconds ?? route.seconds;
}

/** "Traffic adds 6 min", or nothing when there's no traffic data. */
export function trafficLine(route: Route): string | null {
  if (!route.traffic) return null;
  const minutes = Math.round(route.traffic.adds_seconds / 60);
  const closed = route.traffic.closures > 0 ? " · Road closure on route" : "";
  return (minutes >= 1 ? `Traffic adds ${formatDuration(route.traffic.adds_seconds)}` : "No traffic delays") + closed;
}

export function formatDuration(seconds: number): string {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000 / 10) * 10} m`;
  return km < 100 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}
