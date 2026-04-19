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
}

export interface FileItem {
  id: string;
  folder_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  scope: FileScope;
  created_at: string;
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
