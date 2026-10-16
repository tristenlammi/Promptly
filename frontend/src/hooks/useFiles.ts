import { useMemo } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import {
  filesApi,
  type BrowseResult,
  type BulkIds,
  type DriveSort,
  type SharedView,
  type FileScope,
  type FileSearchResponse,
  type RecentFilesResponse,
  type ShareLinkCreatePayload,
  type ShareLinkListResponse,
  type StarredListResponse,
  type StorageQuota,
  type TrashListResponse,
  type FileSearchFilters,
} from "@/api/files";
import { toast } from "@/store/toastStore";

const BROWSE_KEY = "files-browse" as const;
const RECENT_KEY = "files-recent" as const;
const STARRED_KEY = "files-starred" as const;
const TRASH_KEY = "files-trash" as const;
const SEARCH_KEY = "files-search" as const;
const QUOTA_KEY = "files-quota" as const;
const FILE_SHARES_KEY = "file-share-links" as const;
const FOLDER_SHARES_KEY = "folder-share-links" as const;

export function browseKey(scope: FileScope, folderId: string | null) {
  return [BROWSE_KEY, scope, folderId ?? "root"] as const;
}

export function useBrowseFiles(
  scope: FileScope,
  folderId: string | null,
  sort?: DriveSort,
  shared?: SharedView
) {
  return useQuery<BrowseResult>({
    // Sort is part of the key so changing it refetches; browseKey stays
    // the prefix used for invalidation after mutations.
    queryKey: [...browseKey(scope, folderId), sort?.key ?? "name", sort?.dir ?? "asc", shared ?? "all"],
    queryFn: () => filesApi.browse(scope, folderId, sort, shared),
    staleTime: 10_000,
  });
}

const PAGE = 200;

/** Merge pages of a listing: folders come on the first page, files on
 *  every page. */
function mergePages<T extends { folders: unknown[]; files: unknown[]; next_cursor?: string | null }>(
  pages: T[] | undefined
): T | undefined {
  if (!pages?.length) return undefined;
  const last = pages[pages.length - 1];
  return { ...pages[0], files: pages.flatMap((p) => p.files), next_cursor: last.next_cursor ?? null };
}

/** Just a folder's subfolders (WP-7.6) — under the browse key, so the
 *  usual invalidations refresh it. */
export function useSubfolders(scope: FileScope, parentId: string | null) {
  return useQuery<BrowseResult>({
    queryKey: [...browseKey(scope, parentId), "folders-only"],
    queryFn: () => filesApi.subfolders(scope, parentId),
    staleTime: 30_000,
  });
}

/** A folder a page at a time (WP-7.6): 200 files, then more as the list
 *  scrolls. While a newly opened folder loads, the last one stays on
 *  screen rather than flashing a skeleton. */
export function useBrowsePaged(
  scope: FileScope,
  folderId: string | null,
  sort?: DriveSort,
  shared?: SharedView
) {
  const q = useInfiniteQuery<BrowseResult>({
    queryKey: [...browseKey(scope, folderId), sort?.key ?? "name", sort?.dir ?? "asc", shared ?? "all", "paged"],
    queryFn: ({ pageParam }) =>
      filesApi.browse(scope, folderId, sort, shared, { limit: PAGE, cursor: pageParam as string | null }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
  const data = useMemo(() => mergePages(q.data?.pages), [q.data]);
  return { ...q, data };
}

/** Invalidate every Drive list view — used after mutations that
 * can affect multiple surfaces at once (trash cascades, restore,
 * star toggles, uploads). We invalidate by query key prefix so the
 * caller doesn't have to remember which folder level to refetch.
 * The quota query is always invalidated alongside (it has no scope)
 * so the storage pill stays in sync with mutations that could have
 * changed usage. */
export function useInvalidateFiles() {
  const qc = useQueryClient();
  return (scope?: FileScope) => invalidateFileQueries(qc, scope);
}

/** The same, for code that holds a QueryClient rather than calling the
 *  hook. Callers used to invalidate ``["files"]`` / ``["quota"]``, keys no
 *  query has, so share/copy/save-to-Drive left the lists stale (R-216). */
export function invalidateFileQueries(qc: QueryClient, scope?: FileScope) {
  return qc.invalidateQueries({
      predicate: (q) => {
        const head = q.queryKey[0];
        if (head === QUOTA_KEY) return true;
        if (
          head !== BROWSE_KEY &&
          head !== RECENT_KEY &&
          head !== STARRED_KEY &&
          head !== TRASH_KEY &&
          head !== SEARCH_KEY
        ) {
          return false;
        }
        if (!scope) return true;
        return q.queryKey[1] === scope;
      },
  });
}

/** After uploads (WP-7.6): refresh only the folders they landed in, the
 *  storage pill and Recent — not every Drive list. Search results are
 *  marked stale for next time rather than refetched. */
export function invalidateUploadTargets(qc: QueryClient, targets: { scope: FileScope; folderId: string | null }[]) {
  const seen = new Set<string>();
  for (const t of targets) {
    const key = browseKey(t.scope, t.folderId);
    if (seen.has(key.join("|"))) continue;
    seen.add(key.join("|"));
    void qc.invalidateQueries({ queryKey: key });
  }
  void qc.invalidateQueries({ queryKey: [QUOTA_KEY] });
  void qc.invalidateQueries({ queryKey: [RECENT_KEY] });
  void qc.invalidateQueries({ queryKey: [SEARCH_KEY], refetchType: "none" });
}

/** Live storage usage for the Drive sub-nav pill. Short stale time
 *  (10s) so the pill catches up quickly after an upload without
 *  pummelling the endpoint on every remount. */
export function useStorageQuota() {
  return useQuery<StorageQuota>({
    queryKey: [QUOTA_KEY],
    queryFn: () => filesApi.getQuota(),
    staleTime: 10_000,
  });
}

export function useCreateFolder() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: {
      scope: FileScope;
      name: string;
      parentId: string | null;
    }) => filesApi.createFolder(args.scope, args.name, args.parentId),
    onSuccess: (_data, vars) => invalidate(vars.scope),
  });
}

// ---- Bulk multi-select actions ----
export function useBulkTrash() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (ids: BulkIds) => filesApi.bulkTrash(ids),
    onSuccess: () => invalidate(),
  });
}
export function useBulkRestore() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (ids: BulkIds) => filesApi.bulkRestore(ids),
    onSuccess: () => invalidate(),
  });
}
export function useBulkPurge() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (ids: BulkIds) => filesApi.bulkPurge(ids),
    onSuccess: () => invalidate(),
  });
}
export function useBulkMove() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (
      args: BulkIds & { target_folder_id?: string | null; move_to_root?: boolean }
    ) => filesApi.bulkMove(args),
    onSuccess: () => invalidate(),
  });
}
export function useBulkStar() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: BulkIds & { star: boolean }) =>
      args.star ? filesApi.bulkStar(args) : filesApi.bulkUnstar(args),
    onSuccess: () => invalidate(),
  });
}

export function useRenameFolder() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: { id: string; name: string; scope: FileScope }) =>
      filesApi.renameFolder(args.id, args.name),
    onSuccess: (_data, vars) => invalidate(vars.scope),
  });
}

export function useDeleteFolder() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: { id: string; scope: FileScope }) =>
      filesApi.deleteFolder(args.id),
    onSuccess: (_data, vars) => invalidate(vars.scope),
  });
}

export function useUploadFile() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: {
      scope: FileScope;
      file: File;
      folderId: string | null;
      /** Auto-routing hint; ignored when ``folderId`` is set. */
      route?: "chat" | "generated";
    }) => filesApi.upload(args.scope, args.file, args.folderId, args.route),
    onSuccess: (_data, vars) => invalidate(vars.scope),
  });
}

export function useRenameFile() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: { id: string; filename: string; scope: FileScope }) =>
      filesApi.renameFile(args.id, args.filename),
    onSuccess: (_data, vars) => invalidate(vars.scope),
  });
}

export function useDeleteFile() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: { id: string; scope: FileScope }) =>
      filesApi.deleteFile(args.id),
    onSuccess: (_data, vars) => invalidate(vars.scope),
  });
}

export function useMoveFile() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: {
      id: string;
      folderId: string | null;
      scope: FileScope;
      /** Where it was — pass it to get an "Undo" toast (WP-3.5). */
      from?: string | null;
      name?: string;
    }) => filesApi.moveFile(args.id, args.folderId),
    onSuccess: (_data, vars) => {
      invalidate(vars.scope);
      if (vars.from !== undefined) {
        undoToast(`Moved “${vars.name ?? "file"}”`, async () => {
          await filesApi.moveFile(vars.id, vars.from ?? null);
          invalidate(vars.scope);
        });
      }
    },
  });
}

export function useMoveFolder() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: {
      id: string;
      parentId: string | null;
      scope: FileScope;
      from?: string | null;
      name?: string;
    }) => filesApi.moveFolder(args.id, args.parentId),
    onSuccess: (_data, vars) => {
      invalidate(vars.scope);
      if (vars.from !== undefined) {
        undoToast(`Moved “${vars.name ?? "folder"}”`, async () => {
          await filesApi.moveFolder(vars.id, vars.from ?? null);
          invalidate(vars.scope);
        });
      }
    },
  });
}

/** A success toast with an "Undo" action (trash, move — Part C §2.2). */
export function undoToast(message: string, undo: () => Promise<unknown>) {
  toast.success(message, {
    action: {
      label: "Undo",
      onClick: () => {
        undo().catch((e: unknown) =>
          toast.error(e instanceof Error ? e.message : "Couldn't undo that.")
        );
      },
    },
  });
}

// --------------------------------------------------------------------
// Drive stage 1 — Trash
// --------------------------------------------------------------------
export function useTrashFile() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: { id: string; scope: FileScope }) =>
      filesApi.trashFile(args.id),
    onSuccess: (_data, vars) => {
      invalidate(vars.scope);
      undoToast("Moved to trash", async () => {
        await filesApi.restoreFile(vars.id);
        invalidate(vars.scope);
      });
    },
  });
}

export function useRestoreFile() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: { id: string; scope: FileScope }) =>
      filesApi.restoreFile(args.id),
    onSuccess: (_data, vars) => invalidate(vars.scope),
  });
}

export function useTrashFolder() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: { id: string; scope: FileScope }) =>
      filesApi.trashFolder(args.id),
    onSuccess: (_data, vars) => {
      invalidate(vars.scope);
      undoToast("Folder moved to trash", async () => {
        await filesApi.restoreFolder(vars.id);
        invalidate(vars.scope);
      });
    },
  });
}

export function useRestoreFolder() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: { id: string; scope: FileScope }) =>
      filesApi.restoreFolder(args.id),
    onSuccess: (_data, vars) => invalidate(vars.scope),
  });
}

export function useTrashContents(scope: FileScope) {
  const q = useInfiniteQuery<TrashListResponse>({
    queryKey: [TRASH_KEY, scope] as const,
    queryFn: ({ pageParam }) => filesApi.listTrash(scope, { limit: PAGE, cursor: pageParam as string | null }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    staleTime: 10_000,
  });
  const data = useMemo(() => mergePages(q.data?.pages), [q.data]);
  return { ...q, data };
}

export function useEmptyTrash() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: { scope: FileScope }) => filesApi.emptyTrash(args.scope),
    onSuccess: (_data, vars) => invalidate(vars.scope),
  });
}

// --------------------------------------------------------------------
// Drive stage 1 — Starred / Recent / Search
// --------------------------------------------------------------------
export function useStarFile() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: { id: string; scope: FileScope }) =>
      filesApi.starFile(args.id),
    onSuccess: (_data, vars) => invalidate(vars.scope),
  });
}

export function useUnstarFile() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: { id: string; scope: FileScope }) =>
      filesApi.unstarFile(args.id),
    onSuccess: (_data, vars) => invalidate(vars.scope),
  });
}

export function useStarFolder() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: { id: string; scope: FileScope }) =>
      filesApi.starFolder(args.id),
    onSuccess: (_data, vars) => invalidate(vars.scope),
  });
}

export function useUnstarFolder() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: { id: string; scope: FileScope }) =>
      filesApi.unstarFolder(args.id),
    onSuccess: (_data, vars) => invalidate(vars.scope),
  });
}

export function useStarredFiles(scope: FileScope) {
  const q = useInfiniteQuery<StarredListResponse>({
    queryKey: [STARRED_KEY, scope] as const,
    queryFn: ({ pageParam }) => filesApi.listStarred(scope, { limit: PAGE, cursor: pageParam as string | null }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    staleTime: 10_000,
  });
  const data = useMemo(() => mergePages(q.data?.pages), [q.data]);
  return { ...q, data };
}

export function useRecentFiles(scope: FileScope, limit = 50) {
  return useQuery<RecentFilesResponse>({
    queryKey: [RECENT_KEY, scope, limit] as const,
    queryFn: () => filesApi.listRecent(scope, limit),
    staleTime: 10_000,
  });
}

/** Search is user-driven — the hook is disabled for empty queries
 * so tiny keystrokes don't hit the backend. Call with a non-empty
 * query and the page will poll while the input is stable. */
export function useSearchFiles(
  q: string,
  scope: FileScope,
  opts: { limit?: number; enabled?: boolean; folderId?: string | null } = {}
) {
  const enabled = opts.enabled !== false && q.trim().length > 0;
  return useQuery<FileSearchResponse>({
    queryKey: [SEARCH_KEY, scope, q.trim(), opts.limit ?? 20, opts.folderId ?? null] as const,
    queryFn: () =>
      filesApi.search(q.trim(), scope, opts.limit ?? 20, false, { folderId: opts.folderId ?? null }),
    enabled,
    staleTime: 5_000,
  });
}

const SEARCH_PAGE = 30;

/** Paged search for the results page — filters plus "Load more" (R-213;
 *  it was capped at 20 with no way past them). */
export function useSearchFilesPaged(
  q: string,
  scope: FileScope,
  filters: Omit<FileSearchFilters, "offset"> = {}
) {
  return useInfiniteQuery<FileSearchResponse>({
    queryKey: [SEARCH_KEY, scope, q.trim(), "paged", filters] as const,
    queryFn: ({ pageParam }) =>
      filesApi.search(q.trim(), scope, SEARCH_PAGE, false, {
        ...filters,
        offset: pageParam as number,
      }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) =>
      last.has_more ? pages.length * SEARCH_PAGE : undefined,
    enabled: q.trim().length > 0,
    staleTime: 5_000,
  });
}

// --------------------------------------------------------------------
// Drive stage 1 — Share links (owner side)
// --------------------------------------------------------------------
export function useFileShareLinks(fileId: string | null | undefined) {
  return useQuery<ShareLinkListResponse>({
    queryKey: [FILE_SHARES_KEY, fileId ?? "none"] as const,
    queryFn: () =>
      filesApi.listFileShareLinks(fileId as string),
    enabled: !!fileId,
    staleTime: 5_000,
  });
}

export function useFolderShareLinks(folderId: string | null | undefined) {
  return useQuery<ShareLinkListResponse>({
    queryKey: [FOLDER_SHARES_KEY, folderId ?? "none"] as const,
    queryFn: () =>
      filesApi.listFolderShareLinks(folderId as string),
    enabled: !!folderId,
    staleTime: 5_000,
  });
}

export function useCreateFileShareLink(fileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ShareLinkCreatePayload) =>
      filesApi.createFileShareLink(fileId, payload),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: [FILE_SHARES_KEY, fileId] }),
  });
}

export function useCreateFolderShareLink(folderId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ShareLinkCreatePayload) =>
      filesApi.createFolderShareLink(folderId, payload),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: [FOLDER_SHARES_KEY, folderId] }),
  });
}

export function useRevokeShareLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) => filesApi.revokeShareLink(linkId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [FILE_SHARES_KEY] });
      qc.invalidateQueries({ queryKey: [FOLDER_SHARES_KEY] });
    },
  });
}
