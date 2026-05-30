import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";

import type { FileItem } from "@/api/files";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import {
  DriveColumnsHeader,
  DriveEmptyState,
  DriveFileRow,
  DriveFolderRow,
} from "@/components/files/DriveRows";
import { DriveSelectionBar } from "@/components/files/DriveSelectionBar";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { Modal } from "@/components/shared/Modal";
import {
  useBulkRestore,
  useDeleteFile,
  useDeleteFolder,
  useEmptyTrash,
  useRestoreFile,
  useRestoreFolder,
  useTrashContents,
} from "@/hooks/useFiles";
import { useDriveSelection } from "@/hooks/useDriveSelection";
import { downloadAuthed, extractError } from "@/components/files/helpers";
import { toast } from "@/store/toastStore";

// Drive stage 5 — Trash is always "mine". The backend ignores the
// scope parameter (shared resources belong to their owner's trash,
// not yours), and the top sub-nav is the only navigation between
// Drive surfaces now, so the legacy "My files / Shared" tab row
// was retired here.
const SCOPE = "mine" as const;

export function TrashPage() {
  const { data, isLoading } = useTrashContents(SCOPE);
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [emptyError, setEmptyError] = useState<string | null>(null);

  const emptyTrash = useEmptyTrash();
  const restoreFile = useRestoreFile();
  const restoreFolder = useRestoreFolder();
  const deleteFile = useDeleteFile();
  const deleteFolder = useDeleteFolder();
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

  const handleBulkDeleteForever = async () => {
    const count = sel.count;
    const ok = await confirm({
      title: "Delete forever?",
      message: `${count} item${count === 1 ? "" : "s"} will be permanently deleted. This can't be undone.`,
      confirmLabel: "Delete forever",
      danger: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      await Promise.all([
        ...[...sel.files].map((id) =>
          deleteFile.mutateAsync({ id, scope: SCOPE })
        ),
        ...[...sel.folders].map((id) =>
          deleteFolder.mutateAsync({ id, scope: SCOPE })
        ),
      ]);
      toast.success(`Deleted ${count} item${count === 1 ? "" : "s"}`);
      sel.clear();
    } catch (e) {
      toast.error(extractError(e));
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
        subtitle="Items here are kept until you empty the trash. Quota still counts them."
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
        <div className="mx-auto w-full max-w-4xl px-6 py-6">
          {isLoading && (
            <div className="text-sm text-[var(--text-muted)]">Loading…</div>
          )}

          {!isLoading && empty && (
            <DriveEmptyState
              icon={<Trash2 className="h-5 w-5" />}
              title="Trash is empty"
              description="Items you trash will stay here until you empty the trash."
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
            <div className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
              <DriveColumnsHeader />
              <ul className="divide-y divide-[var(--border)]">
                {folders.map((f) => (
                  <DriveFolderRow
                    key={f.id}
                    folder={f}
                    selected={sel.isFolderSelected(f.id)}
                    selectionActive={sel.count > 0}
                    onToggleSelect={() => sel.toggleFolder(f.id)}
                    onOpen={() => {
                      /* Trashed folders are read-only; clicking
                         restore is the useful action, so ignore
                         the default open-folder navigation. */
                    }}
                    actions={{
                      onRestore: () =>
                        restoreFolder.mutate({ id: f.id, scope: SCOPE }),
                      onDeleteForever: () =>
                        deleteFolder.mutate({ id: f.id, scope: SCOPE }),
                    }}
                  />
                ))}
                {files.map((f) => (
                  <DriveFileRow
                    key={f.id}
                    file={f}
                    selected={sel.isFileSelected(f.id)}
                    selectionActive={sel.count > 0}
                    onToggleSelect={() => sel.toggleFile(f.id)}
                    actions={{
                      onPreview: () => setPreview(f),
                      onDownload: () => downloadAuthed(f),
                      onRestore: () =>
                        restoreFile.mutate({ id: f.id, scope: SCOPE }),
                      onDeleteForever: () =>
                        deleteFile.mutate({ id: f.id, scope: SCOPE }),
                    }}
                  />
                ))}
              </ul>
            </div>
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
