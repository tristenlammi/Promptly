import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Clock } from "lucide-react";

import type { FileItem, FileScope } from "@/api/files";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { DriveEmptyState, DriveFileRow } from "@/components/files/DriveRows";
import { DriveScopeTabs } from "@/components/files/DriveScopeTabs";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { ShareLinkDialog } from "@/components/files/ShareLinkDialog";
import { TopNav } from "@/components/layout/TopNav";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { downloadAuthed } from "@/components/files/helpers";
import {
  useRecentFiles,
  useStarFile,
  useTrashFile,
  useUnstarFile,
} from "@/hooks/useFiles";

export function RecentFilesPage() {
  const [scope, setScope] = useState<FileScope>("mine");
  const { data, isLoading } = useRecentFiles(scope);
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [shareFor, setShareFor] = useState<FileItem | null>(null);

  const star = useStarFile();
  const unstar = useUnstarFile();
  const trash = useTrashFile();
  const navigate = useNavigate();

  const files = useMemo(() => data?.files ?? [], [data]);

  return (
    <>
      <TopNav
        title="Recent"
        subtitle="Files you've touched recently, across every folder."
        actions={<FilesTopNavSearch />}
      />
      <DriveSubNav />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-6">
          <DriveScopeTabs scope={scope} onChange={setScope} />

          {isLoading && (
            <div className="text-sm text-[var(--text-muted)]">Loading…</div>
          )}

          {!isLoading && files.length === 0 && (
            <DriveEmptyState
              icon={<Clock className="h-5 w-5" />}
              title="No recent files"
              description="Upload or edit a file to see it here."
            />
          )}

          {files.length > 0 && (
            <div className="rounded-card border border-[var(--border)] bg-[var(--surface)]">
              <ul className="divide-y divide-[var(--border)]">
                {files.map((f) => (
                  <DriveFileRow
                    key={f.id}
                    file={f}
                    actions={{
                      onPreview: () => setPreview(f),
                      onDownload: () => downloadAuthed(f),
                      onShare: () => setShareFor(f),
                      onStar: f.starred_at
                        ? undefined
                        : () => star.mutate({ id: f.id, scope }),
                      onUnstar: f.starred_at
                        ? () => unstar.mutate({ id: f.id, scope })
                        : undefined,
                      onMove:
                        f.folder_id !== undefined
                          ? () =>
                              navigate(
                                f.folder_id
                                  ? `/files/folder/${f.folder_id}`
                                  : "/files"
                              )
                          : undefined,
                      onTrash: () => trash.mutate({ id: f.id, scope }),
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
        onShare={setShareFor}
        onToggleStar={(f) => {
          if (f.starred_at) unstar.mutate({ id: f.id, scope });
          else star.mutate({ id: f.id, scope });
        }}
      />

      <ShareLinkDialog
        open={!!shareFor}
        resource={
          shareFor
            ? { kind: "file", id: shareFor.id, name: shareFor.filename }
            : null
        }
        onClose={() => setShareFor(null)}
      />
    </>
  );
}
