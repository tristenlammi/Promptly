import { apiClient } from "@/api/client";

/**
 * Shared tags (``backend/app/tags``) — one set per person, used by every
 * app. Things inside an app file (tasks, contacts, journal entries,
 * recipes, transactions) keep their tags in the file as plain strings; the
 * shared set mirrors them, so those editors just pick names here. Files,
 * calendar events and albums are tagged through ``/tags/entity``.
 */

export interface Tag {
  id: string;
  name: string;
  /** ``#rrggbb``, or null for the colour picked from the name. */
  color: string | null;
  count?: number;
}

export type TaggableKind = "file" | "event" | "album" | "task" | "contact" | "journal_entry" | "recipe" | "transaction";

export interface TaggedThing {
  kind: TaggableKind;
  /** The thing's id (``<file_id>:<id>`` for things inside an app file). */
  id: string;
  app: string;
  title: string;
  detail: string;
  url: string;
  file_id?: string;
}

export const tagsApi = {
  async list(q?: string): Promise<Tag[]> {
    const { data } = await apiClient.get<{ tags: Tag[] }>("/tags", { params: q ? { q } : undefined });
    return data.tags;
  },
  async get(id: string): Promise<Tag> {
    const { data } = await apiClient.get<Tag>(`/tags/${id}`);
    return data;
  },
  async create(name: string, color?: string | null): Promise<Tag> {
    const { data } = await apiClient.post<Tag>("/tags", { name, color: color ?? null });
    return data;
  },
  async update(id: string, patch: { name?: string; color?: string | null }): Promise<Tag> {
    const { data } = await apiClient.patch<Tag>(`/tags/${id}`, patch);
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/tags/${id}`);
  },
  async merge(id: string, into: string): Promise<Tag> {
    const { data } = await apiClient.post<Tag>(`/tags/${id}/merge`, { into });
    return data;
  },
  /** Everything with the tag, across apps — only what you can open. */
  async items(id: string): Promise<{ tag: Tag; items: TaggedThing[] }> {
    const { data } = await apiClient.get<{ tag: Tag; items: TaggedThing[] }>(`/tags/${id}/items`);
    return data;
  },
  async forEntity(kind: TaggableKind, id: string): Promise<Tag[]> {
    const { data } = await apiClient.get<{ tags: Tag[] }>("/tags/entity", { params: { kind, id } });
    return data.tags;
  },
  async setForEntity(kind: TaggableKind, id: string, names: string[]): Promise<Tag[]> {
    const { data } = await apiClient.put<{ tags: Tag[] }>("/tags/entity", { kind, id, names });
    return data.tags;
  },
};

const PALETTE = ["#c2410c", "#b45309", "#4d7c0f", "#047857", "#0e7490", "#1d4ed8", "#6d28d9", "#a21caf", "#be123c", "#57534e"];

/** A tag's colour: its own, else one picked steadily from its name. */
export function tagColor(t: { name: string; color?: string | null }): string {
  if (t.color) return t.color;
  let h = 0;
  for (const ch of t.name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export const TAG_COLORS = PALETTE;
