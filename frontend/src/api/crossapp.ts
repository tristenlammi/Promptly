import { apiClient } from "@/api/client";
import type { Message } from "@/api/rooms";
import type { FileItem } from "@/api/files";

/*
 * Across apps (``/api/crossapp``): "Send to…" cards in Rooms, a trip's
 * photo album and Budget spending, and the grocery list → Tasks.
 */

export type ShareKind = "file" | "folder" | "photo" | "album" | "task" | "recipe" | "trip"
  // A note in Notes.
  | "note";

/** What's being shared: ``id`` is the thing; tasks, recipes and trips also
 *  name the app file they live in (``file_id``). */
export interface ShareTarget {
  kind: ShareKind;
  id: string;
  file_id?: string;
  /** Shown in the sheet's header ("Send “Tacos” to…"). */
  title: string;
}

/** Kinds whose own sharing can let a room in (Drive share / album members). */
export const GRANTABLE: ShareKind[] = ["file", "folder", "photo", "album"];

export interface ShareCard {
  kind: ShareKind;
  title: string;
  subtitle: string;
  thumb: string | null;
  href: string | null;
  emoji: string | null;
  image_url: string | null;
  file: FileItem | null;
}

export interface ShareCardResp {
  kind: ShareKind;
  label: string;
  /** null: you can't open it (or it's gone). */
  card: ShareCard | null;
  can_grant: boolean;
}

export interface GrantResult {
  granted: number;
  already: number;
  skipped: number;
}

export interface PhotoTile {
  id: string;
  thumb: string | null;
  thumbhash: string | null;
  kind: string;
  taken_local: string;
  width: number | null;
  height: number | null;
}

export interface TripAlbum {
  album: { id: string; title: string; count: number; href: string } | null;
  photos: PhotoTile[];
  can_make: boolean;
}

export interface TripSpending {
  has_budget: boolean;
  budget_file_id?: string;
  count: number;
  untagged: number;
  spent_minor: number;
  currency: string;
  converted: boolean;
  budget_cents?: number;
  budget_currency?: string;
  tagged_now?: number;
}

export interface BudgetTrip {
  ref: string;
  file_id: string;
  trip_id: string;
  title: string;
  emoji: string;
  start: string | null;
  end: string | null;
}

export interface ToTasksResult {
  list_id: string;
  added: number;
  updated: number;
  done: number;
  removed: number;
  open: number;
  tasks_file_id: string;
  href: string;
}

export const crossApi = {
  share: async (body: { room_id: string; kind: ShareKind; id: string; file_id?: string; note?: string; grant?: boolean }) => {
    const { data } = await apiClient.post<{ message: Message; granted: GrantResult | null }>("/crossapp/share", body);
    return data;
  },
  card: async (messageId: string) => {
    const { data } = await apiClient.get<ShareCardResp>(`/crossapp/share/card/${messageId}`);
    return data;
  },
  tripAlbum: async (fileId: string, tripId: string) => {
    const { data } = await apiClient.get<TripAlbum>(`/crossapp/trip/${fileId}/${encodeURIComponent(tripId)}/album`);
    return data;
  },
  makeTripAlbum: async (fileId: string, tripId: string) => {
    const { data } = await apiClient.post<TripAlbum>(`/crossapp/trip/${fileId}/${encodeURIComponent(tripId)}/album`);
    return data;
  },
  tripSpending: async (fileId: string, tripId: string) => {
    const { data } = await apiClient.get<TripSpending>(`/crossapp/trip/${fileId}/${encodeURIComponent(tripId)}/spending`);
    return data;
  },
  tagTripSpending: async (fileId: string, tripId: string) => {
    const { data } = await apiClient.post<TripSpending>(`/crossapp/trip/${fileId}/${encodeURIComponent(tripId)}/spending/tag`);
    return data;
  },
  budgetTrips: async () => {
    const { data } = await apiClient.get<BudgetTrip[]>("/crossapp/budget/trips");
    return data;
  },
  mealplanToTasks: async (fileId: string) => {
    const { data } = await apiClient.post<ToTasksResult>(`/crossapp/mealplan/${fileId}/to-tasks`);
    return data;
  },
};
