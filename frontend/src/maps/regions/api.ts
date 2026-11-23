// Choosing this server's maps (admins only): the admin panel's P Maps card
// and the first-time setup wizard both use this. See
// backend/app/maps/regions_router.py.
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/api/client";

/** One map you can choose. Sizes are rough, in MB; null when not known. */
export interface MapRegion {
  id: string;
  name: string;
  /** For part of a country ("California"): the country's id and name. */
  parent: string | null;
  parent_name: string | null;
  continent: string;
  kind: "country" | "part";
  /** Two-letter codes of the countries it covers. */
  codes?: string[];
  download_mb: number | null;
  disk_mb: number | null;
  minutes: number | null;
}

export interface MapRegionCatalog {
  /** "builtin" is the short list used when the download site can't be reached. */
  source: "geofabrik" | "builtin";
  fetched_at: number | null;
  regions: MapRegion[];
}

export interface MapRegionRow {
  id: string;
  name: string;
  /** installed: in the live map. building / waiting: chosen, not live yet.
   *  removing: still live until the build without it finishes. */
  state: "installed" | "building" | "waiting" | "removing";
}

export interface MapRegionsState {
  /** False when the maps service isn't running (P Maps is off on this server). */
  available: boolean;
  /** "env": the map is set in the server's .env file, so it can't be changed here. */
  managed: "ui" | "env";
  /** False until an admin has chosen a map (nothing is downloaded before that). */
  chosen: boolean;
  regions: MapRegionRow[];
  ready: boolean;
  building: boolean;
  failed: boolean;
  step: string | null;
  step_number: number | null;
  steps_total: number | null;
  /** While downloading: the map being fetched. */
  detail: string | null;
  /** 0 to 1, by step. Null when nothing is building. */
  progress: number | null;
  built_at: string | null;
  disk: { free_bytes: number | null; total_bytes: number | null; maps_bytes: number } | null;
  offline: boolean;
}

/** What keeping a whole set of maps costs (they're built together). */
export interface MapRegionEstimate {
  /** False when a size wasn't known for every map: the numbers are low. */
  complete: boolean;
  download_bytes: number;
  /** The part of the download that is read as it arrives and never stored
   *  (search files, which a small country can share with a big neighbour). */
  streamed_bytes?: number;
  disk_after_bytes: number;
  /** Free space needed while it builds, next to the maps already there. */
  disk_needed_bytes: number;
  disk_live_bytes: number;
  free_bytes: number | null;
  /** Null when the server's free space isn't known. */
  fits: boolean | null;
  minutes: number;
}

export const mapRegionsApi = {
  async state() {
    return (await apiClient.get<MapRegionsState>("/maps/regions")).data;
  },
  async catalog(refresh = false) {
    return (await apiClient.get<MapRegionCatalog>("/maps/regions/catalog", { params: refresh ? { refresh: true } : undefined })).data;
  },
  /** The cost of keeping exactly these maps. */
  async estimate(ids: string[], signal?: AbortSignal) {
    return (await apiClient.post<MapRegionEstimate>("/maps/regions/estimate", { ids }, { signal })).data;
  },
  /** Keep exactly these maps (what the setup wizard calls). */
  async choose(ids: string[], force = false) {
    return (await apiClient.put<MapRegionsState>("/maps/regions", { ids, force })).data;
  },
  async add(ids: string[], force = false) {
    return (await apiClient.post<MapRegionsState>("/maps/regions/add", { ids, force })).data;
  },
  async remove(ids: string[]) {
    return (await apiClient.post<MapRegionsState>("/maps/regions/remove", { ids })).data;
  },
  async retry() {
    await apiClient.post("/maps/regions/retry");
  },
};

export const MAP_REGIONS_STATE_KEY = ["maps-regions-state"] as const;

/** The server's maps, refreshed every few seconds while one is building. */
export function useMapRegionsState(enabled = true) {
  return useQuery({
    queryKey: MAP_REGIONS_STATE_KEY,
    queryFn: mapRegionsApi.state,
    enabled,
    retry: false,
    refetchInterval: (q) => {
      const s = q.state.data;
      if (!s?.available) return false;
      return s.building || s.regions.some((r) => r.state !== "installed") ? 5_000 : 60_000;
    },
  });
}

export function useMapRegionCatalog(enabled = true) {
  return useQuery({
    queryKey: ["maps-regions-catalog"],
    queryFn: () => mapRegionsApi.catalog(),
    enabled,
    staleTime: 3_600_000,
    retry: false,
  });
}

/** "850 MB", "1.2 GB", "14 GB". */
export function sizeText(bytes: number): string {
  if (bytes >= 10_000_000_000) return `${Math.round(bytes / 1_000_000_000)} GB`;
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/** "a few minutes", "about 40 minutes", "about 2 hours". */
export function timeText(minutes: number): string {
  if (minutes < 8) return "a few minutes";
  if (minutes < 50) return `about ${Math.round(minutes / 5) * 5} minutes`;
  if (minutes < 90) return "about an hour";
  const hours = Math.round(minutes / 30) / 2;
  return `about ${hours} hours`;
}

const STEP_NAMES: Record<string, string> = {
  osm: "Downloading the map",
  basemap: "Downloading the map's picture",
  routing: "Working out the roads for directions",
  addresses: "Downloading street addresses",
  search: "Building search",
  places: "Finding chargers and cameras",
  areas: "Making offline maps for phones",
  finish: "Finishing",
};

export function stepText(step: string | null): string {
  return (step && STEP_NAMES[step]) || "Getting ready";
}
