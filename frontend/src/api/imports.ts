import { apiClient } from "./client";

/** Moving in (WP-10.1, 10.3): a Google Takeout, a folder of photos or an
 *  Apple export, uploaded in parts, read, then imported. Google Keep
 *  (Notes N1.6) is a Takeout that brings its notes only. */

export type ImportSource = "takeout" | "folder" | "apple" | "keep";

/** What the check found of notes (Google Keep, or a Promptly export's). */
export interface NotesReport {
  notes: number;
  lists: number;
  pinned: number;
  archived: number;
  /** In Keep's trash: left out. */
  trashed: number;
  with_pictures: number;
  with_recordings: number;
  labels: string[];
  /** Pictures or recordings a note names that aren't in the archives. */
  missing_attachments: number;
  /** Notes shared in Keep (the people aren't added here). */
  shared: number;
  /** Notes too long for a note, shortened. */
  cut: number;
  unreadable: number;
}
export type ImportState = "collecting" | "indexing" | "ready" | "importing" | "done" | "failed" | "cancelled";

export interface ImportReport {
  photos: number;
  videos: number;
  bytes: number;
  with_details: number;
  matched_by: Record<string, number>;
  unmatched_sample: string[];
  albums: { title: string; count: number }[];
  years: [number, number] | null;
  favorites: number;
  archived: number;
  drive_files: number;
  /** Where files that aren't photos go (a folder or Apple import). */
  files_root?: string;
  skipped: { other_products: number; trash: number; unsupported: number };
  other_products: string[];
  parts: number;
  notes?: NotesReport | null;
}

export interface ImportProgress {
  done: number;
  total: number;
  imported: number;
  duplicates: number;
  failed: number;
  albums?: number;
  drive?: number;
  notes?: number;
  stage?: "photos" | "albums" | "drive" | "notes";
  failures?: { name: string; reason: string }[];
}

export interface ImportJob {
  id: string;
  source: ImportSource;
  state: ImportState;
  parts: { n: number; name: string; size: number }[];
  report: ImportReport | null;
  progress: ImportProgress | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export const importsApi = {
  async list(): Promise<ImportJob[]> {
    const { data } = await apiClient.get<ImportJob[]>("/imports");
    return data;
  },
  async create(source: ImportSource): Promise<ImportJob> {
    const { data } = await apiClient.post<ImportJob>("/imports", { source });
    return data;
  },
  async get(id: string): Promise<ImportJob> {
    const { data } = await apiClient.get<ImportJob>(`/imports/${id}`);
    return data;
  },
  async removePart(id: string, n: number): Promise<ImportJob> {
    const { data } = await apiClient.delete<ImportJob>(`/imports/${id}/parts/${n}`);
    return data;
  },
  async check(id: string): Promise<ImportJob> {
    const { data } = await apiClient.post<ImportJob>(`/imports/${id}/check`);
    return data;
  },
  async start(id: string): Promise<ImportJob> {
    const { data } = await apiClient.post<ImportJob>(`/imports/${id}/start`);
    return data;
  },
  async cancel(id: string): Promise<void> {
    await apiClient.delete(`/imports/${id}`);
  },
};
