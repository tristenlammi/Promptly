import { filesApi, type FileScope } from "@/api/files";
import type { useUploadStore } from "@/store/uploadStore";

import type { TreeFile } from "./folderTree";

export { treeFromDrop, treeFromPicked, type TreeFile } from "./folderTree";

type StartUploads = ReturnType<typeof useUploadStore.getState>["startUploads"];

/**
 * Uploading folder trees (WP-8.2, Part C §5.6): a picked directory (the
 * "Upload folder" picker's ``webkitRelativePath``) or folders dragged in
 * from the desktop (DataTransfer entries) are recreated under the target
 * folder, and each file is queued into its own folder.
 */

/** Recreate the tree's folders under ``parentId`` (a clashing name gets
 *  " (2)", " (3)"…), then queue every file into its folder. Returns how
 *  many files were queued. */
export async function uploadTree(
  tree: TreeFile[],
  parentId: string | null,
  scope: FileScope,
  startUploads: StartUploads
): Promise<number> {
  const dirs = new Set<string>();
  for (const { dir } of tree) {
    const parts = dir.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const ids = new Map<string, string | null>([["", parentId]]);
  const ordered = [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  for (const dir of ordered) {
    const parent = ids.get(dir.split("/").slice(0, -1).join("/")) ?? parentId;
    const base = dir.split("/").pop() || "Folder";
    let made: string | null = null;
    for (let n = 1; n <= 20 && !made; n++) {
      try {
        made = (await filesApi.createFolder(scope, n === 1 ? base : `${base} (${n})`, parent)).id;
      } catch (e) {
        const status = (e as { response?: { status?: number } })?.response?.status;
        if (status !== 409) throw e;
      }
    }
    if (!made) throw new Error(`Couldn't create the folder “${base}”.`);
    ids.set(dir, made);
  }
  const byDir = new Map<string, File[]>();
  for (const { file, dir } of tree) byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
  for (const [dir, group] of byDir) {
    startUploads({ files: group, scope, folderId: ids.get(dir) ?? parentId, onConflict: "keep_both" });
  }
  return tree.length;
}
