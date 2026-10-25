import { apiClient } from "./client";

/** The photo library (Part E PH-1, WP-9.1): every photo and video you own,
 *  by when it was taken. */

export type PhotoView = "all" | "favorites" | "archive" | "family";

export interface PhotoBucket {
  /** "YYYY-MM", in the time zone each photo was taken in. */
  month: string;
  count: number;
}

export interface PhotoItem {
  id: string;
  filename: string;
  mime: string;
  kind: "image" | "video";
  taken_at: string;
  /** Wall-clock time where it was taken, ISO without a zone. */
  taken_local: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  thumbhash: string | null;
  /** A Live Photo (its video plays behind the still). */
  live: boolean;
  favorite: boolean;
  archived: boolean;
  /** Signed tile URL once the media worker has made it. */
  thumb: string | null;
  state: string | null;
  /** Shown edited (PH-7) — the original is untouched. */
  edited?: boolean;
  /** Yours (false: someone's in your family library or a shared album). */
  mine?: boolean;
}

/** A photo's edit (PH-7), applied in this order; crop is 0–1 of the
 *  rotated, flipped picture. */
export interface EditOps {
  rotate: 0 | 90 | 180 | 270;
  flip: boolean;
  crop: { x: number; y: number; w: number; h: number } | null;
  brightness: number;
  contrast: number;
  saturation: number;
}

export type CleanupReason = "duplicate" | "blurry" | "screenshot" | "large_video";
export type SizedPhoto = PhotoItem & { size: number };
export interface CleanupFound {
  duplicate: { count: number; bytes: number; groups: { keep: SizedPhoto; others: SizedPhoto[] }[] };
  blurry: { count: number; bytes: number; items: SizedPhoto[] };
  screenshot: { count: number; bytes: number; items: SizedPhoto[] };
  large_video: { count: number; bytes: number; items: SizedPhoto[] };
}

export interface TimelinePage {
  items: PhotoItem[];
  next_cursor: string | null;
}

export interface PhotoChip {
  kind: "person" | "pet" | "who" | "place" | "when" | "words" | "looks" | "album";
  label: string;
}

export interface PhotoSearchResult {
  items: (PhotoItem & { score: number; matched: "text" | "description" | "looks" | "filters"; chips: PhotoChip[]; similar: number })[];
  query: string;
  /** How the question was read: people, pets, place, dates, kind… */
  understood: Record<string, unknown> & { people?: string[]; pets?: string[]; place?: string | null };
  /** What was let go because nothing matched exactly. */
  relaxed: string[];
  /** Names or places it couldn't find, with what to do. */
  unresolved: string[];
}

/** Your Photos settings (PH-2). */
export interface PhotoSettings {
  faces: boolean;
  face_count: number;
  captions: boolean;
  /** The model that would describe them — null until an admin chooses one. */
  captions_model: { label: string; local: boolean } | null;
  /** "Set up Photos" finished or put away (PH-7). */
  setup_done?: boolean;
  /** The Photos folder — the library: only what's in it is in Photos. */
  folder: { id: string; name: string };
}

/** One stage of understanding the library (PH-2). */
export interface UnderstandingStage {
  stage: string;
  label: string;
  done: number;
  total: number;
  failed: number;
  waiting?: string;
}

export const photosApi = {
  async settings(): Promise<PhotoSettings> {
    const { data } = await apiClient.get("/photos/settings");
    return data;
  },
  /** File a picture or video from elsewhere in My files into Photos. */
  async moveToPhotos(fileId: string): Promise<{ id: string; folder_id: string; moved: boolean }> {
    const { data } = await apiClient.post(`/photos/files/${fileId}/move-to-photos`);
    return data;
  },
  async saveSettings(body: {
    faces?: boolean;
    captions?: boolean;
    setup_done?: boolean;
  }): Promise<PhotoSettings> {
    const { data } = await apiClient.put("/photos/settings", body);
    return data;
  },
  /** Photos by what's in them (PH-2), best first. */
  /** Ask your photos (PH-4). */
  async search(q: string): Promise<PhotoSearchResult> {
    const { data } = await apiClient.get("/photos/search", { params: { q } });
    return data;
  },
  /** These photos (in this order) with fresh links — a chat's photo card. */
  async items(ids: string[]): Promise<PhotoItem[]> {
    const { data } = await apiClient.post<{ items: PhotoItem[] }>("/photos/items", { ids });
    return data.items;
  },
  async understanding(): Promise<{ stages: UnderstandingStage[]; complete: boolean }> {
    const { data } = await apiClient.get("/photos/understanding");
    return data;
  },
  async buckets(view: PhotoView): Promise<{ buckets: PhotoBucket[]; total: number }> {
    const { data } = await apiClient.get("/photos/buckets", { params: { view } });
    return data;
  },
  async timeline(args: { view: PhotoView; before?: string | null; month?: string; limit?: number; place?: number; country?: string }): Promise<TimelinePage> {
    const { data } = await apiClient.get<TimelinePage>("/photos/timeline", {
      params: { view: args.view, before: args.before || undefined, month: args.month, limit: args.limit, place: args.place, country: args.country },
    });
    return data;
  },
  async getEdit(fileId: string): Promise<{ ops: EditOps | null; item: PhotoItem | null }> {
    const { data } = await apiClient.get(`/photos/files/${fileId}/edit`);
    return data;
  },
  async saveEdit(fileId: string, ops: EditOps): Promise<{ ops: EditOps | null; item: PhotoItem | null }> {
    const { data } = await apiClient.put(`/photos/files/${fileId}/edit`, ops);
    return data;
  },
  async revertEdit(fileId: string): Promise<{ ops: null; item: PhotoItem | null }> {
    const { data } = await apiClient.delete(`/photos/files/${fileId}/edit`);
    return data;
  },
  /** The edited photo, full size, as a JPEG download. */
  async downloadEdited(fileId: string, filename: string): Promise<void> {
    const { data } = await apiClient.get(`/photos/files/${fileId}/edited`, { responseType: "blob" });
    const url = URL.createObjectURL(data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename.replace(/\.[^.]+$/, "")} (edited).jpg`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },
  /** What you might not want (PH-7): duplicates, blurry, screenshots, large videos. */
  /** Photos hidden as copies of ones you already have (a phone synced
   *  after a Takeout), each with its original. */
  async copies(): Promise<{ count: number; items: { copy: PhotoItem; original: PhotoItem }[] }> {
    const { data } = await apiClient.get("/photos/copies");
    return data;
  },
  /** "These aren't copies": back in Photos for good. */
  async notCopies(fileIds: string[]): Promise<number> {
    const { data } = await apiClient.post<{ restored: number }>("/photos/copies/not", { file_ids: fileIds });
    return data.restored;
  },
  async cleanup(): Promise<CleanupFound> {
    const { data } = await apiClient.get<CleanupFound>("/photos/cleanup");
    return data;
  },
  /** These are wanted: not suggested again for this reason. */
  async keep(fileIds: string[], reason: CleanupReason): Promise<number> {
    const { data } = await apiClient.post<{ kept: number }>("/photos/cleanup/keep", { file_ids: fileIds, reason });
    return data.kept;
  },
  /** Every located photo of yours, for the map (PH-5) — parallel arrays. */
  async map(): Promise<{ ids: string[]; lat: number[]; lon: number[]; basemap: string | null; online?: boolean }> {
    const { data } = await apiClient.get("/photos/map", { timeout: 60_000 });
    return data;
  },
  /** Where your photos were taken (PH-5): countries, or one country's towns. */
  async places(country?: string): Promise<{
    countries?: { code: string; name: string; count: number; cover: PhotoItem | null }[];
    country?: { code: string; name: string };
    places?: { id: number; name: string; admin1: string | null; count: number; cover: PhotoItem | null }[];
  }> {
    const { data } = await apiClient.get("/photos/places", { params: { country } });
    return data;
  },
  /** Every photo of one month (pages through it; stops at the month's edge). */
  async month(view: PhotoView, month: string, count: number): Promise<PhotoItem[]> {
    const out: PhotoItem[] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 200; guard++) {
      const page: TimelinePage = await photosApi.timeline({
        view,
        month: before ? undefined : month,
        before,
        limit: Math.min(500, Math.max(count - out.length, 1) + 1),
      });
      for (const item of page.items) {
        if (item.taken_local.slice(0, 7) !== month) return out;
        out.push(item);
      }
      if (!page.next_cursor || out.length >= count) return out;
      before = page.next_cursor;
    }
    return out;
  },
  async archive(fileIds: string[], archived: boolean): Promise<number> {
    const { data } = await apiClient.post<{ updated: number }>("/photos/archive", { file_ids: fileIds, archived });
    return data.updated;
  },
};
