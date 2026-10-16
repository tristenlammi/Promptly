/**
 * Folder trees for upload (WP-8.2): what was picked (``webkitRelativePath``)
 * or dropped (DataTransfer entries, walked recursively), as files with the
 * folder each sits in. No imports — the e2e runner unit-tests it.
 */

export interface TreeFile {
  file: File;
  /** Its folder inside the tree, "a/b" — "" for a loose file. */
  dir: string;
}

/** A picked directory's files, with their folders. */
export function treeFromPicked(files: File[]): TreeFile[] {
  return files.map((f) => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    return { file: f, dir: rel.split("/").slice(0, -1).join("/") };
  });
}

/** Everything dropped: loose files and whole folders (recursively). */
export async function treeFromDrop(dt: DataTransfer): Promise<{ files: TreeFile[]; hasFolders: boolean }> {
  const entries = Array.from(dt.items ?? [])
    .filter((i) => i.kind === "file")
    .map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() ?? null);
  // No entry API (old browsers): just the files.
  if (!entries.length || entries.some((e) => e === null)) {
    return { files: Array.from(dt.files ?? []).map((file) => ({ file, dir: "" })), hasFolders: false };
  }
  const out: TreeFile[] = [];
  let hasFolders = false;
  const walk = async (entry: FileSystemEntry, dir: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, dir });
      return;
    }
    if (!entry.isDirectory) return;
    hasFolders = true;
    const here = dir ? `${dir}/${entry.name}` : entry.name;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries hands them over in batches until an empty one.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walk(child, here);
    }
  };
  for (const e of entries) if (e) await walk(e, "");
  // System clutter never gets uploaded.
  return { files: out.filter((t) => t.file.name !== ".DS_Store" && !t.file.name.startsWith("._")), hasFolders };
}
