import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, Trash2 } from "lucide-react";

import { trashGuardApi, type FileItem } from "@/api/files";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { DriveEmptyState, DriveSimpleList } from "@/components/files/DriveSimpleList";
import { DriveSelectionBar } from "@/components/files/DriveSelectionBar";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { Modal } from "@/components/shared/Modal";
import {
  useBulkPurge,
  useBulkRestore,
  useEmptyTrash,
  useRestoreFile,
  useRestoreFolder,
  useTrashContents,
} from "@/hooks/useFiles";
import { useDriveSelection } from "@/hooks/useDriveSelection";
import { downloadAuthed, extractError } from "@/components/files/helpers";
import { formatRelativeTime } from "@/components/files/helpers";
import { toast } from "@/store/toastStore";

// Drive stage 5 — Trash is always "mine". The backend ignores the
// scope parameter (shared resources belong to their owner's trash,
// not yours), and the top sub-nav is the only navigation between
// Drive surfaces now, so the legacy "My files / Shared" tab row
// was retired here.
const SCOPE = "mine" as const;

export function TrashPage() {
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useTrashContents(SCOPE);
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [emptyError, setEmptyError] = useState<string | null>(null);

  const emptyTrash = useEmptyTrash();
  const restoreFile = useRestoreFile();
  const restoreFolder = useRestoreFolder();
  const bulkPurge = useBulkPurge();
  const bulkRestore = useBulkRestore();

  const folders = data?.folders ?? [];
  const files = useMemo(() => data?.files ?? [], [data]);
  const empty = folders.length === 0 && files.length === 0;

  // Multi-select + bulk actions.
  const sel = useDriveSelection();
  const [bulkBusy, setBulkBusy] = useState(false);
  useEffect(() => {
    sel.prune(
      new Set(files.map((f) => f.id)),
      new Set(folders.map((f) => f.id))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const handleBulkRestore = async () => {
    setBulkBusy(true);
    try {
      await bulkRestore.mutateAsync({
        file_ids: [...sel.files],
        folder_ids: [...sel.folders],
      });
      toast.success(`Restored ${sel.count} item${sel.count === 1 ? "" : "s"}`);
      sel.clear();
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBulkBusy(false);
    }
  };

  // "Delete forever" used to call the soft-delete endpoint, which only
  // re-stamped the trash date — nothing was deleted, yet the toast said so
  // (R-025). It now purges for real and reports what actually went.
  const deleteForever = async (
    ids: { file_ids: string[]; folder_ids: string[] },
    count: number
  ) => {
    const ok = await confirm({
      title: "Delete forever?",
      message: `${count} item${count === 1 ? "" : "s"} will be permanently deleted.`,
      confirmLabel: "Delete forever",
      danger: true,
    });
    if (!ok) return false;
    try {
      const res = await bulkPurge.mutateAsync(ids);
      const n = res.files + res.folders;
      if (n === 0) toast.error("Nothing was deleted — it may already be gone.");
      else toast.success(`Deleted ${n} item${n === 1 ? "" : "s"} for good`);
      return true;
    } catch (e) {
      toast.error(extractError(e));
      return false;
    }
  };

  const handleBulkDeleteForever = async () => {
    setBulkBusy(true);
    try {
      const done = await deleteForever(
        { file_ids: [...sel.files], folder_ids: [...sel.folders] },
        sel.count
      );
      if (done) sel.clear();
    } finally {
      setBulkBusy(false);
    }
  };

  const onEmpty = async () => {
    setEmptyError(null);
    try {
      await emptyTrash.mutateAsync({ scope: SCOPE });
      setEmptyOpen(false);
    } catch (e) {
      setEmptyError(extractError(e));
    }
  };

  return (
    <>
      <TopNav
        title="Trash"
        subtitle="Items are deleted for good after 30 days. Quota still counts them until then."
        actions={
          <>
            <FilesTopNavSearch />
            <Button
              size="sm"
              variant="danger"
              leftIcon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => setEmptyOpen(true)}
              disabled={empty}
            >
              Empty trash
            </Button>
          </>
        }
      />
      <DriveSubNav />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="w-full px-6 py-6">
          <RestoreDeviceBanner />
          {isLoading && (
            <div className="text-sm text-[var(--text-muted)]">Loading…</div>
          )}

          {!isLoading && empty && (
            <DriveEmptyState
              icon={<Trash2 className="h-5 w-5" />}
              title="Trash is empty"
              description="Items you trash stay here for 30 days, then they’re deleted for good."
            />
          )}

          <DriveSelectionBar
            count={sel.count}
            busy={bulkBusy}
            onClear={sel.clear}
            onRestore={() => void handleBulkRestore()}
            onDeleteForever={() => void handleBulkDeleteForever()}
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
              // Trashed folders are read-only — restore is the useful
              // action, so clicking one doesn't navigate.
              open={(e) => (e.kind === "file" ? setPreview(e.file) : undefined)}
              extra={(e) =>
                e.kind === "file"
                  ? trashedFrom(e.file.location, e.file.trashed_at)
                  : trashedFrom(e.folder.location, e.folder.trashed_at)
              }
              actions={(e) =>
                e.kind === "folder"
                  ? {
                      onRestore: () =>
                        restoreFolder.mutate(
                          { id: e.folder.id, scope: SCOPE },
                          { onSuccess: (r) => restoredToast(e.folder.name, r.location) }
                        ),
                      onDeleteForever: () => void deleteForever({ file_ids: [], folder_ids: [e.folder.id] }, 1),
                    }
                  : {
                      onPreview: () => setPreview(e.file),
                      onDownload: () => downloadAuthed(e.file),
                      onRestore: () =>
                        restoreFile.mutate(
                          { id: e.file.id, scope: SCOPE },
                          { onSuccess: (r) => restoredToast(e.file.filename, r.location) }
                        ),
                      onDeleteForever: () => void deleteForever({ file_ids: [e.file.id], folder_ids: [] }, 1),
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
      />

      <Modal
        open={emptyOpen}
        onClose={() => setEmptyOpen(false)}
        title="Empty trash?"
        description="Every file and folder currently in the trash will be permanently deleted. This action cannot be undone."
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEmptyOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={onEmpty}
              loading={emptyTrash.isPending}
            >
              Empty trash
            </Button>
          </>
        }
      >
        {emptyError ? (
          <p className="text-sm text-red-600 dark:text-red-400">{emptyError}</p>
        ) : null}
      </Modal>
    </>
  );
}

/** "From My files / Projects · deleted 3 days ago" under a trashed row. */
function trashedFrom(location?: string | null, trashedAt?: string | null) {
  if (!location && !trashedAt) return null;
  return (
    <span className="truncate">
      {location ? `From ${location}` : ""}
      {location && trashedAt ? " · " : ""}
      {trashedAt ? `deleted ${formatRelativeTime(trashedAt)}` : ""}
    </span>
  );
}

function restoredToast(name: string, location?: string | null) {
  toast.success(location ? `Restored “${name}” to ${location}` : `Restored “${name}”`);
}


/** The mass-delete alert's link lands here with ``?restore=<credential>``:
 *  put back everything that device sent to the trash (WP-7.2). */
function RestoreDeviceBanner() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const credential = params.get("restore");
  const [busy, setBusy] = useState(false);
  const { data } = useQuery({
    queryKey: ["trash-restore-device", credential],
    queryFn: () => trashGuardApi.summary(credential!),
    enabled: !!credential,
  });
  if (!credential || !data) return null;
  const close = () => {
    params.delete("restore");
    setParams(params, { replace: true });
  };
  const total = data.files + data.folders;
  return (
    <div
      role="region"
      aria-label="Restore deleted files"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-card border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
    >
      <ShieldAlert className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        {total ? (
          <>
            <strong>
              {data.files} file{data.files === 1 ? "" : "s"}
              {data.folders ? ` and ${data.folders} folder${data.folders === 1 ? "" : "s"}` : ""}
            </strong>{" "}
            were sent to the trash from {data.this_device ? "this device" : "one device"} in the last two days.
            {!data.this_device && " If that wasn't you, restore them and change your password."}
          </>
        ) : (
          "Nothing from that device is in the trash any more."
        )}
      </div>
      {total > 0 && (
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await trashGuardApi.restore(credential);
              toast.success(`Restored ${r.files} file${r.files === 1 ? "" : "s"}${r.folders ? ` and ${r.folders} folder${r.folders === 1 ? "" : "s"}` : ""}.`);
              await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").startsWith("files-") });
              close();
            } catch (e) {
              toast.error(extractError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Restore everything
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={close}>
        Dismiss
      </Button>
    </div>
  );
}
