import { apiClient } from "./client";

/** Export my library (WP-10.4): everything you own as an ordinary folder
 *  tree, in zip parts written as they download. */

export interface LibraryExportPart {
  n: number;
  files: number;
  bytes: number;
  name: string;
  /** A signed link (``/m/…``): the browser downloads it itself. */
  url: string;
}

export interface LibraryExport {
  id: string;
  created: number;
  expires: number;
  part_gb: number;
  bytes: number;
  counts: { files: number; documents: number; photos: number; folders: number };
  parts: LibraryExportPart[];
}

export const libraryExportApi = {
  async current(): Promise<LibraryExport | null> {
    const { data } = await apiClient.get<LibraryExport | null>("/files/exports/current");
    return data;
  },
  async create(partGb: number): Promise<LibraryExport> {
    const { data } = await apiClient.post<LibraryExport>("/files/exports", { part_gb: partGb });
    return data;
  },
  async discard(id: string): Promise<void> {
    await apiClient.delete(`/files/exports/${id}`);
  },
};
