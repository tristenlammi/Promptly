import { apiClient } from "@/api/client";

/**
 * Places (``backend/app/places``): one list and map of where things are —
 * trip stops, photo places, event locations and contact addresses —
 * grouped by town. Places matched offline get ``lat``/``lon``; free text
 * that couldn't be matched is list-only (``lat: null``).
 */

export type PlaceSource = "trip" | "photos" | "event" | "contact";

export interface PlaceMention {
  source: Exclude<PlaceSource, "photos">;
  title: string;
  detail: string;
  url: string;
  when: string | null;
  /** The place as written ("12 High St, Leeds"). */
  place: string;
}

export interface Place {
  key: string;
  name: string;
  /** Region, country. */
  sub: string;
  lat: number | null;
  lon: number | null;
  place_id: number | null;
  country_code: string | null;
  counts: Record<PlaceSource, number>;
  total: number;
  photos: { count: number; url: string } | null;
  items: PlaceMention[];
  more: number;
}

export interface PlacesData {
  places: Place[];
  gazetteer: boolean;
  attribution: string | null;
  basemap: string | null;
}

export const placesApi = {
  get: () => apiClient.get<PlacesData>("/places").then((r) => r.data),
};
