import { apiClient } from "./client";
import type { PhotoItem } from "./photos";

/** Memories (PH-5): "On this day", trips, "Max's first year", "You &
 *  Sarah" — made from your own library, for you only. */

export type MemoryKind = "on_this_day" | "trip" | "first_year" | "together";

export interface Memory {
  id: string;
  kind: MemoryKind;
  title: string;
  subtitle: string;
  period_start: string;
  period_end: string;
  count: number;
  /** Who it's about (first year, together). */
  person_id: string | null;
  cover: PhotoItem | null;
}

export const memoriesApi = {
  async list(): Promise<Memory[]> {
    const { data } = await apiClient.get<{ memories: Memory[] }>("/photos/memories");
    return data.memories;
  },
  async get(id: string): Promise<Memory & { items: PhotoItem[] }> {
    const { data } = await apiClient.get(`/photos/memories/${id}`);
    return data;
  },
  async dismiss(id: string): Promise<void> {
    await apiClient.post(`/photos/memories/${id}/dismiss`);
  },
  async hidePerson(id: string): Promise<void> {
    await apiClient.post(`/photos/memories/${id}/hide-person`);
  },
  async saveAsAlbum(id: string): Promise<{ id: string; added: number }> {
    const { data } = await apiClient.post(`/photos/memories/${id}/album`);
    return data;
  },
};
