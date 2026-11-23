/**
 * Which country P Maps downloads: the one small seam between the setup
 * wizard's Maps step and the maps-regions API.
 *
 * The API is being built on another branch. Until the two meet, every call
 * here answers "not available" (null) on a 404 and the step hides itself.
 * To wire the real thing, change only this file: keep the three functions
 * and the two types, point them at the real endpoints (or swap the step's
 * picker for the shared region-picker component).
 *
 * What the step expects:
 *
 *   listRegions()  GET  /api/maps/regions
 *     -> { regions: MapRegion[] }            404 = maps regions aren't here
 *   regionState()  GET  /api/maps/regions/state
 *     -> MapRegionState                      404 = maps regions aren't here
 *   chooseRegion() POST /api/maps/regions/choose  { region_id }
 *     -> MapRegionState (the build then runs in the background)
 *
 * All three are admin-only.
 */
import axios from "axios";

import { apiClient } from "@/api/client";

export interface MapRegion {
  /** Stable id sent back to chooseRegion, e.g. "australia". */
  id: string;
  /** What the person reads, e.g. "Australia". */
  name: string;
  /** Optional heading to group a long list under, e.g. "Oceania". */
  group?: string | null;
  /** Disk needed while it builds, and what it settles to afterwards (GB). */
  build_gb: number;
  disk_gb: number;
  /** Roughly how long the first build takes on an ordinary machine. */
  build_minutes: number;
}

export interface MapRegionState {
  /** Region ids chosen so far; empty = no map chosen. */
  chosen: string[];
  /** none: nothing chosen. building / ready / failed: the map data. */
  state: "none" | "building" | "ready" | "failed";
  /** The build step in progress, in plain words, when building. */
  step?: string | null;
}

function gone(err: unknown): boolean {
  return axios.isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 405);
}

/** The countries on offer, or null when this server has no region choice. */
export async function listRegions(): Promise<MapRegion[] | null> {
  try {
    const { data } = await apiClient.get<{ regions: MapRegion[] }>("/maps/regions");
    return Array.isArray(data?.regions) ? data.regions : null;
  } catch (err) {
    if (gone(err)) return null;
    throw err;
  }
}

/** What's chosen and how the build is doing, or null when not available. */
export async function regionState(): Promise<MapRegionState | null> {
  try {
    const { data } = await apiClient.get<MapRegionState>("/maps/regions/state");
    return data && Array.isArray(data.chosen) ? data : null;
  } catch (err) {
    if (gone(err)) return null;
    throw err;
  }
}

/** Start downloading a country's map. */
export async function chooseRegion(regionId: string): Promise<MapRegionState> {
  const { data } = await apiClient.post<MapRegionState>("/maps/regions/choose", { region_id: regionId });
  return data;
}

/** "about 1 hour", "about 20 minutes". */
export function buildTimeWords(minutes: number): string {
  if (minutes >= 90) return `about ${Math.round(minutes / 60)} hours`;
  if (minutes >= 50) return "about an hour";
  return `about ${Math.max(5, Math.round(minutes / 5) * 5)} minutes`;
}
