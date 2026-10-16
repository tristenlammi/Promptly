import { apiClient } from "./client";

export type FileScope = "mine" | "shared";

export type DriveSortKey = "name" | "modified" | "size";
export type DriveSortDir = "asc" | "desc";
export interface DriveSort {
  key: DriveSortKey;
  dir: DriveSortDir;
}

export interface BulkIds {
  file_ids: string[];
  folder_ids: string[];
}
export interface BulkResult {
  files: number;
  folders: number;
  /** Left alone because a workspace owns them (R-215). */
  skipped?: number;
}

/** Identifies a folder created and managed by the system (e.g. "Chat
 * Uploads"). Mirrors ``app.files.system_folders.SystemKind`` on the
 * backend; ``null`` for normal user-created folders. */
export type SystemFolderKind =
  | "chat_uploads"
  | "generated_root"
  | "generated_files"
  | "generated_media"
  | "workspaces_root"
  | "templates"
  | "camera_uploads";

/** Compact representation of one grantee on a file/folder.
 *  Mirrors :class:`GranteeBrief` on the backend. ``grant_id`` is
 *  ``00000000-...`` when the brief refers to the *owner* — it has
 *  no underlying ``ResourceGrant`` row but the frontend reuses
 *  the same shape so the pill / banner can render uniformly. */
export interface Grantee {
  grant_id: string;
  user_id: string;
  username: string;
  email: string | null;
  can_copy: boolean;
  /** Drive stage 5.1 — write access. Currently only meaningful on
   *  Drive Documents (the backend refuses ``can_edit=true`` on
   *  folder grants and on non-document files). When ``true``, the
   *  grantee gets a real-time collaborative editing seat instead
   *  of read-only access. Defaulted to ``false`` for compatibility
   *  with rows persisted before migration 0043. */
  can_edit?: boolean;
  /** WP-6.6 — can comment (Docs, Sheets, Whiteboards); true for editors too. */
  can_comment?: boolean;
  /** WP-6.6 — joined through a comment / edit link (lasts while it does). */
  via_link?: boolean;
}

/** Per-row sharing summary attached to every file/folder response.
 *  ``null`` when nobody is on the share list; populated otherwise.
 *  See ``GrantSummary`` on the backend. */
export interface GrantSummary {
  /** ``"owner"`` = caller owns this row; ``"grantee"`` = caller has
   *  been granted access to someone else's row. */
  role: "owner" | "grantee";
  /** Everyone except the caller who currently has access. */
  grantees: Grantee[];
  /** True only when ``role === "grantee"`` AND the caller's grant
   *  carries ``can_copy``. Used to gate the "Copy to my files" UI. */
  can_copy: boolean;
  /** True only when ``role === "grantee"`` AND the caller's grant
   *  (on the file or any ancestor folder) carries ``can_edit``. The
   *  document editor flips out of read-only mode when this is set. */
  can_edit?: boolean;
  can_comment?: boolean;
  /** Owner brief — only populated when ``role === "grantee"`` so the
   *  UI can render a "Shared by @alice" chip. */
  owner: Grantee | null;
  /** Live public links on it (owner's view) — shown as a link badge. */
  public_links?: number;
}

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
  /** Left out of Photos, with everything inside it (WP-9.1). */
  hide_from_photos?: boolean;
  /** Drive stage 5 — peer-to-peer share grants. ``null`` on rows
   *  with no outstanding grants. */
  sharing?: GrantSummary | null;
  /** "My files / Projects" — set by the trash list and restore (R-209). */
  location?: string | null;
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
  /** Provenance hint. ``"document"`` on Drive Documents (TipTap + Y.js),
   *  ``"rendered_pdf"`` / ``"markdown_source"`` on chat-generated PDFs,
   *  ``null`` on ordinary user uploads. Kept loose-typed so UI code
   *  doesn't break when a new kind ships before this type is updated. */
  source_kind?: string | null;
  /** Non-null on rows that point back at an editable source (e.g. a
   *  rendered PDF → its markdown source, or a document asset → its
   *  owning document). */
  source_file_id?: string | null;
  /** Drive stage 5 — peer-to-peer share grants (see ``FolderItem``). */
  sharing?: GrantSummary | null;
  /** When the content last changed (a star or move doesn't count). */
  modified_at?: string | null;
  location?: string | null;
  /** What the nightly integrity check found (WP-7.2). */
  blob_state?: "ready" | "ingesting" | "missing" | "damaged";
  /** A photo's / video's blurred placeholder, base64 ThumbHash (WP-7.4). */
  thumbhash?: string | null;
  /** A signed link to its WebP grid tile, once made (WP-7.5). */
  thumb_url?: string | null;
}

/** A zip download being made (WP-7.6). */
export interface ZipStatus {
  state: "queued" | "building" | "ready" | "failed";
  files: number;
  done: number;
  bytes: number;
  source_bytes: number;
  name: string;
  error: string | null;
  url: string | null;
}

/** Short-lived links (``/m/<token>``) that work in ``<img>``, ``<video>``
 *  and ``<a download>`` without the bearer header (WP-7.5). ``null`` when
 *  there's nothing to serve (yet). */
export interface SignedUrls {
  original: string | null;
  thumb: string | null;
  preview: string | null;
  poster: string | null;
  video: string | null;
  state: "pending" | "processing" | "ready" | "failed" | "skipped" | null;
  expires_at: string;
  /** Shown edited (PH-7); ``source`` is the preview before the edit. */
  edited?: boolean;
  source?: string | null;
}

/** Drive Document detection — ``true`` for the user-created TipTap
 *  documents created via "New file". The classification feeds the
 *  click router (documents jump straight into the editor instead of
 *  the generic preview iframe) and the Save / format-aware download
 *  affordances that only make sense on documents. */
export function isDocumentFile(file: Pick<FileItem, "source_kind">): boolean {
  return file.source_kind === "document";
}

/** A spreadsheet or whiteboard's Drive file (WP-3.2): its content lives in
 *  the sheet / whiteboard editor, the file is its identity in Drive. */
export function isOfficeShell(file: Pick<FileItem, "source_kind">): boolean {
  return file.source_kind === "sheet" || file.source_kind === "whiteboard";
}

/** Documents, spreadsheets and whiteboards can be shared with editors. */
/** The roles a share link (or a person) can have on this file (WP-6.6):
 *  comment and edit on Docs / Sheets / Whiteboards, edit on an uploaded
 *  PDF, view on everything else. */
export function shareRolesFor(
  file: Pick<FileItem, "source_kind"> & Partial<Pick<FileItem, "filename" | "mime_type">>
): ShareLinkRole[] {
  if (isDocumentFile(file) || isOfficeShell(file)) return ["view", "comment", "edit"];
  if (isEditablePdf(file)) return ["view", "edit"];
  return ["view"];
}

export function supportsEditGrant(file: Pick<FileItem, "source_kind"> & Partial<Pick<FileItem, "filename" | "mime_type">>): boolean {
  return isDocumentFile(file) || isOfficeShell(file) || isEditablePdf(file);
}

/** An uploaded PDF — fill in, mark up and reorganise in the viewer, and
 *  share with editors (WP-6.5). A chat-made PDF is rebuilt from its source. */
export function isEditablePdf(file: Pick<FileItem, "source_kind"> & Partial<Pick<FileItem, "filename" | "mime_type">>): boolean {
  return !file.source_kind && (/\.pdf$/i.test(file.filename ?? "") || file.mime_type === "application/pdf");
}

// --------------------------------------------------------------------
// Drive stage 5 — share grants DTOs
// --------------------------------------------------------------------
export type ShareableResourceType = "file" | "folder";

export interface UserSearchHit {
  id: string;
  username: string;
  email: string | null;
  already_granted: boolean;
}

export interface UserSearchResponse {
  results: UserSearchHit[];
}

export interface GrantsListResponse {
  grants: Grantee[];
  can_share: boolean;
}

export interface CreateGrantPayload {
  grantee_user_id: string;
  can_copy: boolean;
  /** Optional — defaults to ``false`` server-side. Backend rejects
   *  ``true`` for folders or non-document files with a 400 so the
   *  share modal can rely on the spec for which resources accept it. */
  can_edit?: boolean;
  /** WP-6.6 — comment without editing (Docs, Sheets, Whiteboards). */
  can_comment?: boolean;
}

export interface UpdateGrantPayload {
  can_copy: boolean;
  /** Optional. ``undefined`` means "leave as-is", ``true``/``false``
   *  overwrite. Same validation rules as :type:`CreateGrantPayload`. */
  can_edit?: boolean | null;
  can_comment?: boolean | null;
}

/** Hard cap from the product spec — refused with a 400 on the
 *  backend if the modal tries to add an 11th. Mirrored here so the
 *  modal can disable the picker before the round trip. */
export const MAX_GRANTS_PER_RESOURCE = 10;

// --------------------------------------------------------------------
// Drive stage 1 — search / list / share-link DTOs
// --------------------------------------------------------------------
export interface FileSearchHit {
  file: FileItem;
  rank: number;
  snippet: string | null;
  /** "My files / Taxes" or "Shared by sam / Projects". */
  breadcrumb: string | null;
  /** The containing folder, as an app path (WP-5.4). */
  parent_link?: string | null;
  /** Why it matched: words in the name / the text, or by meaning (AI search). */
  match?: "name" | "content" | "meaning" | null;
}

export interface FileSearchResponse {
  query: string;
  hits: FileSearchHit[];
  /** Folders whose name matches (first page only) — yours and shared. */
  folders?: FolderItem[];
  /** Each folder hit's trail, by id. */
  folder_breadcrumbs?: Record<string, string>;
  has_more?: boolean;
  /** First page with ``semantic``: files about the query without its words. */
  related?: FileSearchHit[];
  /** With ``folderId``: that folder's trail. */
  within_trail?: string | null;
}

export type FileSearchType =
  | "document"
  | "sheet"
  | "whiteboard"
  | "pdf"
  | "office"
  | "image"
  | "video"
  | "audio"
  | "text"
  | "folder";

export interface FileSearchFilters {
  type?: FileSearchType | null;
  /** ISO timestamp. */
  modifiedAfter?: string | null;
  owner?: "any" | "me" | "others";
  /** Only inside this folder (and its subfolders). */
  folderId?: string | null;
  /** Also list files related by meaning (AI search of your files). */
  semantic?: boolean;
  offset?: number;
}

export interface RecentFilesResponse {
  files: FileItem[];
}

export interface StarredListResponse {
  folders: FolderItem[];
  files: FileItem[];
  next_cursor?: string | null;
}

export interface TrashListResponse {
  folders: FolderItem[];
  files: FileItem[];
  next_cursor?: string | null;
}

export type ShareAccessMode = "public" | "invite";
/** What people with a link can do (WP-6.6). Comment / edit links are always
 *  "Specific people" — editing is never anonymous. */
export type ShareLinkRole = "view" | "comment" | "edit";
export type ShareResourceType = "file" | "folder" | "album";

export interface ShareLinkCreatePayload {
  access_mode: ShareAccessMode;
  role?: ShareLinkRole;
  password?: string | null;
  expires_in_days?: number | null;
  /** Photos keep their location / camera details for people with the link. */
  keep_location?: boolean;
}

export interface ShareLink {
  id: string;
  resource_type: ShareResourceType;
  resource_id: string;
  token: string;
  access_mode: ShareAccessMode;
  role?: ShareLinkRole;
  has_password: boolean;
  keep_location?: boolean;
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

/** A link plus what it opens — the "Shared links" view (R-208). */
export interface OwnedShareLink extends ShareLink {
  resource_name: string | null;
  resource_trashed: boolean;
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
  /** WP-6.6: a comment / edit link — opened signed in, where to go. */
  role?: ShareLinkRole;
  open_path?: string | null;
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
  /** Set when this folder is (inside) a workspace's folder (R-215). */
  workspace_id?: string | null;
  workspace_title?: string | null;
  /** More files after these — pass back as ``cursor`` (WP-7.6). */
  next_cursor?: string | null;
}

/** A page of a listing (WP-7.6). Without ``limit``, everything. */
export interface PageOpts {
  limit?: number;
  cursor?: string | null;
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

/** The Shared page's two views (WP-3.5). */
export type SharedView = "with_me" | "by_me";

/** "Restore everything this device deleted" (WP-7.2). */
export const trashGuardApi = {
  async summary(credential: string): Promise<{ files: number; bytes: number; folders: number; this_device: boolean }> {
    const { data } = await apiClient.get("/files/trash/restore-device", { params: { credential } });
    return data;
  },
  async restore(credential: string): Promise<{ files: number; folders: number }> {
    const { data } = await apiClient.post("/files/trash/restore-device", { credential });
    return data;
  },
};

/** A photo's or video's details (WP-7.3). */
export interface MediaInfo {
  extracted: boolean;
  kind?: "image" | "video" | "raw";
  taken_at?: string | null;
  taken_at_source?: "exif" | "quicktime" | "sidecar" | "client" | "upload" | "edited" | null;
  /** A description brought in with it (Google Takeout, WP-10.2). */
  description?: string | null;
  tz_offset?: number | null;
  location?: { lat: number; lon: number; edited: boolean } | null;
  /** The nearest named place (PH-2), worked out offline from GeoNames. */
  place?: { id: number; name: string; admin1: string | null; country: string | null; label: string; attribution: string } | null;
  /** The wall-clock time Photos shows (no zone): the owner's zone when the
   *  photo has none of its own. */
  taken_local?: string | null;
  /** What the Photos vision model said of it (PH-2). */
  caption?: { text: string; tags: string[] } | null;
  /** The words read in it (PH-2): a sign, a menu, a screenshot. */
  text?: string | null;
  /** Animals found (PH-2): what kind, and where. */
  animals?: { species: string; x: number; y: number; w: number; h: number }[];
  /** Faces found (PH-2) — the owner's, when they turned face recognition on. */
  faces?: { x: number; y: number; w: number; h: number }[] | null;
  has_original_location?: boolean;
  width?: number | null;
  height?: number | null;
  orientation?: number | null;
  camera?: string | null;
  duration_ms?: number | null;
  codec?: string | null;
  live_pair_file_id?: string | null;
  motion_embedded?: boolean;
  error?: string | null;
  can_edit?: boolean;
}

export interface MediaPatch {
  taken_at?: string;
  reset_taken_at?: boolean;
  lat?: number;
  lon?: number;
  hide_location?: boolean;
  reset_location?: boolean;
}

export const mediaApi = {
  async get(fileId: string): Promise<MediaInfo> {
    const { data } = await apiClient.get<MediaInfo>(`/files/${fileId}/media`);
    return data;
  },
  async patch(fileId: string, patch: MediaPatch): Promise<MediaInfo> {
    const { data } = await apiClient.patch<MediaInfo>(`/files/${fileId}/media`, patch);
    return data;
  },
};

export const filesApi = {
  /** Every live folder in the caller's personal Drive, flat (excludes the
   *  Workspaces subtree). For pickers needing the whole tree at once. */
  async allFolders(): Promise<
    { id: string; parent_id: string | null; name: string }[]
  > {
    const { data } = await apiClient.get<
      { id: string; parent_id: string | null; name: string }[]
    >("/files/folders/all");
    return data;
  },

  async browse(
    scope: FileScope,
    folderId: string | null,
    sort?: DriveSort,
    /** Shared root only: "with_me" (others' items), "by_me" (yours). */
    shared?: SharedView,
    page?: PageOpts
  ): Promise<BrowseResult> {
    const params = new URLSearchParams({ scope });
    if (folderId) params.set("folder_id", folderId);
    if (shared && scope === "shared" && !folderId) params.set("shared", shared);
    if (sort) {
      params.set("sort", sort.key);
      params.set("dir", sort.dir);
    }
    if (page?.limit) params.set("limit", String(page.limit));
    if (page?.cursor) params.set("cursor", page.cursor);
    const { data } = await apiClient.get<BrowseResult>(
      `/files/browse?${params.toString()}`
    );
    return data;
  },

  /** A folder's subfolders without its files (WP-7.6) — for the folder
   *  tree and the Move picker. */
  async subfolders(scope: FileScope, parentId: string | null): Promise<BrowseResult> {
    const params = new URLSearchParams({ scope });
    if (parentId) params.set("parent_id", parentId);
    const { data } = await apiClient.get<BrowseResult>(`/files/folders?${params.toString()}`);
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

  async setHideFromPhotos(id: string, hide: boolean): Promise<FolderItem> {
    const { data } = await apiClient.patch<FolderItem>(`/files/folders/${id}`, { hide_from_photos: hide });
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
    route?: "chat" | "generated" | "camera"
  ): Promise<FileItem> {
    const form = new FormData();
    form.append("file", file);
    form.append("scope", scope);
    // The file's date on this device — a photo's fallback "taken" date (WP-7.3).
    if (file.lastModified) form.append("last_modified", String(file.lastModified));
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

  async signedUrls(id: string): Promise<SignedUrls> {
    const { data } = await apiClient.get<SignedUrls>(`/files/${id}/signed-urls`);
    return data;
  },

  /** Build the URL for a download. Caller is responsible for attaching auth. */
  downloadUrl(id: string): string {
    return `/api/files/${id}/download`;
  },

  /** Build the URL for a small image thumbnail (315xx JPEG). 415 for
   *  non-images. Caller attaches auth (fetch as a blob → object URL). */
  thumbnailUrl(id: string): string {
    return `/api/files/${id}/thumbnail`;
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
  async listTrash(scope: FileScope, page?: PageOpts): Promise<TrashListResponse> {
    const params = new URLSearchParams({ scope });
    if (page?.limit) params.set("limit", String(page.limit));
    if (page?.cursor) params.set("cursor", page.cursor);
    const { data } = await apiClient.get<TrashListResponse>(`/files/trash?${params.toString()}`);
    return data;
  },
  async emptyTrash(scope: FileScope): Promise<void> {
    await apiClient.delete(`/files/trash?scope=${scope}`);
  },

  // ----------------------------------------------------------------
  // Bulk operations — one atomic request per multi-select action.
  // ----------------------------------------------------------------
  async bulkTrash(ids: BulkIds): Promise<BulkResult> {
    const { data } = await apiClient.post<BulkResult>("/files/bulk/trash", ids);
    return data;
  },
  /** Trash's "Delete forever": only items already in the trash. */
  async bulkPurge(ids: BulkIds): Promise<BulkResult> {
    const { data } = await apiClient.post<BulkResult>("/files/bulk/purge", ids);
    return data;
  },
  async bulkRestore(ids: BulkIds): Promise<BulkResult> {
    const { data } = await apiClient.post<BulkResult>(
      "/files/bulk/restore",
      ids
    );
    return data;
  },
  async bulkMove(
    ids: BulkIds & { target_folder_id?: string | null; move_to_root?: boolean }
  ): Promise<BulkResult> {
    const { data } = await apiClient.post<BulkResult>("/files/bulk/move", ids);
    return data;
  },
  async bulkStar(ids: BulkIds): Promise<BulkResult> {
    const { data } = await apiClient.post<BulkResult>("/files/bulk/star", ids);
    return data;
  },
  async bulkUnstar(ids: BulkIds): Promise<BulkResult> {
    const { data } = await apiClient.post<BulkResult>(
      "/files/bulk/unstar",
      ids
    );
    return data;
  },
  /** Zip the selection (WP-7.6): the server writes it in the background
   *  — folders keep their structure — and the browser then downloads it
   *  itself from a signed link (resumable, no time limit). A progress toast
   *  shows while a big one is being made. */
  async bulkZipDownload(ids: BulkIds): Promise<void> {
    const { toast } = await import("@/store/toastStore");
    const { data: job } = await apiClient.post<{ job_id: string; files: number; name: string }>("/files/bulk/zip", ids);
    let note: string | null = null;
    const started = Date.now();
    try {
      for (;;) {
        const { data } = await apiClient.get<ZipStatus>(`/files/zips/${job.job_id}`);
        if (data.state === "ready" && data.url) {
          const a = document.createElement("a");
          a.href = data.url;
          a.download = data.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          return;
        }
        if (data.state === "failed") throw new Error(data.error ?? "The zip couldn't be made.");
        const message = `Zipping ${data.done.toLocaleString()} of ${data.files.toLocaleString()} file${data.files === 1 ? "" : "s"}…`;
        // Only for one that takes a moment — a small zip just downloads.
        if (!note && Date.now() - started > 1500) note = toast.info(message, { title: data.name, duration: 0 });
        else if (note) toast.update(note, { message });
        await new Promise((r) => window.setTimeout(r, 1000));
      }
    } finally {
      if (note) toast.dismiss(note);
    }
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
  async listStarred(scope: FileScope, page?: PageOpts): Promise<StarredListResponse> {
    const params = new URLSearchParams({ scope });
    if (page?.limit) params.set("limit", String(page.limit));
    if (page?.cursor) params.set("cursor", page.cursor);
    const { data } = await apiClient.get<StarredListResponse>(`/files/starred?${params.toString()}`);
    return data;
  },
  async listRecent(
    scope: FileScope,
    limit = 50,
    /** Drop files in the Chat Uploads / Generated / Workspaces system
     *  buckets — used by the ``@``-mention picker. */
    excludeSystemFolders = false
  ): Promise<RecentFilesResponse> {
    const params = new URLSearchParams({ scope, limit: String(limit) });
    if (excludeSystemFolders) params.set("exclude_system_folders", "true");
    const { data } = await apiClient.get<RecentFilesResponse>(
      `/files/recent?${params.toString()}`
    );
    return data;
  },
  async search(
    q: string,
    scope: FileScope,
    limit = 20,
    excludeSystemFolders = false,
    filters: FileSearchFilters = {}
  ): Promise<FileSearchResponse> {
    const params = new URLSearchParams({ q, scope, limit: String(limit) });
    if (excludeSystemFolders) params.set("exclude_system_folders", "true");
    if (filters.type) params.set("type", filters.type);
    if (filters.modifiedAfter) params.set("modified_after", filters.modifiedAfter);
    if (filters.owner && filters.owner !== "any") params.set("owner", filters.owner);
    if (filters.offset) params.set("offset", String(filters.offset));
    if (filters.folderId) params.set("folder_id", filters.folderId);
    if (filters.semantic) params.set("semantic", "true");
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
  /** Keep the file's current state as a version — before an AI change is
   *  applied (WP-3.3). Best-effort: resolves even if it fails. */
  async snapshotVersion(
    fileId: string,
    source: "pre_ai" | "manual",
    label?: string
  ): Promise<void> {
    try {
      await apiClient.post(
        `/files/${fileId}/versions`,
        { source, label: label ?? null },
        { timeout: 4000 }
      );
    } catch {
      /* never block the edit on the safety copy */
    }
  },

  async revokeShareLink(linkId: string): Promise<void> {
    await apiClient.delete(`/files/share-links/${linkId}`);
  },
  async listMyShareLinks(): Promise<{ links: OwnedShareLink[] }> {
    const { data } = await apiClient.get<{ links: OwnedShareLink[] }>("/files/share-links");
    return data;
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

  // ----------------------------------------------------------------
  // Drive stage 5 — Peer-to-peer share grants
  // ----------------------------------------------------------------
  /** User picker / directory for the share modal. ``q`` matches
   *  username / email by case-insensitive prefix; a blank ``q``
   *  browses the first ``limit`` users so the UI can list who's on
   *  the app. Pass the resource ids so the picker can mark
   *  already-granted rows. */
  async searchUsersForShare(
    q: string,
    resource: { type: ShareableResourceType; id: string } | null,
    limit = 20
  ): Promise<UserSearchResponse> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (resource) {
      params.set("resource_type", resource.type);
      params.set("resource_id", resource.id);
    }
    const { data } = await apiClient.get<UserSearchResponse>(
      `/files/users/search?${params.toString()}`
    );
    return data;
  },

  async listGrants(
    type: ShareableResourceType,
    id: string
  ): Promise<GrantsListResponse> {
    const { data } = await apiClient.get<GrantsListResponse>(
      `/files/${type}/${id}/grants`
    );
    return data;
  },

  async createGrant(
    type: ShareableResourceType,
    id: string,
    payload: CreateGrantPayload
  ): Promise<GrantsListResponse> {
    const { data } = await apiClient.post<GrantsListResponse>(
      `/files/${type}/${id}/grants`,
      payload
    );
    return data;
  },

  async updateGrant(
    type: ShareableResourceType,
    id: string,
    grantId: string,
    payload: UpdateGrantPayload
  ): Promise<GrantsListResponse> {
    const { data } = await apiClient.patch<GrantsListResponse>(
      `/files/${type}/${id}/grants/${grantId}`,
      payload
    );
    return data;
  },

  async revokeGrant(
    type: ShareableResourceType,
    id: string,
    grantId: string
  ): Promise<GrantsListResponse> {
    const { data } = await apiClient.delete<GrantsListResponse>(
      `/files/${type}/${id}/grants/${grantId}`
    );
    return data;
  },

  /** Stop sharing entirely — revoke every grant on this resource in
   *  a single round-trip. Backend returns the (now-empty) grants
   *  list so the UI can refresh its pill without a second call. */
  async revokeAllGrants(
    type: ShareableResourceType,
    id: string
  ): Promise<GrantsListResponse> {
    const { data } = await apiClient.delete<GrantsListResponse>(
      `/files/${type}/${id}/grants`
    );
    return data;
  },

  /** Clone a shared file into the caller's Drive root. Backend
   *  enforces ``can_copy`` and quota; returns the freshly cloned
   *  file row. */
  async copyFileToMine(
    fileId: string
  ): Promise<{ file: FileItem }> {
    const { data } = await apiClient.post<{ file: FileItem }>(
      `/files/files/${fileId}/copy-to-mine`
    );
    return data;
  },
};
