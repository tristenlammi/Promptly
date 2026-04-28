import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Star } from "lucide-react";

import type { FileItem } from "@/api/files";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import {
  DriveEmptyState,
  DriveFileRow,
  DriveFolderRow,
} from "@/components/files/DriveRows";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { ShareLinkDialog } from "@/components/files/ShareLinkDialog";
import { TopNav } from "@/components/layout/TopNav";
import {
  useStarredFiles,
  useTrashFile,
  useTrashFolder,
  useUnstarFile,
  useUnstarFolder,
} from "@/hooks/useFiles";
import { downloadAuthed } from "@/components/files/helpers";

// Drive stage 5 — Starred is always "mine". Grantees can preview a
// shared folder/file but can't star it (stars live on the owner's
// row; they don't propagate). The sub-nav is the only surface-level
// navigation now, so the legacy scope tab row was retired here.
const SCOPE = "mine" as const;

export function StarredFilesPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useStarredFiles(SCOPE);
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [shareFor, setShareFor] = useState<
    { kind: "file" | "folder"; id: string; name: string } | null
  >(null);

  const unstarFile = useUnstarFile();
  const unstarFolder = useUnstarFolder();
  const trashFile = useTrashFile();
  const trashFolder = useTrashFolder();

  const folders = data?.folders ?? [];
  const files = useMemo(() => data?.files ?? [], [data]);
  const empty = folders.length === 0 && files.length === 0;

  return (
    <>
      <TopNav
        title="Starred"
        subtitle="Quick access to folders and files you've marked."
        actions={<FilesTopNavSearch />}
      />
      <DriveSubNav />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-6">
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

          {!empty && (
            <div className="rounded-card border border-[var(--border)] bg-[var(--surface)]">
              <ul className="divide-y divide-[var(--border)]">
                {folders.map((f) => (
                  <DriveFolderRow
                    key={f.id}
                    folder={f}
                    onOpen={() => navigate(`/files/folder/${f.id}`)}
                    actions={{
                      onUnstar: () =>
                        unstarFolder.mutate({ id: f.id, scope: SCOPE }),
                      onShare: () =>
                        setShareFor({
                          kind: "folder",
                          id: f.id,
                          name: f.name,
                        }),
                      onTrash: () =>
                        trashFolder.mutate({ id: f.id, scope: SCOPE }),
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
                      onUnstar: () =>
                        unstarFile.mutate({ id: f.id, scope: SCOPE }),
                      onShare: () =>
                        setShareFor({
                          kind: "file",
                          id: f.id,
                          name: f.filename,
                        }),
                      onTrash: () =>
                        trashFile.mutate({ id: f.id, scope: SCOPE }),
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
        onShare={(f) =>
          setShareFor({ kind: "file", id: f.id, name: f.filename })
        }
        onToggleStar={(f) => {
          unstarFile.mutate({ id: f.id, scope: SCOPE });
        }}
      />

      <ShareLinkDialog
        open={!!shareFor}
        resource={shareFor}
        onClose={() => setShareFor(null)}
      />
    </>
  );
}
