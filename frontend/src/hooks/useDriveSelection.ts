import { useCallback, useMemo, useState } from "react";

/**
 * Shared multi-select state for any Drive surface (browse, recent,
 * starred, trash, search). Tracks file and folder ids separately so a
 * bulk action can route each to the right endpoint, and exposes a small
 * imperative API the canonical list/grid + selection bar consume.
 *
 * Call `reset(keys)` when the underlying list changes (folder navigation,
 * scope switch) to drop ids that are no longer present.
 */
export function useDriveSelection() {
  const [files, setFiles] = useState<Set<string>>(new Set());
  const [folders, setFolders] = useState<Set<string>>(new Set());

  const toggleFile = useCallback((id: string, on?: boolean) => {
    setFiles((prev) => {
      const next = new Set(prev);
      const want = on ?? !next.has(id);
      want ? next.add(id) : next.delete(id);
      return next;
    });
  }, []);

  const toggleFolder = useCallback((id: string, on?: boolean) => {
    setFolders((prev) => {
      const next = new Set(prev);
      const want = on ?? !next.has(id);
      want ? next.add(id) : next.delete(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setFiles(new Set());
    setFolders(new Set());
  }, []);

  /** Drop any selected ids that aren't in the supplied present sets —
   *  used to prune the selection after the list refetches/navigates. */
  const prune = useCallback(
    (presentFiles: Set<string>, presentFolders: Set<string>) => {
      setFiles((prev) => {
        const next = new Set([...prev].filter((id) => presentFiles.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setFolders((prev) => {
        const next = new Set([...prev].filter((id) => presentFolders.has(id)));
        return next.size === prev.size ? prev : next;
      });
    },
    []
  );

  const selectAll = useCallback(
    (fileIds: string[], folderIds: string[]) => {
      setFiles(new Set(fileIds));
      setFolders(new Set(folderIds));
    },
    []
  );

  const count = files.size + folders.size;

  return useMemo(
    () => ({
      files,
      folders,
      count,
      isFileSelected: (id: string) => files.has(id),
      isFolderSelected: (id: string) => folders.has(id),
      toggleFile,
      toggleFolder,
      clear,
      prune,
      selectAll,
    }),
    [files, folders, count, toggleFile, toggleFolder, clear, prune, selectAll]
  );
}

export type DriveSelection = ReturnType<typeof useDriveSelection>;
