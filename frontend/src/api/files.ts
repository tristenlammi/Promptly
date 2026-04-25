import { apiClient } from "./client";

export type FileScope = "mine" | "shared";

/** Identifies a folder created and managed by the system (e.g. "Chat
 * Uploads"). Mirrors ``app.files.system_folders.SystemKind`` on the
 * backend; ``null`` for normal user-created folders. */
export type SystemFolderKind =
  | "chat_uploads"
  | "generated_root"
  | "generated_files"
  | "generated_media";

export interface FolderItem {
  id: string;
  parent_id: string | null;
  name: string;
  scope: FileScope;
  created_at: string;
  system_kind: SystemFolderKind | null;
  /** Drive stage 1 — non-null on rows last modified after migration 0035. */
  updated_at: string | null;
  /** Drive stage 1 — non-null when the folder is starred. */
  starred_at: string | null;
  /** Drive stage 1 — non-null when the folder (or an ancestor) was trashed. */
  trashed_at: string | null;
}

export interface FileItem {
  id: string;
  folder_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  scope: FileScope;
  created_at: string;
  /** See ``FolderItem``; populated on every read path once 0035 applies. */
  updated_at: string | null;
  starred_at: string | null;
  trashed_at: string | null;
}

// --------------------------------------------------------------------
// Drive stage 1 — search / list / share-link DTOs
// --------------------------------------------------------------------
export interface FileSearchHit {
  file: FileItem;
  rank: number;
  snippet: string | null;
  breadcrumb: string | null;
}

export interface FileSearchResponse {
  query: string;
  hits: FileSearchHit[];
}

export interface RecentFilesResponse {
  files: FileItem[];
}

export interface StarredListResponse {
  folders: FolderItem[];
  files: FileItem[];
}

export interface TrashListResponse {
  folders: FolderItem[];
  files: FileItem[];
}

export type ShareAccessMode = "public" | "invite";
export type ShareResourceType = "file" | "folder";

export interface ShareLinkCreatePayload {
  access_mode: ShareAccessMode;
  password?: string | null;
  expires_in_days?: number | null;
}

export interface ShareLink {
  id: string;
  resource_type: ShareResourceType;
  resource_id: string;
  token: string;
  access_mode: ShareAccessMode;
  has_password: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  /** ``/s/{token}`` — landing page path (prepend current origin for copy). */
  path: string;
}

export interface ShareLinkListResponse {
  links: ShareLink[];
}

export interface ShareLinkMeta {
  resource_type: ShareResourceType;
  access_mode: ShareAccessMode;
  requires_password: boolean;
  requires_auth: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
}

export interface ShareLinkUnlockResponse {
  unlock_token: string;
}

export interface ShareFolderBrowseResponse {
  folder: FolderItem;
  breadcrumbs: BreadcrumbEntry[];
  folders: FolderItem[];
  files: FileItem[];
}

/** Response of ``GET /api/files/quota`` — mirrors
 *  ``StorageQuotaResponse`` on the backend. ``cap_bytes`` /
 *  ``remaining_bytes`` are nullable when the user is uncapped. */
export interface StorageQuota {
  cap_bytes: number | null;
  used_bytes: number;
  remaining_bytes: number | null;
}

export interface BreadcrumbEntry {
  id: string | null;
  name: string;
}

export interface BrowseResult {
  scope: FileScope;
  folder: FolderItem | null;
  breadcrumbs: BreadcrumbEntry[];
  folders: FolderItem[];
  files: FileItem[];
  writable: boolean;
}

export interface AttachmentSnapshot {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

/** Payload of ``GET /api/files/{id}/source`` — the editable Markdown
 *  source backing a rendered artefact (currently only PDFs).
 *  ``rendered_file_id`` is the same id the caller passed in; carrying
 *  it back lets the panel cache results without round-tripping. */
export interface FileSourceContent {
  rendered_file_id: string;
  rendered_filename: string;
  rendered_size_bytes: number;
  source_file_id: string;
  source_filename: string;
  source_mime_type: string;
  source_size_bytes: number;
  content: string;
}

export const filesApi = {
  async browse(scope: FileScope, folderId: string | null): Promise<BrowseResult> {
    const params = new URLSearchParams({ scope });
    if (folderId) params.set("folder_id", folderId);
    const { data } = await apiClient.get<BrowseResult>(
      `/files/browse?${params.toString()}`
    );
    return data;
  },

  /** Storage cap + current usage for the signed-in user. Used by the
   *  Drive sub-nav storage pill and the upload panel's footer. */
  async getQuota(): Promise<StorageQuota> {
    const { data } = await apiClient.get<StorageQuota>("/files/quota");
    return data;
  },

  async createFolder(
    scope: FileScope,
    name: string,
    parentId: string | null
  ): Promise<FolderItem> {
    const { data } = await apiClient.post<FolderItem>("/files/folders", {
      scope,
      name,
      parent_id: parentId,
    });
    return data;
  },

  async renameFolder(id: string, name: string): Promise<FolderItem> {
    const { data } = await apiClient.patch<FolderItem>(`/files/folders/${id}`, {
      name,
    });
    return data;
  },

  async moveFolder(id: string, parentId: string | null): Promise<FolderItem> {
    const body =
      parentId === null
        ? { move_to_root: true }
        : { parent_id: parentId };
    const { data } = await apiClient.patch<FolderItem>(
      `/files/folders/${id}`,
      body
    );
    return data;
  },

  async deleteFolder(id: string): Promise<void> {
    await apiClient.delete(`/files/folders/${id}`);
  },

  /**
   * Upload a file into the user's pool.
   *
   * @param folderId  Explicit destination folder. When provided the file
   *                  always lands there.
   * @param route     Auto-routing hint used when ``folderId`` is null and
   *                  ``scope === "mine"``. ``"chat"`` lands the file in
   *                  the user's "Chat Uploads" system folder.
   */
  async upload(
    scope: FileScope,
    file: File,
    folderId: string | null,
    route?: "chat" | "generated"
  ): Promise<FileItem> {
    const form = new FormData();
    form.append("file", file);
    form.append("scope", scope);
    if (folderId) form.append("folder_id", folderId);
    if (route && !folderId && scope === "mine") form.append("route", route);
    const { data } = await apiClient.post<FileItem>("/files/", form, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 120_000,
    });
    return data;
  },

  async renameFile(id: string, filename: string): Promise<FileItem> {
    const { data } = await apiClient.patch<FileItem>(`/files/${id}`, {
      filename,
    });
    return data;
  },

  async moveFile(id: string, folderId: string | null): Promise<FileItem> {
    const body =
      folderId === null ? { move_to_root: true } : { folder_id: folderId };
    const { data } = await apiClient.patch<FileItem>(`/files/${id}`, body);
    return data;
  },

  async deleteFile(id: string): Promise<void> {
    await apiClient.delete(`/files/${id}`);
  },

  async getFile(id: string): Promise<FileItem> {
    const { data } = await apiClient.get<FileItem>(`/files/${id}`);
    return data;
  },

  /** Build the URL for a download. Caller is responsible for attaching auth. */
  downloadUrl(id: string): string {
    return `/api/files/${id}/download`;
  },

  // ----------------------------------------------------------------
  // Drive stage 1 — Trash
  // ----------------------------------------------------------------
  async trashFile(id: string): Promise<FileItem> {
    const { data } = await apiClient.post<FileItem>(`/files/${id}/trash`);
    return data;
  },
  async restoreFile(id: string): Promise<FileItem> {
    const { data } = await apiClient.post<FileItem>(`/files/${id}/restore`);
    return data;
  },
  async trashFolder(id: string): Promise<FolderItem> {
    const { data } = await apiClient.post<FolderItem>(
      `/files/folders/${id}/trash`
    );
    return data;
  },
  async restoreFolder(id: string): Promise<FolderItem> {
    const { data } = await apiClient.post<FolderItem>(
      `/files/folders/${id}/restore`
    );
    return data;
  },
  async listTrash(scope: FileScope): Promise<TrashListResponse> {
    const { data } = await apiClient.get<TrashListResponse>(
      `/files/trash?scope=${scope}`
    );
    return data;
  },
  async emptyTrash(scope: FileScope): Promise<void> {
    await apiClient.delete(`/files/trash?scope=${scope}`);
  },

  // ----------------------------------------------------------------
  // Drive stage 1 — Starred / Recent / Search
  // ----------------------------------------------------------------
  async starFile(id: string): Promise<FileItem> {
    const { data } = await apiClient.post<FileItem>(`/files/${id}/star`);
    return data;
  },
  async unstarFile(id: string): Promise<FileItem> {
    const { data } = await apiClient.delete<FileItem>(`/files/${id}/star`);
    return data;
  },
  async starFolder(id: string): Promise<FolderItem> {
    const { data } = await apiClient.post<FolderItem>(
      `/files/folders/${id}/star`
    );
    return data;
  },
  async unstarFolder(id: string): Promise<FolderItem> {
    const { data } = await apiClient.delete<FolderItem>(
      `/files/folders/${id}/star`
    );
    return data;
  },
  async listStarred(scope: FileScope): Promise<StarredListResponse> {
    const { data } = await apiClient.get<StarredListResponse>(
      `/files/starred?scope=${scope}`
    );
    return data;
  },
  async listRecent(
    scope: FileScope,
    limit = 50
  ): Promise<RecentFilesResponse> {
    const { data } = await apiClient.get<RecentFilesResponse>(
      `/files/recent?scope=${scope}&limit=${limit}`
    );
    return data;
  },
  async search(
    q: string,
    scope: FileScope,
    limit = 20
  ): Promise<FileSearchResponse> {
    const params = new URLSearchParams({ q, scope, limit: String(limit) });
    const { data } = await apiClient.get<FileSearchResponse>(
      `/files/search?${params.toString()}`
    );
    return data;
  },

  // ----------------------------------------------------------------
  // Drive stage 1 — Share links (owner side, authenticated)
  // ----------------------------------------------------------------
  async listFileShareLinks(fileId: string): Promise<ShareLinkListResponse> {
    const { data } = await apiClient.get<ShareLinkListResponse>(
      `/files/${fileId}/share-links`
    );
    return data;
  },
  async listFolderShareLinks(
    folderId: string
  ): Promise<ShareLinkListResponse> {
    const { data } = await apiClient.get<ShareLinkListResponse>(
      `/files/folders/${folderId}/share-links`
    );
    return data;
  },
  async createFileShareLink(
    fileId: string,
    payload: ShareLinkCreatePayload
  ): Promise<ShareLink> {
    const { data } = await apiClient.post<ShareLink>(
      `/files/${fileId}/share-links`,
      payload
    );
    return data;
  },
  async createFolderShareLink(
    folderId: string,
    payload: ShareLinkCreatePayload
  ): Promise<ShareLink> {
    const { data } = await apiClient.post<ShareLink>(
      `/files/folders/${folderId}/share-links`,
      payload
    );
    return data;
  },
  async revokeShareLink(linkId: string): Promise<void> {
    await apiClient.delete(`/files/share-links/${linkId}`);
  },

  /** Load the editable Markdown source backing a rendered artefact.
   *  ``id`` is the *rendered* file's id (e.g. the PDF chip the user
   *  clicked). 404 if the file isn't a rendered artefact, or if its
   *  source has been deleted out from under it. */
  async getSource(id: string): Promise<FileSourceContent> {
    const { data } = await apiClient.get<FileSourceContent>(
      `/files/${id}/source`
    );
    return data;
  },

  /** Save edited Markdown and trigger an in-place re-render of the
   *  linked PDF. Returns the refreshed pair so the editor can update
   *  its dirty-state baseline + show the new size in the header. */
  async updateSource(
    id: string,
    content: string
  ): Promise<FileSourceContent> {
    const { data } = await apiClient.put<FileSourceContent>(
      `/files/${id}/source`,
      { content }
    );
    return data;
  },
};
