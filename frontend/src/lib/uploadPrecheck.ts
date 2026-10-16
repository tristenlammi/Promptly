import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { apiClient } from "@/api/client";
import type { FileScope } from "@/api/files";

/**
 * Skip files that are already there (WP-8.2, Part C §5.6): before a batch
 * uploads, the server says which of them have a same-name, same-size file
 * in the target folder, and only those are hashed here (streaming, so a
 * 4 GB video never sits in memory). Identical bytes → nothing to upload.
 *
 * Re-uploading a camera roll, or a folder you uploaded last week, then
 * costs seconds instead of the whole transfer.
 */

const SLICE = 8 * 1024 * 1024;

/** SHA-256 of a file, read in slices. */
export async function sha256OfFile(file: File, signal?: AbortSignal): Promise<string> {
  // Pure JS (the app's CSP doesn't allow WebAssembly), streaming.
  const hasher = sha256.create();
  for (let off = 0; off < file.size; off += SLICE) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    hasher.update(new Uint8Array(await file.slice(off, off + SLICE).arrayBuffer()));
  }
  return bytesToHex(hasher.digest());
}

interface PrecheckResponse {
  /** Index in the request → the sha256 of the file already there. */
  matches: Record<string, string>;
}

/** Which of ``files`` are already in the target folder, byte for byte. */
export async function alreadyThere(args: {
  files: File[];
  scope: FileScope;
  folderId: string | null;
  workspaceId?: string;
}): Promise<Set<number>> {
  const skip = new Set<number>();
  if (args.files.length === 0) return skip;
  let res: PrecheckResponse;
  try {
    res = (
      await apiClient.post<PrecheckResponse>("/files/precheck", {
        scope: args.scope,
        folder_id: args.folderId,
        workspace_id: args.workspaceId ?? null,
        files: args.files.map((f) => ({ name: f.name, size: f.size })),
      })
    ).data;
  } catch {
    return skip; // the check is only a shortcut — upload as usual
  }
  for (const [i, sha] of Object.entries(res.matches)) {
    const file = args.files[Number(i)];
    if (!file) continue;
    try {
      if ((await sha256OfFile(file)) === sha) skip.add(Number(i));
    } catch {
      /* unreadable here: let the upload decide */
    }
  }
  return skip;
}
