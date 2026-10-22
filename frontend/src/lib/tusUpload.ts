import { DetailedError, Upload, defaultOptions, type HttpRequest } from "tus-js-client";

import { authHeader, refreshAccessToken } from "@/api/client";

/**
 * Big uploads, resumably (WP-8.2, Part C §5.6): files over the policy's
 * threshold go to the tusd sidecar in ~50 MB chunks (under Cloudflare's
 * 100 MB request cap). A dropped connection retries from where it got to;
 * after a refresh, choosing the same file again carries on from there
 * (tus-js-client remembers the upload by file name, type, size and date).
 *
 * The backend checks the upload before a byte is accepted (who, where,
 * the allowlist, disk and quota) and files it on the last chunk, through
 * the same path as any upload; the file's id comes back on that response.
 */

export const TUS_ENDPOINT = "/api/files/tus/";
export const TUS_CHUNK = 50 * 1024 * 1024;

export interface TusArgs {
  file: File;
  metadata: Record<string, string>;
  signal: AbortSignal;
  onProgress: (sent: number, total: number) => void;
}

export class TusRejected extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: unknown
  ) {
    super(message);
  }
}

/** What the server said, from a tus error's response body. */
function rejection(err: unknown): TusRejected | Error {
  if (err instanceof DetailedError && err.originalResponse) {
    const status = err.originalResponse.getStatus();
    let detail: unknown = null;
    let message = "";
    try {
      detail = JSON.parse(err.originalResponse.getBody() || "null")?.detail ?? null;
      message = typeof detail === "string" ? detail : (detail as { message?: string })?.message ?? "";
    } catch {
      /* not JSON */
    }
    return new TusRejected(message || `Upload failed (${status})`, status, detail);
  }
  return err instanceof Error ? err : new Error("Upload failed");
}

/** Upload ``file``; resolves with the new (or replaced) file's id. */
export function tusUpload({ file, metadata, signal, onProgress }: TusArgs): Promise<string> {
  return new Promise((resolve, reject) => {
    let refreshing: Promise<unknown> | null = null;
    const upload = new Upload(file, {
      endpoint: TUS_ENDPOINT,
      chunkSize: TUS_CHUNK,
      metadata,
      retryDelays: [0, 1000, 3000, 5000, 10_000, 20_000, 30_000, 60_000],
      removeFingerprintOnSuccess: true,
      onBeforeRequest: async (req: HttpRequest) => {
        if (refreshing) await refreshing;
        const h = authHeader();
        if (h.Authorization) req.setHeader("Authorization", h.Authorization);
      },
      onShouldRetry: (err) => {
        const status = err.originalResponse?.getStatus() ?? 0;
        if (status === 401) {
          // Expired access token: refresh, then the retry carries the new one.
          refreshing = refreshAccessToken();
          return true;
        }
        // A refusal (not allowed, too big, no room…) won't change on retry —
        // nor will a name clash (a 409 tus would otherwise retry).
        if (status === 409 && (err.originalResponse?.getBody() ?? "").includes("name_exists")) return false;
        if (status >= 400 && status < 500 && status !== 409 && status !== 423) return false;
        return true;
      },
      onProgress: (sent, total) => onProgress(sent, total),
      onSuccess: ({ lastResponse }) => {
        const id = lastResponse.getHeader("Upload-File-Id");
        if (id) resolve(id);
        else reject(new Error("The upload finished but the server didn't say where it went."));
      },
      onError: (err) => reject(rejection(err)),
    });
    signal.addEventListener("abort", () => {
      // Cancelled: remove what's been sent, too.
      void upload.abort(true).catch(() => undefined);
      reject(new DOMException("Aborted", "AbortError"));
    });
    void upload
      .findPreviousUploads()
      .then((previous) => {
        // Only carry on an upload of this file *for the same place* (the
        // same import, folder…): the same file chosen for a new import after
        // the old one was cancelled must start afresh, or it lands in the
        // cancelled one.
        const same = previous.filter((p) =>
          Object.entries(metadata).every(([k, v]) => (p.metadata as Record<string, string> | undefined)?.[k] === v)
        );
        if (same.length) upload.resumeFromPreviousUpload(same[0]);
        upload.start();
      })
      .catch(() => upload.start());
  });
}

/** Uploads started here that never finished (the tab closed, a refresh):
 *  choose the same file again to carry on. */
export interface UnfinishedUpload {
  key: string;
  name: string;
  size: number | null;
  folderId: string | null;
  scope: string;
  workspaceId: string | null;
  startedAt: string;
  url: string | null;
}

export async function unfinishedUploads(): Promise<UnfinishedUpload[]> {
  try {
    const all = await defaultOptions.urlStorage.findAllUploads();
    // Import archives (WP-10.1) resume on the import page, not here.
    return all.filter((u) => !u.metadata?.import_job).map((u) => ({
      key: u.urlStorageKey,
      name: u.metadata?.filename ?? "file",
      size: u.size,
      folderId: u.metadata?.folder_id || null,
      scope: u.metadata?.scope || "mine",
      workspaceId: u.metadata?.workspace_id || null,
      startedAt: u.creationTime,
      url: u.uploadUrl,
    }));
  } catch {
    return [];
  }
}

/** Give up on an unfinished upload: forget it here and remove it there. */
export async function discardUnfinished(u: UnfinishedUpload): Promise<void> {
  try {
    if (u.url) {
      await Upload.terminate(u.url, {
        headers: authHeader(),
        retryDelays: [0, 1000],
      });
    }
  } catch {
    /* already gone — the server sweeps old ones anyway */
  }
  await defaultOptions.urlStorage.removeUpload(u.key);
}
