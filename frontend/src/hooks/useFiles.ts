import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  filesApi,
  type BrowseResult,
  type FileScope,
  type FileSearchResponse,
  type RecentFilesResponse,
  type ShareLinkCreatePayload,
  type ShareLinkListResponse,
  type StarredListResponse,
  type StorageQuota,
  type TrashListResponse,
} from "@/api/files";

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

export function useBrowseFiles(scope: FileScope, folderId: string | null) {
  return useQuery<BrowseResult>({
    queryKey: browseKey(scope, folderId),
    queryFn: () => filesApi.browse(scope, folderId),
    staleTime: 10_000,
  });
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
  return (scope?: FileScope) =>
    qc.invalidateQueries({
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
    }) => filesApi.moveFile(args.id, args.folderId),
    onSuccess: (_data, vars) => invalidate(vars.scope),
  });
}

export function useMoveFolder() {
  const invalidate = useInvalidateFiles();
  return useMutation({
    mutationFn: (args: {
      id: string;
      parentId: string | null;
      scope: FileScope;
    }) => filesApi.moveFolder(args.id, args.parentId),
    onSuccess: (_data, vars) => invalidate(vars.scope),
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
    onSuccess: (_data, vars) => invalidate(vars.scope),
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
    onSuccess: (_data, vars) => invalidate(vars.scope),
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
  return useQuery<TrashListResponse>({
    queryKey: [TRASH_KEY, scope] as const,
    queryFn: () => filesApi.listTrash(scope),
    staleTime: 10_000,
  });
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
  return useQuery<StarredListResponse>({
    queryKey: [STARRED_KEY, scope] as const,
    queryFn: () => filesApi.listStarred(scope),
    staleTime: 10_000,
  });
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
  opts: { limit?: number; enabled?: boolean } = {}
) {
  const enabled = opts.enabled !== false && q.trim().length > 0;
  return useQuery<FileSearchResponse>({
    queryKey: [SEARCH_KEY, scope, q.trim(), opts.limit ?? 20] as const,
    queryFn: () => filesApi.search(q.trim(), scope, opts.limit ?? 20),
    enabled,
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
