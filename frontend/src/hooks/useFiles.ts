import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { filesApi, type BrowseResult, type FileScope } from "@/api/files";

const BROWSE_KEY = "files-browse" as const;

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

/** Invalidate browse views for a given scope (covers all folder levels). */
export function useInvalidateFiles() {
  const qc = useQueryClient();
  return (scope?: FileScope) =>
    qc.invalidateQueries({
      predicate: (q) => {
        if (q.queryKey[0] !== BROWSE_KEY) return false;
        if (!scope) return true;
        return q.queryKey[1] === scope;
      },
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
