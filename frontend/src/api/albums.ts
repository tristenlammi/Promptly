import { apiClient } from "./client";
import type { PhotoItem } from "./photos";

/** Albums (WP-9.4): references to photos, with viewers and contributors. */

export type AlbumRole = "owner" | "contributor" | "viewer";

/** A smart album's question (PH-5): the photos search's fields; people
 *  and pets as ``id:<uuid>`` (or "me"). */
export interface SmartRules {
  people?: string[];
  pets?: string[];
  species?: string[];
  place?: string | null;
  near?: boolean;
  date_from?: string | null;
  date_to?: string | null;
  media?: "photo" | "video" | null;
  text?: string | null;
  looks_like?: string | null;
  favorites?: boolean;
}

export interface Album {
  /** A smart album: its question and the question in words. */
  smart?: { rules: SmartRules; summary: string } | null;
  id: string;
  title: string;
  description: string | null;
  sort: "newest" | "oldest";
  role: AlbumRole;
  owner: { id: string; username: string | null };
  count: number;
  cover: PhotoItem | null;
  created_at: string;
  updated_at: string;
  /** Has members besides the owner (list view). */
  shared?: boolean;
  members?: { user_id: string; username: string; role: "viewer" | "contributor" }[];
}

export interface AlbumPhoto extends PhotoItem {
  added_by: string | null;
  /** The viewer's own photo (they can take it out, as a contributor). */
  mine: boolean;
}

export const albumsApi = {
  async list(): Promise<Album[]> {
    const { data } = await apiClient.get<{ albums: Album[] }>("/photos/albums");
    return data.albums;
  },
  async create(title: string, fileIds: string[] = [], smart?: { rules?: SmartRules; q?: string }): Promise<Album> {
    const { data } = await apiClient.post<Album>("/photos/albums", { title, file_ids: fileIds, ...(smart ?? {}) });
    return data;
  },
  /** What a smart album with this question would hold now. */
  async preview(rules: SmartRules): Promise<{ count: number; summary: string; rules: SmartRules; sample: PhotoItem[] }> {
    const { data } = await apiClient.post("/photos/albums/preview", { rules });
    return data;
  },
  async setRules(id: string, rules: SmartRules | null): Promise<Album> {
    const { data } = await apiClient.patch<Album>(`/photos/albums/${id}`, { rules });
    return data;
  },
  async get(id: string): Promise<Album> {
    const { data } = await apiClient.get<Album>(`/photos/albums/${id}`);
    return data;
  },
  async update(id: string, patch: Partial<{ title: string; description: string; cover_file_id: string; sort: "newest" | "oldest" }>): Promise<Album> {
    const { data } = await apiClient.patch<Album>(`/photos/albums/${id}`, patch);
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/photos/albums/${id}`);
  },
  async items(id: string, before?: string | null): Promise<{ items: AlbumPhoto[]; next_cursor: string | null }> {
    const { data } = await apiClient.get(`/photos/albums/${id}/items`, { params: { before: before || undefined, limit: 300 } });
    return data;
  },
  async addItems(id: string, fileIds: string[]): Promise<number> {
    const { data } = await apiClient.post<{ added: number }>(`/photos/albums/${id}/items`, { file_ids: fileIds });
    return data.added;
  },
  async removeItems(id: string, fileIds: string[]): Promise<number> {
    const { data } = await apiClient.delete<{ removed: number }>(`/photos/albums/${id}/items`, { data: { file_ids: fileIds } });
    return data.removed;
  },
  async addMember(id: string, userId: string, role: "viewer" | "contributor") {
    const { data } = await apiClient.post(`/photos/albums/${id}/members`, { user_id: userId, role });
    return data;
  },
  async setRole(id: string, userId: string, role: "viewer" | "contributor") {
    await apiClient.patch(`/photos/albums/${id}/members/${userId}`, { role });
  },
  async removeMember(id: string, userId: string): Promise<void> {
    await apiClient.delete(`/photos/albums/${id}/members/${userId}`);
  },
  async links(id: string): Promise<AlbumLink[]> {
    const { data } = await apiClient.get<{ links: AlbumLink[] }>(`/photos/albums/${id}/links`);
    return data.links;
  },
  async createLink(id: string, keepLocation: boolean): Promise<AlbumLink> {
    const { data } = await apiClient.post<AlbumLink>(`/photos/albums/${id}/links`, { keep_location: keepLocation });
    return data;
  },
  async revokeLink(id: string, linkId: string): Promise<void> {
    await apiClient.delete(`/photos/albums/${id}/links/${linkId}`);
  },
};

/** A public link to an album (WP-9.5): anyone with it can look, no account. */
export interface AlbumLink {
  id: string;
  /** "/s/<token>" — the address on this server. */
  path: string;
  keep_location: boolean;
  expires_at: string | null;
  created_at: string;
  access_count: number;
  /** The link as a QR code (a PNG data URL). */
  qr: string;
}
