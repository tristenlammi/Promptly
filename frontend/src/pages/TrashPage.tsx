import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";

import type { FileItem, FileScope } from "@/api/files";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import {
  DriveEmptyState,
  DriveFileRow,
  DriveFolderRow,
} from "@/components/files/DriveRows";
import { DriveScopeTabs } from "@/components/files/DriveScopeTabs";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import {
  useDeleteFile,
  useDeleteFolder,
  useEmptyTrash,
  useRestoreFile,
  useRestoreFolder,
  useTrashContents,
} from "@/hooks/useFiles";
import { downloadAuthed, extractError } from "@/components/files/helpers";

export function TrashPage() {
  const [scope, setScope] = useState<FileScope>("mine");
  const { data, isLoading } = useTrashContents(scope);
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [emptyError, setEmptyError] = useState<string | null>(null);

  const emptyTrash = useEmptyTrash();
  const restoreFile = useRestoreFile();
  const restoreFolder = useRestoreFolder();
  const deleteFile = useDeleteFile();
  const deleteFolder = useDeleteFolder();

  const folders = data?.folders ?? [];
  const files = useMemo(() => data?.files ?? [], [data]);
  const empty = folders.length === 0 && files.length === 0;

  const onEmpty = async () => {
    setEmptyError(null);
    try {
      await emptyTrash.mutateAsync({ scope });
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
          <DriveScopeTabs scope={scope} onChange={setScope} />

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

          {!empty && (
            <div className="rounded-card border border-[var(--border)] bg-[var(--surface)]">
              <ul className="divide-y divide-[var(--border)]">
                {folders.map((f) => (
                  <DriveFolderRow
                    key={f.id}
                    folder={f}
                    onOpen={() => {
                      /* Trashed folders are read-only; clicking
                         restore is the useful action, so ignore
                         the default open-folder navigation. */
                    }}
                    actions={{
                      onRestore: () =>
                        restoreFolder.mutate({ id: f.id, scope }),
                      onDeleteForever: () =>
                        deleteFolder.mutate({ id: f.id, scope }),
                    }}
                  />
                ))}
                {files.map((f) => (
                  <DriveFileRow
                    key={f.id}
                    file={f}
                    actions={{
                      onPreview: () => setPreview(f),
                      onDownload: () => downloadAuthed(f),
                      onRestore: () => restoreFile.mutate({ id: f.id, scope }),
                      onDeleteForever: () =>
                        deleteFile.mutate({ id: f.id, scope }),
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
