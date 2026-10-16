import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";

import { filesApi, type FileItem, type ShareLinkRole, shareRolesFor, supportsEditGrant } from "@/api/files";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { DriveEmptyState, DriveSimpleList } from "@/components/files/DriveSimpleList";
import { DriveSelectionBar } from "@/components/files/DriveSelectionBar";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { ShareGrantsModal } from "@/components/files/ShareGrantsModal";
import { TopNav } from "@/components/layout/TopNav";
import {
  useBulkStar,
  useBulkTrash,
  useStarredFiles,
  useTrashFile,
  useTrashFolder,
  useUnstarFile,
  useUnstarFolder,
  invalidateFileQueries,
} from "@/hooks/useFiles";
import { useDriveSelection } from "@/hooks/useDriveSelection";
import { downloadAuthed, extractError, openFile as openInEditor } from "@/components/files/helpers";
import { toast } from "@/store/toastStore";

// Drive stage 5 — Starred is always "mine". Grantees can preview a
// shared folder/file but can't star it (stars live on the owner's
// row; they don't propagate). The sub-nav is the only surface-level
// navigation now, so the legacy scope tab row was retired here.
const SCOPE = "mine" as const;

export function StarredFilesPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useStarredFiles(SCOPE);
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [shareFor, setShareFor] = useState<
    {
      kind: "file" | "folder";
      id: string;
      name: string;
      supportsEdit?: boolean;
      roles?: ShareLinkRole[];
    } | null
  >(null);

  // Documents, sheets and whiteboards open on their editor page (WP-3.4);
  // everything else previews.
  const openFile = (f: FileItem) => {
    if (!openInEditor(f, navigate)) setPreview(f);
  };

  const unstarFile = useUnstarFile();
  const unstarFolder = useUnstarFolder();
  const trashFile = useTrashFile();
  const trashFolder = useTrashFolder();

  const folders = data?.folders ?? [];
  const files = useMemo(() => data?.files ?? [], [data]);
  const empty = folders.length === 0 && files.length === 0;

  // Multi-select + bulk actions.
  const sel = useDriveSelection();
  const bulkStar = useBulkStar();
  const bulkTrash = useBulkTrash();
  const [bulkBusy, setBulkBusy] = useState(false);
  useEffect(() => {
    sel.prune(
      new Set(files.map((f) => f.id)),
      new Set(folders.map((f) => f.id))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const bulkIds = () => ({
    file_ids: [...sel.files],
    folder_ids: [...sel.folders],
  });

  const runBulk = async (fn: () => Promise<unknown>, done?: string) => {
    setBulkBusy(true);
    try {
      await fn();
      if (done) toast.success(done);
      sel.clear();
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <>
      <TopNav
        title="Starred"
        subtitle="Quick access to folders and files you've marked."
        actions={<FilesTopNavSearch />}
      />
      <DriveSubNav />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="w-full px-6 py-6">
          {isLoading && (
            <div className="text-sm text-[var(--text-muted)]">Loading…</div>
          )}

          {!isLoading && empty && (
            <DriveEmptyState
              icon={<Star className="h-5 w-5" />}
              title="No starred items"
              description="Right-click any folder or file and choose Star to pin it here."
            />
          )}

          <DriveSelectionBar
            count={sel.count}
            busy={bulkBusy}
            onClear={sel.clear}
            onDownload={() =>
              void runBulk(() => filesApi.bulkZipDownload(bulkIds()))
            }
            onUnstar={() =>
              void runBulk(
                () => bulkStar.mutateAsync({ ...bulkIds(), star: false }),
                "Unstarred"
              )
            }
            onTrash={() =>
              void runBulk(
                () => bulkTrash.mutateAsync(bulkIds()),
                `Moved ${sel.count} item${sel.count === 1 ? "" : "s"} to trash`
              )
            }
          />

          {!empty && (
            <DriveSimpleList
              folders={folders}
              files={files}
              selection={{
                count: sel.count,
                isFileSelected: sel.isFileSelected,
                isFolderSelected: sel.isFolderSelected,
                toggleFile: sel.toggleFile,
                toggleFolder: sel.toggleFolder,
              }}
              open={(e) => (e.kind === "folder" ? navigate(`/files/folder/${e.folder.id}`) : openFile(e.file))}
              actions={(e) =>
                e.kind === "folder"
                  ? {
                      onUnstar: () => unstarFolder.mutate({ id: e.folder.id, scope: SCOPE }),
                      onShare: () => setShareFor({ kind: "folder", id: e.folder.id, name: e.folder.name }),
                      onTrash: () => trashFolder.mutate({ id: e.folder.id, scope: SCOPE }),
                    }
                  : {
                      onPreview: () => openFile(e.file),
                      onDownload: () => downloadAuthed(e.file),
                      onUnstar: () => unstarFile.mutate({ id: e.file.id, scope: SCOPE }),
                      onShare: () =>
                        setShareFor({
                          kind: "file",
                          id: e.file.id,
                          name: e.file.filename,
                          supportsEdit: supportsEditGrant(e.file),
                          roles: shareRolesFor(e.file),
                        }),
                      onTrash: () => trashFile.mutate({ id: e.file.id, scope: SCOPE }),
                    }
              }
              hasMore={!!hasNextPage}
              loadingMore={isFetchingNextPage}
              onLoadMore={() => void fetchNextPage()}
            />
          )}
        </div>
      </div>

      <FilePreviewModal
        open={!!preview}
        file={preview}
        siblings={files}
        onSelect={setPreview}
        onClose={() => setPreview(null)}
        onShare={(f) =>
          setShareFor({
            kind: "file",
            id: f.id,
            name: f.filename,
            supportsEdit: supportsEditGrant(f),
                          roles: shareRolesFor(f),
          })
        }
        onToggleStar={(f) => {
          unstarFile.mutate({ id: f.id, scope: SCOPE });
        }}
      />

      <ShareGrantsModal
        open={!!shareFor}
        resource={
          shareFor
            ? {
                type: shareFor.kind,
                id: shareFor.id,
                name: shareFor.name,
                supports_edit: shareFor.supportsEdit ?? false,
                roles: shareFor.roles,
              }
            : null
        }
        onClose={() => setShareFor(null)}
        onChanged={() => {
          void invalidateFileQueries(qc);
          void qc.invalidateQueries({ queryKey: ["workspaces"] });
        }}
      />

    </>
  );
}
