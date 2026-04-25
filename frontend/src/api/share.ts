/**
 * Public share-link API surface.
 *
 * Wraps the backend's ``/api/s/*`` endpoints that are deliberately
 * mounted OUTSIDE ``/api/files`` so anonymous visitors can open a
 * share URL without an access token. We still go through the
 * standard ``apiClient`` so an authenticated Promptly user gets
 * their bearer token attached automatically — the backend uses
 * that to satisfy ``invite`` mode links without any extra
 * frontend ceremony.
 */
import { apiClient, authHeader } from "./client";

import type {
  ShareFolderBrowseResponse,
  ShareLinkMeta,
  ShareLinkUnlockResponse,
} from "./files";

/** Header name the landing page uses to carry an unlock token. */
export const SHARE_UNLOCK_HEADER = "X-Share-Unlock";

export const shareApi = {
  async meta(token: string, unlockToken?: string | null): Promise<ShareLinkMeta> {
    const { data } = await apiClient.get<ShareLinkMeta>(`/s/${token}/meta`, {
      headers: unlockToken ? { [SHARE_UNLOCK_HEADER]: unlockToken } : undefined,
    });
    return data;
  },

  async unlock(
    token: string,
    password: string
  ): Promise<ShareLinkUnlockResponse> {
    const { data } = await apiClient.post<ShareLinkUnlockResponse>(
      `/s/${token}/unlock`,
      { password }
    );
    return data;
  },

  async browse(
    token: string,
    folderId: string | null,
    unlockToken?: string | null
  ): Promise<ShareFolderBrowseResponse> {
    const params = new URLSearchParams();
    if (folderId) params.set("folder_id", folderId);
    const url = `/s/${token}/browse${params.size ? `?${params}` : ""}`;
    const { data } = await apiClient.get<ShareFolderBrowseResponse>(url, {
      headers: unlockToken ? { [SHARE_UNLOCK_HEADER]: unlockToken } : undefined,
    });
    return data;
  },

  /**
   * Absolute download URL for the shared resource. ``fileId`` is
   * optional — for file share links omit it; for folder shares pass
   * the descendant file's id and the backend walks the ancestor
   * chain to confirm it lives under the shared root.
   */
  downloadUrl(token: string, fileId?: string | null): string {
    if (fileId) return `/api/s/${token}/file/${fileId}/download`;
    return `/api/s/${token}/download`;
  },

  /**
   * ``fetch`` wrapper that attaches optional auth + unlock headers
   * and returns a Blob. Used by the landing page to stream a file
   * into an object URL without forcing a full page navigation.
   */
  async downloadBlob(
    token: string,
    opts: { fileId?: string | null; unlockToken?: string | null } = {}
  ): Promise<Blob> {
    const url = shareApi.downloadUrl(token, opts.fileId ?? null);
    const headers: Record<string, string> = { ...authHeader() };
    if (opts.unlockToken) headers[SHARE_UNLOCK_HEADER] = opts.unlockToken;
    const res = await fetch(url, {
      headers,
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(await extractError(res));
    }
    return res.blob();
  },
};

async function extractError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: string };
    if (body && typeof body.detail === "string") return body.detail;
  } catch {
    /* not JSON */
  }
  if (res.status === 401) return "Password required";
  if (res.status === 404) return "Share link not found";
  if (res.status === 410) return "This share link is no longer active";
  return `Download failed (${res.status})`;
}
